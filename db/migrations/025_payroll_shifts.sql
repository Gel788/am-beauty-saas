-- PAYROLL-SHIFT-*: pay per shift worked («за выход»), alone or together with a percent,
-- and the «percent, but not below the shift rate» guarantee.
ALTER TABLE payroll_rules DROP CONSTRAINT IF EXISTS payroll_rules_period_unit_check;
ALTER TABLE payroll_rules ADD CONSTRAINT payroll_rules_period_unit_check CHECK (period_unit IN ('month', 'biweekly', 'week', 'shift'));
ALTER TABLE payroll_rules ADD COLUMN guarantee boolean NOT NULL DEFAULT false;
