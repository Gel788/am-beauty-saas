/**
 * Stage 6: bringing clients back.
 * REV-*: a review request after the visit, the client's page, moderation, ratings for the widget.
 * WAIT-*: waitlist; a cancelled slot is matched against it and offered in one tap.
 * NOSHOW-01: a phone with too many no-shows books by calling the salon.
 * REBOOK-*: "book again" at checkout, a due list, and consent-gated rebook / birthday messages.
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError, isAppError } from "@/domain/errors";
import { addCalendarDays, formatLocalDate, localMinutes, todayInZone, zonedDateTimeToUtc } from "@/domain/time";
import { isAdminPlus, loadBranch } from "./access";
import { createAppointment, getAppointment } from "./appointments";
import { audit } from "./audit";
import { many, one, poolOne, pool, withSession } from "./db";
import { appointmentValues, deliverToClient, notifyDesk, publicUrl, render, templateBody } from "./messaging";
import { inQuietHours, JOBS_ACTOR_ID } from "./reminders";
import type { Actor, BranchRow, Ctx } from "./types";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function requireAdmin(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
}

/** The salon's public booking page: where every "come back" message points. */
export async function bookingPageUrl(ctx: Ctx, branchId: string) {
  const row = await one<{ tenant_slug: string; branch_slug: string; online_enabled: boolean }>(
    ctx.db,
    "SELECT t.slug AS tenant_slug, b.slug AS branch_slug, b.online_enabled FROM branches b JOIN tenants t ON t.id = b.tenant_id WHERE b.id = $1",
    [branchId],
  );
  if (!row) return publicUrl();
  return `${publicUrl()}/b/${row.tenant_slug}/${row.branch_slug}`;
}

// ---------------------------------------------------------------- Settings

export function presentRetentionSettings(branch: BranchRow) {
  return {
    reviewEnabled: branch.review_enabled,
    reviewDelayHours: Number(branch.review_delay_hours),
    reviewModeration: branch.review_moderation,
    noshowBlockAfter: Number(branch.noshow_block_after),
    rebookEnabled: branch.rebook_enabled,
    birthdayEnabled: branch.birthday_enabled,
  };
}

export async function retentionSettings(ctx: Ctx, branchId: string) {
  requireAdmin(ctx);
  return presentRetentionSettings(await loadBranch(ctx, branchId));
}

export async function updateRetentionSettings(ctx: Ctx, branchId: string, input: Record<string, unknown>) {
  requireAdmin(ctx);
  const before = await loadBranch(ctx, branchId);
  const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
  const int = (value: unknown, min: number, max: number, label: string) => {
    if (value === undefined || value === null) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new AppError("VALIDATION", `${label}: от ${min} до ${max}`);
    return n;
  };
  await ctx.db.query(
    `UPDATE branches SET
       review_enabled = COALESCE($2, review_enabled),
       review_delay_hours = COALESCE($3, review_delay_hours),
       review_moderation = COALESCE($4, review_moderation),
       noshow_block_after = COALESCE($5, noshow_block_after),
       rebook_enabled = COALESCE($6, rebook_enabled),
       birthday_enabled = COALESCE($7, birthday_enabled)
     WHERE id = $1`,
    [
      branchId,
      bool(input.reviewEnabled),
      int(input.reviewDelayHours, 0, 72, "Задержка отзыва, часов"),
      bool(input.reviewModeration),
      int(input.noshowBlockAfter, 0, 20, "Неявок до запрета онлайн-записи"),
      bool(input.rebookEnabled),
      bool(input.birthdayEnabled),
    ],
  );
  const after = presentRetentionSettings(await loadBranch(ctx, branchId));
  await audit(ctx, { branchId, entity: "branch", entityId: branchId, action: "retention.settings", diff: { before: presentRetentionSettings(before), after } });
  return after;
}

// ---------------------------------------------------------------- No-shows

/** NOSHOW-01: no-shows in the last 365 days. */
export async function noShowCount(ctx: Ctx, clientId: string) {
  const row = await one<{ n: number }>(
    ctx.db,
    "SELECT count(*)::int AS n FROM appointments WHERE client_id = $1 AND status = 'no_show' AND starts_at > $2::timestamptz - interval '365 days'",
    [clientId, ctx.now.toISOString()],
  );
  return Number(row?.n ?? 0);
}

/** Online booking refuses a client over the branch limit; the desk can still book them. */
export async function assertOnlineAllowed(ctx: Ctx, branch: BranchRow, clientId: string) {
  const limit = Number(branch.noshow_block_after);
  if (!limit) return;
  const count = await noShowCount(ctx, clientId);
  if (count < limit) return;
  // The booking transaction rolls back, so the desk learns about it from the client's call.
  throw new AppError("VALIDATION", "Онлайн-запись для вас сейчас недоступна. Позвоните, пожалуйста, в салон — с радостью запишем", { reason: "NOSHOW_LIMIT" });
}

// ---------------------------------------------------------------- Reviews

type ReviewRow = {
  id: string;
  branch_id: string;
  appointment_id: string | null;
  client_id: string | null;
  staff_id: string | null;
  rating: number;
  body: string;
  status: "pending" | "published" | "hidden" | "rejected";
  source: string;
  reject_reason: string | null;
  reply: string;
  moderated_at: Date | null;
  created_at: Date;
  client_name: string | null;
  staff_name: string | null;
  title: string | null;
  starts_at: Date | null;
};

