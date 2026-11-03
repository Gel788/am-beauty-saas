import { createHash, randomBytes } from "crypto";
import { AppError, isAppError } from "@/domain/errors";
import { normalizePhone } from "@/domain/phone";
import { isInsideWorkingHours } from "@/domain/schedule";
import {
  addCalendarDays,
  formatLocalDate,
  formatLocalTime,
  localDayUtcRange,
  todayInZone,
  zonedDateTimeToUtc,
} from "@/domain/time";
import { createAppointment, lockStaff } from "./appointments";
import { audit } from "./audit";
import { many, one, poolOne, withSession } from "./db";
import { loadWorkingIntervals } from "./hours";
import type { Actor, BranchRow, Ctx } from "./types";
import { applyPromo } from "./loyalty";

/** The online channel acts under this fixed id: it has no user row, like the system actor in audit. */
export const ONLINE_ACTOR_ID = "00000000-0000-0000-0000-0000000000b0";

const MAX_SLOT_DAYS = 14;
const HOLDS_PER_IP_PER_HOUR = 30;

type OnlineBranch = BranchRow;

type ServiceRow = {
  id: string;
  title: string;
  duration_min: number;
  buffer_after_min: number;
  price_minor: number;
  category_id: string | null;
};

type StaffRow = { id: string; display_name: string; color: string; specialties: string };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function onlineActor(tenantId: string): Actor {
  return {
    userId: ONLINE_ACTOR_ID,
    tenantId,
    role: "client",
    branchId: null,
    staffId: null,
    name: "Онлайн-запись",
    email: "",
  };
}

export function asOnline<T>(tenantId: string, fn: (ctx: Ctx) => Promise<T>, now = new Date()): Promise<T> {
  return withSession({ tenantId, userId: ONLINE_ACTOR_ID }, (db) =>
    fn({ db, actor: onlineActor(tenantId), now, channel: "online" }),
  );
}

/** Slug pair → ids. Runs outside any tenant: the SECURITY DEFINER lookup is the only door. */
export async function resolvePublicBranch(tenantSlug: string, branchSlug: string) {
  const row = await poolOne<{ tenant_id: string; branch_id: string }>(
    "SELECT tenant_id, branch_id FROM public_branch_lookup($1, $2)",
    [tenantSlug.toLowerCase(), branchSlug.toLowerCase()],
  );
  if (!row) throw new AppError("NOT_FOUND", "Онлайн-запись не найдена");
  return { tenantId: row.tenant_id, branchId: row.branch_id };
}

export async function resolveBookingToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("NOT_FOUND", "Запись не найдена");
  const row = await poolOne<{ tenant_id: string; appointment_id: string }>(
    "SELECT tenant_id, appointment_id FROM public_booking_lookup($1)",
    [sha256(token)],
  );
  if (!row) throw new AppError("NOT_FOUND", "Запись не найдена");
  return { tenantId: row.tenant_id, appointmentId: row.appointment_id };
}

async function loadOnlineBranch(ctx: Ctx, branchId: string): Promise<OnlineBranch> {
  const branch = await one<OnlineBranch>(ctx.db, "SELECT * FROM branches WHERE id = $1", [branchId]);
  if (!branch || !branch.online_enabled) throw new AppError("NOT_FOUND", "Онлайн-запись не найдена");
  return branch;
}

async function loadOnlineService(ctx: Ctx, serviceId: string): Promise<ServiceRow> {
  const service = await one<ServiceRow>(
    ctx.db,
    `SELECT id, title, duration_min, buffer_after_min, price_minor, category_id
     FROM services WHERE id = $1 AND active AND online_visible`,
    [serviceId],
  );
  if (!service) throw new AppError("VALIDATION", "Услуга недоступна для онлайн-записи");
  return service;
}

/** Masters who can take this service online in this branch, in display order. */
async function eligibleStaff(ctx: Ctx, branchId: string, serviceId: string): Promise<StaffRow[]> {
  return many<StaffRow>(
    ctx.db,
    `SELECT s.id, s.display_name, s.color, s.specialties
     FROM staff s
     JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $1
     JOIN service_staff ss ON ss.staff_id = s.id AND ss.service_id = $2
     WHERE s.active AND s.online_bookable
     ORDER BY s.display_name, s.id`,
    [branchId, serviceId],
  );
}

