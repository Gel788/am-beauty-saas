/**
 * 54-ФЗ receipts (FISC-*). A posted payment becomes a receipt document in the same transaction;
 * a provider adapter registers it later (job or right after the request), with retries.
 * Providers are code adapters: `test` registers instantly with made-up fiscal attributes,
 * real ones (АТОЛ Онлайн, ЮKassa, OrangeData…) plug in through registerFiscalProvider.
 */
import { AppError } from "@/domain/errors";
import { isAdminPlus, loadBranch } from "./access";
import { many, one, pool, withSession } from "./db";
import type { Actor, BranchRow, Ctx } from "./types";
import { formatMoney } from "@/domain/money";
import { notifyDesk } from "./messaging";

export const FISCAL_ACTOR_ID = "00000000-0000-0000-0000-0000000000c1";
const MAX_ATTEMPTS = 10;

export type ReceiptItem = {
  name: string;
  quantity: number;
  sumMinor: number;
  vat: string;
  /** ФФД 1.05 tag 1214: full_payment, advance, credit_payment */
  paymentMethod: "full_payment" | "advance" | "credit_payment";
  /** tag 1212: service, commodity, payment */
  paymentObject: "service" | "commodity" | "payment";
};
export type ReceiptPayment = { type: "cash" | "electronic" | "prepaid"; sumMinor: number };
export type ReceiptDocument = {
  operation: "sell" | "sell_refund";
  inn: string;
  place: string;
  taxation: string;
  customer: { phone?: string; email?: string };
  items: ReceiptItem[];
  payments: ReceiptPayment[];
  totalMinor: number;
  /** Deposits of the visit settled by this receipt (зачёт предоплаты). */
  offsetMinor?: number;
};

export type FiscalResult =
  | { status: "done"; externalId: string; fnNumber: string; fdNumber: string; fiscalSign: string; registeredAt: string; ofdUrl?: string | null }
  | { status: "sent"; externalId: string }
  | { status: "failed"; error: string; retry: boolean };

export type FiscalProvider = {
  name: string;
  label: string;
  register: (receiptId: string, document: ReceiptDocument) => Promise<FiscalResult>;
  /** For providers that register asynchronously (status `sent`). */
  check?: (externalId: string) => Promise<FiscalResult>;
};

let testCounter = 0;
const testProvider: FiscalProvider = {
  name: "test",
  label: "Тестовая касса (чеки не уходят в ФНС)",
  async register(receiptId) {
    testCounter += 1;
    return {
      status: "done",
      externalId: `test-${receiptId}`,
      fnNumber: "9999078900000000",
      fdNumber: String(100000 + testCounter),
      fiscalSign: String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)),
      registeredAt: new Date().toISOString(),
      ofdUrl: null,
    };
  },
};

const providers = new Map<string, FiscalProvider>([[testProvider.name, testProvider]]);
export function registerFiscalProvider(provider: FiscalProvider) {
  providers.set(provider.name, provider);
}
export function fiscalProviders() {
  return [...providers.values()].map((provider) => ({ name: provider.name, label: provider.label }));
}

const ELECTRONIC = new Set(["card", "sbp", "transfer"]);
const PREPAID = new Set(["certificate", "membership"]);

type LineRow = { line_type: string; title: string; amount_minor: number; qty: string | null };
type TenderRow = { method: string; amount_minor: number };

/** Spread `amount` over `weights` proportionally, largest remainder, never above a weight. */
export function spread(weights: number[], amount: number) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const raw = weights.map((weight) => (weight * amount) / total);
  const parts = raw.map(Math.floor);
  let left = amount - parts.reduce((sum, part) => sum + part, 0);
  const order = raw.map((value, index) => ({ index, frac: value - Math.floor(value) })).sort((a, b) => b.frac - a.frac);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] += 1;
    left -= 1;
  }
  return parts;
}

/**
 * Lines and tenders → a 54-ФЗ document. Tips are not the salon's revenue and stay out;
 * bonuses are a discount on the items; certificates and memberships are a prepaid tender.
 */
