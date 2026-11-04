import { AppError } from "@/domain/errors";
import { loadBranch } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import type { Ctx } from "./types";

type Unit = "pcs" | "ml" | "g" | "pack";
type MovementType = "receipt" | "write_off" | "sale" | "consume" | "transfer" | "inventory_adjust";

type ItemRow = {
  id: string;
  sku: string;
  title: string;
  unit: Unit;
  track_stock: boolean;
  cost_minor: number;
  sell_price_minor: number;
  for_sale: boolean;
  active: boolean;
  min_qty: string | number;
};

const WRITE_ROLES = ["owner", "admin", "accountant", "super"];
const READ_ROLES = [...WRITE_ROLES, "master"];
export const UNITS: Record<Unit, string> = { pcs: "шт", ml: "мл", g: "г", pack: "уп" };

function assertWrite(ctx: Ctx) {
  if (!WRITE_ROLES.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Склад ведут владелец, администратор или бухгалтер");
}

function assertRead(ctx: Ctx) {
  if (!READ_ROLES.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Недостаточно прав");
}

/** Quantities are decimals with up to three places (ml, g); they travel as strings to keep numeric exact. */
export function parseQty(value: unknown, label = "Количество"): number {
  const n = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new AppError("VALIDATION", `${label}: больше нуля`);
  const rounded = Math.round(n * 1000) / 1000;
  if (Math.abs(rounded - n) > 1e-9) throw new AppError("VALIDATION", `${label}: не больше трёх знаков после запятой`);
  if (rounded > 1_000_000) throw new AppError("VALIDATION", `${label}: слишком много`);
  return rounded;
}

const q = (n: number) => n.toFixed(3);
const num = (v: unknown) => Math.round(Number(v ?? 0) * 1000) / 1000;

function presentItem(row: ItemRow & { qty?: unknown; total_qty?: unknown }) {
  return {
    id: row.id,
    sku: row.sku,
    title: row.title,
    unit: row.unit,
    trackStock: row.track_stock,
    costMinor: Number(row.cost_minor),
    sellPriceMinor: Number(row.sell_price_minor),
    forSale: row.for_sale,
    active: row.active,
    minQty: num(row.min_qty),
    qty: num(row.qty),
    totalQty: num(row.total_qty),
  };
}

async function loadItem(ctx: Ctx, id: string, lock = false) {
  const row = await one<ItemRow>(ctx.db, `SELECT * FROM inventory_items WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id]);
  if (!row) throw new AppError("NOT_FOUND", "Позиция не найдена");
  return row;
}

// ---------- INV-ITEM-01 ----------

export async function listItems(ctx: Ctx, branchId: string, opts: { includeArchived?: boolean } = {}) {
  assertRead(ctx);
  await loadBranch(ctx, branchId);
  const rows = await many<ItemRow & { qty: string; total_qty: string }>(
    ctx.db,
    `SELECT i.*, COALESCE(b.qty, 0) AS qty,
            (SELECT COALESCE(SUM(qty), 0) FROM stock_balances WHERE item_id = i.id) AS total_qty
     FROM inventory_items i LEFT JOIN stock_balances b ON b.item_id = i.id AND b.branch_id = $1
     WHERE $2 OR i.active
     ORDER BY i.active DESC, i.title`,
    [branchId, Boolean(opts.includeArchived)],
  );
  return rows.map(presentItem);
}

type ItemInput = {
  sku?: string;
  title?: string;
  unit?: Unit;
  trackStock?: boolean;
  costMinor?: number;
  sellPriceMinor?: number;
  forSale?: boolean;
  minQty?: unknown;
};

function validateItem(input: ItemInput) {
  const sku = input.sku?.trim() ?? "";
  const title = input.title?.trim() ?? "";
  if (!title) throw new AppError("VALIDATION", "Укажите название");
  if (input.unit && !(input.unit in UNITS)) throw new AppError("VALIDATION", "Единица: шт, мл, г или уп");
  for (const [value, label] of [[input.costMinor, "Себестоимость"], [input.sellPriceMinor, "Цена продажи"]] as const) {
    const n = Number(value ?? 0);
    if (!Number.isInteger(n) || n < 0) throw new AppError("VALIDATION", `${label}: сумма в копейках ≥ 0`);
  }
  const min = input.minQty === undefined || input.minQty === null || input.minQty === "" ? 0 : Number(String(input.minQty).replace(",", "."));
  if (!Number.isFinite(min) || min < 0) throw new AppError("VALIDATION", "Минимальный остаток: число ≥ 0");
  return { sku, title, minQty: Math.round(min * 1000) / 1000 };
}

/** INV-ITEM-01: an empty article number is filled in as P-0001, P-0002, … */
async function nextSku(ctx: Ctx) {
  const row = await one<{ n: number }>(ctx.db, "SELECT COALESCE(MAX((substring(sku FROM '^P-(\\d+)$'))::int), 0) + 1 AS n FROM inventory_items");
  return `P-${String(Number(row?.n ?? 1)).padStart(4, "0")}`;
}

export async function createItem(ctx: Ctx, input: ItemInput & { branchId?: string; initialQty?: unknown }) {
  assertWrite(ctx);
  const valid = validateItem(input);
  const { title, minQty } = valid;
  const sku = valid.sku || (await nextSku(ctx));
  if (await one(ctx.db, "SELECT 1 FROM inventory_items WHERE sku = $1", [sku])) throw new AppError("VALIDATION", `Позиция с артикулом ${sku} уже есть`);
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO inventory_items (id, tenant_id, sku, title, unit, track_stock, cost_minor, sell_price_minor, for_sale, min_qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      ctx.actor.tenantId,
      sku,
      title,
      input.unit ?? "pcs",
      input.trackStock ?? true,
      Number(input.costMinor ?? 0),
      Number(input.sellPriceMinor ?? 0),
      input.forSale ?? false,
      q(minQty),
    ],
  );
  await audit(ctx, { entity: "inventory_item", entityId: id, action: "inventory.item_created", diff: { sku, title } });
  // INV-ITEM-02: what is on the shelf right now goes in as the first receipt.
  const initial = input.initialQty === undefined || input.initialQty === null || input.initialQty === "" ? 0 : Number(String(input.initialQty).replace(",", "."));
  if (initial > 0 && (input.trackStock ?? true)) {
    if (!input.branchId) throw new AppError("VALIDATION", "Укажите филиал для начального остатка");
    await receiveStock(ctx, { branchId: input.branchId, document: "Начальный остаток", lines: [{ itemId: id, qty: initial }] });
  }
  return presentItem(await loadItem(ctx, id));
}

export async function updateItem(ctx: Ctx, id: string, input: ItemInput & { active?: boolean }) {
  assertWrite(ctx);
  const existing = await loadItem(ctx, id, true);
  const merged = { ...presentItem(existing), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ReturnType<typeof presentItem>;
  const valid = validateItem(merged);
  const { title, minQty } = valid;
  const sku = valid.sku || existing.sku;
  if (existing.track_stock && merged.trackStock === false) {
    const left = await one<{ n: number }>(ctx.db, "SELECT COUNT(*)::int AS n FROM stock_balances WHERE item_id = $1 AND qty <> 0", [id]);
    if (Number(left?.n ?? 0) > 0) throw new AppError("VALIDATION", "Есть остатки — сначала спишите их");
  }
  await ctx.db.query(
    `UPDATE inventory_items SET sku = $2, title = $3, unit = $4, track_stock = $5, cost_minor = $6, sell_price_minor = $7, for_sale = $8, active = $9, min_qty = $10
     WHERE id = $1`,
    [id, sku, title, merged.unit, merged.trackStock, merged.costMinor, merged.sellPriceMinor, merged.forSale, merged.active, q(minQty)],
  );
  await audit(ctx, { entity: "inventory_item", entityId: id, action: "inventory.item_updated", diff: input });
  return presentItem(await loadItem(ctx, id));
}

/** Deletes an unused item; anything with stock or history is archived instead. */
export async function deleteItem(ctx: Ctx, id: string) {
  assertWrite(ctx);
  await loadItem(ctx, id, true);
  const used = await one<{ moves: number; stock: number }>(
    ctx.db,
    `SELECT (SELECT COUNT(*)::int FROM stock_movements WHERE item_id = $1) AS moves,
            (SELECT COUNT(*)::int FROM stock_balances WHERE item_id = $1 AND qty <> 0) AS stock`,
    [id],
  );
  if (Number(used?.stock ?? 0) > 0) throw new AppError("VALIDATION", "Нельзя удалить позицию с остатком. Спишите остаток или отправьте в архив");
  if (Number(used?.moves ?? 0) > 0) {
    await ctx.db.query("UPDATE inventory_items SET active = false WHERE id = $1", [id]);
    await audit(ctx, { entity: "inventory_item", entityId: id, action: "inventory.item_archived" });
    return { id, outcome: "archived" as const };
  }
  await ctx.db.query("DELETE FROM inventory_items WHERE id = $1", [id]);
  await audit(ctx, { entity: "inventory_item", entityId: id, action: "inventory.item_deleted" });
  return { id, outcome: "deleted" as const };
}

// ---------- Movements ----------

type MoveInput = {
  branchId: string;
  itemId: string;
  type: MovementType;
  qty: number; // signed
  costMinor: number;
  allowNegative: boolean;
  appointmentId?: string | null;
  appointmentServiceId?: string | null;
  paymentId?: string | null;
  paymentLineId?: string | null;
  transferId?: string | null;
  countId?: string | null;
  reversesId?: string | null;
  supplier?: string | null;
  document?: string | null;
  reason?: string | null;
};

/** The one place a balance changes: row-locked, never below zero unless the caller's policy allows it (flagged). */
async function move(ctx: Ctx, input: MoveInput, label: string) {
  await ctx.db.query(
    "INSERT INTO stock_balances (tenant_id, item_id, branch_id, qty) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING",
    [ctx.actor.tenantId, input.itemId, input.branchId],
  );
  const balance = await one<{ qty: string }>(
    ctx.db,
    "SELECT qty FROM stock_balances WHERE item_id = $1 AND branch_id = $2 FOR UPDATE",
    [input.itemId, input.branchId],
  );
  const before = num(balance?.qty);
  const after = num(before + input.qty);
  const negative = after < 0 && input.qty < 0;
  if (negative && !input.allowNegative) {
    throw new AppError("VALIDATION", `Не хватает остатка: ${label} (есть ${before})`, { itemId: input.itemId, availableQty: before });
  }
  await ctx.db.query("UPDATE stock_balances SET qty = $3 WHERE item_id = $1 AND branch_id = $2", [input.itemId, input.branchId, q(after)]);
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO stock_movements (id, tenant_id, branch_id, item_id, type, qty, cost_minor, negative, appointment_id, appointment_service_id,
       payment_id, payment_line_id, transfer_id, count_id, reverses_id, supplier, document, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      id,
      ctx.actor.tenantId,
      input.branchId,
      input.itemId,
      input.type,
      q(input.qty),
      input.costMinor,
      negative,
      input.appointmentId ?? null,
      input.appointmentServiceId ?? null,
      input.paymentId ?? null,
      input.paymentLineId ?? null,
      input.transferId ?? null,
      input.countId ?? null,
      input.reversesId ?? null,
      input.supplier ?? null,
      input.document ?? null,
      input.reason ?? null,
      ctx.actor.userId,
    ],
  );
  return { id, negative, before, after };
}

async function trackedItem(ctx: Ctx, itemId: string) {
  const item = await loadItem(ctx, itemId);
  if (!item.track_stock) throw new AppError("VALIDATION", `«${item.title}» без учёта остатков`);
  return item;
}

/** INV-RECEIPT-01 */
export async function receiveStock(
  ctx: Ctx,
  input: { branchId: string; supplier?: string; document?: string; lines: { itemId: string; qty: unknown; costMinor?: number }[] },
) {
  assertWrite(ctx);
  await loadBranch(ctx, input.branchId);
  if (!input.lines?.length) throw new AppError("VALIDATION", "Добавьте хотя бы одну позицию");
  const lines = [...input.lines].sort((a, b) => a.itemId.localeCompare(b.itemId));
  const done: { itemId: string; qty: number }[] = [];
  for (const line of lines) {
    const item = await trackedItem(ctx, line.itemId);
    const qty = parseQty(line.qty);
    let cost = Number(item.cost_minor);
    if (line.costMinor !== undefined && line.costMinor !== null) {
      cost = Number(line.costMinor);
      if (!Number.isInteger(cost) || cost < 0) throw new AppError("VALIDATION", "Цена закупки: копейки ≥ 0");
      // The latest purchase price becomes the item's cost for consumption and margin.
      await ctx.db.query("UPDATE inventory_items SET cost_minor = $2 WHERE id = $1", [item.id, cost]);
    }
    await move(
      ctx,
      {
        branchId: input.branchId,
        itemId: item.id,
        type: "receipt",
        qty,
        costMinor: cost,
        allowNegative: true,
        supplier: input.supplier?.trim() || null,
        document: input.document?.trim() || null,
      },
      item.title,
    );
    done.push({ itemId: item.id, qty });
  }
  await audit(ctx, { branchId: input.branchId, entity: "stock", entityId: input.branchId, action: "inventory.receipt", diff: { lines: done, supplier: input.supplier ?? null, document: input.document ?? null } });
  return { lines: done.length };
}

/** INV-WRITEOFF-01 */
export async function writeOffStock(ctx: Ctx, input: { branchId: string; itemId: string; qty: unknown; reason?: string }) {
  assertWrite(ctx);
  const branch = await loadBranch(ctx, input.branchId);
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new AppError("VALIDATION", "Укажите причину списания");
  const item = await trackedItem(ctx, input.itemId);
  const qty = parseQty(input.qty);
  const result = await move(
    ctx,
    { branchId: input.branchId, itemId: item.id, type: "write_off", qty: -qty, costMinor: Number(item.cost_minor), allowNegative: branch.allow_negative_stock, reason },
    item.title,
  );
  await audit(ctx, { branchId: input.branchId, entity: "stock", entityId: item.id, action: "inventory.write_off", diff: { qty, reason, negative: result.negative } });
  return { id: result.id, qty: result.after, negative: result.negative };
}

/** INV-TRANSFER-01: one transaction, two linked movements. */
export async function transferStock(ctx: Ctx, input: { fromBranchId: string; toBranchId: string; itemId: string; qty: unknown; reason?: string }) {
  assertWrite(ctx);
  if (input.fromBranchId === input.toBranchId) throw new AppError("VALIDATION", "Выберите другой филиал");
  const from = await loadBranch(ctx, input.fromBranchId);
  await loadBranch(ctx, input.toBranchId);
  const item = await trackedItem(ctx, input.itemId);
  const qty = parseQty(input.qty);
  const transferId = crypto.randomUUID();
  const common = { itemId: item.id, type: "transfer" as const, costMinor: Number(item.cost_minor), transferId, reason: input.reason?.trim() || null };
  // Lock the two balances in a fixed order so crossing transfers cannot deadlock.
  const ordered = [input.fromBranchId, input.toBranchId].sort();
  for (const branchId of ordered) {
    await ctx.db.query("INSERT INTO stock_balances (tenant_id, item_id, branch_id, qty) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING", [
      ctx.actor.tenantId,
      item.id,
      branchId,
    ]);
    await ctx.db.query("SELECT 1 FROM stock_balances WHERE item_id = $1 AND branch_id = $2 FOR UPDATE", [item.id, branchId]);
  }
  const out = await move(ctx, { ...common, branchId: input.fromBranchId, qty: -qty, allowNegative: from.allow_negative_stock }, item.title);
  await move(ctx, { ...common, branchId: input.toBranchId, qty, allowNegative: true }, item.title);
  await audit(ctx, { branchId: input.fromBranchId, entity: "stock", entityId: item.id, action: "inventory.transfer", diff: { transferId, qty, to: input.toBranchId } });
  return { transferId, negative: out.negative };
}

export async function listMovements(ctx: Ctx, branchId: string, filter: { itemId?: string; type?: string; limit?: number } = {}) {
  assertRead(ctx);
  await loadBranch(ctx, branchId);
  const rows = await many<{
    id: string;
    type: MovementType;
    qty: string;
    cost_minor: number;
    negative: boolean;
    item_id: string;
    item_title: string;
    unit: Unit;
    appointment_id: string | null;
    payment_id: string | null;
    transfer_id: string | null;
    count_id: string | null;
    reverses_id: string | null;
    supplier: string | null;
    document: string | null;
    reason: string | null;
    created_at: Date;
    user_name: string | null;
  }>(
    ctx.db,
    `SELECT m.*, i.title AS item_title, i.unit, u.name AS user_name
     FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id LEFT JOIN users u ON u.id = m.created_by
     WHERE m.branch_id = $1 AND ($2::uuid IS NULL OR m.item_id = $2) AND ($3::text IS NULL OR m.type = $3)
     ORDER BY m.created_at DESC, m.id LIMIT $4`,
    [branchId, filter.itemId || null, filter.type || null, Math.min(Number(filter.limit ?? 200), 500)],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    qty: num(row.qty),
    costMinor: Number(row.cost_minor),
    negative: row.negative,
    itemId: row.item_id,
    itemTitle: row.item_title,
    unit: row.unit,
    appointmentId: row.appointment_id,
    paymentId: row.payment_id,
    transferId: row.transfer_id,
    countId: row.count_id,
    reversal: Boolean(row.reverses_id),
    supplier: row.supplier,
    document: row.document,
    reason: row.reason,
    createdAt: new Date(row.created_at).toISOString(),
    userName: row.user_name,
  }));
}

// ---------- INV-CONSUME-01 ----------

export async function getConsumables(ctx: Ctx, serviceId: string) {
  assertRead(ctx);
  const rows = await many<{ item_id: string; title: string; unit: Unit; qty_per_service: string; cost_minor: number }>(
    ctx.db,
    `SELECT c.item_id, i.title, i.unit, c.qty_per_service, i.cost_minor FROM service_consumables c JOIN inventory_items i ON i.id = c.item_id
     WHERE c.service_id = $1 ORDER BY i.title`,
    [serviceId],
  );
  return rows.map((row) => ({ itemId: row.item_id, title: row.title, unit: row.unit, qty: num(row.qty_per_service), costMinor: Number(row.cost_minor) }));
}

export async function setConsumables(ctx: Ctx, serviceId: string, lines: { itemId: string; qty: unknown }[]) {
  assertWrite(ctx);
  const service = await one<{ id: string }>(ctx.db, "SELECT id FROM services WHERE id = $1", [serviceId]);
  if (!service) throw new AppError("NOT_FOUND", "Услуга не найдена");
  const seen = new Set<string>();
  const clean: { itemId: string; qty: number }[] = [];
  for (const line of lines ?? []) {
    if (seen.has(line.itemId)) throw new AppError("VALIDATION", "Позиция указана дважды");
    seen.add(line.itemId);
    await trackedItem(ctx, line.itemId);
    clean.push({ itemId: line.itemId, qty: parseQty(line.qty, "Расход на услугу") });
  }
  await ctx.db.query("DELETE FROM service_consumables WHERE service_id = $1", [serviceId]);
  for (const line of clean) {
    await ctx.db.query("INSERT INTO service_consumables (tenant_id, service_id, item_id, qty_per_service) VALUES ($1,$2,$3,$4)", [
      ctx.actor.tenantId,
      serviceId,
      line.itemId,
      q(line.qty),
    ]);
  }
  await audit(ctx, { entity: "service", entityId: serviceId, action: "inventory.consumables_set", diff: { lines: clean } });
  return getConsumables(ctx, serviceId);
}

export type StockWarning = { itemId: string; title: string; neededQty: number; availableQty: number; unit: Unit };

/**
 * Called when a visit becomes completed. Policy `block` refuses the completion when stock is short;
 * `warn` (default) consumes anyway, flags the movements negative and returns the warnings.
 */
export async function consumeForAppointment(ctx: Ctx, appointmentId: string, branch: { id: string; consume_policy: string }) {
  const rows = await many<{ appointment_service_id: string; item_id: string; title: string; unit: Unit; qty: string; cost_minor: number }>(
    ctx.db,
    `SELECT s.id AS appointment_service_id, c.item_id, i.title, i.unit, c.qty_per_service AS qty, i.cost_minor
     FROM appointment_services s
     JOIN service_consumables c ON c.service_id = s.service_id
     JOIN inventory_items i ON i.id = c.item_id AND i.track_stock
     WHERE s.appointment_id = $1
       AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.appointment_service_id = s.id AND m.type = 'consume')
     ORDER BY c.item_id, s.position`,
    [appointmentId],
  );
  if (!rows.length) return [] as StockWarning[];
  const need = new Map<string, { title: string; unit: Unit; qty: number }>();
  for (const row of rows) {
    const entry = need.get(row.item_id) ?? { title: row.title, unit: row.unit, qty: 0 };
    entry.qty = num(entry.qty + num(row.qty));
    need.set(row.item_id, entry);
  }
  const warnings: StockWarning[] = [];
  for (const [itemId, entry] of need) {
    await ctx.db.query("INSERT INTO stock_balances (tenant_id, item_id, branch_id, qty) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING", [
      ctx.actor.tenantId,
      itemId,
      branch.id,
    ]);
    const balance = await one<{ qty: string }>(ctx.db, "SELECT qty FROM stock_balances WHERE item_id = $1 AND branch_id = $2 FOR UPDATE", [itemId, branch.id]);
    const available = num(balance?.qty);
    if (available < entry.qty) warnings.push({ itemId, title: entry.title, neededQty: entry.qty, availableQty: available, unit: entry.unit });
  }
  if (warnings.length && branch.consume_policy === "block") {
    throw new AppError("VALIDATION", `Не хватает материалов: ${warnings.map((w) => `${w.title} (нужно ${w.neededQty} ${UNITS[w.unit]}, есть ${w.availableQty})`).join(", ")}`, {
      stockWarnings: warnings,
    });
  }
  for (const row of rows) {
    await move(
      ctx,
      {
        branchId: branch.id,
        itemId: row.item_id,
        type: "consume",
        qty: -num(row.qty),
        costMinor: Number(row.cost_minor),
        allowNegative: true,
        appointmentId,
        appointmentServiceId: row.appointment_service_id,
      },
      row.title,
    );
  }
  if (warnings.length) {
    await audit(ctx, { branchId: branch.id, entity: "appointment", entityId: appointmentId, action: "inventory.consume_negative", diff: { warnings } });
  }
  return warnings;
}

/** Puts consumed materials back, e.g. when the service is refunded. Each movement is reversed once. */
export async function reverseConsume(ctx: Ctx, where: { appointmentServiceId: string }, reason: string) {
  const rows = await many<{ id: string; branch_id: string; item_id: string; qty: string; cost_minor: number; appointment_id: string | null; title: string }>(
    ctx.db,
    `SELECT m.id, m.branch_id, m.item_id, m.qty, m.cost_minor, m.appointment_id, i.title
     FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
     WHERE m.type = 'consume' AND m.qty < 0 AND m.appointment_service_id = $1
       AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id)
     ORDER BY m.item_id`,
    [where.appointmentServiceId],
  );
  for (const row of rows) {
    await move(
      ctx,
      {
        branchId: row.branch_id,
        itemId: row.item_id,
        type: "consume",
        qty: -num(row.qty),
        costMinor: Number(row.cost_minor),
        allowNegative: true,
        appointmentId: row.appointment_id,
        appointmentServiceId: where.appointmentServiceId,
        reversesId: row.id,
        reason,
      },
      row.title,
    );
  }
  return rows.length;
}

/** Net cost of materials consumed per appointment service (for PAYROLL-SCHEME-05). */
export async function materialsCost(ctx: Ctx, appointmentServiceIds: string[]) {
  if (!appointmentServiceIds.length) return new Map<string, number>();
  const rows = await many<{ id: string; cost: string }>(
    ctx.db,
    `SELECT appointment_service_id AS id, SUM(-qty * cost_minor) AS cost FROM stock_movements
     WHERE type = 'consume' AND appointment_service_id = ANY($1::uuid[]) GROUP BY appointment_service_id`,
    [appointmentServiceIds],
  );
  return new Map(rows.map((row) => [row.id, Math.max(0, Math.round(Number(row.cost)))]));
}

// ---------- INV-SALE-01 ----------

/** Product lines of a till payment: priced from the item, stock goes out with the payment. */
export async function productLines(ctx: Ctx, branchId: string, items: { itemId: string; qty: unknown; priceMinor?: number }[]) {
  const branch = await loadBranch(ctx, branchId);
  const lines: { type: "product"; refId: null; title: string; amountMinor: number; itemId: string; qty: number }[] = [];
  for (const entry of items) {
    const item = await loadItem(ctx, entry.itemId);
    if (!item.active || !item.for_sale) throw new AppError("VALIDATION", `«${item.title}» не продаётся`);
    const qty = parseQty(entry.qty);
    const unitPrice = entry.priceMinor !== undefined ? Number(entry.priceMinor) : Number(item.sell_price_minor);
    if (!Number.isInteger(unitPrice) || unitPrice <= 0) throw new AppError("VALIDATION", `Укажите цену «${item.title}»`);
    if (item.track_stock) {
      const balance = await one<{ qty: string }>(ctx.db, "SELECT qty FROM stock_balances WHERE item_id = $1 AND branch_id = $2", [item.id, branchId]);
      if (num(balance?.qty) < qty && !branch.allow_negative_stock) {
        throw new AppError("VALIDATION", `Не хватает остатка: ${item.title} (есть ${num(balance?.qty)})`);
      }
    }
    lines.push({ type: "product", refId: null, title: qty === 1 ? item.title : `${item.title} × ${qty}`, amountMinor: Math.round(unitPrice * qty), itemId: item.id, qty });
  }
  return lines;
}

/**
 * Stock side of a posted payment: a sale takes items out, a refund of a product line returns the
 * refunded share, a refund that leaves a service unpaid puts its materials back.
 */
export async function afterPaymentPosted(ctx: Ctx, paymentId: string) {
  const payment = await one<{ id: string; branch_id: string; direction: "in" | "out"; appointment_id: string | null }>(
    ctx.db,
    "SELECT id, branch_id, direction, appointment_id FROM payments WHERE id = $1",
    [paymentId],
  );
  if (!payment) return;
  const branch = await loadBranch(ctx, payment.branch_id);
  const lines = await many<{
    id: string;
    line_type: string;
    ref_id: string | null;
    item_id: string | null;
    qty: string | null;
    amount_minor: number;
    refund_of_line_id: string | null;
  }>(ctx.db, "SELECT id, line_type, ref_id, item_id, qty, amount_minor, refund_of_line_id FROM payment_lines WHERE payment_id = $1", [paymentId]);
  for (const line of lines) {
    if (line.line_type === "product" && line.item_id && line.qty) {
      const item = await loadItem(ctx, line.item_id);
      if (!item.track_stock) continue;
      const sign = payment.direction === "in" ? -1 : 1;
      await move(
        ctx,
        {
          branchId: payment.branch_id,
          itemId: item.id,
          type: "sale",
          qty: sign * num(line.qty),
          costMinor: Number(item.cost_minor),
          allowNegative: payment.direction === "out" || branch.allow_negative_stock,
          paymentId,
          paymentLineId: line.id,
          reason: payment.direction === "out" ? "Возврат товара" : null,
        },
        item.title,
      );
    }
    if (payment.direction === "out" && line.line_type === "service" && line.ref_id) {
      const net = await one<{ s: number }>(
        ctx.db,
        `SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::int AS s
         FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
         WHERE p.status IN ('posted', 'refunded') AND pl.line_type = 'service' AND pl.ref_id = $1`,
        [line.ref_id],
      );
      if (Number(net?.s ?? 0) <= 0) await reverseConsume(ctx, { appointmentServiceId: line.ref_id }, "Возврат услуги");
    }
  }
}

/** A voided sale puts its items back. */
export async function afterPaymentVoided(ctx: Ctx, paymentId: string) {
  const rows = await many<{ id: string; branch_id: string; item_id: string; qty: string; cost_minor: number; title: string }>(
    ctx.db,
    `SELECT m.id, m.branch_id, m.item_id, m.qty, m.cost_minor, i.title FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id
     WHERE m.payment_id = $1 AND m.type = 'sale' AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id)`,
    [paymentId],
  );
  for (const row of rows) {
    await move(
      ctx,
      { branchId: row.branch_id, itemId: row.item_id, type: "sale", qty: -num(row.qty), costMinor: Number(row.cost_minor), allowNegative: true, paymentId, reversesId: row.id, reason: "Аннулирование" },
      row.title,
    );
  }
}

// ---------- INV-COUNT-01 ----------

export async function startCount(ctx: Ctx, input: { branchId: string; note?: string }) {
  assertWrite(ctx);
  await loadBranch(ctx, input.branchId);
  const id = crypto.randomUUID();
  await ctx.db.query("INSERT INTO inventory_counts (id, tenant_id, branch_id, note, created_by) VALUES ($1,$2,$3,$4,$5)", [
    id,
    ctx.actor.tenantId,
    input.branchId,
    input.note?.trim() || null,
    ctx.actor.userId,
  ]);
  // Snapshot of what the system expects right now, for every tracked item.
  await ctx.db.query(
    `INSERT INTO inventory_count_lines (tenant_id, count_id, item_id, expected_qty, cost_minor)
     SELECT $1, $2, i.id, COALESCE(b.qty, 0), i.cost_minor FROM inventory_items i
     LEFT JOIN stock_balances b ON b.item_id = i.id AND b.branch_id = $3
     WHERE i.track_stock AND (i.active OR COALESCE(b.qty, 0) <> 0)`,
    [ctx.actor.tenantId, id, input.branchId],
  );
  await audit(ctx, { branchId: input.branchId, entity: "inventory_count", entityId: id, action: "inventory.count_started" });
  return getCount(ctx, id);
}

async function loadCount(ctx: Ctx, id: string, lock = false) {
  const row = await one<{ id: string; branch_id: string; status: string; note: string | null; created_at: Date; applied_at: Date | null }>(
    ctx.db,
    `SELECT id, branch_id, status, note, created_at, applied_at FROM inventory_counts WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!row) throw new AppError("NOT_FOUND", "Инвентаризация не найдена");
  await loadBranch(ctx, row.branch_id);
  return row;
}

