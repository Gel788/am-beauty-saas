import { randomBytes } from "node:crypto";
import { AppError } from "@/domain/errors";
import { addCalendarDays, formatLocalDate } from "@/domain/time";
import { isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import type { Ctx } from "./types";

/** Tenders that are not money handed over: they spend something the salon sold earlier. */
export const LOYALTY_METHODS = ["bonus", "certificate", "membership"] as const;
export type LoyaltyMethod = (typeof LOYALTY_METHODS)[number];
export const isLoyaltyMethod = (method: string): method is LoyaltyMethod => (LOYALTY_METHODS as readonly string[]).includes(method);

type TenantSettings = {
  bonus_enabled: boolean;
  bonus_earn_bps: number;
  bonus_burn_max_bps: number;
  bonus_earn_on_products: boolean;
  certificate_valid_days: number;
  bonus_expire_days: number;
  loyalty_tiers: Tier[] | null;
};

/** LOY-TIER-01: reached by lifetime spend; the tier's rate replaces the base earn rate. */
export type Tier = { title: string; minSpendMinor: number; earnBps: number };

const SETUP_ROLES = ["owner", "admin", "super"];

function assertSetup(ctx: Ctx) {
  if (!SETUP_ROLES.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Программы лояльности настраивают владелец или администратор");
}

function assertDesk(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
}

async function settings(ctx: Ctx) {
  const row = await one<TenantSettings>(
    ctx.db,
    "SELECT bonus_enabled, bonus_earn_bps, bonus_burn_max_bps, bonus_earn_on_products, certificate_valid_days, bonus_expire_days, loyalty_tiers FROM tenants WHERE id = $1",
    [ctx.actor.tenantId],
  );
  if (!row) throw new AppError("NOT_FOUND", "Салон не найден");
  return row;
}

function presentSettings(row: TenantSettings) {
  return {
    bonusEnabled: row.bonus_enabled,
    bonusEarnBps: Number(row.bonus_earn_bps),
    bonusBurnMaxBps: Number(row.bonus_burn_max_bps),
    bonusEarnOnProducts: row.bonus_earn_on_products,
    certificateValidDays: Number(row.certificate_valid_days),
    bonusExpireDays: Number(row.bonus_expire_days),
    tiers: (row.loyalty_tiers ?? []).map((tier) => ({ title: String(tier.title), minSpendMinor: Number(tier.minSpendMinor), earnBps: Number(tier.earnBps) })),
  };
}

function cleanTiers(input: unknown): Tier[] {
  if (!Array.isArray(input)) throw new AppError("VALIDATION", "Уровни: список");
  if (input.length > 6) throw new AppError("VALIDATION", "Не больше 6 уровней");
  const tiers = input.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const title = String(item.title ?? "").trim().slice(0, 40);
    const minSpendMinor = Number(item.minSpendMinor);
    const earnBps = Number(item.earnBps);
    if (!title) throw new AppError("VALIDATION", "Уровень: укажите название");
    if (!Number.isInteger(minSpendMinor) || minSpendMinor < 0) throw new AppError("VALIDATION", `«${title}»: сумма покупок — целое число от 0`);
    if (!Number.isInteger(earnBps) || earnBps < 0 || earnBps > 10000) throw new AppError("VALIDATION", `«${title}»: начисление от 0 до 100%`);
    return { title, minSpendMinor, earnBps };
  });
  tiers.sort((a, b) => a.minSpendMinor - b.minSpendMinor);
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].minSpendMinor === tiers[i - 1].minSpendMinor) throw new AppError("VALIDATION", "У двух уровней одинаковый порог");
  }
  return tiers;
}

/** What the client paid for services and goods, net of refunds: the tier yardstick. */
async function clientSpend(ctx: Ctx, clientId: string) {
  const row = await one<{ s: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::bigint AS s
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.client_id = $1 AND p.status IN ('posted', 'refunded') AND pl.line_type IN ('service', 'deposit', 'product')`,
    [clientId],
  );
  return Math.max(0, Number(row?.s ?? 0));
}

export function tierFor(tiers: Tier[], spendMinor: number) {
  let current: Tier | null = null;
  let next: Tier | null = null;
  for (const tier of [...tiers].sort((a, b) => a.minSpendMinor - b.minSpendMinor)) {
    if (tier.minSpendMinor <= spendMinor) current = tier;
    else if (!next) next = tier;
  }
  return { current, next };
}

/**
 * LOY-BONUS-EXPIRE-01, FIFO: points credited before the cutoff that were not spent since are due.
 * due = credits older than N days − everything debited ever (spent, clawed back, expired).
 */
async function expiringPoints(ctx: Ctx, clientId: string, cutoff: Date, balance: number) {
  const row = await one<{ credits: number; debits: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(delta) FILTER (WHERE delta > 0 AND created_at < $2), 0)::int AS credits,
            COALESCE(-SUM(delta) FILTER (WHERE delta < 0), 0)::int AS debits
     FROM bonus_ledger WHERE client_id = $1`,
    [clientId, cutoff.toISOString()],
  );
  return Math.max(0, Math.min(balance, Number(row?.credits ?? 0) - Number(row?.debits ?? 0)));
}

/** Job: burns points older than the program's lifetime. Idempotent: expired points count as debits. */
export async function expireBonuses(ctx: Ctx) {
  const program = await one<{ bonus_expire_days: number }>(ctx.db, "SELECT bonus_expire_days FROM tenants WHERE id = $1", [ctx.actor.tenantId]);
  const days = Number(program?.bonus_expire_days ?? 0);
  if (!days) return 0;
  const cutoff = new Date(ctx.now.getTime() - days * 86_400_000);
  const clients = await many<{ id: string; bonus_balance: number }>(
    ctx.db,
    `SELECT c.id, c.bonus_balance FROM clients c WHERE c.bonus_balance > 0
       AND EXISTS (SELECT 1 FROM bonus_ledger l WHERE l.client_id = c.id AND l.delta > 0 AND l.created_at < $1)`,
    [cutoff.toISOString()],
  );
  let total = 0;
  for (const client of clients) {
    const due = await expiringPoints(ctx, client.id, cutoff, Number(client.bonus_balance));
    if (due > 0) total += -(await bonusMove(ctx, client.id, "expire", -due, { reason: `Срок баллов ${days} дн. истёк`, clamp: true }));
  }
  return total;
}

export async function getLoyaltySettings(ctx: Ctx) {
  return presentSettings(await settings(ctx));
}