function presentBranch(branch: OnlineBranch) {
  return {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    timezone: branch.timezone,
    currency: branch.currency,
    accent: branch.online_accent,
    logoUrl: branch.online_logo_url,
    cancelHours: Number(branch.online_cancel_hours),
    maxAdvanceDays: Number(branch.online_max_advance_days),
  };
}

/** Step 1 of the funnel: categories → services that are online_visible, active and have a master. */
export async function publicCatalog(ctx: Ctx, branchId: string) {
  const branch = await loadOnlineBranch(ctx, branchId);
  const categories = await many<{ id: string; title: string }>(
    ctx.db,
    "SELECT id, title FROM service_categories ORDER BY sort, title",
  );
  const services = await many<ServiceRow & { staff_ids: string[] }>(
    ctx.db,
    `SELECT sv.id, sv.title, sv.duration_min, sv.buffer_after_min, sv.price_minor, sv.category_id,
            array_agg(s.id ORDER BY s.display_name, s.id) AS staff_ids
     FROM services sv
     JOIN service_staff ss ON ss.service_id = sv.id
     JOIN staff s ON s.id = ss.staff_id AND s.active AND s.online_bookable
     JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $1
     WHERE sv.active AND sv.online_visible
     GROUP BY sv.id
     ORDER BY sv.sort, sv.title`,
    [branchId],
  );
  const staffIds = [...new Set(services.flatMap((service) => service.staff_ids))];
  const staff = staffIds.length
    ? await many<StaffRow>(
        ctx.db,
        "SELECT id, display_name, color, specialties FROM staff WHERE id = ANY($1::uuid[]) ORDER BY display_name, id",
        [staffIds],
      )
    : [];
  const used = new Set(services.map((service) => service.category_id));
  return {
    branch: presentBranch(branch),
    categories: categories.filter((category) => used.has(category.id)),
    services: services.map((service) => ({
      id: service.id,
      title: service.title,
      categoryId: service.category_id,
      durationMin: Number(service.duration_min),
      priceMinor: Number(service.price_minor),
      staffIds: service.staff_ids,
    })),
    staff: staff.map((row) => ({ id: row.id, name: row.display_name, color: row.color, specialties: row.specialties })),
  };
}

type Busy = { start: number; end: number };

async function busyFor(ctx: Ctx, staffId: string, from: Date, to: Date, exceptHoldId?: string): Promise<Busy[]> {
  const rows = await many<{ starts_at: Date; ends_at: Date }>(
    ctx.db,
    `SELECT starts_at, ends_at FROM appointments
     WHERE staff_id = $1 AND status <> 'cancelled' AND starts_at < $3 AND ends_at > $2
     UNION ALL
     SELECT starts_at, ends_at FROM slot_holds
     WHERE staff_id = $1 AND appointment_id IS NULL AND released_at IS NULL AND expires_at > $4
       AND starts_at < $3 AND ends_at > $2
       AND id <> COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000')`,
    [staffId, from.toISOString(), to.toISOString(), ctx.now.toISOString(), exceptHoldId ?? null],
  );
  return rows.map((row) => ({ start: new Date(row.starts_at).getTime(), end: new Date(row.ends_at).getTime() }));
}

