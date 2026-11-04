/**
 * Online payments by card and SBP (ACQ-*): the admin sends a pay link, the client pays on the provider's page,
 * a webhook (or the test sandbox) settles it into an ordinary posted payment, which then gets its receipt.
 * Providers are adapters; `test` is a sandbox served by our own /pay page.
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@/domain/errors";
import { audit } from "./audit";
import { isAdminPlus, loadBranch } from "./access";
import { many, one, poolOne, withSession } from "./db";
import { createPayment, LIVE_PAYMENT, NET_AMOUNT } from "./payments";
import type { Actor, Ctx } from "./types";
import { formatMoney } from "@/domain/money";
import { appointmentValues, deliverToClient, notifyDesk, render, templateBody, type SendResult } from "./messaging";

export const ACQUIRING_ACTOR_ID = "00000000-0000-0000-0000-0000000000c2";

export type ProviderStatus = "pending" | "succeeded" | "canceled";
export type AcquiringProvider = {
  name: string;
  label: string;
  /** Sandbox providers are paid on our own page; real ones redirect to confirmationUrl. */
  sandbox?: boolean;
  createPayment: (input: {
    id: string;
    amountMinor: number;
    description: string;
    returnUrl: string;
    payPageUrl: string;
    expiresAt: Date;
  }) => Promise<{ externalId: string; confirmationUrl: string }>;
  /** Verifies and parses a webhook; null means "not ours / ignore". */
  parseWebhook?: (body: unknown, headers: Headers) => Promise<{ externalId: string; status: ProviderStatus; method?: "card" | "sbp" } | null>;
};

const testProvider: AcquiringProvider = {
  name: "test",
  label: "Тестовая оплата (деньги не списываются)",
  sandbox: true,
  async createPayment(input) {
    return { externalId: `test-${input.id}`, confirmationUrl: input.payPageUrl };
  },
};
const providers = new Map<string, AcquiringProvider>([[testProvider.name, testProvider]]);
export function registerAcquiringProvider(provider: AcquiringProvider) {
  providers.set(provider.name, provider);
}
export function acquiringProviders() {
  return [...providers.values()].map((provider) => ({ name: provider.name, label: provider.label }));
}
export function acquiringProvider(name: string) {
  return providers.get(name) ?? null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type OnlineRow = {
  id: string;
  branch_id: string;
  appointment_id: string | null;
  client_id: string | null;
  purpose: "deposit" | "visit";
  amount_minor: number;
  description: string;
  status: "created" | "pending" | "succeeded" | "canceled" | "expired";
  provider: string;
  external_id: string | null;
  confirmation_url: string | null;
  method: string | null;
  payment_id: string | null;
  error: string | null;
  expires_at: Date;
  paid_at: Date | null;
  created_at: Date;
};

function present(row: OnlineRow, url?: string) {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    purpose: row.purpose,
    amountMinor: Number(row.amount_minor),
    description: row.description,
    status: row.status,
    provider: row.provider,
    method: row.method,
    paymentId: row.payment_id,
    error: row.error,
    expiresAt: new Date(row.expires_at).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    ...(url ? { url } : {}),
  };
}

async function appointmentDue(ctx: Ctx, appointmentId: string) {
  const price = await one<{ s: number }>(ctx.db, "SELECT COALESCE(SUM(price_minor), 0)::int AS s FROM appointment_services WHERE appointment_id = $1", [appointmentId]);
  const paid = await one<{ s: number }>(
    ctx.db,
    `SELECT ${NET_AMOUNT} AS s FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT} AND pl.line_type IN ('service', 'deposit')`,
    [appointmentId],
  );
  return Math.max(0, Number(price?.s ?? 0) - Number(paid?.s ?? 0));
}