export async function updateLoyaltySettings(
  ctx: Ctx,
  input: { bonusEnabled?: boolean; bonusEarnBps?: number; bonusBurnMaxBps?: number; bonusEarnOnProducts?: boolean; certificateValidDays?: number; bonusExpireDays?: number; tiers?: unknown },
) {
  assertSetup(ctx);
  const current = presentSettings(await settings(ctx));
  const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as typeof current;
  if (input.tiers !== undefined) next.tiers = cleanTiers(input.tiers);
  if (!Number.isInteger(next.bonusExpireDays) || next.bonusExpireDays < 0 || next.bonusExpireDays > 3650) {
    throw new AppError("VALIDATION", "Срок жизни баллов: от 0 (бессрочно) до 3650 дней");
  }
  for (const [value, label] of [[next.bonusEarnBps, "Начисление"], [next.bonusBurnMaxBps, "Оплата баллами"]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 10000) throw new AppError("VALIDATION", `${label}: от 0 до 100%`);
  }
  if (!Number.isInteger(next.certificateValidDays) || next.certificateValidDays < 1 || next.certificateValidDays > 3650) {
    throw new AppError("VALIDATION", "Срок сертификата: от 1 до 3650 дней");
  }
  await ctx.db.query(
    `UPDATE tenants SET bonus_enabled = $2, bonus_earn_bps = $3, bonus_burn_max_bps = $4, bonus_earn_on_products = $5, certificate_valid_days = $6,
       bonus_expire_days = $7, loyalty_tiers = $8::jsonb WHERE id = $1`,
    [ctx.actor.tenantId, next.bonusEnabled, next.bonusEarnBps, next.bonusBurnMaxBps, next.bonusEarnOnProducts, next.certificateValidDays, next.bonusExpireDays, JSON.stringify(next.tiers)],
  );
  await audit(ctx, { entity: "tenant", entityId: ctx.actor.tenantId, action: "loyalty.settings_updated", diff: input });
  return next;
}

async function today(ctx: Ctx, branchId?: string | null) {
  const tz = branchId ? (await loadBranch(ctx, branchId)).timezone : "Europe/Moscow";
  return formatLocalDate(ctx.now, tz);
}

// ---------- Bonus points ----------

async function bonusMove(
  ctx: Ctx,
  clientId: string,
  kind: "earn" | "burn" | "clawback" | "burn_refund" | "manual" | "expire",
  delta: number,
  opts: { paymentId?: string | null; reason?: string | null; clamp?: boolean } = {},
) {
  const client = await one<{ bonus_balance: number }>(ctx.db, "SELECT bonus_balance FROM clients WHERE id = $1 FOR UPDATE", [clientId]);
  if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
  const balance = Number(client.bonus_balance);
  let applied = delta;
  if (balance + delta < 0) {
    // Clawback never pushes points below zero; spending more than the balance is an error.
    if (!opts.clamp) throw new AppError("VALIDATION", `Баллов не хватает: на счёте ${balance}`);
    applied = -balance;
  }
  if (applied === 0) return 0;
  await ctx.db.query("UPDATE clients SET bonus_balance = $2 WHERE id = $1", [clientId, balance + applied]);
  await ctx.db.query(
    `INSERT INTO bonus_ledger (id, tenant_id, client_id, kind, delta, balance_after, payment_id, reason, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
       -- Moves made in one request keep their order: never at or before the client's last move.
       GREATEST($10::timestamptz, (SELECT MAX(created_at) + interval '1 millisecond' FROM bonus_ledger WHERE client_id = $3)))`,
    [crypto.randomUUID(), ctx.actor.tenantId, clientId, kind, applied, balance + applied, opts.paymentId ?? null, opts.reason ?? null, ctx.actor.userId, ctx.now.toISOString()],
  );
  return applied;
}

/** Manual adjustment, admin+ with a reason. */
export async function adjustBonus(ctx: Ctx, clientId: string, input: { delta: number; reason?: string }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Начислять баллы вручную может администратор");
  const delta = Number(input.delta);
  if (!Number.isInteger(delta) || delta === 0) throw new AppError("VALIDATION", "Баллы: целое число, не ноль");
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new AppError("VALIDATION", "Укажите причину");
  await bonusMove(ctx, clientId, "manual", delta, { reason });
  await audit(ctx, { entity: "client", entityId: clientId, action: "loyalty.bonus_adjusted", diff: { delta, reason } });
  return clientLoyalty(ctx, clientId);
}

