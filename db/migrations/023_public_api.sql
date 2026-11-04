-- Phase 4 · API-*: keys for the salon's own integrations (site, 1С, Zapier…) and outgoing webhooks.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('read', 'write')),
  branch_id uuid REFERENCES branches (id) ON DELETE CASCADE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- A request knows only its key: this is the one door from the key hash to the tenant.
CREATE OR REPLACE FUNCTION api_key_lookup(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, name text, scope text, branch_id uuid, created_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, name, scope, branch_id, created_by FROM api_keys WHERE key_hash = p_hash AND revoked_at IS NULL
$$;

CREATE TABLE api_webhooks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  url text NOT NULL CHECK (url ~ '^https?://'),
  events text[] NOT NULL,
  sealed_secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_status int,
  last_error text,
  last_delivery_at timestamptz,
  failures int NOT NULL DEFAULT 0
);
ALTER TABLE api_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_webhooks USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES api_webhooks (id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  response_status int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_at) WHERE status = 'pending';
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

CREATE OR REPLACE FUNCTION webhook_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT tenant_id FROM webhook_deliveries WHERE status = 'pending' AND next_at <= now()
$$;

REVOKE ALL ON FUNCTION api_key_lookup(text), webhook_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_lookup(text), webhook_tenants() TO app_user;