export async function listCounts(ctx: Ctx, branchId: string) {
  assertRead(ctx);
  await loadBranch(ctx, branchId);
  const rows = await many<{ id: string; status: string; created_at: Date; applied_at: Date | null; lines: number; counted: number; variance: string }>(
    ctx.db,
    `SELECT c.id, c.status, c.created_at, c.applied_at, COUNT(l.item_id)::int AS lines, COUNT(l.counted_qty)::int AS counted,
            COALESCE(SUM((l.counted_qty - l.expected_qty) * l.cost_minor) FILTER (WHERE l.counted_qty IS NOT NULL), 0) AS variance
     FROM inventory_counts c LEFT JOIN inventory_count_lines l ON l.count_id = c.id
     WHERE c.branch_id = $1 GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50`,
    [branchId],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
    lines: Number(row.lines),
    counted: Number(row.counted),
    varianceCostMinor: Math.round(Number(row.variance)),
  }));
}

/** Count sheet with the variance report: counted − expected, in units and in money at cost. */
export async function getCount(ctx: Ctx, id: string) {
  assertRead(ctx);
  const count = await loadCount(ctx, id);
  const lines = await many<{ item_id: string; sku: string; title: string; unit: Unit; expected_qty: string; counted_qty: string | null; cost_minor: number }>(
    ctx.db,
    `SELECT l.item_id, i.sku, i.title, i.unit, l.expected_qty, l.counted_qty, l.cost_minor
     FROM inventory_count_lines l JOIN inventory_items i ON i.id = l.item_id WHERE l.count_id = $1 ORDER BY i.title`,
    [id],
  );
  const present = lines.map((line) => {
    const expected = num(line.expected_qty);
    const counted = line.counted_qty === null ? null : num(line.counted_qty);
    const diff = counted === null ? null : num(counted - expected);
    return {
      itemId: line.item_id,
      sku: line.sku,
      title: line.title,
      unit: line.unit,
      expectedQty: expected,
      countedQty: counted,
      diffQty: diff,
      diffCostMinor: diff === null ? null : Math.round(diff * Number(line.cost_minor)),
    };
  });
  const withDiff = present.filter((line) => line.diffQty !== null && line.diffQty !== 0);
  return {
    id: count.id,
    branchId: count.branch_id,
    status: count.status,
    note: count.note,
    createdAt: new Date(count.created_at).toISOString(),
    appliedAt: count.applied_at ? new Date(count.applied_at).toISOString() : null,
    lines: present,
    summary: {
      counted: present.filter((line) => line.countedQty !== null).length,
      total: present.length,
      shortageCostMinor: withDiff.filter((line) => line.diffQty! < 0).reduce((sum, line) => sum + line.diffCostMinor!, 0),
      surplusCostMinor: withDiff.filter((line) => line.diffQty! > 0).reduce((sum, line) => sum + line.diffCostMinor!, 0),
    },
  };
}