function presentReview(row: ReviewRow) {
  return {
    id: row.id,
    branchId: row.branch_id,
    appointmentId: row.appointment_id,
    clientId: row.client_id,
    clientName: row.client_name,
    staffId: row.staff_id,
    staffName: row.staff_name,
    services: row.title,
    visitAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    rating: Number(row.rating),
    body: row.body,
    status: row.status,
    source: row.source,
    rejectReason: row.reject_reason,
    reply: row.reply,
    moderatedAt: row.moderated_at ? new Date(row.moderated_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const REVIEW_SELECT = `SELECT r.*, c.name AS client_name, s.display_name AS staff_name, a.starts_at,
    (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = r.appointment_id) AS title
  FROM reviews r LEFT JOIN clients c ON c.id = r.client_id LEFT JOIN staff s ON s.id = r.staff_id LEFT JOIN appointments a ON a.id = r.appointment_id`;

/** REV-REQUEST-01 for one visit. Returns false when a request already went out. */
export async function requestReview(ctx: Ctx, appointmentId: string) {
  const row = await one<{ id: string; branch_id: string; client_id: string | null; status: string; review_requested_at: Date | null }>(
    ctx.db,
    "SELECT id, branch_id, client_id, status, review_requested_at FROM appointments WHERE id = $1 FOR UPDATE",
    [appointmentId],
  );
  if (!row || row.status !== "completed" || !row.client_id || row.review_requested_at) return false;
  const token = randomBytes(32).toString("hex");
  await ctx.db.query("UPDATE appointments SET review_token_hash = $2, review_requested_at = $3 WHERE id = $1", [appointmentId, sha256(token), ctx.now.toISOString()]);
  const { values } = await appointmentValues(ctx, appointmentId, { ссылка: `${publicUrl()}/r/${token}` });
  const sent = await deliverToClient(ctx, {
    clientId: row.client_id,
    branchId: row.branch_id,
    appointmentId,
    kind: "review_request",
    body: render(await templateBody(ctx, "review_request"), values),
    once: true,
  });
  return { sent: Boolean(sent && !sent.error), token };
}

/** Visits completed at least `delay` hours ago (and not older than 3 days), without a request yet. */
async function sendDueReviewRequests(ctx: Ctx, branch: BranchRow) {
  const due = await many<{ id: string }>(
    ctx.db,
    `SELECT a.id FROM appointments a
     WHERE a.branch_id = $1 AND a.status = 'completed' AND a.client_id IS NOT NULL AND a.review_requested_at IS NULL
       AND a.ends_at <= $2::timestamptz - make_interval(hours => $3) AND a.ends_at > $2::timestamptz - interval '3 days'
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
     ORDER BY a.ends_at LIMIT 200`,
    [branch.id, ctx.now.toISOString(), Number(branch.review_delay_hours)],
  );
  let sent = 0;
  for (const row of due) if (await requestReview(ctx, row.id)) sent += 1;
  return sent;
}

export async function resolveReviewToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError("NOT_FOUND", "Ссылка недействительна");
  const row = await poolOne<{ tenant_id: string; appointment_id: string }>("SELECT tenant_id, appointment_id FROM public_review_lookup($1)", [sha256(token)]);
  if (!row) throw new AppError("NOT_FOUND", "Ссылка недействительна");
  return { tenantId: row.tenant_id, appointmentId: row.appointment_id };
}

async function loadVisitForReview(ctx: Ctx, appointmentId: string) {
  const row = await one<{ id: string; branch_id: string; client_id: string | null; staff_id: string; status: string; starts_at: Date; staff_name: string; title: string | null; branch_name: string; timezone: string }>(
    ctx.db,
    `SELECT a.id, a.branch_id, a.client_id, a.staff_id, a.status, a.starts_at, s.display_name AS staff_name, b.name AS branch_name, b.timezone,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title
     FROM appointments a JOIN staff s ON s.id = a.staff_id JOIN branches b ON b.id = a.branch_id WHERE a.id = $1`,
    [appointmentId],
  );
  // Edge 1: a visit cancelled after the request no longer takes a review.
  if (!row || row.status !== "completed") throw new AppError("NOT_FOUND", "Ссылка недействительна");
  return row;
}

export async function publicReviewInfo(ctx: Ctx, appointmentId: string) {
  const visit = await loadVisitForReview(ctx, appointmentId);
  const review = await one<{ rating: number; body: string; status: string }>(ctx.db, "SELECT rating, body, status FROM reviews WHERE appointment_id = $1", [appointmentId]);
  return {
    branchName: visit.branch_name,
    staffName: visit.staff_name,
    services: visit.title ?? "Визит",
    date: formatLocalDate(new Date(visit.starts_at), visit.timezone),
    review: review ? { rating: Number(review.rating), body: review.body } : null,
  };
}

/** REV-CREATE-01: one review per visit; a second submit is refused. */
export async function submitReview(ctx: Ctx, appointmentId: string, input: { rating?: unknown; body?: unknown }) {
  const visit = await loadVisitForReview(ctx, appointmentId);
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError("VALIDATION", "Поставьте оценку от 1 до 5");
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body.length > 2000) throw new AppError("VALIDATION", "Отзыв длиннее 2000 символов");
  const branch = await one<BranchRow>(ctx.db, "SELECT * FROM branches WHERE id = $1", [visit.branch_id]);
  const exists = await one<{ id: string }>(ctx.db, "SELECT id FROM reviews WHERE appointment_id = $1", [appointmentId]);
  if (exists) throw new AppError("VALIDATION", "Вы уже оставили отзыв об этом визите. Спасибо!");
  const status = branch!.review_moderation ? "pending" : "published";
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO reviews (id, tenant_id, branch_id, appointment_id, client_id, staff_id, rating, body, status, source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'invite',$10)`,
    [id, ctx.actor.tenantId, visit.branch_id, appointmentId, visit.client_id, visit.staff_id, rating, body, status, ctx.now.toISOString()],
  );
  await audit(ctx, { branchId: visit.branch_id, entity: "review", entityId: id, action: "review.created", diff: { rating, status } });
  // A low score is something the owner wants to hear about today, not at the end of the month.
  await notifyDesk(ctx, {
    branchId: visit.branch_id,
    kind: rating <= 3 ? "review.low" : "review.new",
    title: rating <= 3 ? `Низкая оценка: ${"★".repeat(rating)} — ${visit.staff_name}` : `Новый отзыв ${"★".repeat(rating)} — ${visit.staff_name}`,
    body: body.slice(0, 200),
    entity: "review",
    entityId: id,
  });
  return { id, status };
}

export async function listReviews(ctx: Ctx, input: { branchId: string; status?: string; staffId?: string }) {
  await loadBranch(ctx, input.branchId);
  const params: unknown[] = [input.branchId];
  let where = "r.branch_id = $1";
  if (ctx.actor.role === "master") {
    // Masters see what clients said about them, published or waiting; they do not moderate.
    params.push(ctx.actor.staffId);
    where += ` AND r.staff_id = $${params.length} AND r.status IN ('published', 'pending')`;
  } else {
    requireAdmin(ctx);
    if (input.staffId) {
      params.push(input.staffId);
      where += ` AND r.staff_id = $${params.length}`;
    }
  }
  if (input.status && ["pending", "published", "hidden", "rejected"].includes(input.status)) {
    params.push(input.status);
    where += ` AND r.status = $${params.length}`;
  }
  const rows = await many<ReviewRow>(ctx.db, `${REVIEW_SELECT} WHERE ${where} ORDER BY r.created_at DESC LIMIT 300`, params);
  const counts = await many<{ status: string; n: number }>(
    ctx.db,
    `SELECT status, count(*)::int AS n FROM reviews r WHERE r.branch_id = $1 ${ctx.actor.role === "master" ? "AND r.staff_id = $2" : ""} GROUP BY status`,
    ctx.actor.role === "master" ? [input.branchId, ctx.actor.staffId] : [input.branchId],
  );
  return {
    items: rows.map(presentReview),
    counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.n)])),
    staff: await staffRatings(ctx, input.branchId),
  };
}

/** REV-SHOW-01: published reviews only. */
export async function staffRatings(ctx: Ctx, branchId: string) {
  const rows = await many<{ staff_id: string; name: string; avg: string; n: number }>(
    ctx.db,
    `SELECT r.staff_id, s.display_name AS name, avg(r.rating)::numeric(3,2) AS avg, count(*)::int AS n
     FROM reviews r JOIN staff s ON s.id = r.staff_id
     WHERE r.branch_id = $1 AND r.status = 'published' GROUP BY r.staff_id, s.display_name ORDER BY s.display_name`,
    [branchId],
  );
  return rows.map((row) => ({ staffId: row.staff_id, name: row.name, rating: Number(row.avg), count: Number(row.n) }));
}

/** For the booking widget: rating per master and the latest published texts. */
export async function publicReviews(ctx: Ctx, branchId: string) {
  const latest = await many<{ rating: number; body: string; created_at: Date; staff_id: string | null; client_name: string | null }>(
    ctx.db,
    `SELECT r.rating, r.body, r.created_at, r.staff_id, c.name AS client_name FROM reviews r LEFT JOIN clients c ON c.id = r.client_id
     WHERE r.branch_id = $1 AND r.status = 'published' AND r.body <> '' ORDER BY r.created_at DESC LIMIT 6`,
    [branchId],
  );
  return {
    staff: (await staffRatings(ctx, branchId)).map(({ staffId, rating, count }) => ({ staffId, rating, count })),
    latest: latest.map((row) => ({
      rating: Number(row.rating),
      body: row.body,
      staffId: row.staff_id,
      // First name only on a public page.
      author: (row.client_name ?? "Клиент").split(/\s+/)[0],
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

/** REV-MOD-01. Hard delete is owner-only (REV-DELETE-01). */
export async function moderateReview(ctx: Ctx, id: string, input: { action?: unknown; reason?: unknown; reply?: unknown }) {
  requireAdmin(ctx);
  const row = await one<ReviewRow>(ctx.db, `${REVIEW_SELECT} WHERE r.id = $1`, [id]);
  if (!row) throw new AppError("NOT_FOUND", "Отзыв не найден");
  await loadBranch(ctx, row.branch_id);
  const action = String(input.action ?? "");
  if (action === "delete") {
    if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Удалить отзыв может только владелец");
    await ctx.db.query("DELETE FROM reviews WHERE id = $1", [id]);
    await audit(ctx, { branchId: row.branch_id, entity: "review", entityId: id, action: "review.deleted", diff: { rating: row.rating, body: row.body } });
    return { id, deleted: true };
  }
  const reply = typeof input.reply === "string" ? input.reply.trim().slice(0, 2000) : null;
  const next = { publish: "published", hide: "hidden", reject: "rejected", reply: row.status }[action];
  if (!next) throw new AppError("VALIDATION", "Неизвестное действие");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (action === "reject" && !reason) throw new AppError("VALIDATION", "Укажите причину отклонения");
  await ctx.db.query(
    `UPDATE reviews SET status = $2, reject_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE reject_reason END,
       reply = COALESCE($4, reply), moderated_by = $5, moderated_at = $6 WHERE id = $1`,
    [id, next, reason || null, reply, ctx.actor.userId, ctx.now.toISOString()],
  );
  await audit(ctx, { branchId: row.branch_id, entity: "review", entityId: id, action: `review.${action}`, diff: { from: row.status, to: next, reason: reason || null } });
  const fresh = await one<ReviewRow>(ctx.db, `${REVIEW_SELECT} WHERE r.id = $1`, [id]);
  return presentReview(fresh!);
}

/** REV-EXPORT-01. */
export async function reviewsCsv(ctx: Ctx, branchId: string, from: string, to: string) {
  requireAdmin(ctx);
  const branch = await loadBranch(ctx, branchId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new AppError("VALIDATION", "Укажите период");
  const start = zonedDateTimeToUtc(from, 0, branch.timezone);
  const end = zonedDateTimeToUtc(addCalendarDays(to, 1), 0, branch.timezone);
  const rows = await many<ReviewRow>(ctx.db, `${REVIEW_SELECT} WHERE r.branch_id = $1 AND r.created_at >= $2 AND r.created_at < $3 ORDER BY r.created_at`, [branchId, start.toISOString(), end.toISOString()]);
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const STATUS: Record<string, string> = { pending: "на модерации", published: "опубликован", hidden: "скрыт", rejected: "отклонён" };
  const lines = [["Дата", "Клиент", "Мастер", "Услуги", "Оценка", "Отзыв", "Статус", "Ответ салона"].join(";")];
  for (const row of rows) {
    lines.push([formatLocalDate(new Date(row.created_at), branch.timezone), row.client_name, row.staff_name, row.title, row.rating, row.body, STATUS[row.status], row.reply].map(cell).join(";"));
  }
  await audit(ctx, { branchId, entity: "review", entityId: branchId, action: "report.exported", diff: { kind: "reviews", from, to, rows: rows.length } });
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------- Waitlist

type WaitRow = {
  id: string;
  branch_id: string;
  client_id: string;
  service_id: string | null;
  staff_id: string | null;
  date_from: string | Date;
  date_to: string | Date;
  time_from_min: number;
  time_to_min: number;
  note: string;
  status: string;
  offers: number;
  last_offered_at: Date | null;
  created_at: Date;
  client_name: string;
  phone: string | null;
  service_title: string | null;
  staff_name: string | null;
};

const dateOnly = (value: string | Date) => (typeof value === "string" ? value.slice(0, 10) : new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10));

const WAIT_SELECT = `SELECT w.*, c.name AS client_name, sv.title AS service_title, s.display_name AS staff_name,
    (SELECT phone_e164 FROM client_phones p WHERE p.client_id = w.client_id AND p.deleted_at IS NULL ORDER BY p.is_primary DESC LIMIT 1) AS phone
  FROM waitlist_entries w JOIN clients c ON c.id = w.client_id
  LEFT JOIN services sv ON sv.id = w.service_id LEFT JOIN staff s ON s.id = w.staff_id`;

function presentWait(row: WaitRow) {
  return {
    id: row.id,
    branchId: row.branch_id,
    clientId: row.client_id,
    clientName: row.client_name,
    phone: row.phone,
    serviceId: row.service_id,
    serviceTitle: row.service_title,
    staffId: row.staff_id,
    staffName: row.staff_name,
    dateFrom: dateOnly(row.date_from),
    dateTo: dateOnly(row.date_to),
    timeFromMin: Number(row.time_from_min),
    timeToMin: Number(row.time_to_min),
    note: row.note,
    status: row.status,
    offers: Number(row.offers),
    lastOfferedAt: row.last_offered_at ? new Date(row.last_offered_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export type FreedSlot = {
  appointmentId: string;
  staffId: string;
  staffName: string;
  startsAt: string;
  endsAt: string;
  date: string;
  services: string;
  serviceIds: string[];
  matches: string[];
};

function fits(entry: ReturnType<typeof presentWait>, slot: Omit<FreedSlot, "matches">, timezone: string) {
  if (slot.date < entry.dateFrom || slot.date > entry.dateTo) return false;
  if (entry.staffId && entry.staffId !== slot.staffId) return false;
  if (entry.serviceId && !slot.serviceIds.includes(entry.serviceId)) return false;
  const start = localMinutes(new Date(slot.startsAt), timezone);
  return start >= entry.timeFromMin && start < entry.timeToMin;
}

/** Cancelled visits still ahead whose time nobody has taken since. */
async function freedSlots(ctx: Ctx, branch: BranchRow): Promise<Omit<FreedSlot, "matches">[]> {
  const rows = await many<{ id: string; staff_id: string; staff_name: string; starts_at: Date; ends_at: Date; title: string | null; service_ids: string[] | null }>(
    ctx.db,
    `SELECT a.id, a.staff_id, s.display_name AS staff_name, a.starts_at, a.ends_at,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title,
            (SELECT array_agg(service_id) FROM appointment_services WHERE appointment_id = a.id) AS service_ids
     FROM appointments a JOIN staff s ON s.id = a.staff_id
     WHERE a.branch_id = $1 AND a.status = 'cancelled' AND a.starts_at > $2 AND a.starts_at < $2::timestamptz + interval '21 days'
       AND NOT EXISTS (
         SELECT 1 FROM appointments o WHERE o.staff_id = a.staff_id AND o.id <> a.id AND o.status NOT IN ('cancelled')
           AND o.starts_at < a.ends_at AND o.ends_at > a.starts_at)
     ORDER BY a.starts_at LIMIT 50`,
    [branch.id, ctx.now.toISOString()],
  );
  // Two cancellations on the same time for the same master are one window.
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = `${row.staff_id}|${new Date(row.starts_at).toISOString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      appointmentId: row.id,
      staffId: row.staff_id,
      staffName: row.staff_name,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      date: formatLocalDate(new Date(row.starts_at), branch.timezone),
      services: row.title ?? "",
      serviceIds: (row.service_ids ?? []).filter(Boolean),
    }));
}

