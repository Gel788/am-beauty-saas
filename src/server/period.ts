/**
 * Stage 5: looking beyond one day.
 * - TT-VIEW-04/05: the journal as a week (columns = days) or a month (calendar grid).
 * - AN-RANGE-01: a report for any period with filters and a comparison with the period before.
 * - AN-EXPORT-01: the same report as CSV, audited.
 * - MASTER-DAY-01: a master's own day on the phone.
 */
import { healthAlert } from "./techcard";
import { AppError } from "@/domain/errors";
import { addCalendarDays, formatLocalDate, formatLocalTime, localDayUtcRange, todayInZone } from "@/domain/time";
import { loadBranch } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import { loadWorkingIntervals } from "./hours";
import { LIVE_PAYMENT } from "./payments";
import type { Ctx } from "./types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_ROLES = ["owner", "admin", "accountant", "super"];

function days(from: string, to: string) {
  const list: string[] = [];
  for (let day = from; day <= to; day = addCalendarDays(day, 1)) list.push(day);
  return list;
}

function workMinutes(intervals: { startMin: number; endMin: number; kind: "work" | "break" }[]) {
  const work = intervals.filter((item) => item.kind === "work").reduce((sum, item) => sum + (item.endMin - item.startMin), 0);
  const breaks = intervals.filter((item) => item.kind === "break").reduce((sum, item) => sum + (item.endMin - item.startMin), 0);
  return Math.max(0, work - breaks);
}

// ------------------------------------------------------------------ Week / month journal

