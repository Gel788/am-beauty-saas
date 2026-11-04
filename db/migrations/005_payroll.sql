-- Phase 3: master payroll (PAYROLL-*).

-- When a visit was completed decides which period it is paid in (accrual_basis = completed_at).
ALTER TABLE appointments
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN exclude_from_payroll boolean NOT NULL DEFAULT false,
  ADD COLUMN exclude_from_payroll_reason text;

UPDATE appointments a SET completed_at = COALESCE(
  (SELECT max(l.created_at) FROM audit_log l WHERE l.entity_id = a.id AND l.action = 'appointment.completed'),
  a.updated_at
) WHERE a.status = 'completed';

CREATE OR REPLACE FUNCTION track_completed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSIF NEW.status <> 'completed' THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_completed_at BEFORE INSERT OR UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION track_completed_at();

ALTER TABLE branches
  ADD COLUMN accrue_on_complete_unpaid boolean NOT NULL DEFAULT false;

CREATE TABLE payroll_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  staff_id uuid REFERENCES staff (id) ON DELETE CASCADE,
  service_id uuid REFERENCES services (id) ON DELETE CASCADE,
  scheme text NOT NULL CHECK (scheme IN ('percent', 'fixed_per_service', 'salary', 'hybrid')),
  percent_bps int NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000),
  fixed_minor int NOT NULL DEFAULT 0 CHECK (fixed_minor >= 0),
  salary_minor int NOT NULL DEFAULT 0 CHECK (salary_minor >= 0),
  period_unit text NOT NULL DEFAULT 'month' CHECK (period_unit IN ('month', 'biweekly', 'week')),
  base text NOT NULL DEFAULT 'service_price' CHECK (base IN ('service_price', 'paid_amount', 'price_after_discount')),
  include_tips boolean NOT NULL DEFAULT true,
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- A service-specific rule always names the master; «all masters, one service» is not a level in the spec.
  CHECK (service_id IS NULL OR staff_id IS NOT NULL)
);
CREATE INDEX payroll_rules_staff ON payroll_rules (staff_id, valid_from);

CREATE TABLE payroll_periods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'approved', 'paid', 'locked')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculated_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  locked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
-- Periods of a branch never overlap, so a visit is accrued exactly once.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE payroll_periods ADD CONSTRAINT payroll_periods_no_overlap
  EXCLUDE USING gist (branch_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);

CREATE TABLE payroll_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES payroll_periods (id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff (id),
  accrual_minor int NOT NULL DEFAULT 0,
  deduction_minor int NOT NULL DEFAULT 0,
  tip_minor int NOT NULL DEFAULT 0,
  total_minor int NOT NULL DEFAULT 0,
  payout_minor int NOT NULL DEFAULT 0,
  carry_debt boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
  paid_on date,
  paid_method text CHECK (paid_method IS NULL OR paid_method IN ('cash', 'transfer')),
  paid_reference text,
  paid_by uuid,
  UNIQUE (period_id, staff_id)
);

CREATE TABLE payroll_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES payroll_items (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('service', 'salary', 'tip', 'bonus', 'penalty', 'adjustment', 'refund_clawback')),
  manual boolean NOT NULL DEFAULT false,
  appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
  appointment_service_id uuid,
  service_id uuid,
  rule_id uuid,
  title text NOT NULL,
  occurred_on date,
  base_amount_minor int NOT NULL DEFAULT 0,
  rate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_minor int NOT NULL,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_lines_item ON payroll_lines (item_id);
CREATE INDEX payroll_lines_service ON payroll_lines (appointment_service_id) WHERE appointment_service_id IS NOT NULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_rules', 'payroll_periods', 'payroll_items', 'payroll_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;
