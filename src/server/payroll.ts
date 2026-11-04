import { AppError } from "@/domain/errors";
import { addCalendarDays, formatLocalDate, isoWeekday, localDayUtcRange, todayInZone } from "@/domain/time";
import { isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import { materialsCost } from "./inventory";
import type { Ctx } from "./types";

type Scheme = "percent" | "fixed_per_service" | "salary" | "hybrid";
type PeriodUnit = "month" | "biweekly" | "week" | "shift";
type Base = "service_price" | "paid_amount" | "price_after_discount";
type PeriodStatus = "draft" | "calculated" | "approved" | "paid" | "locked";

type RuleRow = {
  id: string;
  staff_id: string | null;
  service_id: string | null;
  scheme: Scheme;
  percent_bps: number;
  fixed_minor: number;
  salary_minor: number;
  period_unit: PeriodUnit;
  base: Base;
  include_tips: boolean;
  deduct_materials: boolean;
  guarantee: boolean;
  valid_from: string;
  valid_to: string | null;
};

type PeriodRow = {
  id: string;
  branch_id: string;
  starts_on: string;
  ends_on: string;
  status: PeriodStatus;
  warnings: Warning[];
};

type Warning = { code: "NO_RULE" | "UNPAID" | "FORCED_OVERLAP" | "NEGATIVE_TOTAL"; message: string; staffId?: string; appointmentId?: string };

type LineInput = {
  type: "service" | "salary" | "tip" | "refund_clawback" | "group";
  appointmentId?: string | null;
  groupEventId?: string | null;
  appointmentServiceId?: string | null;
  serviceId?: string | null;
  ruleId?: string | null;
  title: string;
  occurredOn?: string | null;
  baseAmountMinor?: number;
  rateSnapshot?: Record<string, unknown>;
  resultMinor: number;
};

const SETUP_ROLES = ["owner", "admin", "accountant", "super"];
const MONEY_ROLES = ["owner", "accountant", "super"];

function assertRoles(ctx: Ctx, roles: string[]) {
  if (!roles.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Недостаточно прав");
}

function toDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function assertDate(value: unknown, label: string): string {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new AppError("VALIDATION", `${label}: дата в формате ГГГГ-ММ-ДД`);
  return text;
}

function ruDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function daysInMonth(date: string) {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function plural(n: number, one: string, few: string, many: string) {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

const rub = (minor: number) => `${new Intl.NumberFormat("ru-RU").format(Math.round(minor / 100)).replace(/\u00a0/g, " ")} ₽`;

/**
 * PAYROLL-SHIFT-01: the days each master worked in the branch. A day counts when the schedule has it as a
 * working day (weekly template or special hours, minus days off and vacation) and it has already come,
 * or when the master completed a visit that day even off schedule.
 */
async function shiftDays(ctx: Ctx, branchId: string, startsOn: string, endsOn: string, tz: string, from: string, to: string) {
  const templates = await many<{ staff_id: string; weekday: number }>(
    ctx.db,
    "SELECT DISTINCT staff_id, weekday FROM schedule_templates WHERE branch_id = $1 AND kind = 'work'",
    [branchId],
  );
  const exceptions = await many<{ staff_id: string; starts_on: string | Date; ends_on: string | Date; kind: string }>(
    ctx.db,
    "SELECT staff_id, starts_on, ends_on, kind FROM schedule_exceptions WHERE branch_id = $1 AND starts_on <= $3 AND ends_on >= $2",
    [branchId, startsOn, endsOn],
  );
  const visits = await many<{ staff_id: string; completed_at: Date }>(
    ctx.db,
    "SELECT staff_id, completed_at FROM appointments WHERE branch_id = $1 AND status = 'completed' AND completed_at >= $2 AND completed_at < $3",
    [branchId, from, to],
  );
  const last = [endsOn, todayInZone(tz, ctx.now)].sort()[0];
  const weekly = new Map<string, Set<number>>();
  for (const row of templates) weekly.set(row.staff_id, (weekly.get(row.staff_id) ?? new Set()).add(Number(row.weekday)));
  const result = new Map<string, Set<string>>();
  const add = (staffId: string, day: string) => result.set(staffId, (result.get(staffId) ?? new Set()).add(day));
  const staffIds = new Set([...weekly.keys(), ...exceptions.map((row) => row.staff_id)]);
  for (const staffId of staffIds) {
    const own = exceptions.filter((row) => row.staff_id === staffId).map((row) => ({ from: toDate(row.starts_on), to: toDate(row.ends_on), kind: row.kind }));
    for (let day = startsOn; day <= last; day = addCalendarDays(day, 1)) {
      const hit = own.filter((row) => row.from <= day && row.to >= day);
      if (hit.some((row) => row.kind === "day_off" || row.kind === "vacation")) continue;
      if (hit.some((row) => row.kind === "special_hours") || weekly.get(staffId)?.has(isoWeekday(day))) add(staffId, day);
    }
  }
  for (const row of visits) add(row.staff_id, formatLocalDate(new Date(row.completed_at), tz));
  return new Map([...result].map(([staffId, set]) => [staffId, [...set].sort()]));
}

// ---------- Rules (PAYROLL-RULE-01) ----------

function presentRule(row: RuleRow) {
  return {
    id: row.id,
    staffId: row.staff_id,
    serviceId: row.service_id,
    scheme: row.scheme,
    percentBps: Number(row.percent_bps),
    fixedMinor: Number(row.fixed_minor),
    salaryMinor: Number(row.salary_minor),
    periodUnit: row.period_unit,
    base: row.base,
    includeTips: row.include_tips,
    deductMaterials: row.deduct_materials,
    guarantee: row.guarantee,
    validFrom: toDate(row.valid_from),
    validTo: row.valid_to ? toDate(row.valid_to) : null,
  };
}

export async function listRules(ctx: Ctx) {
  assertRoles(ctx, SETUP_ROLES);
  const rows = await many<RuleRow>(ctx.db, "SELECT * FROM payroll_rules ORDER BY staff_id NULLS FIRST, service_id NULLS FIRST, valid_from");
  return rows.map(presentRule);
}

type RuleInput = {
  staffId?: string | null;
  serviceId?: string | null;
  scheme: Scheme;
  percentBps?: number;
  fixedMinor?: number;
  salaryMinor?: number;
  periodUnit?: PeriodUnit;
  base?: Base;
  includeTips?: boolean;
  deductMaterials?: boolean;
  guarantee?: boolean;
  validFrom: string;
  validTo?: string | null;
};

function validateRule(input: RuleInput) {
  if (!["percent", "fixed_per_service", "salary", "hybrid"].includes(input.scheme)) throw new AppError("VALIDATION", "Неизвестная схема оплаты");
  const bps = Number(input.percentBps ?? 0);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new AppError("VALIDATION", "Процент: от 0 до 100");
  for (const [value, label] of [[input.fixedMinor, "Фикс за услугу"], [input.salaryMinor, "Оклад"]] as const) {
    const n = Number(value ?? 0);
    if (!Number.isInteger(n) || n < 0) throw new AppError("VALIDATION", `${label}: сумма в копейках ≥ 0`);
  }
  if ((input.scheme === "percent" || input.scheme === "hybrid") && bps === 0) throw new AppError("VALIDATION", "Укажите процент");
  if (input.scheme === "fixed_per_service" && !Number(input.fixedMinor)) throw new AppError("VALIDATION", "Укажите фикс за услугу");
  if (input.periodUnit && !["month", "biweekly", "week", "shift"].includes(input.periodUnit)) throw new AppError("VALIDATION", "Неизвестный период оклада");
  const perShift = input.periodUnit === "shift";
  if ((input.scheme === "salary" || input.scheme === "hybrid") && !Number(input.salaryMinor)) throw new AppError("VALIDATION", perShift ? "Укажите ставку за выход" : "Укажите оклад");
  if (input.guarantee && input.scheme !== "hybrid") throw new AppError("VALIDATION", "«Не меньше ставки» бывает только у схемы «ставка + процент»");
  if ((input.scheme === "salary" || input.scheme === "hybrid") && input.serviceId) {
    throw new AppError("VALIDATION", "Оклад задаётся на мастера, а не на услугу");
  }
  if (input.serviceId && !input.staffId) throw new AppError("VALIDATION", "Правило на услугу задаётся для конкретного мастера");
  const from = assertDate(input.validFrom, "Действует с");
  const to = input.validTo ? assertDate(input.validTo, "Действует по") : null;
  if (to && to < from) throw new AppError("VALIDATION", "Дата окончания раньше начала");
  return { bps, from, to };
}

/** Rules at the same level whose dates intersect would make the calc ambiguous (edge 2). */
async function overlappingRules(ctx: Ctx, input: RuleInput, from: string, to: string | null, exceptId?: string) {
  return many<{ id: string }>(
    ctx.db,
    `SELECT id FROM payroll_rules
     WHERE staff_id IS NOT DISTINCT FROM $1 AND service_id IS NOT DISTINCT FROM $2
       AND id <> COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000')
       AND daterange(valid_from, valid_to, '[]') && daterange($3::date, $4::date, '[]')`,
    [input.staffId ?? null, input.serviceId ?? null, from, to, exceptId ?? null],
  );
}

export async function createRule(ctx: Ctx, input: RuleInput) {
  assertRoles(ctx, SETUP_ROLES);
  const { bps, from, to } = validateRule(input);
  if ((await overlappingRules(ctx, input, from, to)).length) {
    throw new AppError("VALIDATION", "На эти даты уже есть правило того же уровня. Закройте старое датой окончания");
  }
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO payroll_rules (id, tenant_id, staff_id, service_id, scheme, percent_bps, fixed_minor, salary_minor, period_unit, base, include_tips, valid_from, valid_to, deduct_materials, guarantee)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      ctx.actor.tenantId,
      input.staffId ?? null,
      input.serviceId ?? null,
      input.scheme,
      bps,
      Number(input.fixedMinor ?? 0),
      Number(input.salaryMinor ?? 0),
      input.periodUnit ?? "month",
      input.base ?? "service_price",
      input.includeTips ?? true,
      from,
      to,
      input.deductMaterials ?? false,
      input.scheme === "hybrid" ? (input.guarantee ?? false) : false,
    ],
  );
  await audit(ctx, { entity: "payroll_rule", entityId: id, action: "payroll.rule_created", diff: input });
  const row = await one<RuleRow>(ctx.db, "SELECT * FROM payroll_rules WHERE id = $1", [id]);
  return presentRule(row!);
}

export async function updateRule(ctx: Ctx, id: string, input: RuleInput) {
  assertRoles(ctx, SETUP_ROLES);
  const existing = await one<RuleRow>(ctx.db, "SELECT * FROM payroll_rules WHERE id = $1 FOR UPDATE", [id]);
  if (!existing) throw new AppError("NOT_FOUND", "Правило не найдено");
  const merged: RuleInput = { ...presentRule(existing), ...input };
  const { bps, from, to } = validateRule(merged);
  if ((await overlappingRules(ctx, merged, from, to, id)).length) {
    throw new AppError("VALIDATION", "На эти даты уже есть правило того же уровня. Закройте старое датой окончания");
  }
  await ctx.db.query(
    `UPDATE payroll_rules SET staff_id = $2, service_id = $3, scheme = $4, percent_bps = $5, fixed_minor = $6, salary_minor = $7,
       period_unit = $8, base = $9, include_tips = $10, valid_from = $11, valid_to = $12, deduct_materials = $13, guarantee = $14 WHERE id = $1`,
    [
      id,
      merged.staffId ?? null,
      merged.serviceId ?? null,
      merged.scheme,
      bps,
      Number(merged.fixedMinor ?? 0),
      Number(merged.salaryMinor ?? 0),
      merged.periodUnit ?? "month",
      merged.base ?? "service_price",
      merged.includeTips ?? true,
      from,
      to,
      merged.deductMaterials ?? false,
      merged.scheme === "hybrid" ? (merged.guarantee ?? false) : false,
    ],
  );
  await audit(ctx, { entity: "payroll_rule", entityId: id, action: "payroll.rule_updated", diff: { before: presentRule(existing), after: merged } });
  return presentRule((await one<RuleRow>(ctx.db, "SELECT * FROM payroll_rules WHERE id = $1", [id]))!);
}

/** A rule already used in a settled period is closed with valid_to instead of being deleted. */
export async function deleteRule(ctx: Ctx, id: string) {
  assertRoles(ctx, SETUP_ROLES);
  const existing = await one<RuleRow>(ctx.db, "SELECT * FROM payroll_rules WHERE id = $1 FOR UPDATE", [id]);
  if (!existing) throw new AppError("NOT_FOUND", "Правило не найдено");
  const used = await one<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*)::int AS n FROM payroll_lines l JOIN payroll_items i ON i.id = l.item_id JOIN payroll_periods p ON p.id = i.period_id
     WHERE l.rule_id = $1 AND p.status IN ('approved', 'paid', 'locked')`,
    [id],
  );
  if (Number(used?.n ?? 0) > 0) {
    const today = formatLocalDate(ctx.now, "Europe/Moscow");
    const end = today < toDate(existing.valid_from) ? toDate(existing.valid_from) : today;
    await ctx.db.query("UPDATE payroll_rules SET valid_to = $2 WHERE id = $1", [id, end]);
    await audit(ctx, { entity: "payroll_rule", entityId: id, action: "payroll.rule_closed", diff: { validTo: end } });
    return { id, outcome: "closed" as const, validTo: end };
  }
  await ctx.db.query("DELETE FROM payroll_rules WHERE id = $1", [id]);
  await audit(ctx, { entity: "payroll_rule", entityId: id, action: "payroll.rule_deleted", diff: presentRule(existing) });
  return { id, outcome: "deleted" as const };
}

/** staff+service → staff default → tenant default; two rules on the winning level is a hard error. */
function resolveRule(rules: RuleRow[], staffId: string, serviceId: string | null, date: string, label: string): RuleRow | null {
  const valid = rules.filter((rule) => toDate(rule.valid_from) <= date && (!rule.valid_to || toDate(rule.valid_to) >= date));
  const levels = [
    valid.filter((rule) => rule.staff_id === staffId && serviceId && rule.service_id === serviceId),
    valid.filter((rule) => rule.staff_id === staffId && !rule.service_id),
    valid.filter((rule) => !rule.staff_id && !rule.service_id),
  ];
  for (const level of levels) {
    if (level.length > 1) throw new AppError("VALIDATION", `Два правила оплаты на одну дату: ${label}. Оставьте одно`);
    if (level.length === 1) return level[0];
  }
  return null;
}

// ---------- Periods ----------

async function loadPeriod(ctx: Ctx, id: string, lock = false): Promise<PeriodRow> {
  const row = await one<PeriodRow>(
    ctx.db,
    `SELECT id, branch_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, status, warnings
     FROM payroll_periods WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!row) throw new AppError("NOT_FOUND", "Период не найден");
  await loadBranch(ctx, row.branch_id);
  return row;
}