/** What the client holds: points, live certificates they own, memberships. */
export async function clientLoyalty(ctx: Ctx, clientId: string, opts: { appointmentId?: string } = {}) {
  const client = await one<{ id: string; bonus_balance: number }>(ctx.db, "SELECT id, bonus_balance FROM clients WHERE id = $1", [clientId]);
  if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
  const program = presentSettings(await settings(ctx));
  const memberships = await many<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE client_id = $1 ORDER BY status, valid_to DESC", [clientId]);
  const certificates = await many<CertificateRow>(
    ctx.db,
    "SELECT * FROM certificates WHERE client_id = $1 ORDER BY status, valid_to DESC",
    [clientId],
  );
  const ledger = await many<{ kind: string; delta: number; balance_after: number; reason: string | null; created_at: Date }>(
    ctx.db,
    "SELECT kind, delta, balance_after, reason, created_at FROM bonus_ledger WHERE client_id = $1 ORDER BY created_at DESC LIMIT 30",
    [clientId],
  );
  const date = formatLocalDate(ctx.now, "Europe/Moscow");
  let eligible: Set<string> | null = null;
  if (opts.appointmentId) {
    const services = await many<{ service_id: string | null }>(ctx.db, "SELECT service_id FROM appointment_services WHERE appointment_id = $1", [opts.appointmentId]);
    eligible = new Set(services.map((row) => row.service_id).filter(Boolean) as string[]);
  }
  const balance = Number(client.bonus_balance);
  const spendMinor = await clientSpend(ctx, clientId);
  const { current: tier, next: nextTier } = tierFor(program.tiers, spendMinor);
  // Points that burn within two weeks, so the desk can tell the client.
  const expiringSoon = program.bonusExpireDays && balance > 0
    ? await expiringPoints(ctx, clientId, new Date(ctx.now.getTime() - (program.bonusExpireDays - 14) * 86_400_000), balance)
    : 0;
  return {
    clientId,
    program,
    bonusBalance: balance,
    spendMinor,
    tier,
    nextTier: nextTier ? { ...nextTier, leftMinor: nextTier.minSpendMinor - spendMinor } : null,
    expiringSoon,
    memberships: memberships.map((row) => {
      const view = presentMembership(row, date);
      const fits = eligible ? !row.service_ids.length || row.service_ids.some((id) => eligible!.has(id)) : true;
      return { ...view, usableNow: view.state === "active" && fits };
    }),
    certificates: certificates.map((row) => presentCertificate(row, date)),
    ledger: ledger.map((row) => ({
      kind: row.kind,
      delta: Number(row.delta),
      balanceAfter: Number(row.balance_after),
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

// ---------- Certificates ----------

type CertificateRow = {
  id: string;
  code: string;
  nominal_minor: number;
  balance_minor: number;
  status: "active" | "void";
  valid_to: string | Date;
  client_id: string | null;
  voided_minor: number;
  void_reason: string | null;
  created_at: Date;
};

const dateText = (value: string | Date) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

function presentCertificate(row: CertificateRow, date: string) {
  const validTo = dateText(row.valid_to);
  const state = row.status === "void" ? "void" : validTo < date ? "expired" : Number(row.balance_minor) === 0 ? "used" : "active";
  return {
    id: row.id,
    code: row.code,
    nominalMinor: Number(row.nominal_minor),
    balanceMinor: Number(row.balance_minor),
    validTo,
    state,
    clientId: row.client_id,
    voidedMinor: Number(row.voided_minor),
    voidReason: row.void_reason,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function newCode() {
  // No 0/O/1/I so the code survives being read over the phone.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

export async function listCertificates(ctx: Ctx, filter: { q?: string } = {}) {
  assertDesk(ctx);
  const q = filter.q ? `%${normalizeCode(filter.q)}%` : null;
  const rows = await many<CertificateRow & { client_name: string | null }>(
    ctx.db,
    `SELECT c.*, cl.name AS client_name FROM certificates c LEFT JOIN clients cl ON cl.id = c.client_id
     WHERE $1::text IS NULL OR c.code LIKE $1 ORDER BY c.created_at DESC LIMIT 200`,
    [q],
  );
  const date = formatLocalDate(ctx.now, "Europe/Moscow");
  return rows.map((row) => ({ ...presentCertificate(row, date), clientName: row.client_name }));
}

export async function findCertificate(ctx: Ctx, code: string) {
  assertDesk(ctx);
  const row = await one<CertificateRow>(ctx.db, "SELECT * FROM certificates WHERE code = $1", [normalizeCode(code)]);
  if (!row) throw new AppError("NOT_FOUND", "Сертификат не найден");
  return presentCertificate(row, formatLocalDate(ctx.now, "Europe/Moscow"));
}

/** LOY-CERT-01: created by the sale line of a payment. */
async function issueCertificate(ctx: Ctx, input: { nominalMinor: number; clientId: string | null; paymentId: string; validDays: number; validFrom: string }) {
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode();
    const exists = await one<{ id: string }>(ctx.db, "SELECT id FROM certificates WHERE code = $1", [code]);
    if (exists) continue;
    await ctx.db.query(
      `INSERT INTO certificates (id, tenant_id, code, nominal_minor, balance_minor, valid_to, client_id, sold_payment_id, created_by)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)`,
      [id, ctx.actor.tenantId, code, input.nominalMinor, addCalendarDays(input.validFrom, input.validDays), input.clientId, input.paymentId, ctx.actor.userId],
    );
    return { id, code };
  }
  throw new AppError("VALIDATION", "Не получилось выпустить код, повторите");
}

/** LOY-CERT-03: owner only; only what is left on it is written off. */
export async function voidCertificate(ctx: Ctx, id: string, input: { reason?: string }) {
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Аннулирует сертификат владелец");
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new AppError("VALIDATION", "Укажите причину");
  const row = await one<CertificateRow>(ctx.db, "SELECT * FROM certificates WHERE id = $1 FOR UPDATE", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Сертификат не найден");
  if (row.status === "void") throw new AppError("VALIDATION", "Сертификат уже аннулирован");
  await ctx.db.query("UPDATE certificates SET status = 'void', voided_minor = balance_minor, balance_minor = 0, void_reason = $2 WHERE id = $1", [id, reason]);
  await audit(ctx, { entity: "certificate", entityId: id, action: "loyalty.certificate_voided", diff: { voidedMinor: Number(row.balance_minor), reason } });
  return findCertificateById(ctx, id);
}

async function findCertificateById(ctx: Ctx, id: string) {
  const row = await one<CertificateRow>(ctx.db, "SELECT * FROM certificates WHERE id = $1", [id]);
  return presentCertificate(row!, formatLocalDate(ctx.now, "Europe/Moscow"));
}

// ---------- Memberships ----------

type PlanRow = { id: string; title: string; visits: number; valid_days: number; price_minor: number; service_ids: string[]; active: boolean };
type MembershipRow = {
  id: string;
  plan_id: string;
  client_id: string;
  title: string;
  visits_total: number;
  visits_left: number;
  service_ids: string[];
  valid_from: string | Date;
  valid_to: string | Date;
  frozen_from: string | Date | null;
  frozen_to: string | Date | null;
  status: "active" | "cancelled";
};

function presentPlan(row: PlanRow) {
  return {
    id: row.id,
    title: row.title,
    visits: Number(row.visits),
    validDays: Number(row.valid_days),
    priceMinor: Number(row.price_minor),
    serviceIds: row.service_ids ?? [],
    active: row.active,
  };
}

function presentMembership(row: MembershipRow, date: string) {
  const validTo = dateText(row.valid_to);
  const frozenFrom = row.frozen_from ? dateText(row.frozen_from) : null;
  const frozenTo = row.frozen_to ? dateText(row.frozen_to) : null;
  const frozen = Boolean(frozenFrom && frozenTo && frozenFrom <= date && date <= frozenTo);
  const state =
    row.status === "cancelled" ? "cancelled" : validTo < date ? "expired" : Number(row.visits_left) === 0 ? "used" : frozen ? "frozen" : "active";
  return {
    id: row.id,
    planId: row.plan_id,
    clientId: row.client_id,
    title: row.title,
    visitsTotal: Number(row.visits_total),
    visitsLeft: Number(row.visits_left),
    serviceIds: row.service_ids ?? [],
    validFrom: dateText(row.valid_from),
    validTo,
    frozenFrom,
    frozenTo,
    state,
  };
}

function validatePlan(input: { title?: string; visits?: number; validDays?: number; priceMinor?: number; serviceIds?: string[] }) {
  const title = input.title?.trim() ?? "";
  if (!title) throw new AppError("VALIDATION", "Укажите название");
  const visits = Number(input.visits);
  if (!Number.isInteger(visits) || visits < 1 || visits > 1000) throw new AppError("VALIDATION", "Визитов: от 1 до 1000");
  const days = Number(input.validDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new AppError("VALIDATION", "Срок: от 1 до 3650 дней");
  const price = Number(input.priceMinor);
  if (!Number.isInteger(price) || price <= 0) throw new AppError("VALIDATION", "Цена абонемента больше нуля");
  return { title, visits, days, price, serviceIds: input.serviceIds ?? [] };
}

export async function listPlans(ctx: Ctx) {
  const rows = await many<PlanRow>(ctx.db, "SELECT * FROM membership_plans ORDER BY active DESC, title");
  return rows.map(presentPlan);
}

export async function createPlan(ctx: Ctx, input: { title?: string; visits?: number; validDays?: number; priceMinor?: number; serviceIds?: string[] }) {
  assertSetup(ctx);
  const plan = validatePlan(input);
  const id = crypto.randomUUID();
  await ctx.db.query(
    "INSERT INTO membership_plans (id, tenant_id, title, visits, valid_days, price_minor, service_ids) VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[])",
    [id, ctx.actor.tenantId, plan.title, plan.visits, plan.days, plan.price, plan.serviceIds],
  );
  await audit(ctx, { entity: "membership_plan", entityId: id, action: "loyalty.plan_created", diff: input });
  return presentPlan((await one<PlanRow>(ctx.db, "SELECT * FROM membership_plans WHERE id = $1", [id]))!);
}

export async function setPlanActive(ctx: Ctx, id: string, active: boolean) {
  assertSetup(ctx);
  const updated = await ctx.db.query("UPDATE membership_plans SET active = $2 WHERE id = $1", [id, active]);
  if (!updated.rowCount) throw new AppError("NOT_FOUND", "Абонемент не найден");
  return presentPlan((await one<PlanRow>(ctx.db, "SELECT * FROM membership_plans WHERE id = $1", [id]))!);
}

export async function listMemberships(ctx: Ctx) {
  assertDesk(ctx);
  const rows = await many<MembershipRow & { client_name: string }>(
    ctx.db,
    "SELECT m.*, c.name AS client_name FROM client_memberships m JOIN clients c ON c.id = m.client_id ORDER BY m.created_at DESC LIMIT 200",
  );
  const date = formatLocalDate(ctx.now, "Europe/Moscow");
  return rows.map((row) => ({ ...presentMembership(row, date), clientName: row.client_name }));
}

/** LOY-SUB-03: freeze moves the end date by the frozen days; extend adds days with a reason. */
export async function freezeMembership(ctx: Ctx, id: string, input: { from: string; to: string; reason?: string }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new AppError("VALIDATION", "Укажите причину");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(input.to ?? "") || input.to < input.from) {
    throw new AppError("VALIDATION", "Даты заморозки: с и по");
  }
  const row = await one<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE id = $1 FOR UPDATE", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Абонемент не найден");
  if (row.status !== "active") throw new AppError("VALIDATION", "Абонемент не активен");
  if (row.frozen_from) throw new AppError("VALIDATION", "Абонемент уже замораживали");
  const days = Math.round((Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86400000) + 1;
  if (days > 90) throw new AppError("VALIDATION", "Заморозка не дольше 90 дней");
  const validTo = addCalendarDays(dateText(row.valid_to), days);
  await ctx.db.query("UPDATE client_memberships SET frozen_from = $2, frozen_to = $3, valid_to = $4 WHERE id = $1", [id, input.from, input.to, validTo]);
  await audit(ctx, { entity: "membership", entityId: id, action: "loyalty.membership_frozen", diff: { from: input.from, to: input.to, days, validTo, reason } });
  return membershipById(ctx, id);
}

export async function extendMembership(ctx: Ctx, id: string, input: { days: number; reason?: string }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new AppError("VALIDATION", "Укажите причину");
  const days = Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new AppError("VALIDATION", "Продлить можно на 1–365 дней");
  const row = await one<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE id = $1 FOR UPDATE", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Абонемент не найден");
  if (row.status !== "active") throw new AppError("VALIDATION", "Абонемент не активен");
  const validTo = addCalendarDays(dateText(row.valid_to), days);
  await ctx.db.query("UPDATE client_memberships SET valid_to = $2 WHERE id = $1", [id, validTo]);
  await audit(ctx, { entity: "membership", entityId: id, action: "loyalty.membership_extended", diff: { days, validTo, reason } });
  return membershipById(ctx, id);
}

async function membershipById(ctx: Ctx, id: string) {
  const row = await one<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE id = $1", [id]);
  return presentMembership(row!, formatLocalDate(ctx.now, "Europe/Moscow"));
}

// ---------- Selling certificates and memberships through the till ----------

export type SaleLine = { type: "loyalty"; refId: null; title: string; amountMinor: number; loyaltyKind: "certificate" | "membership"; planId?: string };

export async function certificateSaleLines(ctx: Ctx, nominalMinor: number): Promise<SaleLine[]> {
  if (!Number.isInteger(nominalMinor) || nominalMinor <= 0 || nominalMinor > 100_000_000) throw new AppError("VALIDATION", "Номинал сертификата больше нуля");
  return [{ type: "loyalty", refId: null, title: "Подарочный сертификат", amountMinor: nominalMinor, loyaltyKind: "certificate" }];
}

export async function membershipSaleLines(ctx: Ctx, planId: string, clientId: string | null): Promise<SaleLine[]> {
  if (!clientId) throw new AppError("VALIDATION", "Абонемент продаётся конкретному клиенту");
  const plan = await one<PlanRow>(ctx.db, "SELECT * FROM membership_plans WHERE id = $1", [planId]);
  if (!plan || !plan.active) throw new AppError("VALIDATION", "Абонемент не продаётся");
  return [{ type: "loyalty", refId: null, title: `Абонемент «${plan.title}»`, amountMinor: Number(plan.price_minor), loyaltyKind: "membership", planId }];
}

/** After the sale payment is inserted: issue the certificate or open the membership, point the line at it. */
export async function fulfilSale(ctx: Ctx, paymentId: string, branchId: string, clientId: string | null, lines: { lineId: string; line: SaleLine }[]) {
  const program = await settings(ctx);
  const date = await today(ctx, branchId);
  const issued: { kind: string; id: string; code?: string }[] = [];
  for (const { lineId, line } of lines) {
    if (line.loyaltyKind === "certificate") {
      const cert = await issueCertificate(ctx, { nominalMinor: line.amountMinor, clientId, paymentId, validDays: Number(program.certificate_valid_days), validFrom: date });
      await ctx.db.query("UPDATE payment_lines SET ref_id = $2, title = $3 WHERE id = $1", [lineId, cert.id, `Сертификат ${cert.code}`]);
      issued.push({ kind: "certificate", id: cert.id, code: cert.code });
    } else {
      const plan = await one<PlanRow>(ctx.db, "SELECT * FROM membership_plans WHERE id = $1", [line.planId]);
      const id = crypto.randomUUID();
      await ctx.db.query(
        `INSERT INTO client_memberships (id, tenant_id, plan_id, client_id, title, visits_total, visits_left, service_ids, valid_from, valid_to, sold_payment_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7::uuid[],$8,$9,$10,$11)`,
        [id, ctx.actor.tenantId, plan!.id, clientId, plan!.title, Number(plan!.visits), plan!.service_ids, date, addCalendarDays(date, Number(plan!.valid_days) - 1), paymentId, ctx.actor.userId],
      );
      await ctx.db.query("UPDATE payment_lines SET ref_id = $2 WHERE id = $1", [lineId, id]);
      issued.push({ kind: "membership", id });
    }
  }
  if (issued.length) await audit(ctx, { branchId, entity: "payment", entityId: paymentId, action: "loyalty.sold", diff: { issued } });
  return issued;
}

// ---------- Loyalty tenders ----------

export type TenderInput = { method: string; amountMinor: number; certificateCode?: string; membershipId?: string };
export type ResolvedTender = { method: string; amountMinor: number; certificateId?: string | null; membershipId?: string | null };

/**
 * Validates non-money tenders before the payment is written (LOY-BONUS-BURN-01, LOY-CERT-02, LOY-SUB-02).
 * `bill` is what is being paid for without tips; `appointment` is set for visit payments.
 */
export async function resolveTenders(
  ctx: Ctx,
  input: {
    tenders: TenderInput[];
    branchId: string;
    clientId: string | null;
    bill: number;
    /** Visit payments: cap against the whole visit minus points already spent on it. */
    bonusBase?: { totalMinor: number; spentMinor: number };
    appointmentId: string | null;
    serviceDue?: { serviceId: string | null; dueMinor: number }[];
  },
): Promise<ResolvedTender[]> {
  const loyal = input.tenders.filter((tender) => isLoyaltyMethod(tender.method));
  if (!loyal.length) return input.tenders.map((tender) => ({ method: tender.method, amountMinor: tender.amountMinor }));
  const program = await settings(ctx);
  const date = await today(ctx, input.branchId);
  const resolved: ResolvedTender[] = [];
  const bonusTotal = loyal.filter((tender) => tender.method === "bonus").reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (bonusTotal > 0) {
    if (!program.bonus_enabled) throw new AppError("VALIDATION", "Бонусная программа выключена");
    if (!input.clientId) throw new AppError("VALIDATION", "Баллами платит клиент из базы");
    const client = await one<{ bonus_balance: number }>(ctx.db, "SELECT bonus_balance FROM clients WHERE id = $1", [input.clientId]);
    if (bonusTotal > Number(client?.bonus_balance ?? 0)) throw new AppError("VALIDATION", `Баллов не хватает: на счёте ${Number(client?.bonus_balance ?? 0)}`);
    const cap = input.bonusBase
      ? Math.max(0, Math.floor((input.bonusBase.totalMinor * Number(program.bonus_burn_max_bps)) / 10000) - input.bonusBase.spentMinor)
      : Math.floor((input.bill * Number(program.bonus_burn_max_bps)) / 10000);
    if (bonusTotal > cap) throw new AppError("VALIDATION", `Баллами можно оплатить не больше ${Number(program.bonus_burn_max_bps) / 100}% чека`, { maxBonusMinor: cap });
  }
  let membershipUsed = false;
  for (const tender of input.tenders) {
    if (tender.method === "certificate") {
      const cert = await one<CertificateRow>(ctx.db, "SELECT * FROM certificates WHERE code = $1", [normalizeCode(tender.certificateCode ?? "")]);
      if (!cert) throw new AppError("VALIDATION", "Сертификат не найден");
      const state = presentCertificate(cert, date).state;
      if (state === "void") throw new AppError("VALIDATION", "Сертификат аннулирован");
      if (state === "expired") throw new AppError("VALIDATION", "Срок сертификата истёк");
      if (tender.amountMinor > Number(cert.balance_minor)) {
        throw new AppError("VALIDATION", `На сертификате осталось ${Number(cert.balance_minor) / 100} ₽`, { balanceMinor: Number(cert.balance_minor) });
      }
      resolved.push({ method: "certificate", amountMinor: tender.amountMinor, certificateId: cert.id });
    } else if (tender.method === "membership") {
      if (membershipUsed) throw new AppError("VALIDATION", "Один абонемент — один визит за оплату");
      membershipUsed = true;
      if (!input.appointmentId) throw new AppError("VALIDATION", "Абонементом оплачивают визит");
      const row = await one<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE id = $1", [tender.membershipId ?? null]);
      if (!row || row.client_id !== input.clientId) throw new AppError("VALIDATION", "Абонемент не этого клиента");
      const view = presentMembership(row, date);
      if (view.state === "used") throw new AppError("VALIDATION", "Визиты по абонементу закончились. Примите обычную оплату");
      if (view.state !== "active") throw new AppError("VALIDATION", view.state === "frozen" ? "Абонемент заморожен" : view.state === "expired" ? "Срок абонемента истёк" : "Абонемент не активен");
      const fits = (input.serviceDue ?? []).filter((line) => line.dueMinor > 0 && (!row.service_ids.length || (line.serviceId && row.service_ids.includes(line.serviceId))));
      if (!fits.length) throw new AppError("VALIDATION", "Услуги этой записи не входят в абонемент");
      if (tender.amountMinor !== fits[0].dueMinor) {
        throw new AppError("VALIDATION", "Абонемент закрывает одну услугу целиком", { amountMinor: fits[0].dueMinor });
      }
      resolved.push({ method: "membership", amountMinor: tender.amountMinor, membershipId: row.id });
    } else {
      resolved.push({ method: tender.method, amountMinor: tender.amountMinor });
    }
  }
  return resolved;
}

type PostedPayment = { id: string; branch_id: string; client_id: string | null; direction: "in" | "out"; refund_of_id: string | null };

/** Earn on money paid for services (and products), never on tips, debt or loyalty products. */
async function earnBase(ctx: Ctx, paymentId: string, onProducts: boolean) {
  const row = await one<{ eligible: number; loyal: number }>(
    ctx.db,
    `SELECT (SELECT COALESCE(SUM(amount_minor), 0)::int FROM payment_lines WHERE payment_id = $1 AND line_type = ANY($2::text[])) AS eligible,
            (SELECT COALESCE(SUM(amount_minor), 0)::int FROM payment_tenders WHERE payment_id = $1 AND method IN ('bonus', 'certificate', 'membership')) AS loyal`,
    [paymentId, onProducts ? ["service", "deposit", "product"] : ["service", "deposit"]],
  );
  return Math.max(0, Number(row?.eligible ?? 0) - Number(row?.loyal ?? 0));
}

/** Spends and earns of a payment that was just written; refunds give back and claw back. */
export async function afterPaymentPosted(ctx: Ctx, paymentId: string) {
  const payment = await one<PostedPayment>(ctx.db, "SELECT id, branch_id, client_id, direction, refund_of_id FROM payments WHERE id = $1", [paymentId]);
  if (!payment) return;
  const tenders = await many<{ method: string; amount_minor: number; certificate_id: string | null; membership_id: string | null }>(
    ctx.db,
    "SELECT method, amount_minor, certificate_id, membership_id FROM payment_tenders WHERE payment_id = $1",
    [paymentId],
  );
  const sign = payment.direction === "in" ? -1 : 1;
  for (const tender of tenders) {
    const amount = Number(tender.amount_minor);
    if (!amount) continue;
    if (tender.method === "bonus" && payment.client_id) {
      await bonusMove(ctx, payment.client_id, payment.direction === "in" ? "burn" : "burn_refund", sign * amount, { paymentId });
    }
    if (tender.method === "certificate" && tender.certificate_id) {
      const cert = await one<CertificateRow>(ctx.db, "SELECT * FROM certificates WHERE id = $1 FOR UPDATE", [tender.certificate_id]);
      const next = Number(cert!.balance_minor) + sign * amount;
      if (next < 0) throw new AppError("VALIDATION", "На сертификате не хватает средств");
      // A refund back onto a voided certificate stays voided: the money is accounted as written off.
      if (cert!.status === "void" && payment.direction === "out") {
        await ctx.db.query("UPDATE certificates SET voided_minor = voided_minor + $2 WHERE id = $1", [cert!.id, amount]);
      } else {
        await ctx.db.query("UPDATE certificates SET balance_minor = $2 WHERE id = $1", [cert!.id, Math.min(next, Number(cert!.nominal_minor))]);
      }
    }
    if (tender.method === "membership" && tender.membership_id) {
      const row = await one<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE id = $1 FOR UPDATE", [tender.membership_id]);
      if (payment.direction === "in") {
        if (Number(row!.visits_left) <= 0) throw new AppError("VALIDATION", "Визиты по абонементу закончились");
        await ctx.db.query("UPDATE client_memberships SET visits_left = visits_left - 1 WHERE id = $1", [row!.id]);
      } else {
        // The visit comes back once the membership share of the original is refunded in full.
        const net = await one<{ s: number }>(
          ctx.db,
          `SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN t.amount_minor ELSE -t.amount_minor END), 0)::int AS s
           FROM payment_tenders t JOIN payments p ON p.id = t.payment_id
           WHERE t.membership_id = $1 AND p.status IN ('posted', 'refunded') AND (p.id = $2 OR p.refund_of_id = $2)`,
          [row!.id, payment.refund_of_id],
        );
        if (Number(net?.s ?? 0) <= 0 && Number(row!.visits_left) < Number(row!.visits_total)) {
          await ctx.db.query("UPDATE client_memberships SET visits_left = visits_left + 1 WHERE id = $1", [row!.id]);
        }
      }
    }
  }

  const program = await settings(ctx);
  if (payment.direction === "in") {
    if (program.bonus_enabled && payment.client_id) {
      // LOY-TIER-01: the tier reached with this payment sets the rate.
      const { current: tier } = tierFor(presentSettings(program).tiers, await clientSpend(ctx, payment.client_id));
      const bps = tier ? tier.earnBps : Number(program.bonus_earn_bps);
      const base = bps > 0 ? await earnBase(ctx, paymentId, program.bonus_earn_on_products) : 0;
      const points = Math.floor((base * bps) / 10000);
      if (points > 0) await bonusMove(ctx, payment.client_id, "earn", points, { paymentId, reason: `${bps / 100}% от оплаты${tier ? ` · ${tier.title}` : ""}` });
    }
    return;
  }

  // Refund of a sold certificate or membership.
  const soldLines = await many<{ ref_id: string | null; amount_minor: number; title: string; refund_of_line_id: string | null }>(
    ctx.db,
    "SELECT ref_id, amount_minor, title, refund_of_line_id FROM payment_lines WHERE payment_id = $1 AND line_type = 'loyalty'",
    [paymentId],
  );
  for (const line of soldLines) {
    if (!line.ref_id) continue;
    const cert = await one<CertificateRow>(ctx.db, "SELECT * FROM certificates WHERE id = $1 FOR UPDATE", [line.ref_id]);
    if (cert) {
      if (Number(line.amount_minor) > Number(cert.balance_minor)) {
        throw new AppError("VALIDATION", `Вернуть можно не больше остатка сертификата: ${Number(cert.balance_minor) / 100} ₽`);
      }
      const left = Number(cert.balance_minor) - Number(line.amount_minor);
      await ctx.db.query("UPDATE certificates SET balance_minor = $2, status = CASE WHEN $2 = 0 THEN 'void' ELSE status END, void_reason = CASE WHEN $2 = 0 THEN 'Возврат покупки' ELSE void_reason END WHERE id = $1", [
        cert.id,
        left,
      ]);
      continue;
    }
    const membership = await one<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE id = $1 FOR UPDATE", [line.ref_id]);
    if (membership) {
      if (Number(membership.visits_left) < Number(membership.visits_total)) {
        throw new AppError("VALIDATION", "По абонементу уже были визиты — вернуть покупку целиком нельзя. Оформите возврат на сумму неиспользованных визитов как прочий расход");
      }
      await ctx.db.query("UPDATE client_memberships SET status = 'cancelled' WHERE id = $1", [membership.id]);
    }
  }

  // Claw back points earned on the original, in proportion to the money refunded.
  if (payment.refund_of_id && payment.client_id) {
    const earned = await one<{ s: number }>(
      ctx.db,
      "SELECT COALESCE(SUM(delta), 0)::int AS s FROM bonus_ledger WHERE payment_id = $1 AND kind = 'earn'",
      [payment.refund_of_id],
    );
    const points = Number(earned?.s ?? 0);
    if (points > 0) {
      const origBase = await earnBase(ctx, payment.refund_of_id, program.bonus_earn_on_products);
      const refundBase = await earnBase(ctx, paymentId, program.bonus_earn_on_products);
      const taken = await one<{ s: number }>(
        ctx.db,
        `SELECT COALESCE(-SUM(l.delta), 0)::int AS s FROM bonus_ledger l JOIN payments p ON p.id = l.payment_id
         WHERE p.refund_of_id = $1 AND l.kind = 'clawback'`,
        [payment.refund_of_id],
      );
      const due = origBase > 0 ? Math.min(points - Number(taken?.s ?? 0), Math.round((points * refundBase) / origBase)) : 0;
      if (due > 0) await bonusMove(ctx, payment.client_id, "clawback", -due, { paymentId, clamp: true, reason: "Возврат оплаты" });
    }
  }
}

/** A voided payment undoes everything it did: points, certificate or membership it sold. */
export async function afterPaymentVoided(ctx: Ctx, paymentId: string) {
  const payment = await one<PostedPayment>(ctx.db, "SELECT id, branch_id, client_id, direction, refund_of_id FROM payments WHERE id = $1", [paymentId]);
  if (!payment) return;
  const earned = await many<{ client_id: string; delta: number }>(ctx.db, "SELECT client_id, delta FROM bonus_ledger WHERE payment_id = $1 AND kind = 'earn'", [paymentId]);
  for (const row of earned) await bonusMove(ctx, row.client_id, "clawback", -Number(row.delta), { paymentId, clamp: true, reason: "Аннулирование" });
  const sold = await many<{ ref_id: string | null }>(ctx.db, "SELECT ref_id FROM payment_lines WHERE payment_id = $1 AND line_type = 'loyalty'", [paymentId]);
  for (const line of sold) {
    if (!line.ref_id) continue;
    const cert = await one<CertificateRow>(ctx.db, "SELECT * FROM certificates WHERE id = $1 FOR UPDATE", [line.ref_id]);
    if (cert) {
      if (Number(cert.balance_minor) < Number(cert.nominal_minor)) throw new AppError("VALIDATION", "Сертификатом уже расплачивались — оформите возврат");
      await ctx.db.query("UPDATE certificates SET status = 'void', balance_minor = 0, void_reason = 'Аннулирование продажи' WHERE id = $1", [cert.id]);
    }
    const membership = await one<MembershipRow>(ctx.db, "SELECT * FROM client_memberships WHERE id = $1 FOR UPDATE", [line.ref_id]);
    if (membership) {
      if (Number(membership.visits_left) < Number(membership.visits_total)) throw new AppError("VALIDATION", "По абонементу уже были визиты — оформите возврат");
      await ctx.db.query("UPDATE client_memberships SET status = 'cancelled' WHERE id = $1", [membership.id]);
    }
  }
}

// ---------- Promo codes (LOY-PROMO-01) ----------

type PromoRow = {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  service_ids: string[];
  min_check_minor: number;
  max_uses: number | null;
  per_phone_limit: number | null;
  online_only: boolean;
  active: boolean;
};

function presentPromo(row: PromoRow & { uses?: number }) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    value: Number(row.value),
    validFrom: row.valid_from ? dateText(row.valid_from) : null,
    validTo: row.valid_to ? dateText(row.valid_to) : null,
    serviceIds: row.service_ids ?? [],
    minCheckMinor: Number(row.min_check_minor),
    maxUses: row.max_uses === null ? null : Number(row.max_uses),
    perPhoneLimit: row.per_phone_limit === null ? null : Number(row.per_phone_limit),
    onlineOnly: row.online_only,
    active: row.active,
    uses: Number(row.uses ?? 0),
  };
}

export async function listPromos(ctx: Ctx) {
  assertSetup(ctx);
  const rows = await many<PromoRow & { uses: number }>(
    ctx.db,
    `SELECT p.*, (SELECT COUNT(*)::int FROM promo_redemptions r WHERE r.promo_id = p.id AND r.released_at IS NULL) AS uses
     FROM promo_codes p ORDER BY p.active DESC, p.created_at DESC`,
  );
  return rows.map(presentPromo);
}

export async function createPromo(
  ctx: Ctx,
  input: {
    code?: string;
    kind?: "percent" | "fixed";
    value?: number;
    validFrom?: string | null;
    validTo?: string | null;
    serviceIds?: string[];
    minCheckMinor?: number;
    maxUses?: number | null;
    perPhoneLimit?: number | null;
    onlineOnly?: boolean;
  },
) {
  assertSetup(ctx);
  const code = normalizeCode(input.code ?? "");
  if (!/^[A-Z0-9-]{3,32}$/.test(code)) throw new AppError("VALIDATION", "Промокод: 3–32 символа, латиница, цифры и дефис");
  if (input.kind !== "percent" && input.kind !== "fixed") throw new AppError("VALIDATION", "Скидка: процент или сумма");
  const value = Number(input.value);
  if (!Number.isInteger(value) || value <= 0 || (input.kind === "percent" && value > 10000)) throw new AppError("VALIDATION", "Размер скидки указан неверно");
  for (const [v, label] of [[input.maxUses, "Лимит применений"], [input.perPhoneLimit, "Лимит на телефон"]] as const) {
    if (v !== undefined && v !== null && (!Number.isInteger(Number(v)) || Number(v) < 1)) throw new AppError("VALIDATION", `${label}: целое число от 1`);
  }
  if (input.validFrom && input.validTo && input.validTo < input.validFrom) throw new AppError("VALIDATION", "Дата окончания раньше начала");
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO promo_codes (id, tenant_id, code, kind, value, valid_from, valid_to, service_ids, min_check_minor, max_uses, per_phone_limit, online_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10,$11,$12)`,
    [
      id,
      ctx.actor.tenantId,
      code,
      input.kind,
      value,
      input.validFrom || null,
      input.validTo || null,
      input.serviceIds ?? [],
      Number(input.minCheckMinor ?? 0),
      input.maxUses ?? null,
      input.perPhoneLimit ?? null,
      Boolean(input.onlineOnly),
    ],
  );
  await audit(ctx, { entity: "promo_code", entityId: id, action: "loyalty.promo_created", diff: { ...input, code } });
  return presentPromo((await one<PromoRow>(ctx.db, "SELECT * FROM promo_codes WHERE id = $1", [id]))!);
}

export async function setPromoActive(ctx: Ctx, id: string, active: boolean) {
  assertSetup(ctx);
  const updated = await ctx.db.query("UPDATE promo_codes SET active = $2 WHERE id = $1", [id, active]);
  if (!updated.rowCount) throw new AppError("NOT_FOUND", "Промокод не найден");
  return presentPromo((await one<PromoRow>(ctx.db, "SELECT * FROM promo_codes WHERE id = $1", [id]))!);
}

/** Applies a promo to an unpaid visit: rewrites the service prices, keeps the originals to undo. */
export async function applyPromo(ctx: Ctx, appointmentId: string, rawCode: string, opts: { online?: boolean } = {}) {
  if (!opts.online && !isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const appt = await one<{ id: string; branch_id: string; client_id: string | null; status: string; starts_at: Date }>(
    ctx.db,
    "SELECT id, branch_id, client_id, status, starts_at FROM appointments WHERE id = $1 FOR UPDATE",
    [appointmentId],
  );
  if (!appt) throw new AppError("NOT_FOUND", "Запись не найдена");
  const branch = await loadBranch(ctx, appt.branch_id);
  if (["cancelled", "completed", "no_show"].includes(appt.status)) throw new AppError("VALIDATION", "Промокод применяют до визита");
  const paid = await one<{ n: number }>(ctx.db, "SELECT COUNT(*)::int AS n FROM payments WHERE appointment_id = $1 AND status IN ('posted', 'refunded')", [appointmentId]);
  if (Number(paid?.n ?? 0) > 0) throw new AppError("VALIDATION", "По записи уже есть оплата — промокод применяют до оплаты");
  const live = await one<{ id: string }>(ctx.db, "SELECT id FROM promo_redemptions WHERE appointment_id = $1 AND released_at IS NULL", [appointmentId]);
  if (live) throw new AppError("VALIDATION", "К записи уже применён промокод");

  const promo = await one<PromoRow>(ctx.db, "SELECT * FROM promo_codes WHERE code = $1 FOR UPDATE", [normalizeCode(rawCode)]);
  const invalid = (message: string) => new AppError("VALIDATION", message, { reason: "PROMO_INVALID" });
  if (!promo || !promo.active) throw invalid("Промокод не найден");
  if (promo.online_only && !opts.online) throw invalid("Промокод действует только при онлайн-записи");
  const visitDay = formatLocalDate(new Date(appt.starts_at), branch.timezone);
  if (promo.valid_from && visitDay < dateText(promo.valid_from)) throw invalid("Промокод ещё не действует");
  if (promo.valid_to && visitDay > dateText(promo.valid_to)) throw invalid("Срок промокода истёк");
  if (promo.max_uses !== null) {
    const used = await one<{ n: number }>(ctx.db, "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_id = $1 AND released_at IS NULL", [promo.id]);
    if (Number(used?.n ?? 0) >= Number(promo.max_uses)) throw invalid("Промокод больше не действует: лимит исчерпан");
  }
  const phone = appt.client_id
    ? (await one<{ phone_e164: string }>(ctx.db, "SELECT phone_e164 FROM client_phones WHERE client_id = $1 ORDER BY is_primary DESC LIMIT 1", [appt.client_id]))?.phone_e164 ?? null
    : null;
  if (promo.per_phone_limit !== null) {
    if (!phone) throw invalid("Для этого промокода нужен телефон клиента");
    const mine = await one<{ n: number }>(
      ctx.db,
      "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_id = $1 AND phone_e164 = $2 AND released_at IS NULL",
      [promo.id, phone],
    );
    if (Number(mine?.n ?? 0) >= Number(promo.per_phone_limit)) throw invalid("Этот промокод по вашему номеру уже использован");
  }
  const services = await many<{ id: string; service_id: string | null; price_minor: number }>(
    ctx.db,
    "SELECT id, service_id, price_minor FROM appointment_services WHERE appointment_id = $1 ORDER BY position",
    [appointmentId],
  );
  const total = services.reduce((sum, row) => sum + Number(row.price_minor), 0);
  if (total < Number(promo.min_check_minor)) throw invalid(`Промокод действует от ${Number(promo.min_check_minor) / 100} ₽`);
  const eligible = services.filter((row) => !promo.service_ids.length || (row.service_id && promo.service_ids.includes(row.service_id)));
  const eligibleSum = eligible.reduce((sum, row) => sum + Number(row.price_minor), 0);
  if (!eligibleSum) throw invalid("Промокод не действует на эти услуги");
  const discount = promo.kind === "percent" ? Math.round((eligibleSum * Number(promo.value)) / 10000) : Math.min(Number(promo.value), eligibleSum);
  // Spread the discount over eligible services in proportion to price; the last one takes the rounding.
  let left = discount;
  for (const [index, row] of eligible.entries()) {
    const share = index === eligible.length - 1 ? left : Math.round((discount * Number(row.price_minor)) / eligibleSum);
    left -= share;
    await ctx.db.query("UPDATE appointment_services SET price_before_promo_minor = price_minor, price_minor = price_minor - $2 WHERE id = $1", [row.id, share]);
  }
  await ctx.db.query(
    "INSERT INTO promo_redemptions (id, tenant_id, promo_id, appointment_id, phone_e164, discount_minor) VALUES ($1,$2,$3,$4,$5,$6)",
    [crypto.randomUUID(), ctx.actor.tenantId, promo.id, appointmentId, phone, discount],
  );
  await ctx.db.query("UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = $1", [appointmentId]);
  await audit(ctx, { branchId: appt.branch_id, entity: "appointment", entityId: appointmentId, action: "loyalty.promo_applied", diff: { code: promo.code, discountMinor: discount } });
  return { code: promo.code, discountMinor: discount, priceMinor: total - discount };
}

/** Removes the promo (by hand, or because the visit was cancelled or re-planned) and restores the prices. */
export async function releasePromo(ctx: Ctx, appointmentId: string, opts: { restorePrices?: boolean; reason?: string } = {}) {
  const live = await one<{ id: string }>(ctx.db, "SELECT id FROM promo_redemptions WHERE appointment_id = $1 AND released_at IS NULL FOR UPDATE", [appointmentId]);
  if (!live) return false;
  if (opts.restorePrices !== false) {
    await ctx.db.query(
      "UPDATE appointment_services SET price_minor = price_before_promo_minor, price_before_promo_minor = NULL WHERE appointment_id = $1 AND price_before_promo_minor IS NOT NULL",
      [appointmentId],
    );
  }
  await ctx.db.query("UPDATE promo_redemptions SET released_at = $2 WHERE id = $1", [live.id, ctx.now.toISOString()]);
  await audit(ctx, { entity: "appointment", entityId: appointmentId, action: "loyalty.promo_released", diff: { reason: opts.reason ?? null } });
  return true;
}

export async function removePromo(ctx: Ctx, appointmentId: string) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const paid = await one<{ n: number }>(ctx.db, "SELECT COUNT(*)::int AS n FROM payments WHERE appointment_id = $1 AND status IN ('posted', 'refunded')", [appointmentId]);
  if (Number(paid?.n ?? 0) > 0) throw new AppError("VALIDATION", "По записи уже есть оплата");
  if (!(await releasePromo(ctx, appointmentId, { reason: "снят вручную" }))) throw new AppError("VALIDATION", "Промокод не применён");
  await ctx.db.query("UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = $1", [appointmentId]);
  return { ok: true };
}
