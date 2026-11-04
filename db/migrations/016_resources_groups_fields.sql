-- TZ §10 resources (RES-*), §11 group events (GRP-*), §12 custom fields (CF-*).

-- ---------------------------------------------------------------- Resources
CREATE TABLE resources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'room' CHECK (kind IN ('room', 'equipment', 'other')),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  color text NOT NULL DEFAULT '#e9e2ff',
  capacity int NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  -- RES-SCHEDULE-01: when the room is available; null = always.
  open_min int CHECK (open_min BETWEEN 0 AND 1440),
  close_min int CHECK (close_min BETWEEN 0 AND 1440),
  active boolean NOT NULL DEFAULT true,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resources_branch ON resources (branch_id);

CREATE TABLE service_resources (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, resource_id)
);

CREATE TABLE appointment_resources (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources (id),
  PRIMARY KEY (appointment_id, resource_id)
);
CREATE INDEX appointment_resources_resource ON appointment_resources (resource_id);

-- ---------------------------------------------------------------- Group events
CREATE TABLE group_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text NOT NULL DEFAULT '',
  staff_id uuid REFERENCES staff (id),
  resource_id uuid REFERENCES resources (id),
  service_id uuid REFERENCES services (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  capacity int NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  price_minor bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  online_visible boolean NOT NULL DEFAULT true,
  color text NOT NULL DEFAULT '#ffe3ef',
  series_id uuid,
  cancel_reason text,
  reminded_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_events_branch_time ON group_events (branch_id, starts_at);

CREATE TABLE group_participants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES group_events (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id),
  status text NOT NULL CHECK (status IN ('enrolled', 'waitlisted', 'arrived', 'no_show', 'cancelled')),
  source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'online')),
  payment_id uuid REFERENCES payments (id),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- GRP-ENROLL-01: one live seat per client per event.
CREATE UNIQUE INDEX group_participants_once ON group_participants (event_id, client_id) WHERE status <> 'cancelled';
CREATE INDEX group_participants_client ON group_participants (client_id);

-- ---------------------------------------------------------------- Custom fields
CREATE TABLE custom_fields (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity IN ('client', 'appointment')),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (length(trim(label)) > 0),
  type text NOT NULL CHECK (type IN ('text', 'textarea', 'number', 'select', 'multiselect', 'date', 'bool')),
  options text[] NOT NULL DEFAULT '{}',
  required boolean NOT NULL DEFAULT false,
  show_in_online boolean NOT NULL DEFAULT false,
  show_in_journal boolean NOT NULL DEFAULT false,
  position int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, key)
);
ALTER TABLE clients ADD COLUMN custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE appointments ADD COLUMN custom jsonb NOT NULL DEFAULT '{}';

-- Messages and payments for groups.
ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_kind_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_kind_check CHECK (kind IN (
  'reminder', 'manual', 'booking_created', 'booking_cancelled', 'pay_link', 'review_request', 'waitlist_offer', 'rebook', 'birthday',
  'group_enrolled', 'group_reminder', 'group_cancelled', 'group_seat'));
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_key_check;
ALTER TABLE message_templates ADD CONSTRAINT message_templates_key_check CHECK (key IN (
  'reminder', 'booking_created', 'booking_cancelled', 'pay_link', 'review_request', 'waitlist_offer', 'rebook', 'birthday',
  'group_enrolled', 'group_reminder', 'group_cancelled', 'group_seat'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resources', 'service_resources', 'appointment_resources', 'group_events', 'group_participants', 'custom_fields'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;
