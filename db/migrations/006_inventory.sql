-- Phase 3: inventory (INV-*).

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  sku text NOT NULL,
  title text NOT NULL,
  unit text NOT NULL DEFAULT 'pcs' CHECK (unit IN ('pcs', 'ml', 'g', 'pack')),
  track_stock boolean NOT NULL DEFAULT true,
  -- Cost and price per one unit.
  cost_minor int NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  sell_price_minor int NOT NULL DEFAULT 0 CHECK (sell_price_minor >= 0),
  for_sale boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_items_sku_unique UNIQUE (tenant_id, sku),
  CHECK (length(trim(sku)) > 0 AND length(trim(title)) > 0)
);

CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  qty numeric(14, 3) NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, branch_id)
);

CREATE TABLE inventory_counts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'cancelled')),
  note text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_by uuid,
  applied_at timestamptz
);
-- One open count per branch, so two people do not adjust the same stock twice.
CREATE UNIQUE INDEX inventory_counts_one_open ON inventory_counts (branch_id) WHERE status = 'open';

CREATE TABLE inventory_count_lines (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  count_id uuid NOT NULL REFERENCES inventory_counts (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items (id) ON DELETE CASCADE,
  expected_qty numeric(14, 3) NOT NULL,
  counted_qty numeric(14, 3) CHECK (counted_qty IS NULL OR counted_qty >= 0),
  cost_minor int NOT NULL DEFAULT 0,
  PRIMARY KEY (count_id, item_id)
);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items (id),
  type text NOT NULL CHECK (type IN ('receipt', 'write_off', 'sale', 'consume', 'transfer', 'inventory_adjust')),
  -- Signed: + into the branch, − out of it.
  qty numeric(14, 3) NOT NULL CHECK (qty <> 0),
  cost_minor int NOT NULL DEFAULT 0,
  -- The movement left the balance below zero (allowed only by policy, never silently).
  negative boolean NOT NULL DEFAULT false,
  appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
  appointment_service_id uuid,
  payment_id uuid REFERENCES payments (id) ON DELETE SET NULL,
  payment_line_id uuid,
  transfer_id uuid,
  count_id uuid REFERENCES inventory_counts (id) ON DELETE SET NULL,
  reverses_id uuid REFERENCES stock_movements (id),
  supplier text,
  document text,
  reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_branch_created ON stock_movements (branch_id, created_at DESC);
CREATE INDEX stock_movements_service ON stock_movements (appointment_service_id) WHERE appointment_service_id IS NOT NULL;
-- A movement is reversed at most once.
CREATE UNIQUE INDEX stock_movements_reversed_once ON stock_movements (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE service_consumables (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items (id) ON DELETE CASCADE,
  qty_per_service numeric(14, 3) NOT NULL CHECK (qty_per_service > 0),
  PRIMARY KEY (service_id, item_id)
);

ALTER TABLE branches
  ADD COLUMN consume_policy text NOT NULL DEFAULT 'warn' CHECK (consume_policy IN ('warn', 'block')),
  ADD COLUMN allow_negative_stock boolean NOT NULL DEFAULT false;

-- Product lines in the till name the item and how many were sold.
ALTER TABLE payment_lines
  ADD COLUMN item_id uuid REFERENCES inventory_items (id),
  ADD COLUMN qty numeric(14, 3);

-- PAYROLL-SCHEME-05: base minus the cost of materials consumed on the visit.
ALTER TABLE payroll_rules
  ADD COLUMN deduct_materials boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_items', 'stock_balances', 'inventory_counts', 'inventory_count_lines', 'stock_movements', 'service_consumables'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;