/** ACQ-LINK-01: a pay link for a visit (full or deposit). Only one live link per visit. */
export async function createPayLink(
  ctx: Ctx,
  appointmentId: string,
  input: { amountMinor?: number; purpose?: "deposit" | "visit"; origin: string; send?: boolean },
) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const appt = await one<{ id: string; branch_id: string; client_id: string | null; status: string; starts_at: Date }>(
    ctx.db,
    "SELECT id, branch_id, client_id, status, starts_at FROM appointments WHERE id = $1 FOR UPDATE",
    [appointmentId],
  );
  if (!appt) throw new AppError("NOT_FOUND", "Запись не найдена");
  const branch = await loadBranch(ctx, appt.branch_id);
  if (!branch.acquiring_enabled) throw new AppError("VALIDATION", "Онлайн-оплата выключена в настройках филиала");
  const provider = providers.get(branch.acquiring_provider);
  if (!provider) throw new AppError("VALIDATION", `Провайдер оплаты «${branch.acquiring_provider}» не подключён`);
  if (appt.status === "cancelled" || appt.status === "no_show") throw new AppError("VALIDATION", "Запись отменена");
  const due = await appointmentDue(ctx, appointmentId);
  if (due <= 0) throw new AppError("VALIDATION", "Запись уже оплачена");
  const amount = input.amountMinor ?? due;
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError("VALIDATION", "Укажите сумму");
  if (amount > due) throw new AppError("VALIDATION", "Сумма больше остатка по записи", { dueMinor: due });
  const beforeVisit = ["scheduled", "confirmed"].includes(appt.status);
  const purpose = input.purpose ?? (beforeVisit && amount < due ? "deposit" : "visit");
  if (purpose === "deposit" && !beforeVisit) throw new AppError("VALIDATION", "Предоплату можно взять только до визита");

  // A new link replaces the previous unpaid one, so the client cannot pay twice.
  await ctx.db.query(
    "UPDATE online_payments SET status = 'canceled', updated_at = now() WHERE appointment_id = $1 AND status IN ('created', 'pending')",
    [appointmentId],
  );
  const id = crypto.randomUUID();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(ctx.now.getTime() + Number(branch.acquiring_link_hours) * 3_600_000);
  const services = await many<{ title_snapshot: string }>(ctx.db, "SELECT title_snapshot FROM appointment_services WHERE appointment_id = $1 ORDER BY position", [appointmentId]);
  const description = `${purpose === "deposit" ? "Предоплата" : "Оплата"}: ${services.map((row) => row.title_snapshot).join(", ") || "визит"}`.slice(0, 128);
  const payPageUrl = `${input.origin}/pay/${token}`;
  let created: { externalId: string; confirmationUrl: string };
  try {
    created = await provider.createPayment({ id, amountMinor: amount, description, returnUrl: payPageUrl, payPageUrl, expiresAt });
  } catch (error) {
    throw new AppError("VALIDATION", `Провайдер оплаты не ответил: ${error instanceof Error ? error.message : String(error)}`);
  }
  await ctx.db.query(
    `INSERT INTO online_payments (id, tenant_id, branch_id, appointment_id, client_id, purpose, amount_minor, description, status,
       provider, external_id, confirmation_url, token_hash, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14)`,
    [id, ctx.actor.tenantId, appt.branch_id, appointmentId, appt.client_id, purpose, amount, description, provider.name, created.externalId, created.confirmationUrl, sha256(token), ctx.actor.userId, expiresAt],
  );
  await audit(ctx, { branchId: appt.branch_id, entity: "appointment", entityId: appointmentId, action: "paylink.created", diff: { onlinePaymentId: id, amountMinor: amount, purpose } });
  const row = await one<OnlineRow>(ctx.db, "SELECT * FROM online_payments WHERE id = $1", [id]);
  // MSG-PAY-01: the link goes to the client through the salon's channels; it is only shown once.
  let sent: SendResult | null = null;
  if (input.send && appt.client_id) {
    const { values } = await appointmentValues(ctx, appointmentId, { сумма: formatMoney(amount, branch.currency), ссылка: payPageUrl });
    sent = await deliverToClient(ctx, {
      clientId: appt.client_id,
      branchId: appt.branch_id,
      appointmentId,
      kind: "pay_link",
      body: render(await templateBody(ctx, "pay_link"), values),
      buttons: [{ text: "Оплатить", url: payPageUrl }],
    });
  }
  return { ...present(row!, payPageUrl), sent };
}

export async function listPayLinks(ctx: Ctx, appointmentId: string) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const appt = await one<{ branch_id: string }>(ctx.db, "SELECT branch_id FROM appointments WHERE id = $1", [appointmentId]);
  if (!appt) throw new AppError("NOT_FOUND", "Запись не найдена");
  const branch = await loadBranch(ctx, appt.branch_id);
  const rows = await many<OnlineRow>(ctx.db, "SELECT * FROM online_payments WHERE appointment_id = $1 ORDER BY created_at DESC", [appointmentId]);
  return { enabled: branch.acquiring_enabled, links: rows.map((row) => present(expireIfDue(row, ctx.now))) };
}

