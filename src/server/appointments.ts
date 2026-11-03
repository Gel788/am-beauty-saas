import { AppError } from "@/domain/errors";
import { resolveDensity, type Density } from "@/domain/grid";
import { isInsideWorkingHours } from "@/domain/schedule";
import { canTransition, type AppointmentStatus } from "@/domain/status";
import {
  formatLocalDate,
  localDayUtcRange,
  localMinutes,
  offsetMinutes,
  sameLocalDay,
} from "@/domain/time";
import { phoneDigits } from "@/domain/phone";
import { audit, listAudit } from "./audit";
import { assertRole, isAdminPlus, loadBranch } from "./access";
import { createClient } from "./clients";
import { many, one } from "./db";
import { loadWorkingIntervals } from "./hours";
import { LIVE_PAYMENT, NET_AMOUNT, clearAppointmentDebt, syncAppointmentDebt } from "./payments";
import type { BranchRow, Ctx } from "./types";

type ServiceInput = { serviceId: string; durationMin?: number };

type ApptRow = {
  id: string;
  branch_id: string;
  staff_id: string;
  client_id: string | null;
  booked_by_client_id: string | null;
  starts_at: Date;
  ends_at: Date;
  branch_tz: string;
  tz_offset_min: number;
  status: AppointmentStatus;
  comment: string;
  source: string;
  color: string;
  version: number;
  force_overlap: boolean;
  overlap_reason: string | null;
  cancel_reason: string | null;
  debt_minor: number;
  created_at: Date;
};

type Line = {
  id: string;
  serviceId: string | null;
  title: string;
  durationMin: number;
  priceMinor: number;
  position: number;
};

export async function lockStaff(ctx: Ctx, staffId: string) {
  const row = await one<{ id: string; active: boolean; display_name: string }>(
    ctx.db,
    "SELECT id, active, display_name FROM staff WHERE id = $1 FOR UPDATE",
    [staffId],
  );
  if (!row) throw new AppError("NOT_FOUND", "Мастер не найден");
  return row;
}

async function assertStaffBranch(ctx: Ctx, staffId: string, branchId: string) {
  const link = await one(
    ctx.db,
    "SELECT 1 FROM staff_branches WHERE staff_id = $1 AND branch_id = $2",
    [staffId, branchId],
  );
  if (!link) throw new AppError("VALIDATION", "Мастер не работает в этом филиале");
}

async function linesOf(ctx: Ctx, appointmentId: string): Promise<Line[]> {
  const rows = await many<{
    id: string;
    service_id: string | null;
    title_snapshot: string;
    duration_min: number;
    price_minor: number;
    position: number;
  }>(
    ctx.db,
    `SELECT id, service_id, title_snapshot, duration_min, price_minor, position
     FROM appointment_services WHERE appointment_id = $1 ORDER BY position`,
    [appointmentId],
  );
  return rows.map((row) => ({
    id: row.id,
    serviceId: row.service_id,
    title: row.title_snapshot,
    durationMin: Number(row.duration_min),
    priceMinor: Number(row.price_minor),
    position: Number(row.position),
  }));
}

async function paidMinor(ctx: Ctx, appointmentId: string): Promise<number> {
  const row = await one<{ s: number }>(
    ctx.db,
    `SELECT ${NET_AMOUNT} AS s
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT}
       AND pl.line_type IN ('service', 'deposit')`,
    [appointmentId],
  );
  return Number(row?.s ?? 0);
}

async function resolveLines(
  ctx: Ctx,
  staffId: string,
  services: ServiceInput[],
  previous: Line[] = [],
  refreshPrice = false,
): Promise<{ title: string; serviceId: string; durationMin: number; priceMinor: number; color: string }[]> {
  if (!services.length) throw new AppError("VALIDATION", "Добавьте хотя бы одну услугу");
  const resolved = [];
  for (const input of services) {
    const service = await one<{
      id: string;
      title: string;
      duration_min: number;
      price_minor: number;
      color: string;
      active: boolean;
    }>(ctx.db, "SELECT id, title, duration_min, price_minor, color, active FROM services WHERE id = $1", [
      input.serviceId,
    ]);
    if (!service || !service.active) throw new AppError("VALIDATION", "Услуга недоступна для новой записи");
    const link = await one(
      ctx.db,
      "SELECT 1 FROM service_staff WHERE service_id = $1 AND staff_id = $2",
      [service.id, staffId],
    );
    if (!link) throw new AppError("VALIDATION", `Услуга «${service.title}» не оказывается этим мастером`);
    const prev = previous.find((line) => line.serviceId === service.id);
    const duration = input.durationMin ?? Number(service.duration_min);
    if (!Number.isInteger(duration) || duration < 5 || duration % 5 !== 0) {
      throw new AppError("VALIDATION", "Длительность услуги кратна 5 минутам и не меньше 5");
    }
    const price = refreshPrice || !prev ? Number(service.price_minor) : prev.priceMinor;
    resolved.push({
      title: service.title,
      serviceId: service.id,
      durationMin: duration,
      priceMinor: price,
      color: service.color,
    });
  }
  return resolved;
}

type Overlap = { id: string; branchId: string; clientName: string | null; startsAt: string; endsAt: string };

export async function findOverlaps(ctx: Ctx, staffId: string, starts: Date, ends: Date, excludeId?: string): Promise<Overlap[]> {
  const rows = await many<{
    id: string;
    branch_id: string;
    client_name: string | null;
    starts_at: Date;
    ends_at: Date;
  }>(
    ctx.db,
    `SELECT a.id, a.branch_id, c.name AS client_name, a.starts_at, a.ends_at
     FROM appointments a
     LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.staff_id = $1 AND a.status <> 'cancelled' AND a.id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')
       AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange($3, $4, '[)')`,
    [staffId, excludeId ?? null, starts.toISOString(), ends.toISOString()],
  );
  return rows.map((row) => ({
    id: row.id,
    branchId: row.branch_id,
    clientName: row.client_name,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
  }));
}

