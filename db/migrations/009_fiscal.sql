-- Stage 2: 54-ФЗ receipts and online payments (card / SBP), provider-agnostic.
-- A provider is a code adapter; 'test' simulates one end to end so the flow works without contracts.

ALTER TABLE branches
  ADD COLUMN fiscal_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN fiscal_provider text NOT NULL DEFAULT 'test',
  ADD COLUMN fiscal_inn text NOT NULL DEFAULT '',
  ADD COLUMN fiscal_taxation text NOT NULL DEFAULT 'usn_income'
    CHECK (fiscal_taxation IN ('osn', 'usn_income', 'usn_income_outcome', 'esn', 'patent')),
  ADD COLUMN fiscal_vat text NOT NULL DEFAULT 'none'
    CHECK (fiscal_vat IN ('none', 'vat0', 'vat5', 'vat7', 'vat10', 'vat20')),
  ADD COLUMN fiscal_place text NOT NULL DEFAULT '',
  ADD COLUMN acquiring_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN acquiring_provider text NOT NULL DEFAULT 'test',
  ADD COLUMN acquiring_link_hours int NOT NULL DEFAULT 24 CHECK (acquiring_link_hours BETWEEN 1 AND 168);

CREATE TABLE fiscal_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  -- sell = приход, sell_refund = возврат прихода
  kind text NOT NULL CHECK (kind IN ('sell', 'sell_refund')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'done', 'failed', 'canceled')),
  provider text NOT NULL,
  -- the document as it goes to the provider: items, payments, taxation, customer
  document jsonb NOT NULL,
  total_minor int NOT NULL,
  external_id text,
  fn_number text,
  fd_number text,
  fiscal_sign text,
  registered_at timestamptz,
  ofd_url text,
  error text,
  attempts int NOT NULL DEFAULT 0,
  next_try_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, kind)
);
CREATE INDEX fiscal_receipts_queue ON fiscal_receipts (status, next_try_at) WHERE status IN ('pending', 'sent');
CREATE INDEX fiscal_receipts_branch ON fiscal_receipts (branch_id, created_at DESC);

CREATE TABLE online_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  appointment_id uuid REFERENCES appointments(id),
  client_id uuid REFERENCES clients(id),
  purpose text NOT NULL CHECK (purpose IN ('deposit', 'visit')),
  amount_minor int NOT NULL CHECK (amount_minor > 0),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'succeeded', 'canceled', 'expired')),
  provider text NOT NULL,
  external_id text,
  confirmation_url text,
  method text CHECK (method IN ('card', 'sbp')),
  token_hash text NOT NULL UNIQUE,
  payment_id uuid REFERENCES payments(id),
  error text,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX online_payments_appointment ON online_payments (appointment_id);
CREATE UNIQUE INDEX online_payments_external ON online_payments (provider, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE fiscal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_receipts USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE online_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON online_payments USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- Public pay page: the link token picks the tenant, like the booking cancel token.
CREATE OR REPLACE FUNCTION public_pay_lookup(p_token_hash text)
RETURNS TABLE (tenant_id uuid, online_payment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.tenant_id, o.id FROM online_payments o WHERE o.token_hash = p_token_hash
$$;
-- Provider webhooks carry only the provider's payment id.
CREATE OR REPLACE FUNCTION acquiring_lookup(p_provider text, p_external_id text)
RETURNS TABLE (tenant_id uuid, online_payment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.tenant_id, o.id FROM online_payments o WHERE o.provider = p_provider AND o.external_id = p_external_id
$$;
-- Cron walks tenants that have receipts waiting.
CREATE OR REPLACE FUNCTION fiscal_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT r.tenant_id FROM fiscal_receipts r WHERE r.status IN ('pending', 'sent') AND r.next_try_at <= now()
$$;
REVOKE ALL ON FUNCTION public_pay_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION acquiring_lookup(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fiscal_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_pay_lookup(text) TO app_user;
GRANT EXECUTE ON FUNCTION acquiring_lookup(text, text) TO app_user;
GRANT EXECUTE ON FUNCTION fiscal_tenants() TO app_user;
