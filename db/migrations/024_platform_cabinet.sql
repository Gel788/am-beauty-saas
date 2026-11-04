-- Phase 4 · PLAT-CABINET-*: the platform owner's cabinet. Subscriptions, payments, events,
-- per-salon usage and a to-do list for the platform team.
-- Platform tables are closed to app_user by RLS (policy USING false); the only doors are the
-- SECURITY DEFINER functions below, and the app calls them only for PLATFORM_ADMIN_EMAILS.

CREATE TABLE platform_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  due_on date,
  done_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_tasks_open ON platform_tasks (done_at, due_on);

CREATE TABLE platform_actions (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
  actor_email text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_actions_time ON platform_actions (created_at DESC);

ALTER TABLE platform_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY closed ON platform_tasks USING (false) WITH CHECK (false);
ALTER TABLE platform_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY closed ON platform_actions USING (false) WITH CHECK (false);

-- Every invoice of every salon.
CREATE OR REPLACE FUNCTION platform_invoices() RETURNS TABLE (
  id uuid, tenant_id uuid, tenant_name text, number int, plan text, months int, amount_minor int,
  status text, provider text, created_at timestamptz, paid_at timestamptz, period_to timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.tenant_id, t.name, i.number, i.plan, i.months, i.amount_minor, i.status, i.provider, i.created_at, i.paid_at, i.period_to
  FROM saas_invoices i JOIN tenants t ON t.id = i.tenant_id
  ORDER BY i.created_at DESC
  LIMIT 1000
$$;

-- What a salon does in the product: enough to see who is alive and who is about to leave.
CREATE OR REPLACE FUNCTION platform_tenant_usage(p_id uuid) RETURNS TABLE (
  clients int, appointments_total int, appointments_7d int, online_30d int,
  revenue_30d_minor bigint, users int, branch_names text[],
  months text[], month_appointments int[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH m AS (
    SELECT to_char(d, 'YYYY-MM') AS ym FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') d
  ), per AS (
    SELECT m.ym, (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = p_id AND to_char(a.starts_at, 'YYYY-MM') = m.ym) AS n FROM m
  )
  SELECT
    (SELECT count(*)::int FROM clients c WHERE c.tenant_id = p_id),
    (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = p_id),
    (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = p_id AND a.created_at > now() - interval '7 days'),
    (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = p_id AND a.source = 'online' AND a.created_at > now() - interval '30 days'),
    (SELECT COALESCE(sum(CASE WHEN p.direction = 'in' THEN p.total_minor ELSE -p.total_minor END), 0)::bigint FROM payments p WHERE p.tenant_id = p_id AND p.status = 'posted' AND p.posted_at > now() - interval '30 days'),
    (SELECT count(*)::int FROM memberships mm WHERE mm.tenant_id = p_id),
    (SELECT COALESCE(array_agg(b.name ORDER BY b.created_at, b.id), '{}') FROM branches b WHERE b.tenant_id = p_id),
    (SELECT array_agg(ym ORDER BY ym) FROM per),
    (SELECT array_agg(n ORDER BY ym) FROM per)
$$;

-- One feed of what happened on the platform: sign-ups, invoices, payments, suspensions, team actions.
CREATE OR REPLACE FUNCTION platform_events(p_limit int) RETURNS TABLE (
  at timestamptz, kind text, tenant_id uuid, tenant_name text, text text, amount_minor bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM (
    SELECT t.created_at, 'signup', t.id, t.name, 'Новый салон', NULL::bigint FROM tenants t
    UNION ALL
    SELECT i.created_at, 'invoice', i.tenant_id, t.name, 'Счёт №' || i.number || ' · ' || i.plan || ' на ' || i.months || ' мес.', i.amount_minor::bigint
      FROM saas_invoices i JOIN tenants t ON t.id = i.tenant_id
    UNION ALL
    SELECT i.paid_at, 'paid', i.tenant_id, t.name, 'Оплачен счёт №' || i.number, i.amount_minor::bigint
      FROM saas_invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.status = 'paid' AND i.paid_at IS NOT NULL
    UNION ALL
    SELECT t.suspended_at, 'suspended', t.id, t.name, 'Приостановлен' || CASE WHEN t.suspended_reason <> '' THEN ': ' || t.suspended_reason ELSE '' END, NULL
      FROM tenants t WHERE t.suspended_at IS NOT NULL
    UNION ALL
    SELECT a.created_at, 'action', a.tenant_id, t.name, a.action, NULL
      FROM platform_actions a LEFT JOIN tenants t ON t.id = a.tenant_id
  ) e (at, kind, tenant_id, tenant_name, text, amount_minor)
  ORDER BY at DESC
  LIMIT greatest(1, least(p_limit, 500))
$$;

CREATE OR REPLACE FUNCTION platform_log(p_tenant uuid, p_email text, p_action text, p_details jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO platform_actions (id, tenant_id, actor_email, action, details) VALUES (gen_random_uuid(), p_tenant, p_email, p_action, COALESCE(p_details, '{}'::jsonb))
$$;

CREATE OR REPLACE FUNCTION platform_tasks_list() RETURNS TABLE (
  id uuid, tenant_id uuid, tenant_name text, title text, note text, due_on date, done_at timestamptz, created_by text, created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT k.id, k.tenant_id, t.name, k.title, k.note, k.due_on, k.done_at, k.created_by, k.created_at
  FROM platform_tasks k LEFT JOIN tenants t ON t.id = k.tenant_id
  WHERE k.done_at IS NULL OR k.done_at > now() - interval '30 days'
  ORDER BY (k.done_at IS NOT NULL), k.due_on NULLS LAST, k.created_at DESC
  LIMIT 500
$$;

CREATE OR REPLACE FUNCTION platform_task_create(p_id uuid, p_tenant uuid, p_title text, p_note text, p_due date, p_by text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO platform_tasks (id, tenant_id, title, note, due_on, created_by) VALUES (p_id, p_tenant, p_title, COALESCE(p_note, ''), p_due, p_by)
$$;

CREATE OR REPLACE FUNCTION platform_task_set_done(p_id uuid, p_done boolean) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (UPDATE platform_tasks SET done_at = CASE WHEN p_done THEN COALESCE(done_at, now()) ELSE NULL END WHERE id = p_id RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

CREATE OR REPLACE FUNCTION platform_task_delete(p_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (DELETE FROM platform_tasks WHERE id = p_id RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM d)
$$;

REVOKE ALL ON FUNCTION platform_invoices(), platform_tenant_usage(uuid), platform_events(int), platform_log(uuid, text, text, jsonb),
  platform_tasks_list(), platform_task_create(uuid, uuid, text, text, date, text), platform_task_set_done(uuid, boolean), platform_task_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_invoices(), platform_tenant_usage(uuid), platform_events(int), platform_log(uuid, text, text, jsonb),
  platform_tasks_list(), platform_task_create(uuid, uuid, text, text, date, text), platform_task_set_done(uuid, boolean), platform_task_delete(uuid) TO app_user;