export async function cancelPayLink(ctx: Ctx, id: string) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const row = await one<OnlineRow>(ctx.db, "SELECT * FROM online_payments WHERE id = $1 FOR UPDATE", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Ссылка не найдена");
  await loadBranch(ctx, row.branch_id);
  if (!["created", "pending"].includes(row.status)) throw new AppError("VALIDATION", "Ссылку уже нельзя отменить");
  await ctx.db.query("UPDATE online_payments SET status = 'canceled', updated_at = now() WHERE id = $1", [id]);
  return present({ ...row, status: "canceled" });
}

function expireIfDue(row: OnlineRow, now: Date): OnlineRow {
  if ((row.status === "pending" || row.status === "created") && new Date(row.expires_at) <= now) return { ...row, status: "expired" };
  return row;
}

function settleActor(tenantId: string, branchId: string): Actor {
  // Acts with admin rights inside one branch, only through settleOnlinePayment.
  return { userId: ACQUIRING_ACTOR_ID, tenantId, role: "admin", branchId, staffId: null, name: "Онлайн-оплата", email: "" };
}

/**
 * Provider says the money arrived (or not). Idempotent: repeated webhooks change nothing.
 * Success posts a payment outside the cash shift (the money is in the bank, not the drawer).
 */
export async function applyProviderStatus(ctx: Ctx, id: string, status: ProviderStatus, method: "card" | "sbp" = "card") {
  const row = await one<OnlineRow>(ctx.db, "SELECT * FROM online_payments WHERE id = $1 FOR UPDATE", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Оплата не найдена");
  if (row.status === "succeeded") return present(row);
  if (status === "pending") return present(row);
  if (status === "canceled") {
    if (row.status === "pending" || row.status === "created") {
      await ctx.db.query("UPDATE online_payments SET status = 'canceled', updated_at = now() WHERE id = $1", [id]);
    }
    return present({ ...row, status: row.status === "pending" || row.status === "created" ? "canceled" : row.status });
  }
  // succeeded: money is taken even if the link was replaced or expired meanwhile, so it must be recorded.
  const actorCtx: Ctx = { ...ctx, actor: settleActor(ctx.actor.tenantId, row.branch_id) };
  let paymentId: string;
  let error: string | null = null;
  const appt = row.appointment_id
    ? await one<{ status: string }>(ctx.db, "SELECT status FROM appointments WHERE id = $1", [row.appointment_id])
    : null;
  const due = row.appointment_id ? await appointmentDue(ctx, row.appointment_id) : 0;
  const amount = Number(row.amount_minor);
  if (row.appointment_id && appt && appt.status !== "cancelled" && due >= amount) {
    const asDeposit = row.purpose === "deposit" && ["scheduled", "confirmed"].includes(appt.status);
    const paid = await createPayment(actorCtx, {
      branchId: row.branch_id,
      appointmentId: row.appointment_id,
      kind: asDeposit ? "deposit" : "visit",
      tenders: [{ method, amountMinor: amount }],
      amountMinor: amount,
      online: true,
    });
    paymentId = paid.id;
  } else {
    // Paid twice or after cancellation: keep the money on the books and ask for a refund.
    const paid = await createPayment(actorCtx, {
      branchId: row.branch_id,
      clientId: row.client_id,
      kind: "misc",
      title: `Онлайн-оплата без остатка по записи: ${row.description}`.slice(0, 128),
      tenders: [{ method, amountMinor: amount }],
      online: true,
    });
    paymentId = paid.id;
    error = "Запись уже оплачена или отменена. Оформите возврат клиенту";
  }
  await ctx.db.query(
    "UPDATE online_payments SET status = 'succeeded', method = $2, payment_id = $3, paid_at = $4, error = $5, updated_at = now() WHERE id = $1",
    [id, method, paymentId, ctx.now, error],
  );
  await audit(actorCtx, {
    branchId: row.branch_id,
    entity: "payment",
    entityId: paymentId,
    action: "paylink.paid",
    diff: { onlinePaymentId: id, amountMinor: amount, method },
  });
  const client = row.client_id ? await one<{ name: string }>(ctx.db, "SELECT name FROM clients WHERE id = $1", [row.client_id]) : null;
  await notifyDesk(actorCtx, {
    branchId: row.branch_id,
    kind: error ? "payment.online_problem" : "payment.online",
    title: `Оплата онлайн ${formatMoney(amount)}: ${client?.name ?? "клиент"}`,
    body: error ?? `${method === "sbp" ? "СБП" : "Карта"} · ${row.description}`,
    entity: "appointment",
    entityId: row.appointment_id,
  });
  return present({ ...row, status: "succeeded", method, payment_id: paymentId, paid_at: ctx.now, error });
}

/** Public pay page lookup (token in the link). */
export async function resolvePayToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("NOT_FOUND", "Ссылка на оплату не найдена");
  const row = await poolOne<{ tenant_id: string; online_payment_id: string }>("SELECT tenant_id, online_payment_id FROM public_pay_lookup($1)", [sha256(token)]);
  if (!row) throw new AppError("NOT_FOUND", "Ссылка на оплату не найдена");
  return { tenantId: row.tenant_id, id: row.online_payment_id };
}