export async function setCounted(ctx: Ctx, id: string, lines: { itemId: string; countedQty: unknown }[]) {
  assertWrite(ctx);
  const count = await loadCount(ctx, id, true);
  if (count.status !== "open") throw new AppError("VALIDATION", "Инвентаризация уже завершена");
  for (const line of lines ?? []) {
    let value: string | null = null;
    if (line.countedQty !== null && line.countedQty !== "" && line.countedQty !== undefined) {
      const n = Number(String(line.countedQty).replace(",", "."));
      if (!Number.isFinite(n) || n < 0) throw new AppError("VALIDATION", "Факт: число ≥ 0");
      value = q(Math.round(n * 1000) / 1000);
    }
    const updated = await ctx.db.query("UPDATE inventory_count_lines SET counted_qty = $3 WHERE count_id = $1 AND item_id = $2", [id, line.itemId, value]);
    if (!updated.rowCount) throw new AppError("VALIDATION", "Позиции нет в этой инвентаризации");
  }
  return getCount(ctx, id);
}

/** Applies counted − expected as adjustments, so sales made while counting are not lost. Uncounted lines are left alone. */
export async function applyCount(ctx: Ctx, id: string) {
  assertWrite(ctx);
  const count = await loadCount(ctx, id, true);
  if (count.status !== "open") throw new AppError("VALIDATION", "Инвентаризация уже завершена");
  const sheet = await getCount(ctx, id);
  if (!sheet.summary.counted) throw new AppError("VALIDATION", "Введите фактическое количество хотя бы по одной позиции");
  const lines = sheet.lines.filter((line) => line.diffQty !== null && line.diffQty !== 0).sort((a, b) => a.itemId.localeCompare(b.itemId));
  for (const line of lines) {
    const item = await loadItem(ctx, line.itemId);
    await move(
      ctx,
      { branchId: count.branch_id, itemId: line.itemId, type: "inventory_adjust", qty: line.diffQty!, costMinor: Number(item.cost_minor), allowNegative: true, countId: id, reason: "Инвентаризация" },
      line.title,
    );
  }
  await ctx.db.query("UPDATE inventory_counts SET status = 'applied', applied_by = $2, applied_at = $3 WHERE id = $1", [id, ctx.actor.userId, ctx.now.toISOString()]);
  await audit(ctx, {
    branchId: count.branch_id,
    entity: "inventory_count",
    entityId: id,
    action: "inventory.count_applied",
    diff: { adjusted: lines.length, shortageCostMinor: sheet.summary.shortageCostMinor, surplusCostMinor: sheet.summary.surplusCostMinor },
  });
  return getCount(ctx, id);
}

export async function cancelCount(ctx: Ctx, id: string) {
  assertWrite(ctx);
  const count = await loadCount(ctx, id, true);
  if (count.status !== "open") throw new AppError("VALIDATION", "Инвентаризация уже завершена");
  await ctx.db.query("UPDATE inventory_counts SET status = 'cancelled' WHERE id = $1", [id]);
  await audit(ctx, { branchId: count.branch_id, entity: "inventory_count", entityId: id, action: "inventory.count_cancelled" });
  return getCount(ctx, id);
}