export async function createPeriod(ctx: Ctx, input: { branchId: string; startsOn: string; endsOn: string }) {
  assertRoles(ctx, SETUP_ROLES);
  await loadBranch(ctx, input.branchId);
  const from = assertDate(input.startsOn, "Начало периода");
  const to = assertDate(input.endsOn, "Конец периода");
  if (to < from) throw new AppError("VALIDATION", "Конец периода раньше начала");
  if (daysBetween(from, to) > 62) throw new AppError("VALIDATION", "Период не длиннее двух месяцев");
  const id = crypto.randomUUID();
  await ctx.db.query(
    "INSERT INTO payroll_periods (id, tenant_id, branch_id, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, ctx.actor.tenantId, input.branchId, from, to, ctx.actor.userId],
  );
  await audit(ctx, { branchId: input.branchId, entity: "payroll_period", entityId: id, action: "payroll.period_created", diff: { from, to } });
  return getPeriod(ctx, id);
}

export async function listPeriods(ctx: Ctx, branchId: string) {
  await loadBranch(ctx, branchId);
  const master = ctx.actor.role === "master";
  if (!master) assertRoles(ctx, SETUP_ROLES);
  const rows = await many<PeriodRow & { total: number; payout: number; staff_count: number }>(
    ctx.db,
    `SELECT p.id, p.branch_id, to_char(p.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(p.ends_on, 'YYYY-MM-DD') AS ends_on, p.status, p.warnings,
            COALESCE(SUM(i.total_minor) FILTER (WHERE $2::uuid IS NULL OR i.staff_id = $2), 0)::int AS total,
            COALESCE(SUM(i.payout_minor) FILTER (WHERE $2::uuid IS NULL OR i.staff_id = $2), 0)::int AS payout,
            COUNT(i.id)::int AS staff_count
     FROM payroll_periods p LEFT JOIN payroll_items i ON i.period_id = p.id
     WHERE p.branch_id = $1 AND ($2::uuid IS NULL OR p.status IN ('approved', 'paid', 'locked'))
     GROUP BY p.id ORDER BY p.starts_on DESC`,
    [branchId, master ? (ctx.actor.staffId ?? "00000000-0000-0000-0000-000000000000") : null],
  );
  return rows.map((row) => ({
    id: row.id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    totalMinor: Number(row.total),
    payoutMinor: Number(row.payout),
    staffCount: Number(row.staff_count),
    warningCount: master ? 0 : (row.warnings ?? []).length,
  }));
}