function assertSlot(
  overlaps: Overlap[],
  branchId: string,
  force: boolean | undefined,
  reason: string | undefined,
  admin: boolean,
) {
  const cross = overlaps.filter((row) => row.branchId !== branchId);
  if (cross.length) {
    throw new AppError("CONFLICT_SLOT", "Мастер занят в другом филиале", { conflicts: cross });
  }
  const same = overlaps.filter((row) => row.branchId === branchId);
  if (same.length && !force) {
    throw new AppError("CONFLICT_SLOT", "Время пересекается с другой записью", { conflicts: same });
  }
  if (same.length && force) {
    if (!admin) throw new AppError("FORBIDDEN", "Недостаточно прав, чтобы записать поверх");
    if (!reason?.trim()) throw new AppError("VALIDATION", "Укажите причину пересечения");
  }
  return same.length > 0;
}

async function assertHours(
  ctx: Ctx,
  branch: BranchRow,
  staffId: string,
  starts: Date,
  ends: Date,
  acknowledgeSoft: boolean | undefined,
  extra: string[] = [],
) {
  const date = formatLocalDate(starts, branch.timezone);
  const day = await loadWorkingIntervals(ctx.db, branch.id, staffId, date);
  const startMin = localMinutes(starts, branch.timezone);
  const endMin = ends.getTime() === localDayUtcRange(date, branch.timezone).end.getTime()
    ? 24 * 60
    : localMinutes(ends, branch.timezone);
  const inside = !day.dayOff && isInsideWorkingHours(day.intervals, startMin, endMin === 0 ? 24 * 60 : endMin);
  const warnings = [...extra];
  if (!inside) warnings.push("OUTSIDE_HOURS");
  if (warnings.length && !acknowledgeSoft) {
    throw new AppError("SOFT_CONFIRM", "Нужно подтверждение", { warnings });
  }
}

function assertSameDay(starts: Date, ends: Date, timeZone: string) {
  if (!sameLocalDay(starts, ends, timeZone)) {
    throw new AppError("VALIDATION", "Запись не может переходить через полночь");
  }
}

async function suggestSlot(ctx: Ctx, branch: BranchRow, staffId: string, from: Date, durationMin: number) {
  const date = formatLocalDate(from, branch.timezone);
  const range = localDayUtcRange(date, branch.timezone);
  const existing = await many<{ starts_at: Date; ends_at: Date; branch_id: string }>(
    ctx.db,
    `SELECT starts_at, ends_at, branch_id FROM appointments
     WHERE staff_id = $1 AND status <> 'cancelled' AND starts_at < $3 AND ends_at > $2`,
    [staffId, range.start.toISOString(), range.end.toISOString()],
  );
  for (let cursor = from.getTime(); cursor + durationMin * 60000 <= range.end.getTime(); cursor += 5 * 60000) {
    const slotEnd = cursor + durationMin * 60000;
    const hit = existing.some((row) => new Date(row.starts_at).getTime() < slotEnd && new Date(row.ends_at).getTime() > cursor);
    if (!hit) return new Date(cursor).toISOString();
  }
  return null;
}

async function writeLines(
  ctx: Ctx,
  appointmentId: string,
  lines: { serviceId: string; title: string; durationMin: number; priceMinor: number }[],
) {
  await ctx.db.query("DELETE FROM appointment_services WHERE appointment_id = $1", [appointmentId]);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    await ctx.db.query(
      `INSERT INTO appointment_services (id, tenant_id, appointment_id, service_id, title_snapshot, duration_min, price_minor, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [crypto.randomUUID(), ctx.actor.tenantId, appointmentId, line.serviceId, line.title, line.durationMin, line.priceMinor, i],
    );
  }
}

function durationOf(lines: { durationMin: number }[]) {
  return lines.reduce((sum, line) => sum + line.durationMin, 0);
}

async function loadRow(ctx: Ctx, id: string, lock = false): Promise<ApptRow> {
  const row = await one<ApptRow>(
    ctx.db,
    `SELECT * FROM appointments WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!row) throw new AppError("NOT_FOUND", "Запись не найдена");
  return row;
}

function assertVersion(row: ApptRow, version: number | undefined, overwrite: boolean | undefined, role: string) {
  if (version === undefined) throw new AppError("VALIDATION", "Не передана версия записи");
  if (Number(row.version) !== version) {
    if (overwrite) {
      if (role !== "owner" && role !== "super") throw new AppError("FORBIDDEN", "Перезаписать может только владелец");
      return;
    }
    throw new AppError("STALE", "Запись изменена. Обновить?", { version: Number(row.version) });
  }
}

async function ensureClient(ctx: Ctx, clientId: string) {
  const client = await one<{ id: string; name: string; deleted_at: Date | null }>(
    ctx.db,
    "SELECT id, name, deleted_at FROM clients WHERE id = $1",
    [clientId],
  );
  if (!client || client.deleted_at) throw new AppError("NOT_FOUND", "Клиент не найден");
  return client;
}

