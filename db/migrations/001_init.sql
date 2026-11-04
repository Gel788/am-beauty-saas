-- Am Beauty core schema. Tenant isolation via RLS; app connects as app_user.

CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  currency text NOT NULL DEFAULT 'RUB',
  require_open_shift boolean NOT NULL DEFAULT true,
  owner_can_bypass_shift boolean NOT NULL DEFAULT true,
  master_sees_all_columns boolean NOT NULL DEFAULT false,
  master_can_create_own boolean NOT NULL DEFAULT true,
  master_can_drag_own boolean NOT NULL DEFAULT true,
  master_can_cancel_own_future boolean NOT NULL DEFAULT true,
  master_can_take_payment boolean NOT NULL DEFAULT false,
  arrival_window_hours int NOT NULL DEFAULT 4,
  no_show_grace_min int NOT NULL DEFAULT 15,
  grid_step_min int NOT NULL DEFAULT 5,
  grid_label_min int NOT NULL DEFAULT 30,
  require_payment_on_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('super', 'owner', 'admin', 'master', 'accountant', 'client')),
  branch_id uuid REFERENCES branches (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE staff (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  display_name text NOT NULL,
  color text NOT NULL DEFAULT '#7c5cff',
  specialties text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  online_bookable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_branches (
  staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, branch_id)
);

CREATE TABLE service_categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  title text NOT NULL,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE services (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  category_id uuid REFERENCES service_categories (id) ON DELETE RESTRICT,
  title text NOT NULL,
  duration_min int NOT NULL CHECK (duration_min >= 5 AND duration_min % 5 = 0),
  price_minor int NOT NULL CHECK (price_minor >= 0),
  color text NOT NULL DEFAULT '#f8d0e4',
  online_visible boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  buffer_after_min int NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0 AND buffer_after_min % 5 = 0)
);

CREATE TABLE service_staff (
  service_id uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, staff_id)
);

CREATE TABLE clients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  email text,
  notes text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'walk-in',
  balance_minor int NOT NULL DEFAULT 0,
  birth_date date,
  deleted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  merged_into_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_phones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  deleted_at timestamptz
);

CREATE UNIQUE INDEX client_phones_active_unique
  ON client_phones (tenant_id, phone_e164)
  WHERE deleted_at IS NULL;

CREATE TABLE client_tags (
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  tag text NOT NULL,
  PRIMARY KEY (client_id, tag)
);

CREATE TABLE balance_adjustments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  amount_minor int NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedule_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min smallint NOT NULL CHECK (start_min >= 0 AND start_min < 1440),
  end_min smallint NOT NULL CHECK (end_min > 0 AND end_min <= 1440),
  kind text NOT NULL CHECK (kind IN ('work', 'break')),
  CHECK (end_min > start_min)
);

CREATE TABLE schedule_exceptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('day_off', 'vacation', 'special_hours')),
  start_min smallint,
  end_min smallint,
  CHECK (ends_on >= starts_on)
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff (id),
  client_id uuid REFERENCES clients (id),
  booked_by_client_id uuid REFERENCES clients (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  branch_tz text NOT NULL,
  tz_offset_min int NOT NULL,
  status text NOT NULL CHECK (status IN (
    'scheduled', 'confirmed', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show'
  )),
  comment text NOT NULL DEFAULT '',
  source text NOT NULL CHECK (source IN ('admin', 'online', 'api', 'master')),
  color text NOT NULL DEFAULT '#f8d0e4',
  version int NOT NULL DEFAULT 1,
  force_overlap boolean NOT NULL DEFAULT false,
  overlap_reason text,
  cancel_reason text,
  cancelled_by uuid,
  debt_minor int NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX appointments_staff_time ON appointments (staff_id, starts_at);
CREATE INDEX appointments_branch_time ON appointments (branch_id, starts_at);

CREATE TABLE appointment_services (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  service_id uuid REFERENCES services (id) ON DELETE SET NULL,
  title_snapshot text NOT NULL,
  duration_min int NOT NULL CHECK (duration_min >= 5),
  price_minor int NOT NULL CHECK (price_minor >= 0),
  position int NOT NULL
);

CREATE TABLE cash_shifts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_cash_minor int NOT NULL CHECK (opening_cash_minor >= 0),
  status text NOT NULL CHECK (status IN ('open', 'closing', 'closed')),
  note text NOT NULL DEFAULT '',
  closed_by uuid,
  closed_at timestamptz
);

CREATE UNIQUE INDEX one_open_shift_per_branch
  ON cash_shifts (branch_id)
  WHERE status = 'open';

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments (id) ON DELETE RESTRICT,
  client_id uuid REFERENCES clients (id),
  shift_id uuid REFERENCES cash_shifts (id),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  status text NOT NULL CHECK (status IN ('pending', 'posted', 'refunded', 'void')),
  total_minor int NOT NULL CHECK (total_minor >= 0),
  change_minor int NOT NULL DEFAULT 0 CHECK (change_minor >= 0),
  refund_of_id uuid REFERENCES payments (id),
  created_by uuid NOT NULL,
  posted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  line_type text NOT NULL CHECK (line_type IN ('service', 'product', 'tip', 'debt', 'loyalty', 'deposit')),
  ref_id uuid,
  title text NOT NULL,
  amount_minor int NOT NULL CHECK (amount_minor >= 0)
);

CREATE TABLE payment_tenders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('cash', 'card', 'sbp', 'transfer', 'bonus', 'certificate')),
  amount_minor int NOT NULL CHECK (amount_minor >= 0)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid,
  actor_id uuid,
  entity text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entity ON audit_log (entity, entity_id, created_at);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  journal_density text NOT NULL DEFAULT 'auto' CHECK (journal_density IN ('auto', 'comfortable', 'compact')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants', 'branches', 'staff', 'staff_branches', 'service_categories', 'services',
    'service_staff', 'clients', 'client_phones', 'client_tags', 'balance_adjustments',
    'schedule_templates', 'schedule_exceptions', 'appointments', 'appointment_services',
    'cash_shifts', 'payments', 'payment_lines', 'payment_tenders', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    IF t = 'tenants' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant()) WITH CHECK (id = app_tenant())';
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())',
        t
      );
    END IF;
  END LOOP;
END $$;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_rw ON memberships
  USING (tenant_id = app_tenant() OR user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant());

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pass' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT EXECUTE ON FUNCTION app_tenant() TO app_user;
GRANT EXECUTE ON FUNCTION app_user_id() TO app_user;