/** Period sheet. A master sees only their own item, and only once it is approved (PAYROLL-VIEW-SELF-01). */
export async function getPeriod(ctx: Ctx, id: string) {
  const period = await loadPeriod(ctx, id);
  const master = ctx.actor.role === "master";
  if (master) {
    if (!["approved", "paid", "locked"].includes(period.status)) throw new AppError("FORBIDDEN", "Расчёт ещё не утверждён");
  } else {
    assertRoles(ctx, SETUP_ROLES);
  }
  const items = await many<{
    id: string;
    staff_id: string;
    staff_name: string;
    accrual_minor: number;
    deduction_minor: number;
    tip_minor: number;
    total_minor: number;
    payout_minor: number;
    carry_debt: boolean;
    status: string;
    paid_on: Date | null;
    paid_method: string | null;
    paid_reference: string | null;
  }>(
    ctx.db,
    `SELECT i.*, s.display_name AS staff_name FROM payroll_items i JOIN staff s ON s.id = i.staff_id
     WHERE i.period_id = $1 AND ($2::uuid IS NULL OR i.staff_id = $2)
     ORDER BY s.display_name, s.id`,
    [id, master ? (ctx.actor.staffId ?? "00000000-0000-0000-0000-000000000000") : null],
  );
  const lines = items.length
    ? await many<{
        id: string;
        item_id: string;
        type: string;
        manual: boolean;
        appointment_id: string | null;
        title: string;
        occurred_on: Date | null;
        base_amount_minor: number;
        rate_snapshot: Record<string, unknown>;
        result_minor: number;
        reason: string | null;
      }>(
        ctx.db,
        `SELECT id, item_id, type, manual, appointment_id, title, occurred_on, base_amount_minor, rate_snapshot, result_minor, reason
         FROM payroll_lines WHERE item_id = ANY($1::uuid[]) ORDER BY occurred_on NULLS LAST, created_at`,
        [items.map((item) => item.id)],
      )
    : [];
  return {
    id: period.id,
    branchId: period.branch_id,
    startsOn: period.starts_on,
    endsOn: period.ends_on,
    status: period.status,
    warnings: master ? [] : period.warnings ?? [],
    items: items.map((item) => ({
      id: item.id,
      staffId: item.staff_id,
      staffName: item.staff_name,
      accrualMinor: Number(item.accrual_minor),
      deductionMinor: Number(item.deduction_minor),
      tipMinor: Number(item.tip_minor),
      totalMinor: Number(item.total_minor),
      payoutMinor: Number(item.payout_minor),
      carryDebt: item.carry_debt,
      status: item.status,
      paidOn: item.paid_on ? toDate(item.paid_on) : null,
      paidMethod: item.paid_method,
      paidReference: item.paid_reference,
      lines: lines
        .filter((line) => line.item_id === item.id)
        .map((line) => ({
          id: line.id,
          type: line.type,
          manual: line.manual,
          appointmentId: line.appointment_id,
          title: line.title,
          occurredOn: line.occurred_on ? toDate(line.occurred_on) : null,
          baseAmountMinor: Number(line.base_amount_minor),
          rate: master ? pickRate(line.rate_snapshot) : line.rate_snapshot,
          resultMinor: Number(line.result_minor),
          reason: line.reason,
        })),
    })),
  };
}

