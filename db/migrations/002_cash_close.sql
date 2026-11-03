-- Phase 1b: shift close (SHIFT-CLOSE-*), refunds (PAY-REFUND-*), void (PAY-VOID-01).

-- One active shift per branch: a closing shift still blocks a new one.
DROP INDEX IF EXISTS one_open_shift_per_branch;
CREATE UNIQUE INDEX one_open_shift_per_branch
  ON cash_shifts (branch_id)
  WHERE status IN ('open', 'closing');

ALTER TABLE cash_shifts
  ADD COLUMN closing_started_by uuid,
  ADD COLUMN closing_started_at timestamptz,
  ADD COLUMN expected_cash_minor int,
  ADD COLUMN counted_cash_minor int CHECK (counted_cash_minor IS NULL OR counted_cash_minor >= 0),
  ADD COLUMN variance_minor int,
  ADD COLUMN variance_reason text,
  ADD COLUMN declared jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN totals jsonb,
  ADD COLUMN close_note text NOT NULL DEFAULT '';

CREATE INDEX cash_shifts_branch_opened ON cash_shifts (branch_id, opened_at DESC);

ALTER TABLE payments
  ADD COLUMN void_reason text,
  ADD COLUMN voided_by uuid,
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN refund_reason text;

CREATE INDEX payments_shift ON payments (shift_id);
CREATE INDEX payments_refund_of ON payments (refund_of_id) WHERE refund_of_id IS NOT NULL;
CREATE INDEX payments_appointment ON payments (appointment_id) WHERE appointment_id IS NOT NULL;

ALTER TABLE payment_lines
  ADD COLUMN refund_of_line_id uuid REFERENCES payment_lines (id);

ALTER TABLE branches
  ADD COLUMN shift_variance_threshold_minor int NOT NULL DEFAULT 0
    CHECK (shift_variance_threshold_minor >= 0);
