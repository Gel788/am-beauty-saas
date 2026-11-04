import { randomUUID } from "node:crypto";
import { AppError } from "@/domain/errors";
import { planById } from "@/domain/plans";
import { assertPlatform, platformTenants } from "./billing";
import { pool } from "./db";
import type { Actor } from "./types";

/** PLAT-CABINET-*: the platform owner's cabinet. Every call is for PLATFORM_ADMIN_EMAILS only. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 86400000;

type InvoiceRow = { id: string; tenant_id: string; tenant_name: string; number: number; plan: string; months: number; amount_minor: number; status: string; provider: string; created_at: Date; paid_at: Date | null; period_to: Date | null };

const invoiceOut = (row: InvoiceRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  tenantName: row.tenant_name,
  number: row.number,
  plan: row.plan,
  planTitle: planById(row.plan)?.title ?? row.plan,
  months: row.months,
  amountMinor: row.amount_minor,
  status: row.status,
  provider: row.provider,
  createdAt: row.created_at,
  paidAt: row.paid_at,
  periodTo: row.period_to,
});

async function invoices() {
  const { rows } = await pool.query<InvoiceRow>("SELECT * FROM platform_invoices()");
  return rows.map(invoiceOut);
}

export async function platformInvoices(actor: Actor) {
  assertPlatform(actor);
  return invoices();
}

const monthKey = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

/** PLAT-CABINET-01: the numbers a platform owner opens every morning. */
export async function platformOverview(actor: Actor, now = new Date()) {
  const tenants = await platformTenants(actor, now);
  const all = await invoices();
  const paid = all.filter((item) => item.status === "paid");

  // Monthly recurring revenue: what each paying salon pays per month, by its latest paid invoice.
  const latest = new Map<string, (typeof paid)[number]>();
  for (const item of paid) if (!latest.has(item.tenantId)) latest.set(item.tenantId, item);
  const monthlyOf = (tenantId: string, plan: string) => {
    const last = latest.get(tenantId);
    return last ? Math.round(last.amountMinor / last.months) : planById(plan)?.priceMinor ?? 0;
  };
  const paying = tenants.filter((row) => row.state === "active" || row.state === "grace");
  const mrrMinor = paying.filter((row) => row.plan !== "trial").reduce((sum, row) => sum + monthlyOf(row.id, row.plan), 0);

  const months: { month: string; paidMinor: number; invoices: number; signups: number }[] = [];
  for (let back = 11; back >= 0; back -= 1) {
    const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push({ month: monthKey(at), paidMinor: 0, invoices: 0, signups: 0 });
  }
  const byMonth = new Map(months.map((item) => [item.month, item]));
  for (const item of paid) {
    const slot = item.paidAt ? byMonth.get(monthKey(new Date(item.paidAt))) : undefined;
    if (slot) { slot.paidMinor += item.amountMinor; slot.invoices += 1; }
  }
  for (const row of tenants) {
    const slot = byMonth.get(monthKey(new Date(row.createdAt)));
    if (slot) slot.signups += 1;
  }

  const everPaid = new Set(paid.map((item) => item.tenantId));
  const matured = tenants.filter((row) => now.getTime() - new Date(row.createdAt).getTime() > 14 * DAY);
  const conversion = matured.length ? Math.round((matured.filter((row) => everPaid.has(row.id)).length * 100) / matured.length) : null;

  const plans = ["trial", "start", "salon", "network"].map((plan) => ({ plan, title: planById(plan)?.title ?? "Пробный", count: tenants.filter((row) => row.plan === plan && row.state !== "suspended").length }));

  const risk = tenants
    .flatMap((row) => {
      const inactiveDays = row.lastActivity ? Math.floor((now.getTime() - new Date(row.lastActivity).getTime()) / DAY) : null;
      const reasons: string[] = [];
      if (row.state === "grace") reasons.push("льготные дни");
      if (row.state === "expired") reasons.push("подписка закончилась");
      if ((row.state === "trial" || row.state === "active") && row.daysLeft <= 7) reasons.push(row.state === "trial" ? `пробный кончится через ${row.daysLeft} дн.` : `оплата кончится через ${row.daysLeft} дн.`);
      if (row.state !== "suspended" && (inactiveDays === null || inactiveDays >= 14)) reasons.push(inactiveDays === null ? "ни одного действия" : `не заходили ${inactiveDays} дн.`);
      return reasons.length ? [{ id: row.id, name: row.name, ownerEmail: row.ownerEmail, state: row.state, planTitle: row.planTitle, daysLeft: row.daysLeft, reasons }] : [];
    })
    .slice(0, 50);

  const tasks = await taskRows();
  const today = now.toISOString().slice(0, 10);
  const open = tasks.filter((item) => !item.doneAt);
  const since30 = now.getTime() - 30 * DAY;

  return {
    totals: {
      tenants: tenants.length,
      trial: tenants.filter((row) => row.state === "trial").length,
      active: tenants.filter((row) => row.state === "active").length,
      grace: tenants.filter((row) => row.state === "grace").length,
      expired: tenants.filter((row) => row.state === "expired").length,
      suspended: tenants.filter((row) => row.state === "suspended").length,
      mrrMinor,
      arrMinor: mrrMinor * 12,
      paidTotalMinor: paid.reduce((sum, item) => sum + item.amountMinor, 0),
      paid30dMinor: paid.filter((item) => item.paidAt && new Date(item.paidAt).getTime() > since30).reduce((sum, item) => sum + item.amountMinor, 0),
      pendingInvoices: all.filter((item) => item.status === "pending").length,
      signups30d: tenants.filter((row) => new Date(row.createdAt).getTime() > since30).length,
      conversion,
      openTasks: open.length,
      overdueTasks: open.filter((item) => item.dueOn && item.dueOn < today).length,
    },
    months,
    plans,
    risk,
  };
}