/** The master sees the rate applied to their own line, not anything about other rules. */
function pickRate(snapshot: Record<string, unknown>) {
  const rate: Record<string, unknown> = { scheme: snapshot.scheme, percentBps: snapshot.percentBps, fixedMinor: snapshot.fixedMinor };
  if (snapshot.materialsMinor !== undefined) rate.materialsMinor = snapshot.materialsMinor;
  if (snapshot.periodUnit === "shift") Object.assign(rate, { periodUnit: "shift", shifts: snapshot.shifts, shiftDates: snapshot.shiftDates });
  return rate;
}

async function ensureItem(ctx: Ctx, periodId: string, staffId: string) {
  const existing = await one<{ id: string }>(ctx.db, "SELECT id FROM payroll_items WHERE period_id = $1 AND staff_id = $2", [periodId, staffId]);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await ctx.db.query("INSERT INTO payroll_items (id, tenant_id, period_id, staff_id) VALUES ($1,$2,$3,$4)", [
    id,
    ctx.actor.tenantId,
    periodId,
    staffId,
  ]);
  return id;
}

/** Totals: accrual = positive non-tip lines, deduction = negative lines, payout never below zero (edge 7). */
async function refreshItem(ctx: Ctx, itemId: string) {
  const sums = await one<{ accrual: number; deduction: number; tips: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(result_minor) FILTER (WHERE type <> 'tip' AND result_minor > 0), 0)::int AS accrual,
            COALESCE(-SUM(result_minor) FILTER (WHERE result_minor < 0), 0)::int AS deduction,
            COALESCE(SUM(result_minor) FILTER (WHERE type = 'tip' AND result_minor > 0), 0)::int AS tips
     FROM payroll_lines WHERE item_id = $1`,
    [itemId],
  );
  const accrual = Number(sums?.accrual ?? 0);
  const deduction = Number(sums?.deduction ?? 0);
  const tips = Number(sums?.tips ?? 0);
  const total = accrual + tips - deduction;
  await ctx.db.query(
    "UPDATE payroll_items SET accrual_minor = $2, deduction_minor = $3, tip_minor = $4, total_minor = $5, payout_minor = $6, carry_debt = $7 WHERE id = $1",
    [itemId, accrual, deduction, tips, total, Math.max(0, total), total < 0],
  );
  return total;
}

/** PAYROLL-CALC-01/02: rebuilds auto lines, keeps manual ones. */
export async function calculatePeriod(ctx: Ctx, periodId: string) {
  assertRoles(ctx, SETUP_ROLES);
  const period = await loadPeriod(ctx, periodId, true);
  if (!["draft", "calculated"].includes(period.status)) {
    throw new AppError("VALIDATION", "Период утверждён. Чтобы пересчитать, снимите утверждение");
  }
  const branch = await loadBranch(ctx, period.branch_id);
  const tz = branch.timezone;
  const from = localDayUtcRange(period.starts_on, tz).start.toISOString();
  const to = localDayUtcRange(addCalendarDays(period.ends_on, 1), tz).start.toISOString();
  const rules = await many<RuleRow>(ctx.db, "SELECT * FROM payroll_rules");
  const warnings: Warning[] = [];
  const byStaff = new Map<string, LineInput[]>();
  const push = (staffId: string, line: LineInput) => byStaff.set(staffId, [...(byStaff.get(staffId) ?? []), line]);

  // 1–2. Service lines of completed visits in the period.
  const services = await many<{
    appointment_id: string;
    appointment_service_id: string;
    service_id: string | null;
    title: string;
    price_minor: number;
    list_price_minor: number;
    staff_id: string;
    staff_name: string;
    completed_at: Date;
    force_overlap: boolean;
    appointment_price: number;
    paid_service: number;
    paid_deposit: number;
  }>(
    ctx.db,
    `SELECT a.id AS appointment_id, s.id AS appointment_service_id, s.service_id, s.title_snapshot AS title, s.price_minor,
            COALESCE(s.price_before_promo_minor, s.price_minor) AS list_price_minor,
            a.staff_id, st.display_name AS staff_name, a.completed_at, a.force_overlap,
            (SELECT COALESCE(SUM(price_minor), 0)::int FROM appointment_services WHERE appointment_id = a.id) AS appointment_price,
            (SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::int
               FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
               WHERE p.appointment_id = a.id AND p.status IN ('posted', 'refunded') AND pl.line_type = 'service' AND pl.ref_id = s.id) AS paid_service,
            (SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::int
               FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
               WHERE p.appointment_id = a.id AND p.status IN ('posted', 'refunded') AND pl.line_type = 'deposit') AS paid_deposit
     FROM appointments a
     JOIN appointment_services s ON s.appointment_id = a.id
     JOIN staff st ON st.id = a.staff_id
     WHERE a.branch_id = $1 AND a.status = 'completed' AND NOT a.exclude_from_payroll
       AND a.completed_at >= $2 AND a.completed_at < $3
     ORDER BY a.completed_at, s.position`,
    [branch.id, from, to],
  );
  const materials = await materialsCost(ctx, services.map((row) => row.appointment_service_id));
  const unpaidWarned = new Set<string>();
  for (const row of services) {
    const date = formatLocalDate(new Date(row.completed_at), tz);
    const price = Number(row.price_minor);
    const appointmentPrice = Number(row.appointment_price);
    const depositShare = appointmentPrice > 0 ? Math.round((Number(row.paid_deposit) * price) / appointmentPrice) : 0;
    const paid = Math.max(0, Math.min(price, Number(row.paid_service) + depositShare));
    if (row.force_overlap) {
      warnings.push({ code: "FORCED_OVERLAP", message: `${row.staff_name}: визит ${ruDate(date)} записан поверх другого`, staffId: row.staff_id, appointmentId: row.appointment_id });
    }
    if (paid <= 0 && !branch.accrue_on_complete_unpaid) {
      if (!unpaidWarned.has(row.appointment_id)) {
        unpaidWarned.add(row.appointment_id);
        warnings.push({ code: "UNPAID", message: `${row.staff_name}: визит ${ruDate(date)} завершён без оплаты и не начислен`, staffId: row.staff_id, appointmentId: row.appointment_id });
      }
      continue;
    }
    const rule = resolveRule(rules, row.staff_id, row.service_id, date, `${row.staff_name}, «${row.title}»`);
    if (!rule) {
      warnings.push({ code: "NO_RULE", message: `${row.staff_name}: нет правила оплаты для «${row.title}»`, staffId: row.staff_id, appointmentId: row.appointment_id });
      continue;
    }
    if (rule.scheme === "salary") continue;
    // service_price is the list price before a promo; price_after_discount is what the visit cost.
    const gross = rule.base === "paid_amount" ? paid : rule.base === "price_after_discount" ? price : Number(row.list_price_minor);
    // PAYROLL-SCHEME-05: the cost of materials comes off the base, never below zero.
    const materialsMinor = rule.deduct_materials ? (materials.get(row.appointment_service_id) ?? 0) : 0;
    const base = Math.max(0, gross - materialsMinor);
    const result =
      rule.scheme === "fixed_per_service" ? Number(rule.fixed_minor) : Math.round((base * Number(rule.percent_bps)) / 10000);
    push(row.staff_id, {
      type: "service",
      appointmentId: row.appointment_id,
      appointmentServiceId: row.appointment_service_id,
      serviceId: row.service_id,
      ruleId: rule.id,
      title: row.title,
      occurredOn: date,
      baseAmountMinor: base,
      rateSnapshot: {
        scheme: rule.scheme,
        percentBps: Number(rule.percent_bps),
        fixedMinor: Number(rule.fixed_minor),
        base: rule.base,
        ...(rule.deduct_materials ? { grossMinor: gross, materialsMinor } : {}),
      },
      resultMinor: result,
    });
  }

  // 3. Salary parts: a fixed salary prorated to the period length, or a rate per shift worked.
  const staff = await many<{ id: string; display_name: string }>(
    ctx.db,
    "SELECT s.id, s.display_name FROM staff s JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $1 WHERE s.active ORDER BY s.display_name",
    [branch.id],
  );
  const days = daysBetween(period.starts_on, period.ends_on);
  const shiftsOf = await shiftDays(ctx, branch.id, period.starts_on, period.ends_on, tz, from, to);
  for (const member of staff) {
    const rule = resolveRule(rules, member.id, null, period.ends_on, member.display_name);
    if (!rule || (rule.scheme !== "salary" && rule.scheme !== "hybrid")) continue;
    if (rule.period_unit === "shift") {
      // PAYROLL-SHIFT-01: rate × shifts worked, by the schedule plus any day with a completed visit.
      const worked = shiftsOf.get(member.id) ?? [];
      const rate = Number(rule.salary_minor);
      let amount = rate * worked.length;
      let title = `За выход: ${worked.length} ${plural(worked.length, "смена", "смены", "смен")} × ${rub(rate)}`;
      if (rule.guarantee) {
        // PAYROLL-SHIFT-02: percent, but not below the shift rate: only the shortfall is added.
        const earned = (byStaff.get(member.id) ?? []).filter((line) => line.type === "service").reduce((sum, line) => sum + line.resultMinor, 0);
        amount = Math.max(0, amount - earned);
        title = amount > 0 ? `Доплата до ставки за выход: ${worked.length} ${plural(worked.length, "смена", "смены", "смен")} × ${rub(rate)} = ${rub(rate * worked.length)}, процент ${rub(earned)}` : `Процент ${rub(earned)} больше ставки за ${worked.length} ${plural(worked.length, "выход", "выхода", "выходов")} (${rub(rate * worked.length)}), доплаты нет`;
      }
      push(member.id, {
        type: "salary",
        ruleId: rule.id,
        title,
        occurredOn: period.ends_on,
        baseAmountMinor: rate,
        rateSnapshot: { scheme: rule.scheme, salaryMinor: rate, periodUnit: "shift", shifts: worked.length, shiftDates: worked, guarantee: rule.guarantee },
        resultMinor: amount,
      });
      continue;
    }
    const unitDays = rule.period_unit === "week" ? 7 : rule.period_unit === "biweekly" ? 14 : daysInMonth(period.starts_on);
    const amount = Math.round((Number(rule.salary_minor) * Math.min(days, unitDays)) / unitDays);
    push(member.id, {
      type: "salary",
      ruleId: rule.id,
      title: days >= unitDays ? "Оклад" : `Оклад за ${days} из ${unitDays} дн.`,
      occurredOn: period.ends_on,
      baseAmountMinor: Number(rule.salary_minor),
      rateSnapshot: { scheme: rule.scheme, salaryMinor: Number(rule.salary_minor), periodUnit: rule.period_unit, days },
      resultMinor: amount,
    });
  }

  // 4. Tips posted in the period, net of refunded tips, for the visit's master.
  const tips = await many<{ staff_id: string; staff_name: string; net: number }>(
    ctx.db,
    `SELECT a.staff_id, st.display_name AS staff_name,
            COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::int AS net
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     JOIN appointments a ON a.id = p.appointment_id JOIN staff st ON st.id = a.staff_id
     WHERE p.branch_id = $1 AND p.status IN ('posted', 'refunded') AND pl.line_type = 'tip'
       AND p.posted_at >= $2 AND p.posted_at < $3
     GROUP BY a.staff_id, st.display_name`,
    [branch.id, from, to],
  );
  for (const row of tips) {
    const rule = resolveRule(rules, row.staff_id, null, period.ends_on, row.staff_name);
    if (rule && !rule.include_tips) continue;
    if (Number(row.net) === 0) continue;
    push(row.staff_id, { type: "tip", title: "Чаевые", occurredOn: period.ends_on, resultMinor: Number(row.net) });
  }

  // 6. Clawbacks: service refunds posted now against lines already settled in an approved/paid period.
  const refunds = await many<{
    refund_id: string;
    posted_at: Date;
    appointment_service_id: string;
    amount: number;
    staff_id: string;
    accrued_base: number;
    accrued_result: number;
    title: string;
    appointment_id: string;
  }>(
    ctx.db,
    `SELECT p.id AS refund_id, p.posted_at, pl.ref_id AS appointment_service_id, SUM(pl.amount_minor)::int AS amount,
            i.staff_id, SUM(DISTINCT l.base_amount_minor)::int AS accrued_base, SUM(DISTINCT l.result_minor)::int AS accrued_result,
            l.title, l.appointment_id
     FROM payments p
     JOIN payment_lines pl ON pl.payment_id = p.id AND pl.line_type = 'service'
     JOIN payroll_lines l ON l.appointment_service_id = pl.ref_id AND l.type = 'service'
     JOIN payroll_items i ON i.id = l.item_id
     JOIN payroll_periods pp ON pp.id = i.period_id AND pp.id <> $4 AND pp.status IN ('approved', 'paid', 'locked')
     WHERE p.branch_id = $1 AND p.direction = 'out' AND p.status = 'posted' AND p.posted_at >= $2 AND p.posted_at < $3
     GROUP BY p.id, p.posted_at, pl.ref_id, i.staff_id, l.title, l.appointment_id`,
    [branch.id, from, to, period.id],
  );
  for (const row of refunds) {
    const base = Number(row.accrued_base);
    const accrued = Number(row.accrued_result);
    if (accrued <= 0) continue;
    const back = base > 0 ? Math.min(accrued, Math.round((accrued * Number(row.amount)) / base)) : accrued;
    push(row.staff_id, {
      type: "refund_clawback",
      appointmentId: row.appointment_id,
      appointmentServiceId: row.appointment_service_id,
      title: `Сторно: возврат по «${row.title}»`,
      occurredOn: formatLocalDate(new Date(row.posted_at), tz),
      baseAmountMinor: Number(row.amount),
      rateSnapshot: { refundId: row.refund_id, accruedResultMinor: accrued, accruedBaseMinor: base },
      resultMinor: -back,
    });
  }

  // GRP-COMPLETE-01: host pay for group classes completed in the period.
  const groups = await many<{
    id: string;
    title: string;
    staff_id: string;
    starts_at: Date;
    host_pay_mode: "per_attendee" | "flat" | "percent";
    host_pay_minor: number;
    host_pay_bps: number;
    arrived: number;
    revenue: number;
  }>(
    ctx.db,
    `SELECT g.id, g.title, g.staff_id, g.starts_at, g.host_pay_mode, g.host_pay_minor, g.host_pay_bps,
            (SELECT count(*)::int FROM group_participants p WHERE p.event_id = g.id AND p.status = 'arrived') AS arrived,
            (SELECT COALESCE(SUM(CASE WHEN pay.direction = 'in' THEN pay.total_minor ELSE -pay.total_minor END), 0)::int
               FROM group_participants p JOIN payments pay ON pay.id = p.payment_id OR pay.refund_of_id = p.payment_id
               WHERE p.event_id = g.id AND pay.status IN ('posted', 'refunded')) AS revenue
     FROM group_events g
     WHERE g.branch_id = $1 AND g.status = 'completed' AND g.staff_id IS NOT NULL AND g.host_pay_mode <> 'none'
       AND g.completed_at >= $2 AND g.completed_at < $3
     ORDER BY g.starts_at`,
    [branch.id, from, to],
  );
  for (const row of groups) {
    const arrived = Number(row.arrived);
    const revenue = Math.max(0, Number(row.revenue));
    const result =
      row.host_pay_mode === "flat" ? Number(row.host_pay_minor)
      : row.host_pay_mode === "per_attendee" ? arrived * Number(row.host_pay_minor)
      : Math.round((revenue * Number(row.host_pay_bps)) / 10000);
    const how =
      row.host_pay_mode === "flat" ? "за занятие"
      : row.host_pay_mode === "per_attendee" ? `${arrived} × ${Number(row.host_pay_minor) / 100} ₽`
      : `${Number(row.host_pay_bps) / 100}% от ${revenue / 100} ₽`;
    if (result <= 0) continue;
    push(row.staff_id, {
      type: "group",
      groupEventId: row.id,
      title: `${row.title} (${how})`,
      occurredOn: formatLocalDate(new Date(row.starts_at), tz),
      baseAmountMinor: row.host_pay_mode === "percent" ? revenue : row.host_pay_mode === "per_attendee" ? arrived : 0,
      rateSnapshot: { mode: row.host_pay_mode, payMinor: Number(row.host_pay_minor), bps: Number(row.host_pay_bps), arrived, revenueMinor: revenue },
      resultMinor: result,
    });
  }

  // 5. Keep manual lines: drop only auto lines, then write the fresh ones.
  await ctx.db.query(
    "DELETE FROM payroll_lines WHERE manual = false AND item_id IN (SELECT id FROM payroll_items WHERE period_id = $1)",
    [period.id],
  );
  for (const [staffId, lines] of byStaff) {
    const itemId = await ensureItem(ctx, period.id, staffId);
    for (const line of lines) {
      await ctx.db.query(
        `INSERT INTO payroll_lines (id, tenant_id, item_id, type, manual, appointment_id, appointment_service_id, service_id, rule_id, title,
           occurred_on, base_amount_minor, rate_snapshot, result_minor, group_event_id)
         VALUES ($1,$2,$3,$4,false,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
        [
          crypto.randomUUID(),
          ctx.actor.tenantId,
          itemId,
          line.type,
          line.appointmentId ?? null,
          line.appointmentServiceId ?? null,
          line.serviceId ?? null,
          line.ruleId ?? null,
          line.title,
          line.occurredOn ?? null,
          line.baseAmountMinor ?? 0,
          JSON.stringify(line.rateSnapshot ?? {}),
          line.resultMinor,
          line.groupEventId ?? null,
        ],
      );
    }
  }
  const items = await many<{ id: string; staff_id: string; staff_name: string }>(
    ctx.db,
    "SELECT i.id, i.staff_id, s.display_name AS staff_name FROM payroll_items i JOIN staff s ON s.id = i.staff_id WHERE i.period_id = $1",
    [period.id],
  );
  for (const item of items) {
    const lineCount = await one<{ n: number }>(ctx.db, "SELECT COUNT(*)::int AS n FROM payroll_lines WHERE item_id = $1", [item.id]);
    if (!Number(lineCount?.n ?? 0)) {
      await ctx.db.query("DELETE FROM payroll_items WHERE id = $1", [item.id]);
      continue;
    }
    const total = await refreshItem(ctx, item.id);
    if (total < 0) warnings.push({ code: "NEGATIVE_TOTAL", message: `${item.staff_name}: итог отрицательный, к выплате 0, остаётся долг`, staffId: item.staff_id });
  }
  await ctx.db.query("UPDATE payroll_periods SET status = 'calculated', warnings = $2::jsonb, calculated_at = $3 WHERE id = $1", [
    period.id,
    JSON.stringify(warnings),
    ctx.now.toISOString(),
  ]);
  await audit(ctx, { branchId: branch.id, entity: "payroll_period", entityId: period.id, action: "payroll.calculated", diff: { warnings: warnings.length } });
  return getPeriod(ctx, period.id);
}

