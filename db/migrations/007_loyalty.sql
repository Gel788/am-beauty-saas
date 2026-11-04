-- Phase 3: loyalty (LOY-*): bonus points, certificates, client_memberships, promo codes.

-- Programme settings live on the salon.
ALTER TABLE tenants
  ADD COLUMN bonus_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN bonus_earn_bps int NOT NULL DEFAULT 500 CHECK (bonus_earn_bps BETWEEN 0 AND 10000),
  ADD COLUMN bonus_burn_max_bps int NOT NULL DEFAULT 3000 CHECK (bonus_burn_max_bps BETWEEN 0 AND 10000),
  ADD COLUMN bonus_earn_on_products boolean NOT NULL DEFAULT true,
  ADD COLUMN certificate_valid_days int NOT NULL DEFAULT 365 CHECK (certificate_valid_days BETWEEN 1 AND 3650);

-- One point = one kopeck of discount, so balances are integer minor units like money.
ALTER TABLE clients
  ADD COLUMN bonus_balance int NOT NULL DEFAULT 0 CHECK (bonus_balance >= 0);

CREATE TABLE bonus_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('earn', 'burn', 'clawback', 'burn_refund', 'manual')),
  delta int NOT NULL CHECK (delta <> 0),
  balance_after int NOT NULL,
  payment_id uuid REFERENCES payments (id) ON DELETE SET NULL,
  reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bonus_ledger_client ON bonus_ledger (client_id, created_at DESC);
CREATE INDEX bonus_ledger_payment ON bonus_ledger (payment_id) WHERE payment_id IS NOT NULL;

CREATE TABLE certificates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code text NOT NULL,
  nominal_minor int NOT NULL CHECK (nominal_minor > 0),
  balance_minor int NOT NULL CHECK (balance_minor >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  valid_to date NOT NULL,
  client_id uuid REFERENCES clients (id) ON DELETE SET NULL,
  sold_payment_id uuid REFERENCES payments (id) ON DELETE SET NULL,
  voided_minor int NOT NULL DEFAULT 0,
  void_reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT certificates_code_unique UNIQUE (tenant_id, code),
  CHECK (balance_minor <= nominal_minor)
);

CREATE TABLE membership_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  visits int NOT NULL CHECK (visits BETWEEN 1 AND 1000),
  valid_days int NOT NULL CHECK (valid_days BETWEEN 1 AND 3650),
  price_minor int NOT NULL CHECK (price_minor > 0),
  -- Empty means any service.
  service_ids uuid[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES membership_plans (id),
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  title text NOT NULL,
  visits_total int NOT NULL,
  visits_left int NOT NULL CHECK (visits_left >= 0),
  service_ids uuid[] NOT NULL DEFAULT '{}',
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  frozen_from date,
  frozen_to date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  sold_payment_id uuid REFERENCES payments (id) ON DELETE SET NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (visits_left <= visits_total),
  CHECK (frozen_to IS NULL OR frozen_to >= frozen_from)
);
CREATE INDEX memberships_client ON client_memberships (client_id);

CREATE TABLE promo_codes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value int NOT NULL CHECK (value > 0),
  valid_from date,
  valid_to date,
  service_ids uuid[] NOT NULL DEFAULT '{}',
  min_check_minor int NOT NULL DEFAULT 0 CHECK (min_check_minor >= 0),
  max_uses int CHECK (max_uses IS NULL OR max_uses > 0),
  per_phone_limit int CHECK (per_phone_limit IS NULL OR per_phone_limit > 0),
  online_only boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_codes_code_unique UNIQUE (tenant_id, code),
  CHECK (kind <> 'percent' OR value <= 10000)
);

CREATE TABLE promo_redemptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  promo_id uuid NOT NULL REFERENCES promo_codes (id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  phone_e164 text,
  discount_minor int NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One live promo per visit.
CREATE UNIQUE INDEX promo_one_per_appointment ON promo_redemptions (appointment_id) WHERE released_at IS NULL;

ALTER TABLE appointment_services
  ADD COLUMN price_before_promo_minor int;

-- Tenders that are not money: which certificate or membership paid.
ALTER TABLE payment_tenders DROP CONSTRAINT payment_tenders_method_check;
ALTER TABLE payment_tenders ADD CONSTRAINT payment_tenders_method_check
  CHECK (method IN ('cash', 'card', 'sbp', 'transfer', 'bonus', 'certificate', 'membership'));
ALTER TABLE payment_tenders
  ADD COLUMN certificate_id uuid REFERENCES certificates (id),
  ADD COLUMN membership_id uuid REFERENCES client_memberships (id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bonus_ledger', 'certificates', 'membership_plans', 'client_memberships', 'promo_codes', 'promo_redemptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;