/** OB-SLOT-01 for one master and one local day. Returns slot starts in minutes from local midnight. */
async function staffDaySlots(
  ctx: Ctx,
  branch: OnlineBranch,
  staffId: string,
  date: string,
  blockMin: number,
  exceptHoldId?: string,
): Promise<number[]> {
  const today = todayInZone(branch.timezone, ctx.now);
  if (date < today || date > addCalendarDays(today, Number(branch.online_max_advance_days))) return [];
  const day = await loadWorkingIntervals(ctx.db, branch.id, staffId, date);
  if (day.dayOff) return [];
  const range = localDayUtcRange(date, branch.timezone);
  const busy = await busyFor(ctx, staffId, range.start, range.end, exceptHoldId);
  const earliest = ctx.now.getTime() + Number(branch.online_min_notice_min) * 60000;
  const step = Number(branch.online_step_min);
  const result: number[] = [];
  for (const work of day.intervals.filter((item) => item.kind === "work")) {
    for (let start = Math.ceil(work.startMin / step) * step; start + blockMin <= work.endMin; start += step) {
      if (!isInsideWorkingHours(day.intervals, start, start + blockMin)) continue;
      const startMs = zonedDateTimeToUtc(date, start, branch.timezone).getTime();
      if (startMs < earliest) continue;
      const endMs = startMs + blockMin * 60000;
      if (busy.some((item) => item.start < endMs && item.end > startMs)) continue;
      result.push(start);
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

function blockOf(service: ServiceRow) {
  return Number(service.duration_min) + Number(service.buffer_after_min);
}

function assertDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError("VALIDATION", `${label}: дата в формате ГГГГ-ММ-ДД`);
}

/** Step 2: free windows per day. `staffId` empty means «любой мастер». */
export async function listSlots(
  ctx: Ctx,
  branchId: string,
  input: { serviceId: string; staffId?: string | null; from?: string; days?: number },
) {
  const branch = await loadOnlineBranch(ctx, branchId);
  const service = await loadOnlineService(ctx, input.serviceId);
  let staff = await eligibleStaff(ctx, branchId, service.id);
  if (input.staffId) {
    staff = staff.filter((row) => row.id === input.staffId);
    if (!staff.length) throw new AppError("VALIDATION", "Мастер не принимает онлайн-запись на эту услугу");
  }
  const from = input.from ?? todayInZone(branch.timezone, ctx.now);
  assertDate(from, "Начало периода");
  const days = Math.min(Math.max(Math.trunc(Number(input.days ?? 7)), 1), MAX_SLOT_DAYS);
  const block = blockOf(service);
  const result = [];
  for (let i = 0; i < days; i += 1) {
    const date = addCalendarDays(from, i);
    const byStart = new Map<number, string[]>();
    for (const member of staff) {
      for (const start of await staffDaySlots(ctx, branch, member.id, date, block)) {
        byStart.set(start, [...(byStart.get(start) ?? []), member.id]);
      }
    }
    result.push({
      date,
      slots: [...byStart.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([start, staffIds]) => {
          const startsAt = zonedDateTimeToUtc(date, start, branch.timezone);
          return { startsAt: startsAt.toISOString(), time: formatLocalTime(startsAt, branch.timezone), staffIds };
        }),
    });
  }
  return { serviceId: service.id, durationMin: Number(service.duration_min), stepMin: Number(branch.online_step_min), days: result };
}

/** OB-SLOT-02: reserve the slot before step 3. With «любой» the first free master in display order wins. */
export async function createHold(
  ctx: Ctx,
  branchId: string,
  input: { serviceId: string; staffId?: string | null; startsAt: string; ip?: string | null },
) {
  const branch = await loadOnlineBranch(ctx, branchId);
  const service = await loadOnlineService(ctx, input.serviceId);
  const starts = new Date(input.startsAt);
  if (Number.isNaN(starts.getTime())) throw new AppError("VALIDATION", "Некорректное время");
  if (input.ip) {
    const recent = await one<{ n: number }>(
      ctx.db,
      "SELECT COUNT(*)::int AS n FROM slot_holds WHERE ip = $1 AND created_at > $2::timestamptz - interval '1 hour'",
      [input.ip, ctx.now.toISOString()],
    );
    if (Number(recent?.n ?? 0) >= HOLDS_PER_IP_PER_HOUR) {
      throw new AppError("VALIDATION", "Слишком много попыток. Попробуйте позже или позвоните в салон");
    }
  }
  let candidates = await eligibleStaff(ctx, branchId, service.id);
  if (input.staffId) candidates = candidates.filter((row) => row.id === input.staffId);
  if (!candidates.length) throw new AppError("VALIDATION", "Мастер не принимает онлайн-запись на эту услугу");

  const date = formatLocalDate(starts, branch.timezone);
  const minute = Math.round((starts.getTime() - localDayUtcRange(date, branch.timezone).start.getTime()) / 60000);
  const block = blockOf(service);
  for (const member of candidates) {
    // The staff row lock serialises holds, confirms and admin edits for this master.
    await lockStaff(ctx, member.id);
    const free = await staffDaySlots(ctx, branch, member.id, date, block);
    if (!free.includes(minute)) continue;
    const id = crypto.randomUUID();
    const expires = new Date(ctx.now.getTime() + Number(branch.online_hold_min) * 60000);
    await ctx.db.query(
      `INSERT INTO slot_holds (id, tenant_id, branch_id, staff_id, service_id, starts_at, ends_at, expires_at, ip, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        ctx.actor.tenantId,
        branchId,
        member.id,
        service.id,
        starts.toISOString(),
        new Date(starts.getTime() + block * 60000).toISOString(),
        expires.toISOString(),
        input.ip ?? null,
        ctx.now.toISOString(),
      ],
    );
    return {
      holdId: id,
      expiresAt: expires.toISOString(),
      staffId: member.id,
      staffName: member.display_name,
      serviceId: service.id,
      serviceTitle: service.title,
      priceMinor: Number(service.price_minor),
      startsAt: starts.toISOString(),
      endsAt: new Date(starts.getTime() + Number(service.duration_min) * 60000).toISOString(),
    };
  }
  throw new AppError("CONFLICT_SLOT", "Это время уже заняли. Выберите другое", { reason: "SLOT_TAKEN" });
}

/** Going back to step 2 frees the slot at once instead of waiting for the TTL. */
export async function releaseHold(ctx: Ctx, branchId: string, holdId: string) {
  await ctx.db.query(
    "UPDATE slot_holds SET released_at = $3 WHERE id = $1 AND branch_id = $2 AND appointment_id IS NULL AND released_at IS NULL",
    [holdId, branchId, ctx.now.toISOString()],
  );
  return { ok: true };
}

type HoldRow = {
  id: string;
  branch_id: string;
  staff_id: string;
  service_id: string;
  starts_at: Date;
  expires_at: Date;
  appointment_id: string | null;
  idempotency_key: string | null;
  released_at: Date | null;
  result: Record<string, unknown> | null;
};

async function findOrCreateClient(ctx: Ctx, name: string, phone: string) {
  const existing = await one<{ id: string }>(
    ctx.db,
    `SELECT c.id FROM client_phones p JOIN clients c ON c.id = p.client_id
     WHERE p.phone_e164 = $1 AND p.deleted_at IS NULL AND c.deleted_at IS NULL
     ORDER BY p.is_primary DESC LIMIT 1`,
    [phone],
  );
  if (existing) return { id: existing.id, created: false };
  const id = crypto.randomUUID();
  await ctx.db.query("INSERT INTO clients (id, tenant_id, name, source) VALUES ($1, $2, $3, 'online')", [
    id,
    ctx.actor.tenantId,
    name,
  ]);
  await ctx.db.query(
    "INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary) VALUES ($1, $2, $3, $4, true)",
    [crypto.randomUUID(), ctx.actor.tenantId, id, phone],
  );
  await audit(ctx, { entity: "client", entityId: id, action: "client.created", diff: { source: "online" } });
  return { id, created: true };
}

/** Step 3: contacts + confirm. Converts the hold into an appointment with source=online. */
export async function confirmBooking(
  ctx: Ctx,
  branchId: string,
  input: { holdId: string; name: string; phone: string; comment?: string; idempotencyKey?: string; promoCode?: string },
) {
  const branch = await loadOnlineBranch(ctx, branchId);
  const hold = await one<HoldRow>(ctx.db, "SELECT * FROM slot_holds WHERE id = $1 AND branch_id = $2 FOR UPDATE", [
    input.holdId,
    branchId,
  ]);
  if (!hold) throw new AppError("NOT_FOUND", "Бронь не найдена");
  if (hold.appointment_id) {
    // Double submit: same key gets the same answer, anything else is a second booking attempt.
    if (input.idempotencyKey && input.idempotencyKey === hold.idempotency_key && hold.result) return hold.result;
    throw new AppError("VALIDATION", "Запись по этой брони уже оформлена");
  }
  if (hold.released_at || new Date(hold.expires_at).getTime() <= ctx.now.getTime()) {
    throw new AppError("CONFLICT_SLOT", "Время брони истекло. Выберите время заново", { reason: "HOLD_EXPIRED" });
  }
  const name = input.name?.trim() ?? "";
  if (name.length < 1 || name.length > 120) throw new AppError("VALIDATION", "Укажите имя");
  const phone = normalizePhone(input.phone ?? "");
  const comment = (input.comment ?? "").trim().slice(0, 500);

  const staff = await one<{ active: boolean; online_bookable: boolean; display_name: string }>(
    ctx.db,
    "SELECT active, online_bookable, display_name FROM staff WHERE id = $1",
    [hold.staff_id],
  );
  if (!staff?.active || !staff.online_bookable) {
    throw new AppError("CONFLICT_SLOT", "Мастер больше не принимает запись. Выберите другое время", { reason: "STAFF_UNAVAILABLE" });
  }
  const service = await loadOnlineService(ctx, hold.service_id);

  const client = await findOrCreateClient(ctx, name, phone);
  const active = await one<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*)::int AS n FROM appointments
     WHERE client_id = $1 AND source = 'online' AND status IN ('scheduled', 'confirmed') AND starts_at > $2`,
    [client.id, ctx.now.toISOString()],
  );
  if (Number(active?.n ?? 0) >= Number(branch.online_max_active_per_phone)) {
    throw new AppError("VALIDATION", "У вас уже есть несколько будущих записей. Чтобы записаться ещё, позвоните в салон");
  }

  let appointment: Awaited<ReturnType<typeof createAppointment>>;
  try {
    appointment = await createAppointment(ctx, {
      branchId,
      staffId: hold.staff_id,
      clientId: client.id,
      startsAt: new Date(hold.starts_at).toISOString(),
      services: [{ serviceId: service.id }],
      comment,
      source: "online",
      acknowledgeSoft: false,
    });
  } catch (error) {
    // Schedule changed or an admin booked over the hold: the client picks another slot.
    if (isAppError(error) && (error.code === "SOFT_CONFIRM" || error.code === "CONFLICT_SLOT")) {
      throw new AppError("CONFLICT_SLOT", "Это время больше недоступно. Выберите другое", { reason: "SLOT_TAKEN" });
    }
    if (isAppError(error) && error.code === "VALIDATION") {
      throw new AppError("CONFLICT_SLOT", error.message, { reason: "SLOT_TAKEN" });
    }
    throw error;
  }

  let promo: { code: string; discountMinor: number; priceMinor: number } | null = null;
  if (input.promoCode?.trim()) promo = await applyPromo(ctx, appointment.id, input.promoCode, { online: true });

  const token = randomBytes(32).toString("hex");
  await ctx.db.query("UPDATE appointments SET cancel_token_hash = $2 WHERE id = $1", [appointment.id, sha256(token)]);
  const cancelUntil = new Date(new Date(appointment.startsAt).getTime() - Number(branch.online_cancel_hours) * 3600000);
  const result = {
    appointmentId: appointment.id,
    status: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    staffName: staff.display_name,
    serviceTitle: service.title,
    priceMinor: promo ? promo.priceMinor : appointment.priceMinor,
    promo: promo ? { code: promo.code, discountMinor: promo.discountMinor } : null,
    clientName: name,
    cancelToken: token,
    cancelUntil: cancelUntil.toISOString(),
    branch: presentBranch(branch),
  };
  await ctx.db.query(
    "UPDATE slot_holds SET appointment_id = $2, idempotency_key = $3, result = $4::jsonb WHERE id = $1",
    [hold.id, appointment.id, input.idempotencyKey ?? null, JSON.stringify(result)],
  );
  await audit(ctx, {
    branchId,
    entity: "appointment",
    entityId: appointment.id,
    action: "appointment.online_booked",
    diff: { holdId: hold.id, clientId: client.id, newClient: client.created },
  });
  return result;
}

const CLIENT_CANCELLABLE = new Set(["scheduled", "confirmed"]);

async function loadBooking(ctx: Ctx, appointmentId: string) {
  const row = await one<{
    id: string;
    branch_id: string;
    staff_id: string;
    starts_at: Date;
    ends_at: Date;
    status: string;
    staff_name: string;
    client_name: string | null;
    title: string | null;
    price_minor: number;
  }>(
    ctx.db,
    `SELECT a.id, a.branch_id, a.staff_id, a.starts_at, a.ends_at, a.status, s.display_name AS staff_name,
            c.name AS client_name,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title,
            (SELECT COALESCE(SUM(price_minor), 0)::int FROM appointment_services WHERE appointment_id = a.id) AS price_minor
     FROM appointments a
     JOIN staff s ON s.id = a.staff_id
     LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.id = $1 FOR UPDATE OF a`,
    [appointmentId],
  );
  if (!row) throw new AppError("NOT_FOUND", "Запись не найдена");
  const branch = await one<OnlineBranch>(ctx.db, "SELECT * FROM branches WHERE id = $1", [row.branch_id]);
  if (!branch) throw new AppError("NOT_FOUND", "Запись не найдена");
  const cancelUntil = new Date(new Date(row.starts_at).getTime() - Number(branch.online_cancel_hours) * 3600000);
  const canCancel = CLIENT_CANCELLABLE.has(row.status) && ctx.now.getTime() < cancelUntil.getTime();
  return { row, branch, cancelUntil, canCancel };
}

function presentBooking(booking: Awaited<ReturnType<typeof loadBooking>>) {
  const { row, branch } = booking;
  return {
    appointmentId: row.id,
    status: row.status,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    staffName: row.staff_name,
    clientName: row.client_name,
    serviceTitle: row.title ?? "",
    priceMinor: Number(row.price_minor),
    cancelUntil: booking.cancelUntil.toISOString(),
    canCancel: booking.canCancel,
    branch: presentBranch(branch),
  };
}

export async function getBooking(ctx: Ctx, appointmentId: string) {
  return presentBooking(await loadBooking(ctx, appointmentId));
}

/** OB-CANCEL-01: inside the window the client cancels; later it becomes a request to the admin. */
export async function cancelBooking(ctx: Ctx, appointmentId: string, input: { reason?: string } = {}) {
  const booking = await loadBooking(ctx, appointmentId);
  const reason = (input.reason ?? "").trim().slice(0, 300);
  if (booking.row.status === "cancelled") return { ...presentBooking(booking), outcome: "already_cancelled" as const };
  if (!CLIENT_CANCELLABLE.has(booking.row.status)) {
    throw new AppError("VALIDATION", "Эту запись уже нельзя отменить онлайн");
  }
  if (!booking.canCancel) {
    await audit(ctx, {
      branchId: booking.row.branch_id,
      entity: "appointment",
      entityId: appointmentId,
      action: "appointment.cancel_requested",
      diff: { reason: reason || null, via: "online" },
    });
    return { ...presentBooking(booking), outcome: "requested" as const };
  }
  await ctx.db.query(
    `UPDATE appointments SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3,
       version = version + 1, updated_by = $3, updated_at = now()
     WHERE id = $1`,
    [appointmentId, reason ? `Клиент отменил онлайн: ${reason}` : "Клиент отменил онлайн", ctx.actor.userId],
  );
  await audit(ctx, {
    branchId: booking.row.branch_id,
    entity: "appointment",
    entityId: appointmentId,
    action: "appointment.cancelled",
    diff: { reason: reason || null, from: booking.row.status, via: "online" },
  });
  return { ...presentBooking(await loadBooking(ctx, appointmentId)), outcome: "cancelled" as const };
}
