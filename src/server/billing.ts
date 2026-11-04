import { AppError } from "@/domain/errors";
import { PERIODS, PLANS, accessState, invoiceAmount, isReadOnly, limitsOf, planById, type PlanId, type TenantPlan } from "@/domain/plans";
import { audit } from "./audit";
import { many, one, pool, poolOne, withSession } from "./db";
import { yookassaProvider } from "./providers/yookassa";
import type { Actor, Ctx } from "./types";

type TenantRow = { plan: TenantPlan; trial_ends_at: Date; paid_until: Date | null; suspended_at: Date | null; suspended_reason: string };

function platformShop() {
  const shopId = process.env.PLATFORM_YOOKASSA_SHOP_ID;
  const secretKey = process.env.PLATFORM_YOOKASSA_SECRET_KEY;
  return shopId && secretKey ? { shopId, secretKey } : null;
}
export const billingProvider = () => (platformShop() ? "yookassa" : "test");
const baseUrl = () => (process.env.PUBLIC_URL || "http://127.0.0.1:43123").replace(/\/$/, "");

function stateOf(row: TenantRow, now: Date) {
  return accessState({ plan: row.plan, trialEndsAt: new Date(row.trial_ends_at), paidUntil: row.paid_until ? new Date(row.paid_until) : null, suspendedAt: row.suspended_at }, now);
}

async function tenantRow(ctx: Ctx) {
  const row = await one<TenantRow>(ctx.db, "SELECT plan, trial_ends_at, paid_until, suspended_at, suspended_reason FROM tenants WHERE id = $1", [ctx.actor.tenantId]);
  if (!row) throw new AppError("NOT_FOUND", "Салон не найден");
  return row;
}

async function usage(ctx: Ctx) {
  const row = await one<{ staff: number; branches: number }>(
    ctx.db,
    "SELECT (SELECT count(*)::int FROM staff WHERE active) AS staff, (SELECT count(*)::int FROM branches) AS branches",
  );
  return { staff: Number(row?.staff ?? 0), branches: Number(row?.branches ?? 0) };
}

/** The gate for writes: read-only once the subscription is over or the platform suspended the salon. */
export async function tenantAccess(tenantId: string, now = new Date()) {
  const row = await withSession({ tenantId }, (db) =>
    one<TenantRow>(db, "SELECT plan, trial_ends_at, paid_until, suspended_at, suspended_reason FROM tenants WHERE id = $1", [tenantId]),
  );
  if (!row) return { state: "active" as const, readOnly: false };
  const state = stateOf(row, now);
  return { ...state, readOnly: isReadOnly(state.state), reason: row.suspended_reason };
}

export function assertWritable(access: { readOnly: boolean; state: string; reason?: string }) {
  if (!access.readOnly) return;
  if (access.state === "suspended") throw new AppError("PAYMENT_REQUIRED", `Салон приостановлен платформой${access.reason ? `: ${access.reason}` : ""}. Данные доступны для просмотра`);
  throw new AppError("PAYMENT_REQUIRED", "Подписка закончилась: CRM открыта только для просмотра. Продлите тариф в «Подписке»");
}

/** PLAT-BILLING-01: what the salon pays for, how much of it is used, and its invoices. */
export async function billingSummary(ctx: Ctx) {
  const row = await tenantRow(ctx);
  const state = stateOf(row, ctx.now);
  const used = await usage(ctx);
  const invoices = await many<{ id: string; number: number; plan: PlanId; months: number; amount_minor: number; status: string; provider: string; confirmation_url: string | null; period_from: Date | null; period_to: Date | null; created_at: Date; paid_at: Date | null }>(
    ctx.db,
    "SELECT * FROM saas_invoices ORDER BY created_at DESC LIMIT 24",
  );
  return {
    plan: row.plan,
    planTitle: planById(row.plan)?.title ?? "Пробный период",
    state: state.state,
    until: state.until,
    daysLeft: state.daysLeft,
    trialEndsAt: row.trial_ends_at,
    paidUntil: row.paid_until,
    suspendedReason: row.suspended_reason,
    limits: limitsOf(row.plan),
    usage: used,
    provider: billingProvider(),
    plans: PLANS.map((plan) => ({ ...plan, fits: used.staff <= plan.staffLimit && used.branches <= plan.branchLimit })),
    periods: PERIODS,
    invoices: invoices.map((item) => ({
      id: item.id,
      number: item.number,
      plan: item.plan,
      planTitle: planById(item.plan)?.title ?? item.plan,
      months: item.months,
      amountMinor: item.amount_minor,
      status: item.status,
      provider: item.provider,
      confirmationUrl: item.status === "pending" ? item.confirmation_url : null,
      periodFrom: item.period_from,
      periodTo: item.period_to,
      createdAt: item.created_at,
      paidAt: item.paid_at,
    })),
  };
}

