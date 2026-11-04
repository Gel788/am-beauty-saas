-- Many salons keep their own kassa and bank terminal, not connected to the CRM.
-- The desk records the payment by hand; the receipt number and the terminal's operation code are optional.
ALTER TABLE branches ADD COLUMN external_receipts boolean NOT NULL DEFAULT false;
ALTER TABLE payments
  ADD COLUMN external_receipt_no text CHECK (length(external_receipt_no) <= 40),
  ADD COLUMN terminal_ref text CHECK (length(terminal_ref) <= 40);