/** PAYROLL-ADJ-01: bonus / penalty / adjustment with a reason; survives recalculation. */
export async function addManualLine(
  ctx: Ctx,
  periodId: string,
  input: { staffId: string; type: "bonus" | "penalty" | "adjustment"; amountMinor: number; reason: string },
) {
  assertRoles(ctx, MONEY_ROLES);
  const period = await loadPeriod(ctx, periodId, true);
  if (!["draft", "calculated"].includes(period.status)) throw new AppError("VALIDATION", "Период утверждён — правки закрыты");
  if (!["bonus", "penalty", "adjustment"].includes(input.type)) throw new AppError("VALIDATION", "Тип: премия, штраф или корректировка");
  const amount = Number(input.amountMinor);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000_000) throw new AppError("VALIDATION", "Сумма в копейках, не ноль");
  if (input.type !== "adjustment" && amount < 0) throw new AppError("VALIDATION", "Сумма премии или штрафа положительная");
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new AppError("VALIDATION", "Укажите причину");
  const staff = await one<{ id: string; display_name: string }>(
    ctx.db,
    "SELECT s.id, s.display_name FROM staff s JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $2 WHERE s.id = $1",
    [input.staffId, period.branch_id],
  );
  if (!staff) throw new AppError("VALIDATION", "Мастер не работает в этом филиале");
  const itemId = await ensureItem(ctx, period.id, staff.id);
  const result = input.type === "penalty" ? -amount : amount;
  const titles = { bonus: "Премия", penalty: "Штраф", adjustment: "Корректировка" };
  await ctx.db.query(
    `INSERT INTO payroll_lines (id, tenant_id, item_id, type, manual, title, occurred_on, result_minor, reason, created_by)
     VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9)`,
    [crypto.randomUUID(), ctx.actor.tenantId, itemId, input.type, titles[input.type], period.ends_on, result, reason, ctx.actor.userId],
  );
  await refreshItem(ctx, itemId);
  await audit(ctx, { branchId: period.branch_id, entity: "payroll_period", entityId: period.id, action: `payroll.${input.type}`, diff: { staffId: staff.id, amountMinor: result, reason } });
  return getPeriod(ctx, period.id);
}

