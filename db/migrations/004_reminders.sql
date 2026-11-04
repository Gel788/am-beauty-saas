-- Phase 2: automatic visit reminders (MSG-AUTO-01). Delivery channels plug in later; until then
-- the 'log' channel records what would have been sent.

ALTER TABLE branches
  ADD COLUMN reminder_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN reminder_hours int NOT NULL DEFAULT 24 CHECK (reminder_hours BETWEEN 1 AND 168),
  ADD COLUMN quiet_start_min int NOT NULL DEFAULT 1320 CHECK (quiet_start_min BETWEEN 0 AND 1439),
  ADD COLUMN quiet_end_min int NOT NULL DEFAULT 540 CHECK (quiet_end_min BETWEEN 0 AND 1439);

ALTER TABLE tenants
  ADD COLUMN message_channels text[] NOT NULL DEFAULT ARRAY['log'];

CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments (id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients (id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('reminder')),
  channel text NOT NULL,
  recipient text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('delivered', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One reminder per appointment: the job can run as often as it likes.
CREATE UNIQUE INDEX outbound_one_reminder ON outbound_messages (appointment_id) WHERE kind = 'reminder';
CREATE INDEX outbound_branch_created ON outbound_messages (branch_id, created_at DESC);

ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbound_messages USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- The job walks every salon; under RLS it can only learn which tenants exist through this.
CREATE OR REPLACE FUNCTION reminder_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT b.tenant_id FROM branches b WHERE b.reminder_enabled
$$;
REVOKE ALL ON FUNCTION reminder_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reminder_tenants() TO app_user;