async function activeEntries(ctx: Ctx, branchId: string) {
  const rows = await many<WaitRow>(ctx.db, `${WAIT_SELECT} WHERE w.branch_id = $1 AND w.status = 'active' ORDER BY w.created_at`, [branchId]);
  return rows.map(presentWait);
}

export async function listWaitlist(ctx: Ctx, branchId: string, input: { status?: string } = {}) {
  requireAdmin(ctx);
  const branch = await loadBranch(ctx, branchId);
  // Entries whose dates are behind us close by themselves.
  await ctx.db.query("UPDATE waitlist_entries SET status = 'cancelled', updated_at = now() WHERE branch_id = $1 AND status = 'active' AND date_to < $2::date", [branchId, todayInZone(branch.timezone, ctx.now)]);
  const status = input.status === "closed" ? "w.status <> 'active'" : "w.status = 'active'";
  const rows = await many<WaitRow>(ctx.db, `${WAIT_SELECT} WHERE w.branch_id = $1 AND ${status} ORDER BY w.date_from, w.created_at LIMIT 300`, [branchId]);
  const entries = rows.map(presentWait);
  const active = input.status === "closed" ? await activeEntries(ctx, branchId) : entries;
  const slots: FreedSlot[] = (await freedSlots(ctx, branch)).map((slot) => ({ ...slot, matches: active.filter((entry) => fits(entry, slot, branch.timezone)).map((entry) => entry.id) }));
  return { entries, slots };
}

