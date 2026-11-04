/**
 * Group events (GRP-*): a class, workshop or masterclass with seats. Participants enroll from the
 * desk or online; when full they join the event's waitlist and move up FIFO when a seat frees.
 */
import { AppError } from "@/domain/errors";
import { formatMoney } from "@/domain/money";
import { formatLocalDate, localDayUtcRange } from "@/domain/time";
import { normalizePhone } from "@/domain/phone";
import { isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import { deliverToClient, notifyDesk, render, templateBody, type TemplateKey } from "./messaging";
import { createPayment, type TenderInput } from "./payments";
import { resourceFree } from "./resources";
import type { BranchRow, Ctx } from "./types";

type EventRow = {
  id: string;
  branch_id: string;
  title: string;
  description: string;
  staff_id: string | null;
  resource_id: string | null;
  service_id: string | null;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  price_minor: number;
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  online_visible: boolean;
  color: string;
  series_id: string | null;
  cancel_reason: string | null;
  host_pay_mode: HostPayMode;
  host_pay_minor: number;
  host_pay_bps: number;
  staff_name?: string | null;
  resource_title?: string | null;
  enrolled?: number;
  waitlisted?: number;
  arrived?: number;
  paid?: number;
};
export type HostPayMode = "none" | "per_attendee" | "flat" | "percent";
const HOST_PAY_MODES: HostPayMode[] = ["none", "per_attendee", "flat", "percent"];
type ParticipantStatus = "enrolled" | "waitlisted" | "arrived" | "no_show" | "cancelled";
type ParticipantRow = {
  id: string;
  event_id: string;
  client_id: string;
  status: ParticipantStatus;
  source: "admin" | "online";
  payment_id: string | null;
  enrolled_at: Date;
  client_name?: string;
  phone?: string | null;
};

const SEATED: ParticipantStatus[] = ["enrolled", "arrived", "no_show"];

const EVENT_SELECT = `SELECT g.*, s.display_name AS staff_name, r.title AS resource_title,
   (SELECT count(*)::int FROM group_participants p WHERE p.event_id = g.id AND p.status IN ('enrolled', 'arrived', 'no_show')) AS enrolled,
   (SELECT count(*)::int FROM group_participants p WHERE p.event_id = g.id AND p.status = 'waitlisted') AS waitlisted,
   (SELECT count(*)::int FROM group_participants p WHERE p.event_id = g.id AND p.status = 'arrived') AS arrived,
   (SELECT count(*)::int FROM group_participants p WHERE p.event_id = g.id AND p.payment_id IS NOT NULL AND p.status <> 'cancelled') AS paid
 FROM group_events g LEFT JOIN staff s ON s.id = g.staff_id LEFT JOIN resources r ON r.id = g.resource_id`;

function presentEvent(row: EventRow) {
  const enrolled = Number(row.enrolled ?? 0);
  return {
    id: row.id,
    branchId: row.branch_id,
    title: row.title,
    description: row.description,
    staffId: row.staff_id,
    staffName: row.staff_name ?? null,
    resourceId: row.resource_id,
    resourceTitle: row.resource_title ?? null,
    serviceId: row.service_id,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    capacity: Number(row.capacity),
    priceMinor: Number(row.price_minor),
    status: row.status,
    onlineVisible: row.online_visible,
    color: row.color,
    seriesId: row.series_id,
    cancelReason: row.cancel_reason,
    hostPayMode: row.host_pay_mode,
    hostPayMinor: Number(row.host_pay_minor),
    hostPayBps: Number(row.host_pay_bps),
    enrolled,
    waitlisted: Number(row.waitlisted ?? 0),
    arrived: Number(row.arrived ?? 0),
    paid: Number(row.paid ?? 0),
    freeSeats: Math.max(0, Number(row.capacity) - enrolled),
  };
}

async function loadEvent(ctx: Ctx, id: string, lock = false) {
  if (lock) await ctx.db.query("SELECT 1 FROM group_events WHERE id = $1 FOR UPDATE", [id]);
  const row = await one<EventRow>(ctx.db, `${EVENT_SELECT} WHERE g.id = $1`, [id]);
  if (!row) throw new AppError("NOT_FOUND", "Занятие не найдено");
  return row;
}

/** The host may run the list of their own event; admins anything. */
function assertCanRun(ctx: Ctx, event: Pick<EventRow, "staff_id">) {
  if (isAdminPlus(ctx.actor)) return;
  if (ctx.actor.role === "master" && ctx.actor.staffId && ctx.actor.staffId === event.staff_id) return;
  throw new AppError("FORBIDDEN", "Недостаточно прав");
}

/** GRP-VIEW: events of a branch in a date range (local dates, inclusive). */
export async function listEvents(ctx: Ctx, input: { branchId: string; from: string; to: string }) {
  if (ctx.actor.role === "accountant" || ctx.actor.role === "client") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const branch = await loadBranch(ctx, input.branchId);
  const start = localDayUtcRange(input.from, branch.timezone).start;
  const end = localDayUtcRange(input.to, branch.timezone).end;
  const rows = await many<EventRow>(ctx.db, `${EVENT_SELECT} WHERE g.branch_id = $1 AND g.starts_at >= $2 AND g.starts_at < $3 ORDER BY g.starts_at`, [
    input.branchId,
    start.toISOString(),
    end.toISOString(),
  ]);
  return rows.map(presentEvent);
}

export async function getEvent(ctx: Ctx, id: string) {
  if (ctx.actor.role === "accountant" || ctx.actor.role === "client") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const row = await loadEvent(ctx, id);
  const participants = await many<ParticipantRow>(
    ctx.db,
    `SELECT p.*, c.name AS client_name,
       (SELECT phone_e164 FROM client_phones cp WHERE cp.client_id = c.id AND cp.deleted_at IS NULL ORDER BY cp.is_primary DESC LIMIT 1) AS phone
     FROM group_participants p JOIN clients c ON c.id = p.client_id
     WHERE p.event_id = $1 ORDER BY CASE p.status WHEN 'waitlisted' THEN 1 WHEN 'cancelled' THEN 2 ELSE 0 END, p.enrolled_at`,
    [id],
  );
  const canRun = isAdminPlus(ctx.actor) || (ctx.actor.role === "master" && ctx.actor.staffId === row.staff_id);
  return {
    ...presentEvent(row),
    canEdit: isAdminPlus(ctx.actor),
    canRun,
    participants: participants.map((item) => ({
      id: item.id,
      clientId: item.client_id,
      clientName: item.client_name ?? "",
      // Masters see the list but not phone numbers of other people's clients.
      phone: canRun ? item.phone ?? null : null,
      status: item.status,
      source: item.source,
      paid: Boolean(item.payment_id),
      paymentId: item.payment_id,
      enrolledAt: new Date(item.enrolled_at).toISOString(),
    })),
  };
}

type EventInput = {
  branchId?: string;
  title?: unknown;
  description?: unknown;
  staffId?: unknown;
  resourceId?: unknown;
  serviceId?: unknown;
  startsAt?: unknown;
  durationMin?: unknown;
  capacity?: unknown;
  priceMinor?: unknown;
  onlineVisible?: unknown;
  color?: unknown;
  hostPayMode?: unknown;
  hostPayMinor?: unknown;
  hostPayBps?: unknown;
  /** GRP-RECUR-01: also create the same event on the next N weeks. */
  repeatWeeks?: unknown;
  acknowledgeSoft?: boolean;
};

async function checkConflicts(ctx: Ctx, event: { id?: string; staffId: string | null; resourceId: string | null; starts: Date; ends: Date }, acknowledgeSoft?: boolean) {
  if (event.resourceId) {
    const resource = await one<{ id: string; capacity: number; title: string; active: boolean }>(ctx.db, "SELECT id, capacity, title, active FROM resources WHERE id = $1 FOR UPDATE", [event.resourceId]);
    if (!resource?.active) throw new AppError("VALIDATION", "Зал не найден или выключен");
    // A group takes the whole room: any visit or other group there is a hard conflict.
    if (!(await resourceFree(ctx, { id: resource.id, capacity: 1 }, event.starts, event.ends, { eventId: event.id }))) {
      throw new AppError("CONFLICT_RESOURCE", `${resource.title} занят в это время`, { resourceId: resource.id });
    }
  }
  if (event.staffId && !acknowledgeSoft) {
    const busy = await one<{ n: number }>(
      ctx.db,
      `SELECT (SELECT count(*) FROM appointments a WHERE a.staff_id = $1 AND a.status NOT IN ('cancelled', 'no_show')
                AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange($2, $3, '[)'))
            + (SELECT count(*) FROM group_events g WHERE g.staff_id = $1 AND g.status <> 'cancelled' AND g.id <> COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000')
                AND tstzrange(g.starts_at, g.ends_at, '[)') && tstzrange($2, $3, '[)')) AS n`,
      [event.staffId, event.starts.toISOString(), event.ends.toISOString(), event.id ?? null],
    );
    if (Number(busy?.n)) throw new AppError("SOFT_CONFIRM", "У ведущего в это время есть записи", { warnings: ["STAFF_BUSY"] });
  }
}

/** GRP-CREATE-01: create (optionally weekly series) or edit one event. */
export async function saveEvent(ctx: Ctx, id: string | null, input: EventInput) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const current = id ? await loadEvent(ctx, id, true) : null;
  if (current && (current.status === "cancelled" || current.status === "completed")) throw new AppError("VALIDATION", "Это занятие уже закрыто");
  const branchId = current?.branch_id ?? String(input.branchId ?? "");
  const branch = await loadBranch(ctx, branchId);
  const title = String(input.title ?? current?.title ?? "").trim().slice(0, 120);
  if (!title) throw new AppError("VALIDATION", "Укажите название");
  const starts = new Date(String(input.startsAt ?? current?.starts_at?.toString() ?? ""));
  if (input.startsAt === undefined && current) starts.setTime(new Date(current.starts_at).getTime());
  if (Number.isNaN(starts.getTime())) throw new AppError("VALIDATION", "Укажите время начала");
  const durationMin = Number(input.durationMin ?? (current ? (new Date(current.ends_at).getTime() - new Date(current.starts_at).getTime()) / 60000 : 60));
  if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 12 * 60) throw new AppError("VALIDATION", "Длительность: от 15 минут до 12 часов");
  const ends = new Date(starts.getTime() + durationMin * 60000);
  const capacity = Number(input.capacity ?? current?.capacity ?? 0);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new AppError("VALIDATION", "Мест: от 1 до 500");
  if (current && capacity < Number(current.enrolled ?? 0)) {
    throw new AppError("VALIDATION", `Записано уже ${current.enrolled}: сначала отмените лишних участников`);
  }
  const priceMinor = Number(input.priceMinor ?? current?.price_minor ?? 0);
  if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new AppError("VALIDATION", "Некорректная цена");
  const pick = (value: unknown, fallback: string | null) => (value === undefined ? fallback : value ? String(value) : null);
  const staffId = pick(input.staffId, current?.staff_id ?? null);
  const resourceId = pick(input.resourceId, current?.resource_id ?? null);
  const serviceId = pick(input.serviceId, current?.service_id ?? null);
  if (staffId && !(await one(ctx.db, "SELECT 1 FROM staff WHERE id = $1 AND active", [staffId]))) throw new AppError("VALIDATION", "Ведущий не найден");
  if (serviceId && !(await one(ctx.db, "SELECT 1 FROM services WHERE id = $1", [serviceId]))) throw new AppError("VALIDATION", "Услуга не найдена");
  const description = String(input.description ?? current?.description ?? "").trim().slice(0, 1000);
  const onlineVisible = input.onlineVisible === undefined ? current?.online_visible ?? true : Boolean(input.onlineVisible);
  // GRP-COMPLETE-01: the host's pay for this class goes into payroll when it is completed.
  const hostPayMode = (input.hostPayMode ?? current?.host_pay_mode ?? "none") as HostPayMode;
  if (!HOST_PAY_MODES.includes(hostPayMode)) throw new AppError("VALIDATION", "Неизвестный способ оплаты ведущему");
  const hostPayMinor = Number(input.hostPayMinor ?? current?.host_pay_minor ?? 0);
  const hostPayBps = Number(input.hostPayBps ?? current?.host_pay_bps ?? 0);
  if (!Number.isInteger(hostPayMinor) || hostPayMinor < 0) throw new AppError("VALIDATION", "Оплата ведущему: сумма от 0");
  if (!Number.isInteger(hostPayBps) || hostPayBps < 0 || hostPayBps > 10000) throw new AppError("VALIDATION", "Оплата ведущему: от 0 до 100%");
  const color = /^#[0-9a-f]{6}$/i.test(String(input.color ?? "")) ? String(input.color) : current?.color ?? "#ffe3ef";

  if (current) {
    await checkConflicts(ctx, { id: current.id, staffId, resourceId, starts, ends }, input.acknowledgeSoft);
    await ctx.db.query(
      `UPDATE group_events SET title = $2, description = $3, staff_id = $4, resource_id = $5, service_id = $6, starts_at = $7, ends_at = $8,
         capacity = $9, price_minor = $10, online_visible = $11, color = $12, host_pay_mode = $13, host_pay_minor = $14, host_pay_bps = $15,
         updated_at = now() WHERE id = $1`,
      [current.id, title, description, staffId, resourceId, serviceId, starts.toISOString(), ends.toISOString(), capacity, priceMinor, onlineVisible, color, hostPayMode, hostPayMinor, hostPayBps],
    );
    // More seats: the waitlist moves up.
    if (capacity > Number(current.capacity)) await promoteWaitlist(ctx, current.id);
    await audit(ctx, { branchId, entity: "group_event", entityId: current.id, action: "group.updated", diff: { title, startsAt: starts.toISOString(), capacity } });
    return getEvent(ctx, current.id);
  }
  const weeks = Math.max(0, Math.min(26, Number(input.repeatWeeks ?? 0) || 0));
  const seriesId = weeks ? crypto.randomUUID() : null;
  let firstId = "";
  for (let week = 0; week <= weeks; week += 1) {
    const shift = week * 7 * 86400000;
    const s = new Date(starts.getTime() + shift);
    const e = new Date(ends.getTime() + shift);
    await checkConflicts(ctx, { staffId, resourceId, starts: s, ends: e }, input.acknowledgeSoft);
    const eventId = crypto.randomUUID();
    if (!firstId) firstId = eventId;
    await ctx.db.query(
      `INSERT INTO group_events (id, tenant_id, branch_id, title, description, staff_id, resource_id, service_id, starts_at, ends_at, capacity, price_minor, online_visible, color, series_id, created_by,
         host_pay_mode, host_pay_minor, host_pay_bps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [eventId, ctx.actor.tenantId, branch.id, title, description, staffId, resourceId, serviceId, s.toISOString(), e.toISOString(), capacity, priceMinor, onlineVisible, color, seriesId, ctx.actor.userId,
        hostPayMode, hostPayMinor, hostPayBps],
    );
    await audit(ctx, { branchId, entity: "group_event", entityId: eventId, action: "group.created", diff: { title, startsAt: s.toISOString(), capacity, seriesId } });
  }
  return getEvent(ctx, firstId);
}

async function eventValues(ctx: Ctx, event: EventRow, clientName: string) {
  const branch = await loadBranch(ctx, event.branch_id);
  const salon = await one<{ name: string }>(ctx.db, "SELECT name FROM tenants WHERE id = $1", [ctx.actor.tenantId]);
  const when = new Intl.DateTimeFormat("ru-RU", { timeZone: branch.timezone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(event.starts_at));
  return {
    имя: clientName,
    салон: salon?.name ?? branch.name,
    адрес: branch.address ? `, ${branch.address}` : "",
    когда: when,
    услуги: event.title,
    мастер: event.staff_name ?? "",
    сумма: formatMoney(Number(event.price_minor), branch.currency),
    ссылка: "",
  };
}

async function tell(ctx: Ctx, event: EventRow, participant: { client_id: string }, key: TemplateKey & `group_${string}`) {
  const client = await one<{ name: string }>(ctx.db, "SELECT name FROM clients WHERE id = $1", [participant.client_id]);
  return deliverToClient(ctx, {
    clientId: participant.client_id,
    branchId: event.branch_id,
    kind: key,
    body: render(await templateBody(ctx, key), await eventValues(ctx, event, client?.name ?? "")),
  });
}

/** GRP-WAIT-01: free seats go to the waitlist in order of joining; each promoted client is told. */
async function promoteWaitlist(ctx: Ctx, eventId: string) {
  const event = await loadEvent(ctx, eventId);
  let free = Number(event.capacity) - Number(event.enrolled ?? 0);
  const promoted: string[] = [];
  if (free <= 0 || event.status === "cancelled" || event.status === "completed") return promoted;
  const queue = await many<ParticipantRow>(ctx.db, "SELECT * FROM group_participants WHERE event_id = $1 AND status = 'waitlisted' ORDER BY enrolled_at FOR UPDATE", [eventId]);
  for (const row of queue) {
    if (free <= 0) break;
    await ctx.db.query("UPDATE group_participants SET status = 'enrolled', updated_at = now() WHERE id = $1", [row.id]);
    await tell(ctx, event, row, "group_seat");
    promoted.push(row.id);
    free -= 1;
  }
  return promoted;
}

/** GRP-ENROLL-01: desk adds a client. Full → error with `full: true` unless `waitlist` is asked for. */
export async function enroll(ctx: Ctx, eventId: string, input: { clientId: string; waitlist?: boolean; notify?: boolean; source?: "admin" | "online" }) {
  const event = await loadEvent(ctx, eventId, true);
  if (ctx.channel !== "online") assertCanRun(ctx, event);
  if (event.status === "cancelled" || event.status === "completed") throw new AppError("VALIDATION", "Запись на это занятие закрыта");
  if (new Date(event.ends_at).getTime() <= ctx.now.getTime()) throw new AppError("VALIDATION", "Занятие уже прошло");
  const client = await one<{ id: string }>(ctx.db, "SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL", [input.clientId]);
  if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
  const already = await one(ctx.db, "SELECT 1 FROM group_participants WHERE event_id = $1 AND client_id = $2 AND status <> 'cancelled'", [eventId, input.clientId]);
  if (already) throw new AppError("VALIDATION", "Клиент уже записан на это занятие");
  const full = Number(event.enrolled ?? 0) >= Number(event.capacity);
  if (full && !input.waitlist) throw new AppError("VALIDATION", "Мест нет. Записать в лист ожидания?", { full: true });
  const id = crypto.randomUUID();
  const status: ParticipantStatus = full ? "waitlisted" : "enrolled";
  await ctx.db.query(
    "INSERT INTO group_participants (id, tenant_id, event_id, client_id, status, source, enrolled_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, ctx.actor.tenantId, eventId, input.clientId, status, input.source ?? "admin", ctx.now.toISOString()],
  );
  await audit(ctx, { branchId: event.branch_id, entity: "group_event", entityId: eventId, action: "group.enrolled", diff: { clientId: input.clientId, status } });
  if (status === "enrolled" && input.notify !== false) await tell(ctx, event, { client_id: input.clientId }, "group_enrolled");
  return { participantId: id, status, event: ctx.channel === "online" ? null : await getEvent(ctx, eventId) };
}

/** GRP-STATUS-01 / GRP-CANCEL-PART-01: arrived, no-show, or cancelled (frees the seat). */
export async function setParticipantStatus(ctx: Ctx, participantId: string, status: "enrolled" | "arrived" | "no_show" | "cancelled") {
  const row = await one<ParticipantRow>(ctx.db, "SELECT * FROM group_participants WHERE id = $1 FOR UPDATE", [participantId]);
  if (!row) throw new AppError("NOT_FOUND", "Участник не найден");
  const event = await loadEvent(ctx, row.event_id, true);
  assertCanRun(ctx, event);
  if (row.status === "cancelled") throw new AppError("VALIDATION", "Участие уже отменено");
  if (status === "arrived" || status === "no_show") {
    if (row.status === "waitlisted") throw new AppError("VALIDATION", "Клиент в листе ожидания, у него нет места");
    if (new Date(event.starts_at).getTime() - ctx.now.getTime() > 3 * 3600000) throw new AppError("VALIDATION", "Отмечать приход можно в день занятия");
  }
  await ctx.db.query("UPDATE group_participants SET status = $2, updated_at = now() WHERE id = $1", [participantId, status]);
  await audit(ctx, { branchId: event.branch_id, entity: "group_event", entityId: event.id, action: `group.participant.${status}`, diff: { participantId, from: row.status } });
  const promoted = status === "cancelled" && SEATED.includes(row.status) ? await promoteWaitlist(ctx, event.id) : [];
  return { promoted, refundSuggested: status === "cancelled" && Boolean(row.payment_id), event: await getEvent(ctx, event.id) };
}

/** GRP-STATUS-01 bulk: tick several as arrived. */
export async function markArrived(ctx: Ctx, eventId: string, participantIds: string[]) {
  for (const id of participantIds) {
    const row = await one<{ event_id: string; status: string }>(ctx.db, "SELECT event_id, status FROM group_participants WHERE id = $1", [id]);
    if (!row || row.event_id !== eventId) throw new AppError("NOT_FOUND", "Участник не найден");
    if (row.status === "enrolled" || row.status === "no_show") await setParticipantStatus(ctx, id, "arrived");
  }
  const event = await loadEvent(ctx, eventId, true);
  if (event.status === "scheduled") await ctx.db.query("UPDATE group_events SET status = 'in_progress', updated_at = now() WHERE id = $1", [eventId]);
  return getEvent(ctx, eventId);
}

/** GRP-PAY-01: pays one seat through the till (a service line, so it gets a receipt like a visit). */
export async function paySeat(ctx: Ctx, participantId: string, input: { tenders: TenderInput[]; bypassShift?: boolean }) {
  const row = await one<ParticipantRow>(ctx.db, "SELECT * FROM group_participants WHERE id = $1 FOR UPDATE", [participantId]);
  if (!row) throw new AppError("NOT_FOUND", "Участник не найден");
  const event = await loadEvent(ctx, row.event_id);
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  if (row.payment_id) throw new AppError("VALIDATION", "Место уже оплачено");
  if (row.status === "cancelled" || row.status === "waitlisted") throw new AppError("VALIDATION", "Оплатить можно только занятое место");
  if (Number(event.price_minor) <= 0) throw new AppError("VALIDATION", "Занятие бесплатное");
  const handed = input.tenders.reduce((sum, tender) => sum + Number(tender.amountMinor), 0);
  if (handed !== Number(event.price_minor)) throw new AppError("VALIDATION", `К оплате ровно ${formatMoney(Number(event.price_minor))}`);
  const payment = await createPayment(ctx, {
    branchId: event.branch_id,
    kind: "misc",
    clientId: row.client_id,
    tenders: input.tenders,
    title: `Групповое занятие: ${event.title}`,
    serviceLine: true,
    bypassShift: input.bypassShift,
  });
  await ctx.db.query("UPDATE group_participants SET payment_id = $2, updated_at = now() WHERE id = $1", [participantId, payment.id]);
  await audit(ctx, { branchId: event.branch_id, entity: "group_event", entityId: event.id, action: "group.seat_paid", diff: { participantId, paymentId: payment.id } });
  return { paymentId: payment.id, event: await getEvent(ctx, event.id) };
}

/** GRP-CANCEL-01: the whole event is off. Everyone with a seat is told; paid seats are listed for refunds. */
export async function cancelEvent(ctx: Ctx, eventId: string, input: { reason?: string; notify?: boolean }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const event = await loadEvent(ctx, eventId, true);
  if (event.status === "cancelled") throw new AppError("VALIDATION", "Занятие уже отменено");
  if (event.status === "completed") throw new AppError("VALIDATION", "Прошедшее занятие не отменяется");
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  if (!reason) throw new AppError("VALIDATION", "Укажите причину отмены");
  const live = await many<ParticipantRow>(ctx.db, "SELECT * FROM group_participants WHERE event_id = $1 AND status <> 'cancelled' FOR UPDATE", [eventId]);
  await ctx.db.query("UPDATE group_events SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1", [eventId, reason]);
  await ctx.db.query("UPDATE group_participants SET status = 'cancelled', updated_at = now() WHERE event_id = $1 AND status <> 'cancelled'", [eventId]);
  let notified = 0;
  if (input.notify !== false) {
    for (const row of live) {
      const sent = await tell(ctx, event, row, "group_cancelled");
      if (sent && sent.status === "delivered") notified += 1;
    }
  }
  const refunds = live.filter((row) => row.payment_id).map((row) => ({ participantId: row.id, paymentId: row.payment_id }));
  await audit(ctx, { branchId: event.branch_id, entity: "group_event", entityId: eventId, action: "group.cancelled", diff: { reason, participants: live.length, refunds: refunds.length } });
  if (refunds.length) {
    await notifyDesk(ctx, {
      branchId: event.branch_id,
      kind: "group.refunds",
      title: `Отменено «${event.title}»: ${refunds.length} оплаченных мест`,
      body: "Сделайте возвраты в «Финансы → Платежи».",
      entity: "group_event",
      entityId: eventId,
    });
  }
  return { notified, refunds, event: await getEvent(ctx, eventId) };
}

/** GRP-COMPLETE-01: closes the event; whoever was not marked arrived is a no-show. */
export async function completeEvent(ctx: Ctx, eventId: string) {
  const event = await loadEvent(ctx, eventId, true);
  assertCanRun(ctx, event);
  if (event.status === "cancelled" || event.status === "completed") throw new AppError("VALIDATION", "Занятие уже закрыто");
  if (new Date(event.starts_at).getTime() > ctx.now.getTime()) throw new AppError("VALIDATION", "Занятие ещё не началось");
  await ctx.db.query("UPDATE group_participants SET status = 'no_show', updated_at = now() WHERE event_id = $1 AND status = 'enrolled'", [eventId]);
  await ctx.db.query("UPDATE group_participants SET status = 'cancelled', updated_at = now() WHERE event_id = $1 AND status = 'waitlisted'", [eventId]);
  await ctx.db.query("UPDATE group_events SET status = 'completed', completed_at = $2, updated_at = now() WHERE id = $1", [eventId, ctx.now.toISOString()]);
  await audit(ctx, { branchId: event.branch_id, entity: "group_event", entityId: eventId, action: "group.completed", diff: {} });
  return getEvent(ctx, eventId);
}

/** GRP-ANALYTICS-01: fill rate, attendance and revenue per event title over a period. */
export async function groupStats(ctx: Ctx, input: { branchId: string; from: string; to: string }) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const branch = await loadBranch(ctx, input.branchId);
  const start = localDayUtcRange(input.from, branch.timezone).start;
  const end = localDayUtcRange(input.to, branch.timezone).end;
  const rows = await many<{ title: string; events: number; seats: number; enrolled: number; arrived: number; no_show: number; revenue_minor: number }>(
    ctx.db,
    `SELECT g.title, count(DISTINCT g.id)::int AS events, SUM(g.capacity)::int AS seats,
       COALESCE(SUM((SELECT count(*) FROM group_participants p WHERE p.event_id = g.id AND p.status IN ('enrolled', 'arrived', 'no_show'))), 0)::int AS enrolled,
       COALESCE(SUM((SELECT count(*) FROM group_participants p WHERE p.event_id = g.id AND p.status = 'arrived')), 0)::int AS arrived,
       COALESCE(SUM((SELECT count(*) FROM group_participants p WHERE p.event_id = g.id AND p.status = 'no_show')), 0)::int AS no_show,
       COALESCE(SUM((SELECT COALESCE(SUM(pay.total_minor), 0) FROM group_participants p JOIN payments pay ON pay.id = p.payment_id WHERE p.event_id = g.id AND pay.status = 'posted')), 0)::bigint AS revenue_minor
     FROM group_events g
     WHERE g.branch_id = $1 AND g.status <> 'cancelled' AND g.starts_at >= $2 AND g.starts_at < $3
     GROUP BY g.title ORDER BY events DESC, g.title`,
    [input.branchId, start.toISOString(), end.toISOString()],
  );
  return rows.map((row) => ({
    title: row.title,
    events: Number(row.events),
    seats: Number(row.seats),
    enrolled: Number(row.enrolled),
    arrived: Number(row.arrived),
    fillPercent: row.seats ? Math.round((Number(row.enrolled) / Number(row.seats)) * 100) : 0,
    noShowPercent: row.enrolled ? Math.round((Number(row.no_show) / Number(row.enrolled)) * 100) : 0,
    revenueMinor: Number(row.revenue_minor),
  }));
}

// ---------------------------------------------------------------- Online (GRP-ONLINE-01)

/** Upcoming online-visible events of the branch for the widget. */
export async function publicEvents(ctx: Ctx, branch: BranchRow, days = 30) {
  const rows = await many<EventRow>(
    ctx.db,
    `${EVENT_SELECT} WHERE g.branch_id = $1 AND g.online_visible AND g.status = 'scheduled' AND g.starts_at > $2 AND g.starts_at < $2::timestamptz + make_interval(days => $3)
     ORDER BY g.starts_at LIMIT 60`,
    [branch.id, ctx.now.toISOString(), days],
  );
  return rows.map((row) => {
    const event = presentEvent(row);
    return {
      id: event.id,
      title: event.title,
      description: event.description,
      staffName: event.staffName,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      date: formatLocalDate(new Date(row.starts_at), branch.timezone),
      priceMinor: event.priceMinor,
      freeSeats: event.freeSeats,
      capacity: event.capacity,
    };
  });
}

/**
 * Online enrollment: the seat is taken inside the row lock of the event, so two people racing for the
 * last seat get one seat and one waitlist place (edge case 3). Full → waitlist only if asked.
 */
export async function enrollOnline(
  ctx: Ctx,
  branch: BranchRow,
  eventId: string,
  input: { name: string; phone: string; consent?: boolean; marketing?: boolean; waitlist?: boolean },
  findOrCreateClient: (ctx: Ctx, name: string, phone: string) => Promise<{ id: string; created: boolean }>,
) {
  const event = await one<{ branch_id: string; online_visible: boolean }>(ctx.db, "SELECT branch_id, online_visible FROM group_events WHERE id = $1", [eventId]);
  if (!event || event.branch_id !== branch.id || !event.online_visible) throw new AppError("NOT_FOUND", "Занятие не найдено");
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 120) throw new AppError("VALIDATION", "Укажите имя");
  if (input.consent !== true) throw new AppError("VALIDATION", "Нужно согласие на обработку персональных данных");
  const phone = normalizePhone(String(input.phone ?? ""));
  const client = await findOrCreateClient(ctx, name, phone);
  await ctx.db.query(
    `UPDATE clients SET consent_pd_at = COALESCE(consent_pd_at, $2), consent_pd_source = COALESCE(consent_pd_source, 'online'),
       consent_marketing = consent_marketing OR $3, consent_marketing_at = CASE WHEN $3 AND NOT consent_marketing THEN $2 ELSE consent_marketing_at END
     WHERE id = $1`,
    [client.id, ctx.now.toISOString(), input.marketing === true],
  );
  const result = await enroll(ctx, eventId, { clientId: client.id, waitlist: input.waitlist, source: "online" });
  const full = await loadEvent(ctx, eventId);
  await notifyDesk(ctx, {
    branchId: branch.id,
    kind: "group.online",
    title: result.status === "enrolled" ? `Онлайн-запись на «${full.title}»: ${name}` : `Лист ожидания «${full.title}»: ${name}`,
    entity: "group_event",
    entityId: eventId,
  });
  return { status: result.status, title: full.title, startsAt: new Date(full.starts_at).toISOString(), freeSeats: Math.max(0, Number(full.capacity) - Number(full.enrolled ?? 0)) };
}

// ---------------------------------------------------------------- Reminders (GRP-REMIND-01)

/** Called from the reminder job: once per event inside the branch's reminder window, outside quiet hours. */
export async function sendGroupReminders(ctx: Ctx, branch: BranchRow) {
  const due = await many<EventRow>(
    ctx.db,
    `${EVENT_SELECT} WHERE g.branch_id = $1 AND g.status = 'scheduled' AND g.reminded_at IS NULL
       AND g.starts_at > $2 AND g.starts_at <= $2::timestamptz + make_interval(hours => $3)
     ORDER BY g.starts_at`,
    [branch.id, ctx.now.toISOString(), Number(branch.reminder_hours)],
  );
  let sent = 0;
  let failed = 0;
  for (const event of due) {
    await ctx.db.query("UPDATE group_events SET reminded_at = $2 WHERE id = $1", [event.id, ctx.now.toISOString()]);
    const seated = await many<{ client_id: string }>(ctx.db, "SELECT client_id FROM group_participants WHERE event_id = $1 AND status = 'enrolled'", [event.id]);
    for (const row of seated) {
      const result = await tell(ctx, event, row, "group_reminder");
      if (result?.status === "delivered") sent += 1;
      else failed += 1;
    }
  }
  return { sent, failed };
}

/** Group events in the journal day, for the busy ghost blocks on the host's column and in the resource view. */
export async function groupDay(ctx: Ctx, branchId: string, from: Date, to: Date) {
  const rows = await many<EventRow>(ctx.db, `${EVENT_SELECT} WHERE g.branch_id = $1 AND g.status <> 'cancelled' AND g.starts_at < $3 AND g.ends_at > $2 ORDER BY g.starts_at`, [
    branchId,
    from.toISOString(),
    to.toISOString(),
  ]);
  return rows.map(presentEvent);
}
