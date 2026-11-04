-- Self-service integrations (INT-*): the owner picks a provider and enters their own keys.
-- Public settings are plain JSON; secrets are AES-256-GCM sealed by the app (INTEGRATIONS_KEY).

CREATE TABLE tenant_integrations (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('telegram', 'sms', 'fiscal', 'acquiring')),
  enabled boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}',
  secrets text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ok', 'error')),
  status_text text NOT NULL DEFAULT '',
  checked_at timestamptz,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);
ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_integrations USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- Which bot the chat was linked through: the platform bot or the salon's own one.
ALTER TABLE telegram_links ADD COLUMN own_bot boolean NOT NULL DEFAULT false;
ALTER TABLE telegram_link_tokens ADD COLUMN own_bot boolean NOT NULL DEFAULT false;
