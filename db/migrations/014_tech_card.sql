-- Client tech card (CL-TECH-*): what the master must know before touching the client
-- (allergies, contraindications), the formulas that worked, before/after photos.

ALTER TABLE clients
  ADD COLUMN allergies text NOT NULL DEFAULT '' CHECK (length(allergies) <= 500),
  ADD COLUMN contraindications text NOT NULL DEFAULT '' CHECK (length(contraindications) <= 500),
  -- 152-ФЗ ст. 10: health data needs its own written consent; we record when it was given.
  ADD COLUMN health_consent_at timestamptz;

CREATE TABLE client_formulas (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
  staff_id uuid REFERENCES staff (id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('color', 'nails', 'lashes', 'brows', 'care', 'other')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX client_formulas_client ON client_formulas (client_id, created_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE client_formulas ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_formulas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_formulas USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- Photos live in the database for now (resized on the device to ≤1600 px, ≤1.5 MB);
-- moving them to object storage later only changes where `data` is read from.
CREATE TABLE client_photos (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
  staff_id uuid REFERENCES staff (id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('before', 'after', 'other')),
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 200),
  mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes int NOT NULL CHECK (size_bytes BETWEEN 1 AND 1572864),
  data bytea NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX client_photos_client ON client_photos (client_id, created_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE client_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_photos USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