export function buildDocument(
  branch: Pick<BranchRow, "fiscal_inn" | "fiscal_place" | "fiscal_taxation" | "fiscal_vat">,
  operation: "sell" | "sell_refund",
  lines: LineRow[],
  tenders: TenderRow[],
  customer: { phone?: string; email?: string },
  offsetMinor = 0,
): ReceiptDocument | null {
  const vat = branch.fiscal_vat;
  const items: ReceiptItem[] = [];
  let tips = 0;
  for (const line of lines) {
    const sum = Number(line.amount_minor);
    if (sum <= 0) continue;
    if (line.line_type === "tip") {
      tips += sum;
      continue;
    }
    const qty = line.qty ? Number(line.qty) : 1;
    const base = { name: line.title.slice(0, 128), quantity: qty > 0 ? qty : 1, sumMinor: sum, vat };
    if (line.line_type === "service") items.push({ ...base, paymentMethod: "full_payment", paymentObject: "service" });
    else if (line.line_type === "product") items.push({ ...base, paymentMethod: "full_payment", paymentObject: "commodity" });
    else if (line.line_type === "deposit") items.push({ ...base, name: `Предоплата: ${base.name}`.slice(0, 128), paymentMethod: "advance", paymentObject: "payment" });
    else if (line.line_type === "loyalty") items.push({ ...base, paymentMethod: "advance", paymentObject: "payment" });
    else if (line.line_type === "debt") items.push({ ...base, paymentMethod: "credit_payment", paymentObject: "payment" });
  }
  if (!items.length) return null;

  const sumOf = (pred: (method: string) => boolean) =>
    tenders.filter((tender) => pred(tender.method)).reduce((sum, tender) => sum + Number(tender.amount_minor), 0);
  let cash = sumOf((method) => method === "cash");
  let electronic = sumOf((method) => ELECTRONIC.has(method));
  const prepaid = sumOf((method) => PREPAID.has(method));
  const bonus = sumOf((method) => method === "bonus");

  // Tips leave the money first from cash, then from card.
  const tipCash = Math.min(cash, tips);
  cash -= tipCash;
  electronic -= Math.min(electronic, tips - tipCash);

  // Bonuses lower the price of what they paid for.
  if (bonus > 0) {
    const cut = spread(items.map((item) => item.sumMinor), bonus);
    items.forEach((item, index) => (item.sumMinor -= cut[index]));
  }
  // Deposits taken earlier for this visit are settled here: the services show their full price.
  const hasService = items.some((item) => item.paymentObject === "service" && item.paymentMethod === "full_payment");
  const offset = operation === "sell" && hasService ? offsetMinor : 0;
  if (offset > 0) {
    const services = items.map((item) => (item.paymentObject === "service" && item.paymentMethod === "full_payment" ? item.sumMinor : 0));
    const add = spread(services, offset);
    items.forEach((item, index) => (item.sumMinor += add[index]));
  }
  const payments: ReceiptPayment[] = [];
  if (cash > 0) payments.push({ type: "cash", sumMinor: cash });
  if (electronic > 0) payments.push({ type: "electronic", sumMinor: electronic });
  if (prepaid + offset > 0) payments.push({ type: "prepaid", sumMinor: prepaid + offset });
  const kept = items.filter((item) => item.sumMinor > 0);
  const totalMinor = kept.reduce((sum, item) => sum + item.sumMinor, 0);
  const paid = payments.reduce((sum, payment) => sum + payment.sumMinor, 0);
  if (totalMinor <= 0) return null;
  if (paid !== totalMinor) throw new AppError("VALIDATION", "Чек не сходится: сумма оплат не равна сумме позиций");
  return {
    operation,
    inn: branch.fiscal_inn,
    place: branch.fiscal_place,
    taxation: branch.fiscal_taxation,
    customer,
    items: kept,
    payments,
    totalMinor,
    ...(offset > 0 ? { offsetMinor: offset } : {}),
  };
}