export async function createAppointment(
  ctx: Ctx,
  input: {
    branchId: string;
    staffId: string;
    clientId?: string | null;
    newClient?: { name: string; phone: string; comment?: string };
    bookedByClientId?: string | null;
    startsAt: string;
    services: ServiceInput[];
    comment?: string;
    source?: "admin" | "online" | "api" | "master";
    acknowledgeSoft?: boolean;
    forceOverlap?: boolean;
    overlapReason?: string;
  },
) {
  const branch = await loadBranch(ctx, input.branchId);
  const online = ctx.channel === "online";
  if (online) {
    if (input.source !== "online") throw new AppError("FORBIDDEN", "Недостаточно прав");
  } else if (ctx.actor.role === "master") {
    if (!branch.master_can_create_own || ctx.actor.staffId !== input.staffId) {
      throw new AppError("FORBIDDEN", "Мастер может создавать только свои записи");
    }
  } else if (!isAdminPlus(ctx.actor)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  const staff = await lockStaff(ctx, input.staffId);
  if (!staff.active) throw new AppError("VALIDATION", "Мастер неактивен");
  await assertStaffBranch(ctx, input.staffId, input.branchId);
  let clientId = input.clientId ?? null;
  if (input.newClient) {
    const created = await createClient(ctx, {
      name: input.newClient.name,
      phone: input.newClient.phone,
      notes: input.newClient.comment,
    });
    clientId = created.id;
  }
  if (!clientId) throw new AppError("VALIDATION", "Выберите клиента");
  await ensureClient(ctx, clientId);
  let bookedBy: string | null = input.bookedByClientId ?? null;
  if (bookedBy) {
    if (bookedBy === clientId) bookedBy = null;
    else await ensureClient(ctx, bookedBy);
  }
  const lines = await resolveLines(ctx, input.staffId, input.services);
  const starts = new Date(input.startsAt);
  if (Number.isNaN(starts.getTime())) throw new AppError("VALIDATION", "Некорректное время начала");
  const ends = new Date(starts.getTime() + durationOf(lines) * 60000);
  assertSameDay(starts, ends, branch.timezone);
  const overlaps = await findOverlaps(ctx, input.staffId, starts, ends);
  const forced = assertSlot(overlaps, input.branchId, input.forceOverlap, input.overlapReason, isAdminPlus(ctx.actor));
  await assertHours(ctx, branch, input.staffId, starts, ends, input.acknowledgeSoft);
  const source = input.source ?? (ctx.actor.role === "master" ? "master" : "admin");
  if (source === "online" && !online && !isAdminPlus(ctx.actor)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  const id = crypto.randomUUID();
  const offset = offsetMinutes(starts, branch.timezone);
  await ctx.db.query(
    `INSERT INTO appointments (
       id, tenant_id, branch_id, staff_id, client_id, booked_by_client_id, starts_at, ends_at,
       branch_tz, tz_offset_min, status, comment, source, color, force_overlap, overlap_reason,
       created_by, updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled',$11,$12,$13,$14,$15,$16,$16)`,
    [
      id,
      ctx.actor.tenantId,
      input.branchId,
      input.staffId,
      clientId,
      bookedBy,
      starts.toISOString(),
      ends.toISOString(),
      branch.timezone,
      offset,
      input.comment?.trim() ?? "",
      source,
      lines[0].color,
      forced,
      forced ? input.overlapReason?.trim() : null,
      ctx.actor.userId,
    ],
  );
  await writeLines(ctx, id, lines);
  await audit(ctx, {
    branchId: input.branchId,
    entity: "appointment",
    entityId: id,
    action: "appointment.created",
    diff: { staffId: input.staffId, clientId, startsAt: starts.toISOString(), endsAt: ends.toISOString() },
  });
  return getAppointment(ctx, id);
}

export async function getAppointment(ctx: Ctx, id: string) {
  const row = await loadRow(ctx, id);
  const branch = await loadBranch(ctx, row.branch_id);
  if (ctx.actor.role === "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  if (ctx.actor.role === "master" && !branch.master_sees_all_columns && ctx.actor.staffId !== row.staff_id) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  const lines = await linesOf(ctx, id);
  const client = row.client_id
    ? await one<{ name: string }>(ctx.db, "SELECT name FROM clients WHERE id = $1", [row.client_id])
    : null;
  const paid = await paidMinor(ctx, id);
  const price = lines.reduce((sum, line) => sum + line.priceMinor, 0);
  return {
    id: row.id,
    branchId: row.branch_id,
    staffId: row.staff_id,
    clientId: row.client_id,
    clientName: client?.name ?? null,
    bookedByClientId: row.booked_by_client_id,
    guest: Boolean(row.booked_by_client_id),
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    branchTz: row.branch_tz,
    tzOffsetMin: Number(row.tz_offset_min),
    status: row.status,
    comment: row.comment,
    source: row.source,
    color: row.color,
    version: Number(row.version),
    forceOverlap: row.force_overlap,
    overlapReason: row.overlap_reason,
    cancelReason: row.cancel_reason,
    debtMinor: Number(row.debt_minor),
    services: lines,
    priceMinor: price,
    paidMinor: paid,
    actions: statusActions(row, ctx, branch),
    history: await listAudit(ctx, "appointment", id),
  };
}

export function statusActions(row: Pick<ApptRow, "status" | "staff_id" | "starts_at" | "source">, ctx: Ctx, branch: BranchRow) {
  const own = ctx.actor.staffId === row.staff_id;
  const admin = isAdminPlus(ctx.actor);
  const masterOwn = ctx.actor.role === "master" && own;
  const canOperate = admin || masterOwn;
  const items: { id: string; label: string; enabled: boolean; reason: string | null }[] = [];
  const push = (id: string, label: string, enabled: boolean, reason: string | null) => {
    items.push({ id, label, enabled, reason: enabled ? null : reason });
  };
  const earlyMs = new Date(row.starts_at).getTime() - ctx.now.getTime();
  const arrivalOk = earlyMs <= branch.arrival_window_hours * 3600 * 1000;
  const graceOk = ctx.now.getTime() >= new Date(row.starts_at).getTime() + branch.no_show_grace_min * 60000;
  const future = new Date(row.starts_at).getTime() > ctx.now.getTime();
  const within24h = new Date(row.starts_at).getTime() - ctx.now.getTime() < 24 * 3600 * 1000;

  push(
    "confirmed",
    "Подтвердить",
    row.status === "scheduled" && admin,
    row.status !== "scheduled" ? "Недоступный переход" : "Только администратор",
  );
  push(
    "arrived",
    "Пришёл",
    canTransition(row.status, "arrived") && canOperate && (arrivalOk || admin),
    !canTransition(row.status, "arrived")
      ? "Недоступный переход"
      : !canOperate
        ? "Только свои записи"
        : "Рано отмечать приход",
  );
  push(
    "in_progress",
    "В работе",
    canTransition(row.status, "in_progress") && canOperate,
    !canTransition(row.status, "in_progress") ? "Сначала отметьте приход" : "Только свои записи",
  );
  push(
    "completed",
    "Завершить",
    canTransition(row.status, "completed") && canOperate,
    !canTransition(row.status, "completed") ? "Услуга ещё не в работе" : "Только свои записи",
  );
  push(
    "no_show",
    "Неявка",
    canTransition(row.status, "no_show") && (admin || masterOwn) && graceOk,
    !canTransition(row.status, "no_show") ? "Недоступный переход" : !graceOk ? "Ещё не прошло время ожидания" : "Недостаточно прав",
  );
  const cancelAllowed =
    (["scheduled", "confirmed"].includes(row.status) && (admin || (masterOwn && branch.master_can_cancel_own_future && future))) ||
    (["arrived", "in_progress"].includes(row.status) && admin);
  push(
    "cancelled",
    "Отменить",
    cancelAllowed,
    !["scheduled", "confirmed", "arrived", "in_progress"].includes(row.status)
      ? "Недоступный переход"
      : "Недостаточно прав",
  );
  void within24h;
  return items;
}

export async function updateAppointment(
  ctx: Ctx,
  id: string,
  input: {
    version: number;
    overwrite?: boolean;
    clientId?: string;
    staffId?: string;
    startsAt?: string;
    services?: ServiceInput[];
    comment?: string;
    bookedByClientId?: string | null;
    acknowledgeSoft?: boolean;
    forceOverlap?: boolean;
    overlapReason?: string;
    refreshPrice?: boolean;
  },
) {
  const row = await loadRow(ctx, id, true);
  const branch = await loadBranch(ctx, row.branch_id);
  assertVersion(row, input.version, input.overwrite, ctx.actor.role);
  if (row.status === "cancelled") throw new AppError("VALIDATION", "Отменённую запись можно только восстановить");
  if (ctx.actor.role === "master") {
    if (ctx.actor.staffId !== row.staff_id) throw new AppError("FORBIDDEN", "Недостаточно прав");
  } else if (!isAdminPlus(ctx.actor)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  const staffId = input.staffId ?? row.staff_id;
  if (ctx.actor.role === "master" && staffId !== ctx.actor.staffId) {
    throw new AppError("FORBIDDEN", "Нельзя передать чужому мастеру");
  }
  await lockStaff(ctx, staffId);
  await assertStaffBranch(ctx, staffId, row.branch_id);
  const previous = await linesOf(ctx, id);
  const paid = await paidMinor(ctx, id);
  if (paid > 0 && input.services && !isAdminPlus(ctx.actor)) {
    throw new AppError("FORBIDDEN", "Менять услуги после оплаты может администратор");
  }
  const lines = input.services
    ? await resolveLines(ctx, staffId, input.services, previous, Boolean(input.refreshPrice))
    : previous.map((line) => ({
        serviceId: line.serviceId!,
        title: line.title,
        durationMin: line.durationMin,
        priceMinor: line.priceMinor,
        color: row.color,
      }));
  if (input.clientId) await ensureClient(ctx, input.clientId);
  let bookedBy = input.bookedByClientId === undefined ? row.booked_by_client_id : input.bookedByClientId;
  const clientId = input.clientId ?? row.client_id;
  if (bookedBy && bookedBy === clientId) bookedBy = null;
  if (bookedBy) await ensureClient(ctx, bookedBy);
  const starts = input.startsAt ? new Date(input.startsAt) : new Date(row.starts_at);
  const ends = new Date(starts.getTime() + durationOf(lines) * 60000);
  assertSameDay(starts, ends, branch.timezone);
  const overlaps = await findOverlaps(ctx, staffId, starts, ends, id);
  const forced = assertSlot(overlaps, row.branch_id, input.forceOverlap, input.overlapReason, isAdminPlus(ctx.actor));
  await assertHours(ctx, branch, staffId, starts, ends, input.acknowledgeSoft);
  await ctx.db.query(
    `UPDATE appointments SET
       staff_id = $2, client_id = $3, booked_by_client_id = $4, starts_at = $5, ends_at = $6,
       comment = $7, color = $8, force_overlap = $9, overlap_reason = $10,
       version = version + 1, updated_by = $11, updated_at = now()
     WHERE id = $1`,
    [
      id,
      staffId,
      clientId,
      bookedBy,
      starts.toISOString(),
      ends.toISOString(),
      input.comment !== undefined ? input.comment : row.comment,
      lines[0]?.color ?? row.color,
      forced,
      forced ? input.overlapReason?.trim() ?? row.overlap_reason : null,
      ctx.actor.userId,
    ],
  );
  if (input.services) await writeLines(ctx, id, lines);
  const debt = await syncAppointmentDebt(ctx, id);
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: id,
    action: "appointment.updated",
    diff: {
      before: { staffId: row.staff_id, startsAt: new Date(row.starts_at).toISOString(), comment: row.comment },
      after: { staffId, startsAt: starts.toISOString(), comment: input.comment ?? row.comment },
    },
  });
  const fresh = await getAppointment(ctx, id);
  return { ...fresh, overpaidMinor: debt.overpaidMinor };
}

export async function moveAppointment(
  ctx: Ctx,
  id: string,
  input: {
    version: number;
    startsAt: string;
    endsAt?: string;
    staffId?: string;
    acknowledgeSoft?: boolean;
    forceOverlap?: boolean;
    overlapReason?: string;
    overwrite?: boolean;
  },
) {
  const row = await loadRow(ctx, id, true);
  const branch = await loadBranch(ctx, row.branch_id);
  assertVersion(row, input.version, input.overwrite, ctx.actor.role);
  if (row.status === "cancelled" || row.status === "completed") {
    throw new AppError("VALIDATION", "Эту запись нельзя переносить");
  }
  const staffId = input.staffId ?? row.staff_id;
  if (ctx.actor.role === "master") {
    if (!branch.master_can_drag_own || ctx.actor.staffId !== row.staff_id || staffId !== ctx.actor.staffId) {
      throw new AppError("FORBIDDEN", "Мастер может переносить только свои записи");
    }
  } else if (!isAdminPlus(ctx.actor)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  await lockStaff(ctx, staffId);
  await assertStaffBranch(ctx, staffId, row.branch_id);
  const lines = await linesOf(ctx, id);
  for (const line of lines) {
    if (!line.serviceId) continue;
    const link = await one(ctx.db, "SELECT 1 FROM service_staff WHERE service_id = $1 AND staff_id = $2", [
      line.serviceId,
      staffId,
    ]);
    if (!link) throw new AppError("VALIDATION", `Услуга «${line.title}» не оказывается этим мастером`);
  }
  const duration = new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime();
  const starts = new Date(input.startsAt);
  const ends = new Date(starts.getTime() + duration);
  if (input.endsAt && Math.abs(new Date(input.endsAt).getTime() - ends.getTime()) > 1000) {
    throw new AppError("VALIDATION", "При переносе длительность сохраняется");
  }
  assertSameDay(starts, ends, branch.timezone);
  const overlaps = await findOverlaps(ctx, staffId, starts, ends, id);
  const forced = assertSlot(overlaps, row.branch_id, input.forceOverlap, input.overlapReason, isAdminPlus(ctx.actor));
  const extra = row.status === "in_progress" ? ["IN_PROGRESS"] : [];
  await assertHours(ctx, branch, staffId, starts, ends, input.acknowledgeSoft, extra);
  await ctx.db.query(
    `UPDATE appointments SET staff_id = $2, starts_at = $3, ends_at = $4, force_overlap = $5, overlap_reason = $6,
       version = version + 1, updated_by = $7, updated_at = now()
     WHERE id = $1`,
    [id, staffId, starts.toISOString(), ends.toISOString(), forced, forced ? input.overlapReason?.trim() : null, ctx.actor.userId],
  );
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: id,
    action: "appointment.moved",
    diff: {
      from: { startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), staffId: row.staff_id },
      to: { startsAt: starts.toISOString(), endsAt: ends.toISOString(), staffId },
    },
  });
  return getAppointment(ctx, id);
}

