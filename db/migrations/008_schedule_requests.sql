-- Phase 2 SCH: a master asks to change their own schedule, an admin decides (03 §4 "request-only").
CREATE TABLE schedule_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('template', 'exception')),
  payload jsonb NOT NULL,
  comment text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_requests_open ON schedule_requests (branch_id, status, created_at DESC);

ALTER TABLE schedule_exceptions ADD COLUMN note text NOT NULL DEFAULT '';

ALTER TABLE schedule_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedule_requests USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