function assertOwner(actor: Actor) {
  if (actor.role !== "owner" && actor.role !== "super") throw new AppError("FORBIDDEN", "Подпиской управляет владелец");
}

export async function createInvoice(ctx: Ctx, input: { plan?: unknown; months?: unknown }) {
  assertOwner(ctx.actor);
  const plan = planById(String(input.plan ?? ""));
  if (!plan) throw new AppError("VALIDATION", "Выберите тариф");
  const months = Number(input.months ?? 1);
  if (months !== 1 && months !== 6 && months !== 12) throw new AppError("VALIDATION", "Срок: 1, 6 или 12 месяцев");
  const used = await usage(ctx);
  if (used.staff > plan.staffLimit) throw new AppError("VALIDATION", `На тарифе «${plan.title}» до ${plan.staffLimit} мастеров, сейчас активных ${used.staff}. Отключите лишних или выберите тариф больше`);
  if (used.branches > plan.branchLimit) throw new AppError("VALIDATION", `На тарифе «${plan.title}» до ${plan.branchLimit} филиалов, сейчас ${used.branches}`);

  // A new invoice replaces an unpaid one.
  await ctx.db.query("UPDATE saas_invoices SET status = 'canceled' WHERE status = 'pending'");
  const next = await one<{ n: number }>(ctx.db, "SELECT COALESCE(max(number), 0)::int + 1 AS n FROM saas_invoices");
  const id = crypto.randomUUID();
  const amount = invoiceAmount(plan.id, months);
  const provider = billingProvider();
  await ctx.db.query(
    `INSERT INTO saas_invoices (id, tenant_id, number, plan, months, amount_minor, provider, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ctx.actor.tenantId, Number(next?.n ?? 1), plan.id, months, amount, provider, ctx.actor.userId],
  );
  const shop = platformShop();
  if (shop) {
    const payment = await yookassaProvider.createPayment(
      { id, amountMinor: amount, description: `Am Beauty CRM, тариф «${plan.title}», ${months} мес.`, returnUrl: `${baseUrl()}/settings/billing`, payPageUrl: `${baseUrl()}/settings/billing`, expiresAt: new Date(ctx.now.getTime() + 86400000) },
      shop,
    );
    await ctx.db.query("UPDATE saas_invoices SET external_id = $2, confirmation_url = $3 WHERE id = $1", [id, payment.externalId, payment.confirmationUrl]);
  }
  await audit(ctx, { entity: "saas_invoice", entityId: id, action: "billing.invoice_created", diff: { plan: plan.id, months, amountMinor: amount } });
  return (await billingSummary(ctx)).invoices.find((item) => item.id === id)!;
}

/** Paid: the plan switches and the paid period continues from whatever is left (trial or previous payment). */
export async function markInvoicePaid(ctx: Ctx, id: string) {
  const invoice = await one<{ id: string; plan: PlanId; months: number; status: string }>(ctx.db, "SELECT id, plan, months, status FROM saas_invoices WHERE id = $1 FOR UPDATE", [id]);
  if (!invoice) throw new AppError("NOT_FOUND", "Счёт не найден");
  if (invoice.status === "paid") return invoice;
  if (invoice.status !== "pending") throw new AppError("VALIDATION", "Счёт отменён");
  const row = await tenantRow(ctx);
  const candidates = [ctx.now.getTime(), row.paid_until ? new Date(row.paid_until).getTime() : 0, row.plan === "trial" ? new Date(row.trial_ends_at).getTime() : 0];
  const from = new Date(Math.max(...candidates));
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + invoice.months);
  await ctx.db.query("UPDATE saas_invoices SET status = 'paid', paid_at = $2, period_from = $3, period_to = $4 WHERE id = $1", [id, ctx.now, from, to]);
  await ctx.db.query("UPDATE tenants SET plan = $2, paid_until = $3 WHERE id = $1", [ctx.actor.tenantId, invoice.plan, to]);
  await audit(ctx, { entity: "saas_invoice", entityId: id, action: "billing.invoice_paid", diff: { plan: invoice.plan, months: invoice.months, paidUntil: to.toISOString() } });
  return { ...invoice, status: "paid" };
}

/** Sandbox only: without platform shop keys an owner "pays" on the spot to try the flow. */
export async function sandboxPayInvoice(ctx: Ctx, id: string) {
  assertOwner(ctx.actor);
  const invoice = await one<{ provider: string }>(ctx.db, "SELECT provider FROM saas_invoices WHERE id = $1", [id]);
  if (!invoice) throw new AppError("NOT_FOUND", "Счёт не найден");
  if (invoice.provider !== "test") throw new AppError("FORBIDDEN", "Этот счёт оплачивается через ЮKassa");
  await markInvoicePaid(ctx, id);
  return billingSummary(ctx);
}

/** ЮKassa notification for the platform shop. The status is re-read from the API with the platform keys. */
export async function handleBillingWebhook(body: unknown, headers: Headers) {
  const shop = platformShop();
  if (!shop) return { ok: true, ignored: true };
  const parsed = await yookassaProvider.parseWebhook!(body, headers, shop);
  if (!parsed) return { ok: true, ignored: true };
  const found = await poolOne<{ tenant_id: string; invoice_id: string }>("SELECT tenant_id, invoice_id FROM saas_invoice_lookup($1)", [parsed.externalId]);
  if (!found) return { ok: true, ignored: true };
  const actor: Actor = { userId: "00000000-0000-4000-8000-0000000000b1", tenantId: found.tenant_id, role: "super", branchId: null, staffId: null, name: "Оплата подписки", email: "" };
  await withSession({ tenantId: found.tenant_id }, async (db) => {
    const ctx: Ctx = { db, actor, now: new Date() };
    if (parsed.status === "succeeded") await markInvoicePaid(ctx, found.invoice_id);
    if (parsed.status === "canceled") await db.query("UPDATE saas_invoices SET status = 'canceled' WHERE id = $1 AND status = 'pending'", [found.invoice_id]);
  });
  return { ok: true };
}

// ------------------------------------------------------------------ PLAT-SUPER-01

export function isPlatformAdmin(actor: Actor) {
  const list = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return list.includes(actor.email.toLowerCase());
}

export function assertPlatform(actor: Actor) {
  if (!isPlatformAdmin(actor)) throw new AppError("FORBIDDEN", "Раздел для команды платформы");
}

export async function platformTenants(actor: Actor, now = new Date()) {
  assertPlatform(actor);
  const { rows } = await pool.query("SELECT * FROM platform_tenants()");
  return rows.map((row) => {
    const state = stateOf(row as TenantRow, now);
    return {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      plan: row.plan as TenantPlan,
      planTitle: planById(row.plan)?.title ?? "Пробный",
      state: state.state,
      until: state.until,
      daysLeft: state.daysLeft,
      suspendedReason: row.suspended_reason as string,
      createdAt: row.created_at as Date,
      ownerEmail: (row.owner_email as string | null) ?? "",
      staff: Number(row.staff_active),
      branches: Number(row.branches),
      appointments30d: Number(row.appointments_30d),
      lastActivity: row.last_activity as Date | null,
      paidTotalMinor: Number(row.paid_total_minor),
    };
  });
}

export async function platformUpdateTenant(actor: Actor, id: string, input: { plan?: unknown; extendDays?: unknown; suspend?: unknown; reason?: unknown }, now = new Date()) {
  assertPlatform(actor);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError("NOT_FOUND", "Салон не найден");
  const plan = input.plan === undefined ? null : String(input.plan);
  if (plan !== null && plan !== "trial" && !planById(plan)) throw new AppError("VALIDATION", "Неизвестный тариф");
  const days = input.extendDays === undefined ? 0 : Number(input.extendDays);
  if (!Number.isInteger(days) || days < 0 || days > 366) throw new AppError("VALIDATION", "Продление: от 1 до 366 дней");
  const current = (await platformTenants(actor, now)).find((row) => row.id === id);
  if (!current) throw new AppError("NOT_FOUND", "Салон не найден");
  let trialEnds: Date | null = null;
  let paidUntil: Date | null = null;
  if (days) {
    const base = new Date(Math.max(now.getTime(), current.until ? new Date(current.until).getTime() : 0));
    const end = new Date(base.getTime() + days * 86400000);
    if ((plan ?? current.plan) === "trial") trialEnds = end;
    else paidUntil = end;
  }
  const suspend = input.suspend === undefined ? null : input.suspend === true;
  await pool.query("SELECT platform_update_tenant($1, $2, $3, $4, $5, $6)", [id, plan, trialEnds, paidUntil, suspend, input.reason ? String(input.reason).slice(0, 200) : null]);
  console.info("platform", JSON.stringify({ by: actor.email, tenant: id, plan, days, suspend }));
  const what = [plan && plan !== current.plan ? `тариф → ${planById(plan)?.title ?? "Пробный"}` : "", days ? `продлено на ${days} дн.` : "", suspend === true ? "приостановлен" : suspend === false ? "включён" : ""].filter(Boolean).join(", ");
  if (what) await pool.query("SELECT platform_log($1, $2, $3, $4)", [id, actor.email, `${actor.email}: ${what}`, JSON.stringify({ plan, days, suspend, reason: input.reason ?? null })]);
  return (await platformTenants(actor, now)).find((row) => row.id === id);
}
