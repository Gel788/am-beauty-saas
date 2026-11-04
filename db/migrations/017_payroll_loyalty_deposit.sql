-- Stage: online-booking deposit (OB-PAY-01), bonus expiry and tiers (LOY-BONUS-EXPIRE-01, LOY-TIER-01),
-- group host pay (GRP-COMPLETE-01).

-- OB-PAY-01: share of the price the client pays online to confirm; 0 = no deposit.
ALTER TABLE branches ADD COLUMN online_deposit_bps int NOT NULL DEFAULT 0 CHECK (online_deposit_bps BETWEEN 0 AND 10000);
ALTER TABLE branches ADD COLUMN online_deposit_minutes int NOT NULL DEFAULT 30 CHECK (online_deposit_minutes BETWEEN 10 AND 1440);
-- Per-service override in minor units; null = branch share applies, 0 = never for this service.
ALTER TABLE services ADD COLUMN online_deposit_minor int CHECK (online_deposit_minor >= 0);
-- A booking that waits for its deposit; past this moment unpaid bookings are cancelled and the slot frees up.
ALTER TABLE appointments ADD COLUMN deposit_due_at timestamptz;
CREATE INDEX appointments_deposit_due ON appointments (deposit_due_at) WHERE deposit_due_at IS NOT NULL;

-- LOY-BONUS-EXPIRE-01: points expire N days after they were earned (FIFO); 0 = never.
ALTER TABLE tenants ADD COLUMN bonus_expire_days int NOT NULL DEFAULT 0 CHECK (bonus_expire_days BETWEEN 0 AND 3650);
-- LOY-TIER-01: [{title, minSpendMinor, earnBps}], the highest reached tier sets the earn rate.
ALTER TABLE tenants ADD COLUMN loyalty_tiers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bonus_ledger DROP CONSTRAINT IF EXISTS bonus_ledger_kind_check;
ALTER TABLE bonus_ledger ADD CONSTRAINT bonus_ledger_kind_check CHECK (kind IN ('earn', 'burn', 'clawback', 'burn_refund', 'manual', 'expire'));

-- GRP-COMPLETE-01: what the host earns for a held class.
ALTER TABLE group_events ADD COLUMN host_pay_mode text NOT NULL DEFAULT 'none' CHECK (host_pay_mode IN ('none', 'per_attendee', 'flat', 'percent'));
ALTER TABLE group_events ADD COLUMN host_pay_minor int NOT NULL DEFAULT 0 CHECK (host_pay_minor >= 0);
ALTER TABLE group_events ADD COLUMN host_pay_bps int NOT NULL DEFAULT 0 CHECK (host_pay_bps BETWEEN 0 AND 10000);
ALTER TABLE group_events ADD COLUMN completed_at timestamptz;
ALTER TABLE payroll_lines DROP CONSTRAINT IF EXISTS payroll_lines_type_check;
ALTER TABLE payroll_lines ADD CONSTRAINT payroll_lines_type_check CHECK (type IN ('service', 'salary', 'tip', 'bonus', 'penalty', 'adjustment', 'refund_clawback', 'group'));
ALTER TABLE payroll_lines ADD COLUMN group_event_id uuid REFERENCES group_events (id) ON DELETE SET NULL;

-- The minute job also visits tenants with deposits to cancel and points to expire.
CREATE OR REPLACE FUNCTION reminder_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.tenant_id FROM branches b WHERE b.reminder_enabled
  UNION SELECT t.id FROM tenants t WHERE t.bonus_expire_days > 0
  UNION SELECT a.tenant_id FROM appointments a WHERE a.deposit_due_at IS NOT NULL
$$;