export async function resizeAppointment(
  ctx: Ctx,
  id: string,
  input: { version: number; endsAt: string; acknowledgeSoft?: boolean; overwrite?: boolean },
) {
  const row = await loadRow(ctx, id, true);
  const branch = await loadBranch(ctx, row.branch_id);
  assertVersion(row, input.version, input.overwrite, ctx.actor.role);
  if (row.status === "cancelled" || row.status === "completed") {
    throw new AppError("VALIDATION", "Эту запись нельзя изменить по длительности");
  }
  if (ctx.actor.role === "master") {
    if (!branch.master_can_drag_own || ctx.actor.staffId !== row.staff_id) {
      throw new AppError("FORBIDDEN", "Недостаточно прав");
    }
  } else if (!isAdminPlus(ctx.actor)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  const starts = new Date(row.starts_at);
  const ends = new Date(input.endsAt);
  const deltaMin = Math.round((ends.getTime() - new Date(row.ends_at).getTime()) / 60000);
  if (deltaMin === 0) return getAppointment(ctx, id);
  if (deltaMin % 5 !== 0) throw new AppError("VALIDATION", "Шаг изменения — 5 минут");
  const lines = await linesOf(ctx, id);
  const last = lines[lines.length - 1];
  if (!last || last.durationMin + deltaMin < 5) {
    throw new AppError("VALIDATION", "Минимальная длительность услуги — 5 минут");
  }
  assertSameDay(starts, ends, branch.timezone);
  await lockStaff(ctx, row.staff_id);
  const overlaps = await findOverlaps(ctx, row.staff_id, starts, ends, id);
  assertSlot(overlaps, row.branch_id, false, undefined, false);
  await assertHours(ctx, branch, row.staff_id, starts, ends, input.acknowledgeSoft);
  await ctx.db.query("UPDATE appointment_services SET duration_min = duration_min + $2 WHERE id = $1", [last.id, deltaMin]);
  await ctx.db.query(
    `UPDATE appointments SET ends_at = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1`,
    [id, ends.toISOString(), ctx.actor.userId],
  );
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: id,
    action: "appointment.resized",
    diff: { deltaMin, serviceId: last.serviceId, priceUnchanged: true },
  });
  return getAppointment(ctx, id);
}

