-- TEL-*: the salon's PBX tells the CRM about calls; the desk sees who is calling before picking up.
ALTER TABLE tenant_integrations DROP CONSTRAINT tenant_integrations_kind_check;
ALTER TABLE tenant_integrations ADD CONSTRAINT tenant_integrations_kind_check CHECK (kind IN ('telegram', 'sms', 'fiscal', 'acquiring', 'telephony'));

CREATE TABLE calls (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches (id) ON DELETE SET NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  direction text NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'out')),
  phone_e164 text,
  line text NOT NULL DEFAULT '',
  client_id uuid REFERENCES clients (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'answered', 'missed', 'ended')),
  started_at timestamptz NOT NULL,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec int,
  recording_url text,
  seen_by uuid,
  UNIQUE (tenant_id, provider, external_id)
);
CREATE INDEX calls_live ON calls (tenant_id, started_at DESC);
CREATE INDEX calls_client ON calls (client_id, started_at DESC) WHERE client_id IS NOT NULL;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON calls USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