export async function createWaitlistEntry(
  ctx: Ctx,
  input: { branchId: string; clientId: string; serviceId?: string | null; staffId?: string | null; dateFrom: string; dateTo?: string; timeFromMin?: number; timeToMin?: number; note?: string },
) {
  requireAdmin(ctx);
  const branch = await loadBranch(ctx, input.branchId);
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.test(input.dateFrom ?? "")) throw new AppError("VALIDATION", "Укажите, с какого дня клиенту удобно");
  const dateTo = input.dateTo && date.test(input.dateTo) ? input.dateTo : input.dateFrom;
  if (dateTo < input.dateFrom) throw new AppError("VALIDATION", "Конец периода раньше начала");
  if (dateTo < todayInZone(branch.timezone, ctx.now)) throw new AppError("VALIDATION", "Период уже прошёл");
  const from = Number(input.timeFromMin ?? 0);
  const to = Number(input.timeToMin ?? 1440);
  if (!(from >= 0 && to <= 1440 && to > from)) throw new AppError("VALIDATION", "Проверьте удобное время");
  const client = await one<{ id: string }>(ctx.db, "SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL", [input.clientId]);
  if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO waitlist_entries (id, tenant_id, branch_id, client_id, service_id, staff_id, date_from, date_to, time_from_min, time_to_min, note, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, ctx.actor.tenantId, input.branchId, input.clientId, input.serviceId || null, input.staffId || null, input.dateFrom, dateTo, from, to, (input.note ?? "").trim().slice(0, 500), ctx.actor.userId, ctx.now.toISOString()],
  );
  await audit(ctx, { branchId: input.branchId, entity: "waitlist", entityId: id, action: "waitlist.created", diff: { clientId: input.clientId, dateFrom: input.dateFrom, dateTo } });
  const row = await one<WaitRow>(ctx.db, `${WAIT_SELECT} WHERE w.id = $1`, [id]);
  return presentWait(row!);
}

