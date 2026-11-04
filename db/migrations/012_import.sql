-- Stage 4: moving a salon in. Client import from a spreadsheet (CL-IMPORT-01) and duplicate merge (CL-MERGE-01).

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  file_name text NOT NULL DEFAULT '',
  mapping jsonb NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'undone')),
  stats jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX import_jobs_tenant ON import_jobs (tenant_id, created_at DESC);
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_jobs USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE clients
  -- which import created the card (for undo)
  ADD COLUMN import_job_id uuid REFERENCES import_jobs (id) ON DELETE SET NULL,
  -- history from the previous system, so retention and the card see the real picture
  ADD COLUMN imported_visits int NOT NULL DEFAULT 0 CHECK (imported_visits >= 0),
  ADD COLUMN imported_last_visit date,
  ADD COLUMN imported_revenue_minor bigint NOT NULL DEFAULT 0;
CREATE INDEX clients_import_job ON clients (import_job_id) WHERE import_job_id IS NOT NULL;
CREATE INDEX clients_merged_into ON clients (merged_into_id) WHERE merged_into_id IS NOT NULL;

-- Pairs the owner said are different people, so they stop showing as duplicates.
CREATE TABLE client_not_duplicates (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_a uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  client_b uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_a, client_b),
  CHECK (client_a < client_b)
);
ALTER TABLE client_not_duplicates ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_not_duplicates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_not_duplicates USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