export async function removeManualLine(ctx: Ctx, periodId: string, lineId: string) {
  assertRoles(ctx, MONEY_ROLES);
  const period = await loadPeriod(ctx, periodId, true);
  if (!["draft", "calculated"].includes(period.status)) throw new AppError("VALIDATION", "Период утверждён — правки закрыты");
  const line = await one<{ item_id: string; manual: boolean }>(
    ctx.db,
    "SELECT l.item_id, l.manual FROM payroll_lines l JOIN payroll_items i ON i.id = l.item_id WHERE l.id = $1 AND i.period_id = $2",
    [lineId, periodId],
  );
  if (!line) throw new AppError("NOT_FOUND", "Строка не найдена");
  if (!line.manual) throw new AppError("VALIDATION", "Удалить можно только ручную строку");
  await ctx.db.query("DELETE FROM payroll_lines WHERE id = $1", [lineId]);
  await refreshItem(ctx, line.item_id);
  await audit(ctx, { branchId: period.branch_id, entity: "payroll_period", entityId: period.id, action: "payroll.manual_removed", diff: { lineId } });
  return getPeriod(ctx, period.id);
}

/** PAYROLL-APPROVE-01 */
export async function approvePeriod(ctx: Ctx, periodId: string) {
  assertRoles(ctx, MONEY_ROLES);
  const period = await loadPeriod(ctx, periodId, true);
  if (period.status !== "calculated") throw new AppError("VALIDATION", "Утвердить можно рассчитанный период");
  await ctx.db.query("UPDATE payroll_items SET status = 'approved' WHERE period_id = $1", [periodId]);
  await ctx.db.query("UPDATE payroll_periods SET status = 'approved', approved_by = $2, approved_at = $3 WHERE id = $1", [
    periodId,
    ctx.actor.userId,
    ctx.now.toISOString(),
  ]);
  await audit(ctx, { branchId: period.branch_id, entity: "payroll_period", entityId: periodId, action: "payroll.approved" });
  return getPeriod(ctx, periodId);
}