async function customerOf(ctx: Ctx, clientId: string | null) {
  if (!clientId) return {};
  const row = await one<{ email: string | null; phone: string | null }>(
    ctx.db,
    `SELECT c.email, (SELECT phone_e164 FROM client_phones p WHERE p.client_id = c.id AND p.deleted_at IS NULL ORDER BY p.is_primary DESC LIMIT 1) AS phone
     FROM clients c WHERE c.id = $1`,
    [clientId],
  );
  return { ...(row?.phone ? { phone: row.phone } : {}), ...(row?.email ? { email: row.email } : {}) };
}

/** Deposits on the visit not yet settled by an earlier sell receipt. */
async function openDeposits(ctx: Ctx, appointmentId: string) {
  const deposits = await one<{ s: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::int AS s
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.appointment_id = $1 AND p.status IN ('posted', 'refunded') AND pl.line_type = 'deposit'`,
    [appointmentId],
  );
  const settled = await one<{ s: number }>(
    ctx.db,
    `SELECT COALESCE(SUM((r.document->>'offsetMinor')::int), 0)::int AS s
     FROM fiscal_receipts r JOIN payments p ON p.id = r.payment_id
     WHERE p.appointment_id = $1 AND r.kind = 'sell' AND r.status <> 'canceled'`,
    [appointmentId],
  );
  return Math.max(0, Number(deposits?.s ?? 0) - Number(settled?.s ?? 0));
}

/** Called by insertPayment inside the payment's transaction. No-op when the branch has no fiscal kassa. */
export async function enqueueReceipt(ctx: Ctx, paymentId: string) {
  const payment = await one<{ branch_id: string; client_id: string | null; appointment_id: string | null; direction: "in" | "out" }>(
    ctx.db,
    "SELECT branch_id, client_id, appointment_id, direction FROM payments WHERE id = $1",
    [paymentId],
  );
  if (!payment) return null;
  const branch = await one<BranchRow>(ctx.db, "SELECT * FROM branches WHERE id = $1", [payment.branch_id]);
  if (!branch?.fiscal_enabled) return null;
  const lines = await many<LineRow>(ctx.db, "SELECT line_type, title, amount_minor, qty FROM payment_lines WHERE payment_id = $1", [paymentId]);
  const tenders = await many<TenderRow>(ctx.db, "SELECT method, amount_minor FROM payment_tenders WHERE payment_id = $1", [paymentId]);
  const operation = payment.direction === "in" ? "sell" : "sell_refund";
  const hasService = lines.some((line) => line.line_type === "service");
  const offset = operation === "sell" && hasService && payment.appointment_id ? await openDeposits(ctx, payment.appointment_id) : 0;
  const document = buildDocument(branch, operation, lines, tenders, await customerOf(ctx, payment.client_id), offset);
  if (!document) return null;
  return insertReceipt(ctx, branch, paymentId, document);
}

async function insertReceipt(ctx: Ctx, branch: BranchRow, paymentId: string, document: ReceiptDocument) {
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO fiscal_receipts (id, tenant_id, branch_id, payment_id, kind, provider, document, total_minor, next_try_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.actor.tenantId, branch.id, paymentId, document.operation, branch.fiscal_provider, JSON.stringify(document), document.totalMinor, ctx.now],
  );
  return id;
}

/** PAY-VOID-01 on a fiscalised payment: an unsent receipt is dropped, a registered one is reversed. */
export async function afterPaymentVoidedFiscal(ctx: Ctx, paymentId: string) {
  const receipt = await one<{ id: string; status: string; document: ReceiptDocument; branch_id: string }>(
    ctx.db,
    "SELECT id, status, document, branch_id FROM fiscal_receipts WHERE payment_id = $1 AND kind = 'sell' FOR UPDATE",
    [paymentId],
  );
  if (!receipt) return;
  if (receipt.status === "pending" || receipt.status === "failed") {
    await ctx.db.query("UPDATE fiscal_receipts SET status = 'canceled', updated_at = now() WHERE id = $1", [receipt.id]);
    return;
  }
  const branch = await loadBranch(ctx, receipt.branch_id);
  const { offsetMinor: _offset, ...rest } = receipt.document;
  void _offset;
  await insertReceipt(ctx, branch, paymentId, { ...rest, operation: "sell_refund" });
}

type ReceiptRow = {
  id: string;
  payment_id: string;
  branch_id: string;
  kind: string;
  status: string;
  provider: string;
  document: ReceiptDocument;
  total_minor: number;
  external_id: string | null;
  fn_number: string | null;
  fd_number: string | null;
  fiscal_sign: string | null;
  registered_at: Date | null;
  ofd_url: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
};

function backoffMinutes(attempts: number) {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

/** Sends due receipts of the current tenant. Network calls run inside the row lock (SKIP LOCKED keeps workers apart). */
export async function processReceipts(ctx: Ctx, limit = 20) {
  const due = await many<ReceiptRow>(
    ctx.db,
    `SELECT * FROM fiscal_receipts WHERE status IN ('pending', 'sent') AND next_try_at <= $1
     ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`,
    [ctx.now],
  );
  const stats = { done: 0, sent: 0, failed: 0, retry: 0 };
  for (const receipt of due) {
    const provider = providers.get(receipt.provider);
    let result: FiscalResult;
    if (!provider) result = { status: "failed", error: `Провайдер «${receipt.provider}» не подключён`, retry: false };
    else {
      try {
        result =
          receipt.status === "sent" && receipt.external_id && provider.check
            ? await provider.check(receipt.external_id)
            : await provider.register(receipt.id, receipt.document);
      } catch (error) {
        result = { status: "failed", error: error instanceof Error ? error.message : String(error), retry: true };
      }
    }
    const attempts = Number(receipt.attempts) + 1;
    if (result.status === "done") {
      await ctx.db.query(
        `UPDATE fiscal_receipts SET status = 'done', external_id = $2, fn_number = $3, fd_number = $4, fiscal_sign = $5,
           registered_at = $6, ofd_url = $7, error = NULL, attempts = $8, updated_at = now() WHERE id = $1`,
        [receipt.id, result.externalId, result.fnNumber, result.fdNumber, result.fiscalSign, result.registeredAt, result.ofdUrl ?? null, attempts],
      );
      stats.done += 1;
    } else if (result.status === "sent") {
      await ctx.db.query(
        `UPDATE fiscal_receipts SET status = 'sent', external_id = $2, attempts = $3, error = NULL,
           next_try_at = $4::timestamptz + interval '1 minute', updated_at = now() WHERE id = $1`,
        [receipt.id, result.externalId, attempts, ctx.now],
      );
      stats.sent += 1;
    } else if (result.retry && attempts < MAX_ATTEMPTS) {
      await ctx.db.query(
        `UPDATE fiscal_receipts SET error = $2, attempts = $3, next_try_at = $4::timestamptz + make_interval(mins => $5), updated_at = now() WHERE id = $1`,
        [receipt.id, result.error, attempts, ctx.now, backoffMinutes(attempts)],
      );
      stats.retry += 1;
    } else {
      await ctx.db.query("UPDATE fiscal_receipts SET status = 'failed', error = $2, attempts = $3, updated_at = now() WHERE id = $1", [
        receipt.id,
        result.error,
        attempts,
      ]);
      stats.failed += 1;
      await notifyDesk(ctx, {
        branchId: receipt.branch_id,
        kind: "fiscal.failed",
        title: `Чек не пробит: ${formatMoney(Number(receipt.total_minor))}`,
        body: result.error ?? "Провайдер не принял чек. Откройте «Касса → Чеки» и повторите.",
        entity: "payment",
        entityId: receipt.payment_id,
      });
    }
  }
  return stats;
}

function jobsActor(tenantId: string): Actor {
  return { userId: FISCAL_ACTOR_ID, tenantId, role: "client", branchId: null, staffId: null, name: "Касса", email: "" };
}

export async function runFiscalForTenant(tenantId: string, now = new Date()) {
  return withSession({ tenantId, userId: FISCAL_ACTOR_ID }, (db) => processReceipts({ db, actor: jobsActor(tenantId), now }));
}

/** Cron entry point. */
export async function runFiscalJob(now = new Date()) {
  const tenants = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM fiscal_tenants()");
  const total = { tenants: 0, done: 0, sent: 0, failed: 0, retry: 0 };
  for (const { tenant_id: tenantId } of tenants.rows) {
    const stats = await runFiscalForTenant(tenantId, now);
    total.tenants += 1;
    total.done += stats.done;
    total.sent += stats.sent;
    total.failed += stats.failed;
    total.retry += stats.retry;
  }
  return total;
}

function assertFiscalRole(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
}

function presentReceipt(row: ReceiptRow) {
  return {
    id: row.id,
    paymentId: row.payment_id,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    totalMinor: Number(row.total_minor),
    items: row.document.items,
    payments: row.document.payments,
    customer: row.document.customer,
    fnNumber: row.fn_number,
    fdNumber: row.fd_number,
    fiscalSign: row.fiscal_sign,
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    ofdUrl: row.ofd_url,
    error: row.error,
    attempts: Number(row.attempts),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listReceipts(ctx: Ctx, branchId: string, filter: { status?: string; paymentId?: string } = {}) {
  assertFiscalRole(ctx);
  await loadBranch(ctx, branchId);
  const params: unknown[] = [branchId];
  let where = "branch_id = $1";
  if (filter.status === "problem") where += " AND status IN ('failed', 'pending', 'sent')";
  else if (filter.status) {
    params.push(filter.status);
    where += ` AND status = $${params.length}`;
  }
  if (filter.paymentId) {
    params.push(filter.paymentId);
    where += ` AND payment_id = $${params.length}`;
  }
  const rows = await many<ReceiptRow>(ctx.db, `SELECT * FROM fiscal_receipts WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  return rows.map(presentReceipt);
}

/** Manual retry of a failed receipt (after fixing INN, provider keys, etc.). */
export async function retryReceipt(ctx: Ctx, receiptId: string) {
  assertFiscalRole(ctx);
  const row = await one<ReceiptRow & { branch_id: string }>(ctx.db, "SELECT * FROM fiscal_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
  if (!row) throw new AppError("NOT_FOUND", "Чек не найден");
  if (row.status !== "failed") throw new AppError("VALIDATION", "Повторить можно только чек с ошибкой");
  const branch = await loadBranch(ctx, row.branch_id);
  await ctx.db.query(
    "UPDATE fiscal_receipts SET status = 'pending', attempts = 0, next_try_at = $4, provider = $2, document = document || $3::jsonb, updated_at = now() WHERE id = $1",
    [receiptId, branch.fiscal_provider, JSON.stringify({ inn: branch.fiscal_inn, place: branch.fiscal_place, taxation: branch.fiscal_taxation }), ctx.now],
  );
  return { id: receiptId, status: "pending" as const };
}

/** Receipt status per payment, for the cash list chips. */
export async function receiptStatuses(ctx: Ctx, paymentIds: string[]) {
  if (!paymentIds.length) return new Map<string, { id: string; kind: string; status: string }[]>();
  const rows = await many<{ id: string; payment_id: string; kind: string; status: string }>(
    ctx.db,
    "SELECT id, payment_id, kind, status FROM fiscal_receipts WHERE payment_id = ANY($1::uuid[]) ORDER BY created_at",
    [paymentIds],
  );
  const map = new Map<string, { id: string; kind: string; status: string }[]>();
  for (const row of rows) map.set(row.payment_id, [...(map.get(row.payment_id) ?? []), { id: row.id, kind: row.kind, status: row.status }]);
  return map;
}