export async function changeStatus(
  ctx: Ctx,
  id: string,
  status: AppointmentStatus,
  input: { version: number; acknowledgeSoft?: boolean } = { version: 0 },
) {
  const row = await loadRow(ctx, id, true);
  const branch = await loadBranch(ctx, row.branch_id);
  assertVersion(row, input.version, false, ctx.actor.role);
  if (status === "cancelled" || status === "scheduled") {
    throw new AppError("VALIDATION", "Используйте отмену или восстановление");
  }
  if (!canTransition(row.status, status)) {
    throw new AppError("VALIDATION", "Недоступный переход статуса");
  }
  const own = ctx.actor.staffId === row.staff_id;
  const admin = isAdminPlus(ctx.actor);
  if (status === "confirmed" && !admin) throw new AppError("FORBIDDEN", "Подтвердить может администратор");
  if (["arrived", "in_progress", "completed", "no_show"].includes(status)) {
    if (!(admin || (ctx.actor.role === "master" && own))) throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  if (status === "arrived") {
    const early = new Date(row.starts_at).getTime() - ctx.now.getTime();
    if (early > branch.arrival_window_hours * 3600 * 1000) {
      if (!(admin && input.acknowledgeSoft)) {
        throw new AppError(admin ? "SOFT_CONFIRM" : "VALIDATION", "Рано отмечать приход", { warnings: ["EARLY_ARRIVAL"] });
      }
    }
  }
  if (status === "no_show") {
    const readyAt = new Date(row.starts_at).getTime() + branch.no_show_grace_min * 60000;
    if (ctx.now.getTime() < readyAt) throw new AppError("VALIDATION", "Ещё не прошло время ожидания");
  }
  const action = status === "completed" ? "appointment.completed" : status === "no_show" ? "appointment.no_show" : "appointment.status";
  await ctx.db.query(
    `UPDATE appointments SET status = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1`,
    [id, status, ctx.actor.userId],
  );
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: id,
    action,
    diff: { from: row.status, to: status },
  });
  const fresh = await getAppointment(ctx, id);
  return {
    ...fresh,
    paymentSuggested: status === "completed" && branch.require_payment_on_complete && fresh.paidMinor < fresh.priceMinor,
  };
}