export async function closeWaitlistEntry(ctx: Ctx, id: string, input: { status?: unknown; appointmentId?: unknown }) {
  requireAdmin(ctx);
  const row = await one<WaitRow>(ctx.db, `${WAIT_SELECT} WHERE w.id = $1`, [id]);
  if (!row) throw new AppError("NOT_FOUND", "Запись листа ожидания не найдена");
  await loadBranch(ctx, row.branch_id);
  const status = input.status === "booked" ? "booked" : input.status === "active" ? "active" : "cancelled";
  await ctx.db.query("UPDATE waitlist_entries SET status = $2, appointment_id = COALESCE($3, appointment_id), updated_at = now() WHERE id = $1", [id, status, typeof input.appointmentId === "string" ? input.appointmentId : null]);
  await audit(ctx, { branchId: row.branch_id, entity: "waitlist", entityId: id, action: `waitlist.${status}`, diff: { from: row.status } });
  const fresh = await one<WaitRow>(ctx.db, `${WAIT_SELECT} WHERE w.id = $1`, [id]);
  return presentWait(fresh!);
}

/** WAIT-OFFER-01: the desk offers a freed window to a waiting client. */
export async function offerWaitlistSlot(ctx: Ctx, id: string, input: { appointmentId?: unknown }) {
  requireAdmin(ctx);
  const row = await one<WaitRow>(ctx.db, `${WAIT_SELECT} WHERE w.id = $1 FOR UPDATE OF w`, [id]);
  if (!row || row.status !== "active") throw new AppError("NOT_FOUND", "Клиент уже не в листе ожидания");
  await loadBranch(ctx, row.branch_id);
  const slotId = typeof input.appointmentId === "string" ? input.appointmentId : "";
  const slot = await one<{ id: string; branch_id: string; status: string }>(ctx.db, "SELECT id, branch_id, status FROM appointments WHERE id = $1", [slotId]);
  if (!slot || slot.branch_id !== row.branch_id || slot.status !== "cancelled") throw new AppError("VALIDATION", "Это окно уже недоступно");
  const { values } = await appointmentValues(ctx, slotId, { имя: row.client_name, ссылка: await bookingPageUrl(ctx, row.branch_id) });
  const sent = await deliverToClient(ctx, {
    clientId: row.client_id,
    branchId: row.branch_id,
    kind: "waitlist_offer",
    body: render(await templateBody(ctx, "waitlist_offer"), values),
  });
  await ctx.db.query("UPDATE waitlist_entries SET offers = offers + 1, last_offered_at = $2, updated_at = now() WHERE id = $1", [id, ctx.now.toISOString()]);
  await audit(ctx, { branchId: row.branch_id, entity: "waitlist", entityId: id, action: "waitlist.offered", diff: { slot: slotId, channel: sent?.channel, error: sent?.error } });
  return { sent: sent?.status === "delivered", channel: sent?.channel ?? null, error: sent?.error ?? null };
}