/** PAYROLL-APPROVE-02 */
export async function unapprovePeriod(ctx: Ctx, periodId: string) {
  assertRoles(ctx, MONEY_ROLES);
  const period = await loadPeriod(ctx, periodId, true);
  if (period.status !== "approved") throw new AppError("VALIDATION", "Снять утверждение можно только до выплаты");
  const paid = await one<{ n: number }>(ctx.db, "SELECT COUNT(*)::int AS n FROM payroll_items WHERE period_id = $1 AND status = 'paid'", [periodId]);
  if (Number(paid?.n ?? 0) > 0) throw new AppError("VALIDATION", "Часть выплат уже проведена — снять утверждение нельзя");
  await ctx.db.query("UPDATE payroll_items SET status = 'draft' WHERE period_id = $1", [periodId]);
  await ctx.db.query("UPDATE payroll_periods SET status = 'calculated', approved_by = NULL, approved_at = NULL WHERE id = $1", [periodId]);
  await audit(ctx, { branchId: period.branch_id, entity: "payroll_period", entityId: periodId, action: "payroll.unapproved" });
  return getPeriod(ctx, periodId);
}

/** PAYROLL-PAY-01: one master or everyone left; the period is paid once every item is. */
export async function payPeriod(
  ctx: Ctx,
  periodId: string,
  input: { staffId?: string | null; paidOn: string; method: "cash" | "transfer"; reference?: string },
) {
  assertRoles(ctx, MONEY_ROLES);
  const period = await loadPeriod(ctx, periodId, true);
  if (period.status !== "approved") throw new AppError("VALIDATION", "Выплатить можно утверждённый период");
  const paidOn = assertDate(input.paidOn, "Дата выплаты");
  if (!["cash", "transfer"].includes(input.method)) throw new AppError("VALIDATION", "Способ выплаты: наличные или перевод");
  const updated = await ctx.db.query(
    `UPDATE payroll_items SET status = 'paid', paid_on = $3, paid_method = $4, paid_reference = $5, paid_by = $6
     WHERE period_id = $1 AND status = 'approved' AND ($2::uuid IS NULL OR staff_id = $2) RETURNING id, staff_id, payout_minor`,
    [periodId, input.staffId ?? null, paidOn, input.method, input.reference?.trim() || null, ctx.actor.userId],
  );
  if (!updated.rowCount) throw new AppError("VALIDATION", "Нечего выплачивать");
  const left = await one<{ n: number }>(ctx.db, "SELECT COUNT(*)::int AS n FROM payroll_items WHERE period_id = $1 AND status <> 'paid'", [periodId]);
  if (!Number(left?.n ?? 0)) await ctx.db.query("UPDATE payroll_periods SET status = 'paid' WHERE id = $1", [periodId]);
  await audit(ctx, {
    branchId: period.branch_id,
    entity: "payroll_period",
    entityId: periodId,
    action: "payroll.paid",
    diff: { items: updated.rows.map((row) => ({ staffId: row.staff_id, payoutMinor: Number(row.payout_minor) })), paidOn, method: input.method },
  });
  return getPeriod(ctx, periodId);
}