/** TT-VIEW-04/05: appointments of 1–42 days, grouped by local day, with load per day. */
export async function getCalendar(ctx: Ctx, input: { branchId: string; from: string; days: number; staffId?: string | null }) {
  if (ctx.actor.role === "accountant" || ctx.actor.role === "client") throw new AppError("FORBIDDEN", "Журнал недоступен для этой роли");
  if (!DATE.test(input.from)) throw new AppError("VALIDATION", "Дата в формате ГГГГ-ММ-ДД");
  const count = Math.min(42, Math.max(1, Math.floor(input.days || 7)));
  const branch = await loadBranch(ctx, input.branchId);
  const to = addCalendarDays(input.from, count - 1);
  const start = localDayUtcRange(input.from, branch.timezone).start;
  const end = localDayUtcRange(to, branch.timezone).end;
  let staffFilter = input.staffId ?? null;
  if (ctx.actor.role === "master" && !branch.master_sees_all_columns) staffFilter = ctx.actor.staffId;

  const staff = await many<{ id: string; display_name: string; color: string; active: boolean }>(
    ctx.db,
    `SELECT s.id, s.display_name, s.color, s.active FROM staff s JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $1
     WHERE ($2::uuid IS NULL OR s.id = $2) ORDER BY s.created_at, s.display_name`,
    [input.branchId, staffFilter],
  );
  const rows = await many<{ id: string; staff_id: string; starts_at: Date; ends_at: Date; status: string; source: string; client_name: string | null; title: string | null; price_minor: number }>(
    ctx.db,
    `SELECT a.id, a.staff_id, a.starts_at, a.ends_at, a.status, a.source, c.name AS client_name,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title,
            (SELECT COALESCE(SUM(price_minor), 0)::int FROM appointment_services WHERE appointment_id = a.id) AS price_minor
     FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.branch_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3 AND a.status <> 'cancelled' AND ($4::uuid IS NULL OR a.staff_id = $4)
     ORDER BY a.starts_at`,
    [input.branchId, start.toISOString(), end.toISOString(), staffFilter],
  );
  const staffById = new Map(staff.map((member) => [member.id, member]));
  const result = [];
  for (const day of days(input.from, to)) {
    const own = rows.filter((row) => formatLocalDate(new Date(row.starts_at), branch.timezone) === day);
    let available = 0;
    let working = 0;
    for (const member of staff) {
      if (!member.active) continue;
      const hours = await loadWorkingIntervals(ctx.db, input.branchId, member.id, day);
      const minutes = hours.dayOff ? 0 : workMinutes(hours.intervals);
      available += minutes;
      if (minutes > 0) working += 1;
    }
    const occupied = own.reduce((sum, row) => sum + Math.round((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 60000), 0);
    result.push({
      date: day,
      count: own.length,
      expectedMinor: own.filter((row) => row.status !== "no_show").reduce((sum, row) => sum + Number(row.price_minor), 0),
      loadPercent: available ? Math.round((100 * occupied) / available) : null,
      staffWorking: working,
      appointments: own.map((row) => ({
        id: row.id,
        time: formatLocalTime(new Date(row.starts_at), branch.timezone),
        endTime: formatLocalTime(new Date(row.ends_at), branch.timezone),
        staffId: row.staff_id,
        staffName: staffById.get(row.staff_id)?.display_name ?? "",
        color: staffById.get(row.staff_id)?.color ?? "#8a4fff",
        clientName: row.client_name,
        title: row.title ?? "",
        status: row.status,
        source: row.source,
        priceMinor: Number(row.price_minor),
      })),
    });
  }
  return {
    from: input.from,
    to,
    today: todayInZone(branch.timezone, ctx.now),
    timezone: branch.timezone,
    staff: staff.filter((member) => member.active).map((member) => ({ id: member.id, name: member.display_name, color: member.color })),
    days: result,
  };
}

// ------------------------------------------------------------------ Period report

export type PeriodFilter = { branchId: string; from: string; to: string; staffId?: string | null; serviceId?: string | null; source?: "admin" | "online" | null };

async function totals(ctx: Ctx, f: PeriodFilter, timezone: string) {
  const start = localDayUtcRange(f.from, timezone).start.toISOString();
  const end = localDayUtcRange(f.to, timezone).end.toISOString();
  // Money is posted payments; a staff/service/source filter keeps payments of matching visits only.
  const visitFilter = f.staffId || f.serviceId || f.source;
  const paymentScope = visitFilter
    ? `AND p.appointment_id IN (SELECT a.id FROM appointments a WHERE a.branch_id = $1
         AND ($4::uuid IS NULL OR a.staff_id = $4) AND ($6::text IS NULL OR a.source = $6)
         AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM appointment_services s WHERE s.appointment_id = a.id AND s.service_id = $5)))`
    : "";
  const params = [f.branchId, start, end, f.staffId ?? null, f.serviceId ?? null, f.source ?? null];
  const lines = await many<{ line_type: string; net: number }>(
    ctx.db,
    `SELECT pl.line_type, COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::bigint AS net
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.branch_id = $1 AND ${LIVE_PAYMENT} AND p.posted_at >= $2 AND p.posted_at < $3
       AND ($4::uuid IS NULL OR TRUE) AND ($5::uuid IS NULL OR TRUE) AND ($6::text IS NULL OR TRUE) ${paymentScope}
     GROUP BY pl.line_type`,
    params,
  );
  const sum = (types: string[]) => lines.filter((row) => types.includes(row.line_type)).reduce((acc, row) => acc + Number(row.net), 0);
  const appts = await one<{ total: number; completed: number; cancelled: number; no_show: number; online: number; clients: number; new_clients: number; minutes: number }>(
    ctx.db,
    `WITH v AS (
       SELECT a.* FROM appointments a
       WHERE a.branch_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
         AND ($4::uuid IS NULL OR a.staff_id = $4) AND ($6::text IS NULL OR a.source = $6)
         AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM appointment_services s WHERE s.appointment_id = a.id AND s.service_id = $5))
     )
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE status = 'no_show')::int AS no_show,
            count(*) FILTER (WHERE source = 'online')::int AS online,
            count(DISTINCT client_id) FILTER (WHERE status <> 'cancelled')::int AS clients,
            count(DISTINCT client_id) FILTER (WHERE status <> 'cancelled' AND NOT EXISTS (
              SELECT 1 FROM appointments e WHERE e.client_id = v.client_id AND e.starts_at < $2 AND e.status IN ('completed', 'arrived', 'in_progress')
            ) AND COALESCE((SELECT imported_visits FROM clients c WHERE c.id = v.client_id), 0) = 0)::int AS new_clients,
            COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60) FILTER (WHERE status NOT IN ('cancelled', 'no_show')), 0)::int AS minutes
     FROM v`,
    params,
  );
  const paidVisits = await one<{ n: number }>(
    ctx.db,
    `SELECT count(DISTINCT p.appointment_id)::int AS n FROM payments p
     WHERE p.branch_id = $1 AND ${LIVE_PAYMENT} AND p.direction = 'in' AND p.appointment_id IS NOT NULL AND p.posted_at >= $2 AND p.posted_at < $3
       AND ($4::uuid IS NULL OR TRUE) AND ($5::uuid IS NULL OR TRUE) AND ($6::text IS NULL OR TRUE) ${paymentScope}`,
    params,
  );
  const revenue = lines.reduce((acc, row) => acc + Number(row.net), 0);
  const services = sum(["service", "deposit"]);
  const products = sum(["product"]);
  return {
    revenueMinor: revenue,
    servicesMinor: services,
    productsMinor: products,
    tipsMinor: sum(["tip"]),
    debtRepaidMinor: sum(["debt"]),
    otherMinor: sum(["loyalty"]),
    averageCheckMinor: paidVisits?.n ? Math.round((services + products) / Number(paidVisits.n)) : 0,
    appointments: Number(appts?.total ?? 0),
    completed: Number(appts?.completed ?? 0),
    cancelled: Number(appts?.cancelled ?? 0),
    noShow: Number(appts?.no_show ?? 0),
    online: Number(appts?.online ?? 0),
    clients: Number(appts?.clients ?? 0),
    newClients: Number(appts?.new_clients ?? 0),
    bookedMinutes: Number(appts?.minutes ?? 0),
  };
}

function cleanFilter(input: Record<string, unknown>): PeriodFilter {
  const from = String(input.from ?? "");
  const to = String(input.to ?? "");
  if (!DATE.test(from) || !DATE.test(to)) throw new AppError("VALIDATION", "Период: даты в формате ГГГГ-ММ-ДД");
  if (to < from) throw new AppError("VALIDATION", "Конец периода раньше начала");
  if (days(from, to).length > 366) throw new AppError("VALIDATION", "Период не длиннее года");
  const uuid = (value: unknown) => (typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? value : null);
  return {
    branchId: String(input.branchId ?? ""),
    from,
    to,
    staffId: uuid(input.staffId),
    serviceId: uuid(input.serviceId),
    source: input.source === "online" || input.source === "admin" ? input.source : null,
  };
}

/** AN-RANGE-01. Masters get their own numbers only. */
export async function periodReport(ctx: Ctx, raw: Record<string, unknown>) {
  const filter = cleanFilter(raw);
  if (ctx.actor.role === "master") {
    if (!ctx.actor.staffId) throw new AppError("FORBIDDEN", "Недостаточно прав");
    filter.staffId = ctx.actor.staffId;
  } else if (!REPORT_ROLES.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const branch = await loadBranch(ctx, filter.branchId);
  const length = days(filter.from, filter.to).length;
  const previous = { ...filter, from: addCalendarDays(filter.from, -length), to: addCalendarDays(filter.from, -1) };
  const current = await totals(ctx, filter, branch.timezone);
  const before = await totals(ctx, previous, branch.timezone);

  const start = localDayUtcRange(filter.from, branch.timezone).start.toISOString();
  const end = localDayUtcRange(filter.to, branch.timezone).end.toISOString();
  const scopeParams = [filter.branchId, start, end, filter.staffId ?? null, filter.serviceId ?? null, filter.source ?? null, branch.timezone];
  const visitWhere = `a.branch_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
    AND ($4::uuid IS NULL OR a.staff_id = $4) AND ($6::text IS NULL OR a.source = $6)
    AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM appointment_services s WHERE s.appointment_id = a.id AND s.service_id = $5))`;

  // Day series: posted money by local day (all payments of the branch when no visit filter).
  const series = await many<{ day: string; net: number; visits: number }>(
    ctx.db,
    `WITH money AS (
       SELECT to_char(p.posted_at AT TIME ZONE $7, 'YYYY-MM-DD') AS day,
              SUM(CASE WHEN p.direction = 'in' THEN p.total_minor ELSE -p.total_minor END) AS net
       FROM payments p
       WHERE p.branch_id = $1 AND ${LIVE_PAYMENT} AND p.posted_at >= $2 AND p.posted_at < $3
         AND (($4::uuid IS NULL AND $5::uuid IS NULL AND $6::text IS NULL) OR p.appointment_id IN (SELECT a.id FROM appointments a WHERE ${visitWhere}))
       GROUP BY 1
     ), visits AS (
       SELECT to_char(a.starts_at AT TIME ZONE $7, 'YYYY-MM-DD') AS day, count(*) AS visits
       FROM appointments a WHERE ${visitWhere} AND a.status NOT IN ('cancelled', 'no_show') GROUP BY 1
     )
     SELECT COALESCE(m.day, v.day) AS day, COALESCE(m.net, 0)::bigint AS net, COALESCE(v.visits, 0)::int AS visits
     FROM money m FULL JOIN visits v ON v.day = m.day ORDER BY 1`,
    scopeParams,
  );
  const byDay = new Map(series.map((row) => [row.day, row]));

  const byStaff = await many<{ staff_id: string; name: string; visits: number; minutes: number; services_minor: number; tips_minor: number; no_show: number }>(
    ctx.db,
    `SELECT s.id AS staff_id, s.display_name AS name,
            count(DISTINCT a.id) FILTER (WHERE a.status NOT IN ('cancelled', 'no_show'))::int AS visits,
            COALESCE(SUM(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60) FILTER (WHERE a.status NOT IN ('cancelled', 'no_show')), 0)::int AS minutes,
            count(DISTINCT a.id) FILTER (WHERE a.status = 'no_show')::int AS no_show,
            COALESCE((SELECT SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END)
              FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id JOIN appointments x ON x.id = p.appointment_id
              WHERE x.staff_id = s.id AND x.branch_id = $1 AND x.starts_at >= $2 AND x.starts_at < $3 AND ${LIVE_PAYMENT}
                AND pl.line_type IN ('service', 'deposit')), 0)::bigint AS services_minor,
            COALESCE((SELECT SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END)
              FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id JOIN appointments x ON x.id = p.appointment_id
              WHERE x.staff_id = s.id AND x.branch_id = $1 AND x.starts_at >= $2 AND x.starts_at < $3 AND ${LIVE_PAYMENT}
                AND pl.line_type = 'tip'), 0)::bigint AS tips_minor
     FROM appointments a JOIN staff s ON s.id = a.staff_id
     WHERE ${visitWhere}
     GROUP BY s.id, s.display_name ORDER BY services_minor DESC, visits DESC`,
    scopeParams.slice(0, 6),
  );
  const loadByStaff = new Map<string, number>();
  for (const row of byStaff) {
    let available = 0;
    for (const day of days(filter.from, filter.to)) {
      const hours = await loadWorkingIntervals(ctx.db, filter.branchId, row.staff_id, day);
      if (!hours.dayOff) available += workMinutes(hours.intervals);
    }
    loadByStaff.set(row.staff_id, available ? Math.round((100 * Number(row.minutes)) / available) : 0);
  }

  const topServices = await many<{ service_id: string; title: string; n: number; price_minor: number }>(
    ctx.db,
    `SELECT s.service_id, MIN(s.title_snapshot) AS title, count(*)::int AS n, COALESCE(SUM(s.price_minor), 0)::bigint AS price_minor
     FROM appointment_services s JOIN appointments a ON a.id = s.appointment_id
     WHERE ${visitWhere} AND a.status NOT IN ('cancelled', 'no_show')
     GROUP BY s.service_id ORDER BY n DESC, price_minor DESC LIMIT 10`,
    scopeParams.slice(0, 6),
  );
  const sources = await many<{ source: string; n: number }>(
    ctx.db,
    `SELECT COALESCE(c.source, 'без клиента') AS source, count(DISTINCT a.client_id)::int AS n
     FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
     WHERE ${visitWhere} AND a.status <> 'cancelled' GROUP BY 1 ORDER BY n DESC`,
    scopeParams.slice(0, 6),
  );
  const change = (now: number, was: number) => (was ? Math.round(((now - was) / Math.abs(was)) * 100) : null);
  return {
    branchName: branch.name,
    currency: branch.currency,
    filter,
    previous: { from: previous.from, to: previous.to },
    current,
    before,
    change: {
      revenue: change(current.revenueMinor, before.revenueMinor),
      averageCheck: change(current.averageCheckMinor, before.averageCheckMinor),
      appointments: change(current.appointments, before.appointments),
      clients: change(current.clients, before.clients),
    },
    days: days(filter.from, filter.to).map((day) => ({ date: day, revenueMinor: Number(byDay.get(day)?.net ?? 0), visits: Number(byDay.get(day)?.visits ?? 0) })),
    staff: byStaff.map((row) => ({
      staffId: row.staff_id,
      name: row.name,
      visits: Number(row.visits),
      servicesMinor: Number(row.services_minor),
      tipsMinor: Number(row.tips_minor),
      noShow: Number(row.no_show),
      loadPercent: loadByStaff.get(row.staff_id) ?? 0,
    })),
    services: topServices.map((row) => ({ serviceId: row.service_id, title: row.title, count: Number(row.n), priceMinor: Number(row.price_minor) })),
    sources: sources.map((row) => ({ source: row.source, clients: Number(row.n) })),
  };
}

const SOURCE_LABEL: Record<string, string> = { "walk-in": "с улицы / админ", online: "онлайн-запись", import: "перенесены", admin: "админ" };

function csvCell(value: string | number) {
  const text = String(value);
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const rub = (minor: number) => (minor / 100).toFixed(2).replace(".", ",");

/** AN-EXPORT-01: the report as CSV for Excel (`;`, BOM, rubles with a comma). Every export is audited. */
export async function periodReportCsv(ctx: Ctx, raw: Record<string, unknown>) {
  const report = await periodReport(ctx, raw);
  const rows: (string | number)[][] = [
    ["Отчёт за период", `${report.filter.from} — ${report.filter.to}`, report.branchName],
    [],
    ["Показатель", "Период", "Предыдущий период"],
    ["Выручка, ₽", rub(report.current.revenueMinor), rub(report.before.revenueMinor)],
    ["Услуги, ₽", rub(report.current.servicesMinor), rub(report.before.servicesMinor)],
    ["Товары, ₽", rub(report.current.productsMinor), rub(report.before.productsMinor)],
    ["Чаевые, ₽", rub(report.current.tipsMinor), rub(report.before.tipsMinor)],
    ["Средний чек, ₽", rub(report.current.averageCheckMinor), rub(report.before.averageCheckMinor)],
    ["Записей", report.current.appointments, report.before.appointments],
    ["Завершено", report.current.completed, report.before.completed],
    ["Отмены", report.current.cancelled, report.before.cancelled],
    ["Неявки", report.current.noShow, report.before.noShow],
    ["Клиентов", report.current.clients, report.before.clients],
    ["Новых клиентов", report.current.newClients, report.before.newClients],
    [],
    ["День", "Выручка, ₽", "Визитов"],
    ...report.days.map((day) => [day.date, rub(day.revenueMinor), day.visits]),
    [],
    ["Мастер", "Визитов", "Услуги, ₽", "Чаевые, ₽", "Неявки", "Загрузка, %"],
    ...report.staff.map((row) => [row.name, row.visits, rub(row.servicesMinor), rub(row.tipsMinor), row.noShow, row.loadPercent]),
    [],
    ["Услуга", "Раз", "По прайсу, ₽"],
    ...report.services.map((row) => [row.title, row.count, rub(row.priceMinor)]),
    [],
    ["Откуда клиенты", "Клиентов"],
    ...report.sources.map((row) => [SOURCE_LABEL[row.source] ?? row.source, row.clients]),
  ];
  await audit(ctx, { branchId: report.filter.branchId, entity: "report", entityId: report.filter.branchId, action: "report.exported", diff: report.filter });
  return {
    fileName: `otchet_${report.filter.from}_${report.filter.to}.csv`,
    body: `﻿${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}\r\n`,
  };
}

// ------------------------------------------------------------------ Master's day on the phone

/** MASTER-DAY-01: the master's own appointments for a day, with client notes and today's money. */
export async function masterDay(ctx: Ctx, input: { date?: string; branchId?: string | null }) {
  if (ctx.actor.role !== "master" || !ctx.actor.staffId) throw new AppError("FORBIDDEN", "Экран для мастера");
  const staffId = ctx.actor.staffId;
  const branchRow = input.branchId
    ? { branch_id: input.branchId }
    : await one<{ branch_id: string }>(ctx.db, "SELECT branch_id FROM staff_branches WHERE staff_id = $1 ORDER BY branch_id LIMIT 1", [staffId]);
  if (!branchRow) throw new AppError("NOT_FOUND", "Мастер не привязан к филиалу");
  const branch = await loadBranch(ctx, ctx.actor.branchId ?? branchRow.branch_id);
  const date = input.date && DATE.test(input.date) ? input.date : todayInZone(branch.timezone, ctx.now);
  const range = localDayUtcRange(date, branch.timezone);
  const rows = await many<{ id: string; version: number; starts_at: Date; ends_at: Date; status: string; comment: string; client_id: string | null; client_name: string | null; client_notes: string | null; allergies: string | null; contraindications: string | null; last_formula: string | null; phone: string | null; title: string | null; price_minor: number; visits: number }>(
    ctx.db,
    `SELECT a.id, a.version, a.starts_at, a.ends_at, a.status, a.comment, a.client_id, c.name AS client_name, c.notes AS client_notes, c.allergies, c.contraindications,
            (SELECT f.body FROM client_formulas f WHERE f.client_id = a.client_id AND f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT 1) AS last_formula,
            (SELECT phone_e164 FROM client_phones p WHERE p.client_id = c.id AND p.deleted_at IS NULL ORDER BY p.is_primary DESC LIMIT 1) AS phone,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title,
            (SELECT COALESCE(SUM(price_minor), 0)::int FROM appointment_services WHERE appointment_id = a.id) AS price_minor,
            (SELECT count(*)::int FROM appointments v WHERE v.client_id = a.client_id AND v.status = 'completed' AND v.starts_at < a.starts_at)
              + COALESCE(c.imported_visits, 0) AS visits
     FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.staff_id = $1 AND a.branch_id = $2 AND a.starts_at >= $3 AND a.starts_at < $4 AND a.status <> 'cancelled'
     ORDER BY a.starts_at`,
    [staffId, branch.id, range.start.toISOString(), range.end.toISOString()],
  );
  const money = await one<{ services: number; tips: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END) FILTER (WHERE pl.line_type IN ('service', 'deposit')), 0)::bigint AS services,
            COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END) FILTER (WHERE pl.line_type = 'tip'), 0)::bigint AS tips
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id JOIN appointments a ON a.id = p.appointment_id
     WHERE a.staff_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3 AND ${LIVE_PAYMENT}`,
    [staffId, range.start.toISOString(), range.end.toISOString()],
  );
  const hours = await loadWorkingIntervals(ctx.db, branch.id, staffId, date);
  const next = await many<{ day: string; n: number }>(
    ctx.db,
    `SELECT to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM appointments a
     WHERE a.staff_id = $1 AND a.starts_at >= $2 AND a.status IN ('scheduled', 'confirmed')
     GROUP BY 1 ORDER BY 1 LIMIT 6`,
    [staffId, range.end.toISOString(), branch.timezone],
  );
  const nowMs = ctx.now.getTime();
  return {
    date,
    today: todayInZone(branch.timezone, ctx.now),
    branchId: branch.id,
    branchName: branch.name,
    staffName: ctx.actor.name,
    dayOff: hours.dayOff,
    hours: hours.intervals,
    servicesMinor: Number(money?.services ?? 0),
    tipsMinor: Number(money?.tips ?? 0),
    expectedMinor: rows.filter((row) => row.status !== "no_show").reduce((sum, row) => sum + Number(row.price_minor), 0),
    appointments: rows.map((row) => ({
      id: row.id,
      version: Number(row.version),
      time: formatLocalTime(new Date(row.starts_at), branch.timezone),
      endTime: formatLocalTime(new Date(row.ends_at), branch.timezone),
      status: row.status,
      now: new Date(row.starts_at).getTime() <= nowMs && new Date(row.ends_at).getTime() > nowMs,
      clientId: row.client_id,
      clientName: row.client_name,
      clientNotes: row.client_notes ?? "",
      // CL-TECH-04: the master sees allergies and the last formula before the client sits down.
      alert: healthAlert(row.allergies, row.contraindications),
      lastFormula: row.last_formula,
      phone: row.phone,
      firstVisit: Number(row.visits) === 0,
      visits: Number(row.visits),
      title: row.title ?? "",
      comment: row.comment,
      priceMinor: Number(row.price_minor),
    })),
    upcoming: next.map((row) => ({ date: row.day, count: Number(row.n) })),
  };
}