type EventRow = { at: Date; kind: string; tenant_id: string | null; tenant_name: string | null; text: string; amount_minor: string | null };

export async function platformEvents(actor: Actor, limit = 100, tenantId?: string) {
  assertPlatform(actor);
  const { rows } = await pool.query<EventRow>("SELECT * FROM platform_events($1)", [tenantId ? 500 : Math.min(Math.max(Number(limit) || 100, 1), 500)]);
  return rows
    .filter((row) => !tenantId || row.tenant_id === tenantId)
    .slice(0, limit)
    .map((row) => ({ at: row.at, kind: row.kind, tenantId: row.tenant_id, tenantName: row.tenant_name ?? "", text: row.text, amountMinor: row.amount_minor === null ? null : Number(row.amount_minor) }));
}

type UsageRow = { clients: number; appointments_total: number; appointments_7d: number; online_30d: number; revenue_30d_minor: string; users: number; branch_names: string[]; months: string[]; month_appointments: number[] };

/** PLAT-CABINET-02: one salon, everything about it in one place. */
export async function platformTenantDetail(actor: Actor, id: string, now = new Date()) {
  assertPlatform(actor);
  if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Салон не найден");
  const tenant = (await platformTenants(actor, now)).find((row) => row.id === id);
  if (!tenant) throw new AppError("NOT_FOUND", "Салон не найден");
  const { rows } = await pool.query<UsageRow>("SELECT * FROM platform_tenant_usage($1)", [id]);
  const usage = rows[0];
  return {
    tenant,
    usage: {
      clients: Number(usage.clients),
      appointmentsTotal: Number(usage.appointments_total),
      appointments7d: Number(usage.appointments_7d),
      online30d: Number(usage.online_30d),
      revenue30dMinor: Number(usage.revenue_30d_minor),
      users: Number(usage.users),
      branchNames: usage.branch_names,
      months: usage.months.map((month, index) => ({ month, appointments: Number(usage.month_appointments[index] ?? 0) })),
    },
    invoices: (await invoices()).filter((item) => item.tenantId === id),
    tasks: (await taskRows()).filter((item) => item.tenantId === id),
    events: await platformEvents(actor, 30, id),
  };
}

type TaskRow = { id: string; tenant_id: string | null; tenant_name: string | null; title: string; note: string; due_on: string | Date | null; done_at: Date | null; created_by: string; created_at: Date };

const dateOnly = (value: string | Date | null) => {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
};

async function taskRows() {
  const { rows } = await pool.query<TaskRow>("SELECT * FROM platform_tasks_list()");
  return rows.map((row) => ({ id: row.id, tenantId: row.tenant_id, tenantName: row.tenant_name ?? "", title: row.title, note: row.note, dueOn: dateOnly(row.due_on), doneAt: row.done_at, createdBy: row.created_by, createdAt: row.created_at }));
}

/** PLAT-CABINET-03: the platform team's to-do list, optionally tied to a salon. */
export async function platformTasks(actor: Actor) {
  assertPlatform(actor);
  return taskRows();
}

export async function platformCreateTask(actor: Actor, input: { title?: unknown; note?: unknown; dueOn?: unknown; tenantId?: unknown }) {
  assertPlatform(actor);
  const title = String(input.title ?? "").trim();
  if (!title || title.length > 300) throw new AppError("VALIDATION", "Напишите, что нужно сделать (до 300 символов)");
  const note = String(input.note ?? "").trim().slice(0, 4000);
  const dueOn = input.dueOn ? String(input.dueOn) : null;
  if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) throw new AppError("VALIDATION", "Срок: дата в формате ГГГГ-ММ-ДД");
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  if (tenantId && !UUID.test(tenantId)) throw new AppError("VALIDATION", "Салон не найден");
  const id = randomUUID();
  await pool.query("SELECT platform_task_create($1, $2, $3, $4, $5, $6)", [id, tenantId, title, note, dueOn, actor.email]);
  return (await taskRows()).find((item) => item.id === id);
}

export async function platformSetTaskDone(actor: Actor, id: string, done: unknown) {
  assertPlatform(actor);
  if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Задача не найдена");
  const { rows } = await pool.query<{ ok: boolean }>("SELECT platform_task_set_done($1, $2) AS ok", [id, done !== false]);
  if (!rows[0]?.ok) throw new AppError("NOT_FOUND", "Задача не найдена");
  return (await taskRows()).find((item) => item.id === id) ?? { id, doneAt: new Date() };
}

export async function platformDeleteTask(actor: Actor, id: string) {
  assertPlatform(actor);
  if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Задача не найдена");
  const { rows } = await pool.query<{ ok: boolean }>("SELECT platform_task_delete($1) AS ok", [id]);
  if (!rows[0]?.ok) throw new AppError("NOT_FOUND", "Задача не найдена");
  return { ok: true };
}