/** PAYROLL-LOCK-01 */
export async function lockPeriod(ctx: Ctx, periodId: string) {
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Закрывает период владелец");
  const period = await loadPeriod(ctx, periodId, true);
  if (period.status !== "paid") throw new AppError("VALIDATION", "Закрыть можно полностью выплаченный период");
  await ctx.db.query("UPDATE payroll_periods SET status = 'locked', locked_at = $2 WHERE id = $1", [periodId, ctx.now.toISOString()]);
  await audit(ctx, { branchId: period.branch_id, entity: "payroll_period", entityId: periodId, action: "payroll.locked" });
  return getPeriod(ctx, periodId);
}

/** PAYROLL-ADJ-02 */
export async function setPayrollExclusion(ctx: Ctx, appointmentId: string, input: { exclude: boolean; reason?: string }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const row = await one<{ id: string; branch_id: string }>(ctx.db, "SELECT id, branch_id FROM appointments WHERE id = $1 FOR UPDATE", [appointmentId]);
  if (!row) throw new AppError("NOT_FOUND", "Запись не найдена");
  await loadBranch(ctx, row.branch_id);
  const reason = input.reason?.trim() ?? "";
  if (input.exclude && !reason) throw new AppError("VALIDATION", "Укажите причину");
  await ctx.db.query("UPDATE appointments SET exclude_from_payroll = $2, exclude_from_payroll_reason = $3, version = version + 1 WHERE id = $1", [
    appointmentId,
    input.exclude,
    input.exclude ? reason : null,
  ]);
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: appointmentId,
    action: input.exclude ? "payroll.excluded" : "payroll.included",
    diff: { reason: reason || null },
  });
  return { id: appointmentId, excludeFromPayroll: input.exclude };
}
