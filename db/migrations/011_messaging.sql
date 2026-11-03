-- Stage 3: messaging. Telegram bot and SMS as channels, editable templates, manual messages,
-- confirm-by-link / by Telegram button, in-app notifications for the desk, 152-ФЗ consents.

-- 152-ФЗ: consent to process personal data; 38-ФЗ: separate consent to marketing messages.
ALTER TABLE clients
  ADD COLUMN consent_pd_at timestamptz,
  ADD COLUMN consent_pd_source text,
  ADD COLUMN consent_marketing boolean NOT NULL DEFAULT false,
  ADD COLUMN consent_marketing_at timestamptz;

-- Operator details for the privacy policy page and the consent text.
ALTER TABLE tenants
  ADD COLUMN legal_name text NOT NULL DEFAULT '',
  ADD COLUMN legal_inn text NOT NULL DEFAULT '',
  ADD COLUMN privacy_email text NOT NULL DEFAULT '';

ALTER TABLE branches
  ADD COLUMN booking_message_enabled boolean NOT NULL DEFAULT true;

-- One platform bot; a chat is linked to a client (or a staff user) through a one-time /start token.
CREATE TABLE telegram_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients (id) ON DELETE CASCADE,
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  username text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((client_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX telegram_links_client ON telegram_links (tenant_id, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX telegram_links_user ON telegram_links (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX telegram_links_chat ON telegram_links (chat_id);

CREATE TABLE telegram_link_tokens (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients (id) ON DELETE CASCADE,
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_templates (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('reminder', 'booking_created', 'booking_cancelled', 'pay_link')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_kind_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_kind_check
  CHECK (kind IN ('reminder', 'manual', 'booking_created', 'booking_cancelled', 'pay_link'));
ALTER TABLE outbound_messages ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE outbound_messages ADD COLUMN created_by uuid;
CREATE INDEX outbound_client_created ON outbound_messages (client_id, created_at DESC);

-- What the desk must see: new online booking, client confirmed / cancelled, money arrived, problems.
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches (id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  entity text,
  entity_id uuid,
  read_at timestamptz,
  read_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread ON notifications (tenant_id, created_at DESC) WHERE read_at IS NULL;

ALTER TABLE appointments
  ADD COLUMN confirmed_via text,
  -- the reminder carries its own manage link; the online-booking link keeps working
  ADD COLUMN reminder_token_hash text;
CREATE INDEX appointments_reminder_token ON appointments (reminder_token_hash) WHERE reminder_token_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public_booking_lookup(p_token_hash text)
RETURNS TABLE (tenant_id uuid, appointment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.tenant_id, a.id FROM appointments a WHERE a.cancel_token_hash = p_token_hash OR a.reminder_token_hash = p_token_hash
$$;

ALTER TABLE telegram_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telegram_links USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE telegram_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_link_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telegram_link_tokens USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_templates USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- The bot only knows the token from /start, or the chat id; these find the tenant.
CREATE OR REPLACE FUNCTION telegram_token_lookup(p_token_hash text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.tenant_id FROM telegram_link_tokens t WHERE t.token_hash = p_token_hash
$$;
CREATE OR REPLACE FUNCTION telegram_chat_lookup(p_chat_id text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT l.tenant_id FROM telegram_links l WHERE l.chat_id = p_chat_id
$$;
REVOKE ALL ON FUNCTION telegram_token_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION telegram_chat_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telegram_token_lookup(text) TO app_user;
GRANT EXECUTE ON FUNCTION telegram_chat_lookup(text) TO app_user;