export async function cancelAppointment(
  ctx: Ctx,
  id: string,
  input: { version: number; reason?: string; confirm?: boolean },
) {
  const row = await loadRow(ctx, id, true);
  const branch = await loadBranch(ctx, row.branch_id);
  assertVersion(row, input.version, false, ctx.actor.role);
  if (row.status === "cancelled") throw new AppError("VALIDATION", "Запись уже отменена");
  if (row.status === "completed" || row.status === "no_show") {
    throw new AppError("VALIDATION", "Эту запись нельзя отменить");
  }
  const admin = isAdminPlus(ctx.actor);
  const future = new Date(row.starts_at).getTime() > ctx.now.getTime();
  if (["arrived", "in_progress"].includes(row.status)) {
    if (!admin || !input.confirm) throw new AppError("VALIDATION", "Подтвердите отмену визита, который уже начался");
  } else if (ctx.actor.role === "master") {
    if (!branch.master_can_cancel_own_future || ctx.actor.staffId !== row.staff_id || !future) {
      throw new AppError("FORBIDDEN", "Можно отменить только свою будущую запись");
    }
  } else if (!admin) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  const hoursLeft = (new Date(row.starts_at).getTime() - ctx.now.getTime()) / 3600000;
  if ((hoursLeft < 24 || row.source === "online") && !input.reason?.trim()) {
    throw new AppError("VALIDATION", "Укажите причину отмены");
  }
  await clearAppointmentDebt(ctx, id);
  await ctx.db.query(
    `UPDATE appointments SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3,
       version = version + 1, updated_by = $3, updated_at = now()
     WHERE id = $1`,
    [id, input.reason?.trim() || null, ctx.actor.userId],
  );
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: id,
    action: "appointment.cancelled",
    diff: { reason: input.reason?.trim() || null, from: row.status },
  });
  const paid = await paidMinor(ctx, id);
  const fresh = await getAppointment(ctx, id);
  return { ...fresh, refundSuggested: paid > 0 };
}

export async function restoreAppointment(ctx: Ctx, id: string, version: number) {
  assertRole(ctx, ["owner", "admin", "super"]);
  const row = await loadRow(ctx, id, true);
  const branch = await loadBranch(ctx, row.branch_id);
  assertVersion(row, version, false, ctx.actor.role);
  if (row.status !== "cancelled" && row.status !== "no_show") {
    throw new AppError("VALIDATION", "Восстановить можно только отменённую запись или неявку");
  }
  await lockStaff(ctx, row.staff_id);
  const overlaps = await findOverlaps(ctx, row.staff_id, new Date(row.starts_at), new Date(row.ends_at), id);
  if (overlaps.length) {
    const duration = Math.round((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 60000);
    const suggestion = await suggestSlot(ctx, branch, row.staff_id, new Date(row.ends_at), duration);
    throw new AppError("CONFLICT_SLOT", "Слот занят", { conflicts: overlaps, suggestion });
  }
  await ctx.db.query(
    `UPDATE appointments SET status = 'scheduled', cancel_reason = NULL, cancelled_by = NULL,
       version = version + 1, updated_by = $2, updated_at = now()
     WHERE id = $1`,
    [id, ctx.actor.userId],
  );
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: id,
    action: "appointment.restored",
    diff: { from: row.status, to: "scheduled" },
  });
  return getAppointment(ctx, id);
}

export async function hardDeleteAppointment(ctx: Ctx, id: string) {
  assertRole(ctx, ["owner", "super"]);
  const row = await loadRow(ctx, id, true);
  if (row.status !== "cancelled" && row.status !== "no_show") {
    throw new AppError("VALIDATION", "Сначала отмените запись");
  }
  const payment = await one(ctx.db, "SELECT 1 FROM payments WHERE appointment_id = $1", [id]);
  if (payment) throw new AppError("VALIDATION", "Сначала отмените связанные оплаты");
  await ctx.db.query("DELETE FROM appointments WHERE id = $1", [id]);
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "appointment",
    entityId: id,
    action: "appointment.deleted",
    diff: { status: row.status },
  });
}

export async function reassignAppointmentStaff(ctx: Ctx, id: string, staffId: string) {
  const row = await loadRow(ctx, id, true);
  await lockStaff(ctx, staffId);
  await assertStaffBranch(ctx, staffId, row.branch_id);
  const lines = await linesOf(ctx, id);
  for (const line of lines) {
    if (!line.serviceId) continue;
    const link = await one(ctx.db, "SELECT 1 FROM service_staff WHERE service_id = $1 AND staff_id = $2", [line.serviceId, staffId]);
    if (!link) throw new AppError("VALIDATION", `Услуга «${line.title}» не оказывается новым мастером`);
  }
  const overlaps = await findOverlaps(ctx, staffId, new Date(row.starts_at), new Date(row.ends_at), id);
  assertSlot(overlaps, row.branch_id, false, undefined, false);
  await ctx.db.query(
    `UPDATE appointments SET staff_id = $2, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1`,
    [id, staffId, ctx.actor.userId],
  );
}

