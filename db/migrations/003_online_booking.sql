-- Phase 2: online booking (OB-*). Public page /b/{tenantSlug}/{branchSlug}.

ALTER TABLE tenants ADD COLUMN slug text;
UPDATE tenants SET slug = 'salon-' || left(id::text, 8) WHERE slug IS NULL;
ALTER TABLE tenants ALTER COLUMN slug SET NOT NULL;
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_key UNIQUE (slug);
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$');

ALTER TABLE branches
  ADD COLUMN slug text,
  ADD COLUMN online_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN online_step_min int NOT NULL DEFAULT 15 CHECK (online_step_min IN (5, 10, 15, 30)),
  ADD COLUMN online_min_notice_min int NOT NULL DEFAULT 60 CHECK (online_min_notice_min >= 0),
  ADD COLUMN online_max_advance_days int NOT NULL DEFAULT 30 CHECK (online_max_advance_days BETWEEN 1 AND 365),
  ADD COLUMN online_hold_min int NOT NULL DEFAULT 10 CHECK (online_hold_min BETWEEN 5 AND 10),
  ADD COLUMN online_cancel_hours int NOT NULL DEFAULT 24 CHECK (online_cancel_hours >= 0),
  ADD COLUMN online_max_active_per_phone int NOT NULL DEFAULT 3 CHECK (online_max_active_per_phone >= 1),
  ADD COLUMN online_accent text NOT NULL DEFAULT '#c2185b',
  ADD COLUMN online_logo_url text;
UPDATE branches SET slug = 'branch-' || left(id::text, 8) WHERE slug IS NULL;
ALTER TABLE branches ALTER COLUMN slug SET NOT NULL;
ALTER TABLE branches ADD CONSTRAINT branches_slug_unique UNIQUE (tenant_id, slug);
ALTER TABLE branches ADD CONSTRAINT branches_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$');

-- New rows without a slug get one from their id; the owner can rename it in settings.
CREATE OR REPLACE FUNCTION fill_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := (CASE WHEN TG_TABLE_NAME = 'tenants' THEN 'salon-' ELSE 'branch-' END) || left(NEW.id::text, 8);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_fill_slug BEFORE INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION fill_slug();
CREATE TRIGGER branches_fill_slug BEFORE INSERT ON branches FOR EACH ROW EXECUTE FUNCTION fill_slug();

-- OB-SLOT-02: a hold reserves the slot while the client fills in contacts.
CREATE TABLE slot_holds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ip text,
  appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
  idempotency_key text,
  result jsonb,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX slot_holds_staff_time ON slot_holds (staff_id, starts_at);
CREATE INDEX slot_holds_ip ON slot_holds (ip, created_at);

ALTER TABLE appointments ADD COLUMN cancel_token_hash text;
CREATE UNIQUE INDEX appointments_cancel_token ON appointments (cancel_token_hash) WHERE cancel_token_hash IS NOT NULL;

ALTER TABLE slot_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON slot_holds USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- The public side has no session, so it cannot see any tenant under RLS. These two lookups
-- are the only way in: they return ids only, and every later query runs under that tenant.
CREATE OR REPLACE FUNCTION public_branch_lookup(p_tenant_slug text, p_branch_slug text)
RETURNS TABLE (tenant_id uuid, branch_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.tenant_id, b.id
  FROM branches b JOIN tenants t ON t.id = b.tenant_id
  WHERE t.slug = p_tenant_slug AND b.slug = p_branch_slug AND b.online_enabled
$$;

CREATE OR REPLACE FUNCTION public_booking_lookup(p_token_hash text)
RETURNS TABLE (tenant_id uuid, appointment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.tenant_id, a.id FROM appointments a WHERE a.cancel_token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION public_branch_lookup(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_booking_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_branch_lookup(text, text) TO app_user;
GRANT EXECUTE ON FUNCTION public_booking_lookup(text) TO app_user;
