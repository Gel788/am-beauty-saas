-- Phase 4 · PLAT-*: subscription of the salon to the platform (trial, plans, seats, invoices, platform admin).

ALTER TABLE tenants
  ADD COLUMN plan text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'start', 'salon', 'network')),
  ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  ADD COLUMN paid_until timestamptz,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_reason text NOT NULL DEFAULT '';
-- Salons that already work get a month to choose a plan.
UPDATE tenants SET trial_ends_at = now() + interval '30 days';

-- Plan limits live here so the database refuses an extra master or branch whatever code path inserts it.
CREATE OR REPLACE FUNCTION plan_limits(p text, OUT staff_limit int, OUT branch_limit int) LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'start' THEN 3 WHEN 'salon' THEN 10 ELSE 50 END,
         CASE p WHEN 'start' THEN 1 WHEN 'salon' THEN 2 ELSE 10 END
$$;

CREATE OR REPLACE FUNCTION enforce_plan_limits() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  tenant_plan text;
  lim record;
  used int;
BEGIN
  SELECT plan INTO tenant_plan FROM tenants WHERE id = NEW.tenant_id;
  IF tenant_plan IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO lim FROM plan_limits(tenant_plan);
  IF TG_TABLE_NAME = 'staff' THEN
    IF NOT NEW.active OR (TG_OP = 'UPDATE' AND OLD.active) THEN RETURN NEW; END IF;
    SELECT count(*) INTO used FROM staff WHERE tenant_id = NEW.tenant_id AND active AND id <> NEW.id;
    IF used >= lim.staff_limit THEN
      RAISE EXCEPTION 'PLAN_LIMIT:staff:%', lim.staff_limit USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT count(*) INTO used FROM branches WHERE tenant_id = NEW.tenant_id AND id <> NEW.id;
    IF used >= lim.branch_limit THEN
      RAISE EXCEPTION 'PLAN_LIMIT:branches:%', lim.branch_limit USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_plan_limit BEFORE INSERT OR UPDATE OF active ON staff FOR EACH ROW EXECUTE FUNCTION enforce_plan_limits();
CREATE TRIGGER branches_plan_limit BEFORE INSERT ON branches FOR EACH ROW EXECUTE FUNCTION enforce_plan_limits();

-- Invoices for the subscription. Paid through the platform's own ЮKassa shop (or the sandbox).
CREATE TABLE saas_invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number int NOT NULL,
  plan text NOT NULL CHECK (plan IN ('start', 'salon', 'network')),
  months int NOT NULL CHECK (months IN (1, 6, 12)),
  amount_minor int NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled')),
  provider text NOT NULL,
  external_id text,
  confirmation_url text,
  period_from timestamptz,
  period_to timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (tenant_id, number)
);
CREATE INDEX saas_invoices_external ON saas_invoices (external_id) WHERE external_id IS NOT NULL;
ALTER TABLE saas_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saas_invoices USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- The billing webhook knows only the provider's payment id: this is the one door to the tenant.
CREATE OR REPLACE FUNCTION saas_invoice_lookup(p_external text) RETURNS TABLE (tenant_id uuid, invoice_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id, id FROM saas_invoices WHERE external_id = p_external LIMIT 1
$$;

-- PLAT-SUPER-01: the platform team (PLATFORM_ADMIN_EMAILS) sees every salon and can extend or suspend it.
CREATE OR REPLACE FUNCTION platform_tenants() RETURNS TABLE (
  id uuid, name text, slug text, plan text, trial_ends_at timestamptz, paid_until timestamptz,
  suspended_at timestamptz, suspended_reason text, created_at timestamptz,
  owner_email text, staff_active int, branches int, appointments_30d int, last_activity timestamptz, paid_total_minor bigint
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name, t.slug, t.plan, t.trial_ends_at, t.paid_until, t.suspended_at, t.suspended_reason, t.created_at,
         (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1),
         (SELECT count(*)::int FROM staff s WHERE s.tenant_id = t.id AND s.active),
         (SELECT count(*)::int FROM branches b WHERE b.tenant_id = t.id),
         (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = t.id AND a.created_at > now() - interval '30 days'),
         (SELECT max(a.created_at) FROM audit_log a WHERE a.tenant_id = t.id),
         (SELECT COALESCE(sum(i.amount_minor), 0)::bigint FROM saas_invoices i WHERE i.tenant_id = t.id AND i.status = 'paid')
  FROM tenants t ORDER BY t.created_at DESC
$$;

CREATE OR REPLACE FUNCTION platform_update_tenant(p_id uuid, p_plan text, p_trial_ends_at timestamptz, p_paid_until timestamptz, p_suspended boolean, p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE tenants SET
    plan = COALESCE(p_plan, plan),
    trial_ends_at = COALESCE(p_trial_ends_at, trial_ends_at),
    paid_until = COALESCE(p_paid_until, paid_until),
    suspended_at = CASE WHEN p_suspended IS NULL THEN suspended_at WHEN p_suspended THEN COALESCE(suspended_at, now()) ELSE NULL END,
    suspended_reason = CASE WHEN p_suspended IS NULL THEN suspended_reason WHEN p_suspended THEN COALESCE(p_reason, '') ELSE '' END
  WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION saas_invoice_lookup(text), platform_tenants(), platform_update_tenant(uuid, text, timestamptz, timestamptz, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas_invoice_lookup(text), platform_tenants(), platform_update_tenant(uuid, text, timestamptz, timestamptz, boolean, text), plan_limits(text) TO app_user;