export async function getJournal(
  ctx: Ctx,
  input: { branchId: string; date: string; staffIds?: string[]; showOff?: boolean; showCancelled?: boolean },
) {
  const branch = await loadBranch(ctx, input.branchId);
  if (ctx.actor.role === "accountant" || ctx.actor.role === "client") {
    throw new AppError("FORBIDDEN", "Журнал недоступен для этой роли");
  }
  const range = localDayUtcRange(input.date, branch.timezone);
  const staffRows = await many<{ id: string; display_name: string; color: string; active: boolean }>(
    ctx.db,
    `SELECT s.id, s.display_name, s.color, s.active
     FROM staff s
     JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $1
     ORDER BY s.created_at, s.display_name`,
    [input.branchId],
  );
  const apptRows = await many<{
    id: string;
    staff_id: string;
    client_id: string | null;
    client_name: string | null;
    booked_by_client_id: string | null;
    starts_at: Date;
    ends_at: Date;
    status: AppointmentStatus;
    comment: string;
    source: string;
    color: string;
    version: number;
    force_overlap: boolean;
    debt_minor: number;
  }>(
    ctx.db,
    `SELECT a.id, a.staff_id, a.client_id, c.name AS client_name, a.booked_by_client_id, a.starts_at, a.ends_at,
            a.status, a.comment, a.source, a.color, a.version, a.force_overlap, a.debt_minor
     FROM appointments a
     LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.branch_id = $1 AND a.starts_at < $3 AND a.ends_at > $2
     ORDER BY a.starts_at`,
    [input.branchId, range.start.toISOString(), range.end.toISOString()],
  );
  let visibleIds = new Set(staffRows.map((row) => row.id));
  if (ctx.actor.role === "master" && !branch.master_sees_all_columns && ctx.actor.staffId) {
    visibleIds = new Set([ctx.actor.staffId]);
  }
  if (input.staffIds?.length) {
    visibleIds = new Set([...visibleIds].filter((id) => input.staffIds!.includes(id)));
  }
  const columns = [];
  for (const staff of staffRows) {
    if (!visibleIds.has(staff.id)) continue;
    const hours = await loadWorkingIntervals(ctx.db, input.branchId, staff.id, input.date);
    const hasWork = !hours.dayOff && hours.intervals.some((interval) => interval.kind === "work");
    const ownAppts = apptRows.filter((row) => row.staff_id === staff.id);
    if (!hasWork && ownAppts.length === 0 && !input.showOff) continue;
    if (!staff.active && ownAppts.length === 0) continue;
    const workMin = hours.intervals.filter((interval) => interval.kind === "work").reduce((sum, interval) => sum + (interval.endMin - interval.startMin), 0);
    const breakMin = hours.intervals.filter((interval) => interval.kind === "break").reduce((sum, interval) => sum + (interval.endMin - interval.startMin), 0);
    const booked = ownAppts
      .filter((row) => row.status !== "cancelled")
      .reduce((sum, row) => sum + (new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 60000, 0);
    const capacity = Math.max(0, workMin - breakMin);
    columns.push({
      id: staff.id,
      name: staff.display_name,
      color: staff.color,
      active: staff.active,
      dayOff: hours.dayOff || !hasWork,
      intervals: hours.intervals,
      loadPercent: capacity > 0 ? Math.round((booked / capacity) * 100) : 0,
    });
  }
  const columnIds = new Set(columns.map((column) => column.id));
  const appointments = [];
  for (const row of apptRows) {
    if (!columnIds.has(row.staff_id)) continue;
    if (!input.showCancelled && row.status === "cancelled") continue;
    const services = await linesOf(ctx, row.id);
    const paid = await paidMinor(ctx, row.id);
    const price = services.reduce((sum, line) => sum + line.priceMinor, 0);
    appointments.push({
      id: row.id,
      staffId: row.staff_id,
      clientId: row.client_id,
      clientName: row.client_name,
      bookedByClientId: row.booked_by_client_id,
      guest: Boolean(row.booked_by_client_id),
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      startMin: localMinutes(new Date(row.starts_at), branch.timezone),
      endMin: localMinutes(new Date(row.ends_at), branch.timezone) || 24 * 60,
      status: row.status,
      comment: row.comment,
      source: row.source,
      color: row.color,
      version: Number(row.version),
      forceOverlap: row.force_overlap,
      debtMinor: Number(row.debt_minor),
      services: services.map((line) => ({ id: line.id, serviceId: line.serviceId, title: line.title, durationMin: line.durationMin, priceMinor: line.priceMinor })),
      priceMinor: price,
      paidMinor: paid,
    });
  }
  const activeAppts = appointments.filter((row) => row.status !== "cancelled");
  const expected = activeAppts.reduce((sum, row) => sum + row.priceMinor, 0);
  const workCapacity = columns.reduce((sum, column) => {
    const work = column.intervals.filter((interval) => interval.kind === "work").reduce((acc, interval) => acc + interval.endMin - interval.startMin, 0);
    const brk = column.intervals.filter((interval) => interval.kind === "break").reduce((acc, interval) => acc + interval.endMin - interval.startMin, 0);
    return sum + Math.max(0, work - brk);
  }, 0);
  const booked = activeAppts.reduce((sum, row) => sum + (new Date(row.endsAt).getTime() - new Date(row.startsAt).getTime()) / 60000, 0);
  let minStart = 10 * 60;
  let maxEnd = 20 * 60;
  for (const column of columns) {
    for (const interval of column.intervals.filter((item) => item.kind === "work")) {
      minStart = Math.min(minStart, interval.startMin);
      maxEnd = Math.max(maxEnd, interval.endMin);
    }
  }
  for (const row of appointments) {
    minStart = Math.min(minStart, row.startMin);
    maxEnd = Math.max(maxEnd, row.endMin);
  }
  const dayStartMin = Math.floor(minStart / 60) * 60;
  const dayEndMin = Math.ceil(maxEnd / 60) * 60;
  const created = await one<{ s: number }>(
    ctx.db,
    `SELECT count(*)::int AS s FROM clients
     WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2`,
    [range.start.toISOString(), range.end.toISOString()],
  );
  const pref = await one<{ journal_density: "auto" | Density }>(
    ctx.db,
    "SELECT journal_density FROM user_preferences WHERE user_id = $1",
    [ctx.actor.userId],
  );
  return {
    date: input.date,
    branch: {
      id: branch.id,
      name: branch.name,
      timezone: branch.timezone,
      currency: branch.currency,
      gridLabelMin: branch.grid_label_min,
      requireOpenShift: branch.require_open_shift,
      requirePaymentOnComplete: branch.require_payment_on_complete,
    },
    density: resolveDensity(pref?.journal_density ?? "auto", columns.length),
    dayStartMin,
    dayEndMin: Math.max(dayEndMin, dayStartMin + 8 * 60),
    staff: columns,
    appointments,
    stats: {
      expectedRevenueMinor: expected,
      loadPercent: workCapacity > 0 ? Math.round((booked / workCapacity) * 100) : 0,
      appointmentCount: activeAppts.length,
      onlineCount: activeAppts.filter((row) => row.source === "online").length,
      newClients: Number(created?.s ?? 0),
      anomalies: appointments.filter((row) => row.forceOverlap).length,
    },
  };
}

export async function searchAppointments(ctx: Ctx, branchId: string, query: string) {
  const branch = await loadBranch(ctx, branchId);
  if (ctx.actor.role === "accountant" || ctx.actor.role === "client") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const q = query.trim();
  const digits = phoneDigits(q);
  if (q.length < 2 && digits.length < 10) return [];
  const staffLimit = ctx.actor.role === "master" && !branch.master_sees_all_columns ? ctx.actor.staffId : null;
  const rows = await many<{
    id: string;
    starts_at: Date;
    status: string;
    client_name: string;
    staff_name: string;
    branch_id: string;
  }>(
    ctx.db,
    `SELECT a.id, a.starts_at, a.status, c.name AS client_name, s.display_name AS staff_name, a.branch_id
     FROM appointments a
     JOIN clients c ON c.id = a.client_id
     JOIN staff s ON s.id = a.staff_id
     WHERE a.status <> 'cancelled' AND a.starts_at >= $1 AND a.branch_id = $2
       AND ($5::uuid IS NULL OR a.staff_id = $5)
       AND (
         c.name ILIKE $3 OR ($4::text IS NOT NULL AND EXISTS (
           SELECT 1 FROM client_phones p WHERE p.client_id = c.id AND p.deleted_at IS NULL AND p.phone_e164 LIKE $4
         ))
       )
     ORDER BY a.starts_at
     LIMIT 20`,
    [ctx.now.toISOString(), branchId, `%${q}%`, digits.length >= 2 ? `%${digits}%` : null, staffLimit],
  );
  return rows.map((row) => ({
    id: row.id,
    startsAt: new Date(row.starts_at).toISOString(),
    status: row.status,
    clientName: row.client_name,
    staffName: row.staff_name,
    branchId: row.branch_id,
    date: formatLocalDate(new Date(row.starts_at), branch.timezone),
  }));
}

export async function previousClient(ctx: Ctx, branchId: string, staffId: string, date: string) {
  const branch = await loadBranch(ctx, branchId);
  const range = localDayUtcRange(date, branch.timezone);
  const recent = await one<{ id: string; name: string }>(
    ctx.db,
    `SELECT c.id, c.name
     FROM appointments a JOIN clients c ON c.id = a.client_id
     WHERE a.staff_id = $1 AND a.branch_id = $2 AND a.status IN ('completed', 'arrived')
       AND a.starts_at >= $3 AND a.starts_at < $4 AND c.deleted_at IS NULL
     ORDER BY a.ends_at DESC LIMIT 1`,
    [staffId, branchId, range.start.toISOString(), range.end.toISOString()],
  );
  if (recent) return { id: recent.id, name: recent.name, source: "today" as const };
  const fallback = await one<{ id: string; name: string }>(
    ctx.db,
    `SELECT c.id, c.name FROM clients c
     WHERE c.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND a.branch_id = $1)
     ORDER BY c.created_at DESC LIMIT 1`,
    [branchId],
  );
  if (fallback) return { id: fallback.id, name: fallback.name, source: "branch" as const };
  const anyClient = await one<{ id: string; name: string }>(
    ctx.db,
    "SELECT id, name FROM clients WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
  );
  return anyClient ? { id: anyClient.id, name: anyClient.name, source: "tenant" as const } : null;
}

function csvCell(value: string) {
  let safe = value ?? "";
  if (/^[=+\-@]/.test(safe)) safe = `'${safe}`;
  if (/[",\n;]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export async function exportAppointmentsCsv(
  ctx: Ctx,
  input: { branchId: string; date: string; staffId?: string; status?: string },
) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const branch = await loadBranch(ctx, input.branchId);
  const journal = await getJournal(ctx, { branchId: input.branchId, date: input.date, showCancelled: true, showOff: true });
  const rows = journal.appointments.filter((row) => {
    if (input.staffId && row.staffId !== input.staffId) return false;
    if (input.status && row.status !== input.status) return false;
    return true;
  });
  const header = ["date", "start", "end", "staff", "client", "services", "status", "price_minor", "paid_minor", "source"];
  const staffName = new Map(journal.staff.map((staff) => [staff.id, staff.name]));
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        input.date,
        row.startsAt,
        row.endsAt,
        staffName.get(row.staffId) ?? row.staffId,
        row.clientName ?? "",
        row.services.map((service) => service.title).join(" + "),
        row.status,
        String(row.priceMinor),
        String(row.paidMinor),
        row.source,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  await audit(ctx, {
    branchId: branch.id,
    entity: "appointment",
    entityId: branch.id,
    action: "appointment.exported",
    diff: { date: input.date, count: rows.length },
  });
  return lines.join("\n");
}