/** Called right after a cancellation: tells the desk who is waiting for exactly this time. */
export async function matchWaitlistOnCancel(ctx: Ctx, appointmentId: string) {
  const appt = await one<{ branch_id: string; starts_at: Date }>(ctx.db, "SELECT branch_id, starts_at FROM appointments WHERE id = $1", [appointmentId]);
  if (!appt || new Date(appt.starts_at).getTime() <= ctx.now.getTime()) return 0;
  const branch = await one<BranchRow>(ctx.db, "SELECT * FROM branches WHERE id = $1", [appt.branch_id]);
  const slot = (await freedSlots(ctx, branch!)).find((item) => item.appointmentId === appointmentId);
  if (!slot) return 0;
  const matches = (await activeEntries(ctx, appt.branch_id)).filter((entry) => fits(entry, slot, branch!.timezone));
  if (!matches.length) return 0;
  const when = new Intl.DateTimeFormat("ru-RU", { timeZone: branch!.timezone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(slot.startsAt));
  await notifyDesk(ctx, {
    branchId: appt.branch_id,
    kind: "waitlist.match",
    title: `Освободилось окно: ${matches.length} в листе ожидания`,
    body: `${when} · ${slot.staffName}. ${matches.slice(0, 3).map((entry) => entry.clientName).join(", ")}`,
    entity: "waitlist",
    entityId: null,
  });
  return matches.length;
}

// ---------------------------------------------------------------- Rebook

/**
 * REBOOK-01: "book again in N weeks" at checkout. Same master, same services, same time of day;
 * if that is taken, the nearest free start on that day, then the next days (up to a week).
 */
export async function rebookAppointment(ctx: Ctx, id: string, input: { days?: unknown; weeks?: unknown }) {
  const source = await getAppointment(ctx, id);
  const admin = isAdminPlus(ctx.actor);
  if (!admin && !(ctx.actor.role === "master" && ctx.actor.staffId === source.staffId)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  if (!source.clientId) throw new AppError("VALIDATION", "У записи нет клиента");
  const days = input.days !== undefined ? Number(input.days) : Number(input.weeks ?? 3) * 7;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new AppError("VALIDATION", "Через сколько дней записать: от 1 до 365");
  if (source.status !== "completed" && source.status !== "in_progress" && source.status !== "arrived") throw new AppError("VALIDATION", "Повторно записать можно после визита");
  const branch = await loadBranch(ctx, source.branchId);
  const tz = branch.timezone;
  const baseDate = addCalendarDays(formatLocalDate(new Date(source.startsAt), tz), days);
  const baseMinute = localMinutes(new Date(source.startsAt), tz);
  const shifts = [0, 30, -30, 60, -60, 90, -90, 120, -120, 180, -180, 240, -240];
  const services = source.services.filter((line) => line.serviceId).map((line) => ({ serviceId: line.serviceId as string, durationMin: line.durationMin }));
  if (!services.length) throw new AppError("VALIDATION", "В записи нет услуг из каталога");
  let lastError: unknown = null;
  for (let day = 0; day < 7; day += 1) {
    const date = addCalendarDays(baseDate, day);
    for (const shift of shifts) {
      const minute = baseMinute + shift;
      if (minute < 0 || minute >= 1440) continue;
      const startsAt = zonedDateTimeToUtc(date, minute, tz);
      if (startsAt.getTime() <= ctx.now.getTime()) continue;
      await ctx.db.query("SAVEPOINT rebook_try");
      try {
        const created = await createAppointment(ctx, {
          branchId: source.branchId,
          staffId: source.staffId,
          clientId: source.clientId,
          startsAt: startsAt.toISOString(),
          services,
          comment: "Повторная запись",
          acknowledgeSoft: false,
        });
        await ctx.db.query("RELEASE SAVEPOINT rebook_try");
        await audit(ctx, { branchId: source.branchId, entity: "appointment", entityId: created.id, action: "appointment.rebooked", diff: { from: id, days: days + day, shiftMin: shift } });
        return { appointment: created, exact: day === 0 && shift === 0 };
      } catch (error) {
        await ctx.db.query("ROLLBACK TO SAVEPOINT rebook_try");
        if (!isAppError(error) || !["CONFLICT_SLOT", "SOFT_CONFIRM", "VALIDATION"].includes(error.code)) throw error;
        lastError = error;
      }
    }
  }
  throw new AppError("VALIDATION", "У мастера нет свободного времени в эту неделю. Выберите время в журнале", { cause: isAppError(lastError) ? lastError.message : null });
}

type DueRow = {
  client_id: string;
  client_name: string;
  phone: string | null;
  consent_marketing: boolean;
  last_visit: Date;
  last_appointment_id: string;
  staff_name: string;
  title: string;
  rebook_days: number;
  last_rebook_at: Date | null;
};

async function dueRows(ctx: Ctx, branchId: string, horizonDays: number) {
  // Each client's latest finished visit that contains a service with a rebook interval.
  return many<DueRow>(
    ctx.db,
    `WITH last AS (
       SELECT DISTINCT ON (a.client_id) a.client_id, a.id, a.starts_at, a.staff_id,
              (SELECT min(sv.rebook_days) FROM appointment_services x JOIN services sv ON sv.id = x.service_id WHERE x.appointment_id = a.id) AS rebook_days
       FROM appointments a
       WHERE a.branch_id = $1 AND a.status = 'completed' AND a.client_id IS NOT NULL
       ORDER BY a.client_id, a.starts_at DESC)
     SELECT l.client_id, c.name AS client_name, c.consent_marketing, l.starts_at AS last_visit, l.id AS last_appointment_id, l.rebook_days,
            s.display_name AS staff_name,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = l.id) AS title,
            (SELECT phone_e164 FROM client_phones p WHERE p.client_id = l.client_id AND p.deleted_at IS NULL ORDER BY p.is_primary DESC LIMIT 1) AS phone,
            (SELECT max(m.created_at) FROM outbound_messages m WHERE m.client_id = l.client_id AND m.kind = 'rebook') AS last_rebook_at
     FROM last l JOIN clients c ON c.id = l.client_id AND c.deleted_at IS NULL JOIN staff s ON s.id = l.staff_id
     WHERE l.rebook_days IS NOT NULL
       AND l.starts_at + make_interval(days => l.rebook_days) <= $2::timestamptz + make_interval(days => $3)
       AND l.starts_at > $2::timestamptz - interval '180 days'
       AND NOT EXISTS (SELECT 1 FROM appointments f WHERE f.client_id = l.client_id AND f.status IN ('scheduled', 'confirmed', 'arrived', 'in_progress') AND f.starts_at > l.starts_at)
     ORDER BY l.starts_at + make_interval(days => l.rebook_days)
     LIMIT 300`,
    [branchId, ctx.now.toISOString(), horizonDays],
  );
}

/** REBOOK-DUE-01: who should come back about now and has nothing booked. */
export async function rebookDue(ctx: Ctx, branchId: string) {
  requireAdmin(ctx);
  const branch = await loadBranch(ctx, branchId);
  const rows = await dueRows(ctx, branchId, 7);
  const today = todayInZone(branch.timezone, ctx.now);
  return rows.map((row) => {
    const dueDate = addCalendarDays(formatLocalDate(new Date(row.last_visit), branch.timezone), Number(row.rebook_days));
    const overdue = Math.round((Date.parse(today) - Date.parse(dueDate)) / 86400000);
    return {
      clientId: row.client_id,
      clientName: row.client_name,
      phone: row.phone,
      marketing: row.consent_marketing,
      lastVisitAt: new Date(row.last_visit).toISOString(),
      lastAppointmentId: row.last_appointment_id,
      staffName: row.staff_name,
      services: row.title,
      rebookDays: Number(row.rebook_days),
      dueDate,
      overdueDays: overdue,
      // Already nudged after this visit: don't nudge twice.
      remindedAt: row.last_rebook_at && new Date(row.last_rebook_at) > new Date(row.last_visit) ? new Date(row.last_rebook_at).toISOString() : null,
    };
  });
}

async function sendRebook(ctx: Ctx, branch: BranchRow, row: DueRow) {
  const days = Math.round((ctx.now.getTime() - new Date(row.last_visit).getTime()) / 86400000);
  const { values } = await appointmentValues(ctx, row.last_appointment_id, { ссылка: await bookingPageUrl(ctx, branch.id), дней: String(days) });
  return deliverToClient(ctx, { clientId: row.client_id, branchId: branch.id, kind: "rebook", body: render(await templateBody(ctx, "rebook"), values) });
}

/** The desk nudges one client from the due list. Marketing consent (38-ФЗ) is required. */
export async function sendRebookReminder(ctx: Ctx, branchId: string, clientId: string) {
  requireAdmin(ctx);
  const branch = await loadBranch(ctx, branchId);
  const row = (await dueRows(ctx, branchId, 60)).find((item) => item.client_id === clientId);
  if (!row) throw new AppError("NOT_FOUND", "Клиенту сейчас не нужно напоминание");
  if (!row.consent_marketing) throw new AppError("VALIDATION", "Клиент не давал согласия на рассылки — лучше позвонить");
  const sent = await sendRebook(ctx, branch, row);
  return { sent: sent?.status === "delivered", channel: sent?.channel ?? null, error: sent?.error ?? null };
}

// ---------------------------------------------------------------- Job

function jobsActor(tenantId: string): Actor {
  return { userId: JOBS_ACTOR_ID, tenantId, role: "client", branchId: null, staffId: null, name: "Удержание", email: "" };
}

export async function runRetentionForTenant(ctx: Ctx) {
  const result = { reviews: 0, rebook: 0, birthday: 0, deferred: 0 };
  const branches = await many<BranchRow>(ctx.db, "SELECT * FROM branches WHERE review_enabled OR rebook_enabled OR birthday_enabled ORDER BY created_at");
  for (const branch of branches) {
    if (inQuietHours(ctx.now, branch)) {
      result.deferred += 1;
      continue;
    }
    if (branch.review_enabled) result.reviews += await sendDueReviewRequests(ctx, branch);
    if (branch.rebook_enabled) {
      for (const row of await dueRows(ctx, branch.id, 0)) {
        if (!row.consent_marketing) continue;
        if (row.last_rebook_at && new Date(row.last_rebook_at) > new Date(row.last_visit)) continue;
        const sent = await sendRebook(ctx, branch, row);
        if (sent && !sent.error) result.rebook += 1;
      }
    }
    if (branch.birthday_enabled) {
      const today = todayInZone(branch.timezone, ctx.now);
      const year = Number(today.slice(0, 4));
      // Clients of this branch: anyone who has ever had a visit here.
      const people = await many<{ id: string; name: string }>(
        ctx.db,
        `SELECT c.id, c.name FROM clients c
         WHERE c.deleted_at IS NULL AND c.consent_marketing AND c.birth_date IS NOT NULL
           AND to_char(c.birth_date, 'MM-DD') = $2 AND COALESCE(c.birthday_greeted_year, 0) <> $3
           AND EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND a.branch_id = $1)
         FOR UPDATE OF c SKIP LOCKED`,
        [branch.id, today.slice(5), year],
      );
      const template = await templateBody(ctx, "birthday");
      const link = await bookingPageUrl(ctx, branch.id);
      for (const person of people) {
        const sent = await deliverToClient(ctx, {
          clientId: person.id,
          branchId: branch.id,
          kind: "birthday",
          body: render(template, { имя: person.name.split(/\s+/)[0], салон: branch.name, адрес: branch.address ? `, ${branch.address}` : "", когда: "", услуги: "", мастер: "", сумма: "", дней: "", ссылка: link }),
        });
        await ctx.db.query("UPDATE clients SET birthday_greeted_year = $2 WHERE id = $1", [person.id, year]);
        if (sent && !sent.error) result.birthday += 1;
      }
    }
  }
  return result;
}

/** Entry point for cron (POST /api/jobs/retention), hourly is enough. */
export async function runRetentionJob(now = new Date()) {
  const tenants = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM retention_tenants()");
  const total = { tenants: 0, reviews: 0, rebook: 0, birthday: 0, deferred: 0 };
  for (const { tenant_id: tenantId } of tenants.rows) {
    const result = await withSession({ tenantId, userId: JOBS_ACTOR_ID }, (db) => runRetentionForTenant({ db, actor: jobsActor(tenantId), now }));
    total.tenants += 1;
    total.reviews += result.reviews;
    total.rebook += result.rebook;
    total.birthday += result.birthday;
    total.deferred += result.deferred;
  }
  return total;
}
