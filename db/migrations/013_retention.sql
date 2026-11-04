-- Stage 6: bringing clients back. Reviews after a visit (REV-*), waitlist with freed-slot offers,
-- no-show policy for online booking, rebook reminders and birthday greetings (consent-gated).

ALTER TABLE branches
  ADD COLUMN review_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN review_delay_hours int NOT NULL DEFAULT 2 CHECK (review_delay_hours BETWEEN 0 AND 72),
  ADD COLUMN review_moderation boolean NOT NULL DEFAULT true,
  -- online booking refuses a phone with this many no-shows in the last year; 0 = off
  ADD COLUMN noshow_block_after int NOT NULL DEFAULT 2 CHECK (noshow_block_after BETWEEN 0 AND 20),
  ADD COLUMN rebook_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN birthday_enabled boolean NOT NULL DEFAULT false;

-- "Come back in N days": nails 21, brows 28, haircut 35.
ALTER TABLE services ADD COLUMN rebook_days int CHECK (rebook_days IS NULL OR rebook_days BETWEEN 1 AND 365);

ALTER TABLE clients ADD COLUMN birthday_greeted_year int;

ALTER TABLE appointments
  ADD COLUMN review_token_hash text,
  ADD COLUMN review_requested_at timestamptz;
CREATE UNIQUE INDEX appointments_review_token ON appointments (review_token_hash) WHERE review_token_hash IS NOT NULL;

CREATE TABLE reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients (id) ON DELETE SET NULL,
  -- snapshot: the review stays with the master who did the work
  staff_id uuid REFERENCES staff (id) ON DELETE SET NULL,
  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  status text NOT NULL CHECK (status IN ('pending', 'published', 'hidden', 'rejected')),
  source text NOT NULL CHECK (source IN ('invite', 'widget', 'manual')),
  reject_reason text,
  reply text NOT NULL DEFAULT '' CHECK (length(reply) <= 2000),
  moderated_by uuid,
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviews_one_per_visit ON reviews (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX reviews_branch_created ON reviews (branch_id, created_at DESC);
CREATE INDEX reviews_staff_published ON reviews (staff_id) WHERE status = 'published';
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reviews USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  service_id uuid REFERENCES services (id) ON DELETE SET NULL,
  staff_id uuid REFERENCES staff (id) ON DELETE SET NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  -- minutes from local midnight; the client's window inside a day
  time_from_min int NOT NULL DEFAULT 0 CHECK (time_from_min BETWEEN 0 AND 1440),
  time_to_min int NOT NULL DEFAULT 1440 CHECK (time_to_min BETWEEN 0 AND 1440),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'booked', 'cancelled')),
  offers int NOT NULL DEFAULT 0,
  last_offered_at timestamptz,
  appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from),
  CHECK (time_to_min > time_from_min)
);
CREATE INDEX waitlist_active ON waitlist_entries (branch_id, date_from, date_to) WHERE status = 'active';
ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_entries USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE message_templates DROP CONSTRAINT message_templates_key_check;
ALTER TABLE message_templates ADD CONSTRAINT message_templates_key_check
  CHECK (key IN ('reminder', 'booking_created', 'booking_cancelled', 'pay_link', 'review_request', 'waitlist_offer', 'rebook', 'birthday'));

ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_kind_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_kind_check
  CHECK (kind IN ('reminder', 'manual', 'booking_created', 'booking_cancelled', 'pay_link', 'review_request', 'waitlist_offer', 'rebook', 'birthday'));
CREATE UNIQUE INDEX outbound_one_review ON outbound_messages (appointment_id) WHERE kind = 'review_request';

-- The retention job walks every salon that has something switched on.
CREATE OR REPLACE FUNCTION retention_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT b.tenant_id FROM branches b WHERE b.review_enabled OR b.rebook_enabled OR b.birthday_enabled
$$;

-- A review link carries only a token; this is the one door from it to a salon.
CREATE OR REPLACE FUNCTION public_review_lookup(p_token_hash text)
RETURNS TABLE (tenant_id uuid, appointment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.tenant_id, a.id FROM appointments a WHERE a.review_token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION retention_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public_review_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_tenants() TO app_user;
GRANT EXECUTE ON FUNCTION public_review_lookup(text) TO app_user;

-- Most salons want a rebook reminder on the services that clearly repeat.
UPDATE services SET rebook_days = 21 WHERE rebook_days IS NULL AND (title ILIKE '%маникюр%' OR title ILIKE '%педикюр%');
UPDATE services SET rebook_days = 28 WHERE rebook_days IS NULL AND (title ILIKE '%бров%' OR title ILIKE '%ресниц%');
UPDATE services SET rebook_days = 35 WHERE rebook_days IS NULL AND title ILIKE '%стрижк%';
