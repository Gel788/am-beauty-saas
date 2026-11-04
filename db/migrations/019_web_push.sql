-- PWA-PUSH-01: push notifications to the staff app installed on a phone or desktop.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failures int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, endpoint)
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (tenant_id, user_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_subscriptions USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- Platform-wide keys the app makes for itself (the VAPID pair when not given in env). Secrets sealed by the app.
CREATE TABLE platform_keys (
  name text PRIMARY KEY,
  public_value text NOT NULL,
  sealed_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