function publicActor(tenantId: string): Actor {
  return { userId: ACQUIRING_ACTOR_ID, tenantId, role: "client", branchId: null, staffId: null, name: "Онлайн-оплата", email: "" };
}
export function asAcquiring<T>(tenantId: string, fn: (ctx: Ctx) => Promise<T>, now = new Date()) {
  return withSession({ tenantId, userId: ACQUIRING_ACTOR_ID }, (db) => fn({ db, actor: publicActor(tenantId), now }));
}

export async function publicPayInfo(ctx: Ctx, id: string) {
  const row = await one<OnlineRow & { branch_name: string; address: string; salon: string; starts_at: Date | null; timezone: string }>(
    ctx.db,
    `SELECT o.*, b.name AS branch_name, b.address, b.timezone, t.name AS salon, a.starts_at
     FROM online_payments o JOIN branches b ON b.id = o.branch_id JOIN tenants t ON t.id = o.tenant_id
     LEFT JOIN appointments a ON a.id = o.appointment_id WHERE o.id = $1`,
    [id],
  );
  if (!row) throw new AppError("NOT_FOUND", "Ссылка на оплату не найдена");
  const current = expireIfDue(row, ctx.now);
  const provider = providers.get(row.provider);
  return {
    salon: row.salon,
    branch: row.branch_name,
    address: row.address,
    timezone: row.timezone,
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    description: row.description,
    amountMinor: Number(row.amount_minor),
    status: current.status,
    method: row.method,
    sandbox: Boolean(provider?.sandbox),
    confirmationUrl: provider?.sandbox ? null : row.confirmation_url,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** The test sandbox stands in for the provider's page and webhook. */
export async function sandboxPay(ctx: Ctx, id: string, action: "card" | "sbp" | "cancel") {
  const row = await one<OnlineRow>(ctx.db, "SELECT * FROM online_payments WHERE id = $1", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Ссылка на оплату не найдена");
  if (!providers.get(row.provider)?.sandbox) throw new AppError("FORBIDDEN", "Оплата идёт на странице банка");
  const current = expireIfDue(row, ctx.now);
  if (current.status === "succeeded") return publicPayInfo(ctx, id);
  if (current.status !== "pending" && current.status !== "created") throw new AppError("VALIDATION", "Ссылка больше не действует");
  await applyProviderStatus(ctx, id, action === "cancel" ? "canceled" : "succeeded", action === "sbp" ? "sbp" : "card");
  return publicPayInfo(ctx, id);
}

/** Webhook entry: the provider adapter verifies the body; then the row is found by the provider's id. */
export async function handleWebhook(providerName: string, body: unknown, headers: Headers) {
  const provider = providers.get(providerName);
  if (!provider?.parseWebhook) throw new AppError("NOT_FOUND", "Не найдено");
  const event = await provider.parseWebhook(body, headers);
  if (!event) return { ok: true, ignored: true };
  const row = await poolOne<{ tenant_id: string; online_payment_id: string }>("SELECT tenant_id, online_payment_id FROM acquiring_lookup($1, $2)", [providerName, event.externalId]);
  if (!row) return { ok: true, ignored: true };
  await asAcquiring(row.tenant_id, (ctx) => applyProviderStatus(ctx, row.online_payment_id, event.status, event.method));
  return { ok: true };
}
