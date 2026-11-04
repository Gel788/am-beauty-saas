import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@/domain/errors";
import { normalizePhone } from "@/domain/phone";
import { loadBranch } from "./access";
import { cancelAppointment, createAppointment } from "./appointments";
import { audit } from "./audit";
import { createClient } from "./clients";
import { many, one, poolOne, withSession } from "./db";
import type { Actor, Ctx } from "./types";

/** API-KEY-01: keys look like `ab_live_<32 hex>`; only the sha256 is stored, the key is shown once. */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type KeyRow = { id: string; name: string; prefix: string; scope: "read" | "write"; branch_id: string | null; created_at: Date; last_used_at: Date | null; revoked_at: Date | null };
const presentKey = (row: KeyRow) => ({ id: row.id, name: row.name, prefix: row.prefix, scope: row.scope, branchId: row.branch_id, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });

function assertOwner(ctx: Ctx) {
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Ключи API выдаёт владелец");
}

export async function listApiKeys(ctx: Ctx) {
  assertOwner(ctx);
  return (await many<KeyRow>(ctx.db, "SELECT * FROM api_keys ORDER BY revoked_at NULLS FIRST, created_at DESC")).map(presentKey);
}

export async function createApiKey(ctx: Ctx, input: { name?: unknown; scope?: unknown; branchId?: unknown }) {
  assertOwner(ctx);
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new AppError("VALIDATION", "Назовите ключ, например «Сайт» или «1С»");
  const scope = input.scope === "write" ? "write" : "read";
  const branchId = typeof input.branchId === "string" && input.branchId ? input.branchId : null;
  if (branchId) await loadBranch(ctx, branchId);
  const active = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL");
  if (Number(active?.n ?? 0) >= 20) throw new AppError("VALIDATION", "Не больше 20 действующих ключей");
  const key = `ab_live_${randomBytes(16).toString("hex")}`;
  const id = crypto.randomUUID();
  await ctx.db.query(
    "INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, scope, branch_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [id, ctx.actor.tenantId, name, key.slice(0, 12), sha256(key), scope, branchId, ctx.actor.userId],
  );
  await audit(ctx, { entity: "api_key", entityId: id, action: "api_key.created", diff: { name, scope, branchId } });
  const row = await one<KeyRow>(ctx.db, "SELECT * FROM api_keys WHERE id = $1", [id]);
  return { ...presentKey(row!), key };
}

export async function revokeApiKey(ctx: Ctx, id: string) {
  assertOwner(ctx);
  await ctx.db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
  await audit(ctx, { entity: "api_key", entityId: id, action: "api_key.revoked" });
  return { ok: true };
}

// ------------------------------------------------------------------ authentication

export type ApiCaller = { keyId: string; tenantId: string; scope: "read" | "write"; branchId: string | null; actor: Actor };

/** Key → caller. The caller acts as an admin of the salon (or of one branch), named after the key in the audit log. */
export async function authenticateApiKey(header: string | null): Promise<ApiCaller> {
  const token = header?.match(/^Bearer\s+(ab_live_[a-f0-9]{32})$/i)?.[1];
  if (!token) throw new AppError("FORBIDDEN", "Нужен заголовок Authorization: Bearer ab_live_…");
  const row = await poolOne<{ id: string; tenant_id: string; name: string; scope: "read" | "write"; branch_id: string | null; created_by: string | null }>(
    "SELECT * FROM api_key_lookup($1)",
    [sha256(token)],
  );
  if (!row) throw new AppError("FORBIDDEN", "Ключ не найден или отозван");
  return {
    keyId: row.id,
    tenantId: row.tenant_id,
    scope: row.scope,
    branchId: row.branch_id,
    actor: { userId: row.created_by ?? row.id, tenantId: row.tenant_id, role: "admin", branchId: row.branch_id, staffId: null, name: `API: ${row.name}`, email: "" },
  };
}

// Requests per key per minute, in memory per instance: enough to stop a runaway script.
const RATE = 120;
const windows = new Map<string, { start: number; count: number }>();
export function rateLimit(keyId: string, now = Date.now()) {
  const current = windows.get(keyId);
  if (!current || now - current.start >= 60000) {
    windows.set(keyId, { start: now, count: 1 });
    return { remaining: RATE - 1 };
  }
  current.count += 1;
  if (current.count > RATE) throw new AppError("RATE_LIMITED", "Слишком много запросов: не больше 120 в минуту на ключ", { retryAfterSec: Math.ceil((current.start + 60000 - now) / 1000) });
  return { remaining: RATE - current.count };
}

export function runAsApi<T>(caller: ApiCaller, fn: (ctx: Ctx) => Promise<T>, now = new Date()) {
  return withSession({ tenantId: caller.tenantId, userId: caller.actor.userId }, async (db) => {
    await db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [caller.keyId]);
    return fn({ db, actor: caller.actor, now });
  });
}

// ------------------------------------------------------------------ v1 resources (stable shapes, documented in docs/api.md)

const uuidOr = (value: string | null | undefined) => (value && UUID.test(value) ? value : null);
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

function branchScope(ctx: Ctx, requested: string | null) {
  if (ctx.actor.branchId) {
    if (requested && requested !== ctx.actor.branchId) throw new AppError("FORBIDDEN", "Ключ выдан для другого филиала");
    return ctx.actor.branchId;
  }
  return requested;
}

export async function v1Branches(ctx: Ctx) {
  const rows = await many<{ id: string; name: string; address: string; timezone: string; slug: string; tenant_slug: string }>(
    ctx.db,
    "SELECT b.id, b.name, b.address, b.timezone, b.slug, t.slug AS tenant_slug FROM branches b JOIN tenants t ON t.id = b.tenant_id WHERE ($1::uuid IS NULL OR b.id = $1) ORDER BY b.created_at, b.id",
    [ctx.actor.branchId],
  );
  return { data: rows.map((row) => ({ id: row.id, name: row.name, address: row.address, timezone: row.timezone, bookingUrl: `/b/${row.tenant_slug}/${row.slug}` })) };
}

export async function v1Services(ctx: Ctx) {
  const rows = await many<{ id: string; title: string; duration_min: number; price_minor: number; category: string | null; online_visible: boolean }>(
    ctx.db,
    "SELECT s.id, s.title, s.duration_min, s.price_minor, c.title AS category, s.online_visible FROM services s LEFT JOIN service_categories c ON c.id = s.category_id WHERE s.active ORDER BY c.sort NULLS LAST, s.sort, s.title",
  );
  return { data: rows.map((row) => ({ id: row.id, title: row.title, category: row.category, durationMin: Number(row.duration_min), priceMinor: Number(row.price_minor), onlineVisible: row.online_visible })) };
}

export async function v1Staff(ctx: Ctx) {
  const rows = await many<{ id: string; display_name: string; specialties: string; branch_ids: string[]; service_ids: string[] }>(
    ctx.db,
    `SELECT s.id, s.display_name, s.specialties,
            COALESCE((SELECT array_agg(branch_id) FROM staff_branches sb WHERE sb.staff_id = s.id), '{}') AS branch_ids,
            COALESCE((SELECT array_agg(service_id) FROM service_staff ss WHERE ss.staff_id = s.id), '{}') AS service_ids
     FROM staff s WHERE s.active
       AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM staff_branches sb WHERE sb.staff_id = s.id AND sb.branch_id = $1))
     ORDER BY s.display_name`,
    [ctx.actor.branchId],
  );
  return { data: rows.map((row) => ({ id: row.id, name: row.display_name, specialties: row.specialties, branchIds: row.branch_ids, serviceIds: row.service_ids })) };
}

type ClientRow = { id: string; name: string; email: string | null; phones: string[] | null; birth_date: string | null; source: string; created_at: Date; updated_at: Date };
const presentClient = (row: ClientRow) => ({ id: row.id, name: row.name, phones: row.phones ?? [], email: row.email, birthDate: row.birth_date, source: row.source, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const CLIENT_SELECT = `SELECT c.id, c.name, c.email, to_char(c.birth_date, 'YYYY-MM-DD') AS birth_date, c.source, c.created_at, c.updated_at,
  (SELECT array_agg(p.phone_e164 ORDER BY p.is_primary DESC) FROM client_phones p WHERE p.client_id = c.id AND p.deleted_at IS NULL) AS phones
  FROM clients c`;

/** Clients by phone, by text or the newest; cursor = `updatedAt` of the last row, for syncing in pages. */
export async function v1Clients(ctx: Ctx, query: URLSearchParams) {
  const limit = Math.min(200, Math.max(1, Number(query.get("limit") ?? 50) || 50));
  const phone = query.get("phone");
  const text = query.get("q")?.trim() ?? "";
  const since = query.get("updatedSince");
  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null;
  const e164 = phone ? normalizePhone(phone) : null;
  const rows = await many<ClientRow>(
    ctx.db,
    `${CLIENT_SELECT}
     WHERE c.deleted_at IS NULL AND c.merged_into_id IS NULL
       AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.id AND p.deleted_at IS NULL AND p.phone_e164 = $1))
       AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR c.email ILIKE '%' || $2 || '%')
       AND ($3::timestamptz IS NULL OR c.updated_at > $3)
     ORDER BY c.updated_at, c.id LIMIT $4`,
    [e164, text, sinceDate, limit + 1],
  );
  const page = rows.slice(0, limit);
  return { data: page.map(presentClient), nextUpdatedSince: rows.length > limit ? iso(page[page.length - 1].updated_at) : null };
}

export async function v1Client(ctx: Ctx, id: string) {
  const row = await one<ClientRow>(ctx.db, `${CLIENT_SELECT} WHERE c.id = $1 AND c.deleted_at IS NULL`, [uuidOr(id)]);
  if (!row) throw new AppError("NOT_FOUND", "Клиент не найден");
  return { data: presentClient(row) };
}

export async function v1CreateClient(ctx: Ctx, body: Record<string, unknown>) {
  const created = await createClient(ctx, {
    name: String(body.name ?? ""),
    phone: body.phone ? String(body.phone) : undefined,
    email: body.email ? String(body.email) : null,
    notes: body.notes ? String(body.notes) : undefined,
    birthDate: body.birthDate ? String(body.birthDate) : null,
    source: "api",
  });
  return v1Client(ctx, (created as { id: string }).id);
}

type ApptRow = { id: string; branch_id: string; staff_id: string; staff_name: string; client_id: string | null; client_name: string | null; starts_at: Date; ends_at: Date; status: string; source: string; comment: string; version: number; services: { serviceId: string; title: string; durationMin: number; priceMinor: number }[] | null; created_at: Date; updated_at: Date };
const presentAppt = (row: ApptRow) => ({
  id: row.id,
  branchId: row.branch_id,
  staff: { id: row.staff_id, name: row.staff_name },
  client: row.client_id ? { id: row.client_id, name: row.client_name } : null,
  startsAt: iso(row.starts_at),
  endsAt: iso(row.ends_at),
  status: row.status,
  source: row.source,
  comment: row.comment,
  version: Number(row.version),
  services: row.services ?? [],
  totalMinor: (row.services ?? []).reduce((sum, item) => sum + Number(item.priceMinor), 0),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
const APPT_SELECT = `SELECT a.id, a.branch_id, a.staff_id, s.display_name AS staff_name, a.client_id, c.name AS client_name, a.starts_at, a.ends_at,
  a.status, a.source, a.comment, a.version, a.created_at, a.updated_at,
  (SELECT json_agg(json_build_object('serviceId', x.service_id, 'title', x.title_snapshot, 'durationMin', x.duration_min, 'priceMinor', x.price_minor) ORDER BY x.position)
     FROM appointment_services x WHERE x.appointment_id = a.id) AS services
  FROM appointments a JOIN staff s ON s.id = a.staff_id LEFT JOIN clients c ON c.id = a.client_id`;

/** Visits in a time range (at most 31 days), or changed since a moment for syncing. */
export async function v1Appointments(ctx: Ctx, query: URLSearchParams) {
  const branchId = branchScope(ctx, uuidOr(query.get("branchId")));
  const from = query.get("from");
  const to = query.get("to");
  const since = query.get("updatedSince");
  const limit = Math.min(500, Math.max(1, Number(query.get("limit") ?? 200) || 200));
  const parsed = (value: string | null) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value) : null);
  const start = parsed(from);
  const end = parsed(to);
  const changed = parsed(since);
  if (!changed && (!start || !end)) throw new AppError("VALIDATION", "Передайте from и to (ISO 8601) или updatedSince");
  if (start && end && (end <= start || end.getTime() - start.getTime() > 31 * 86400000)) throw new AppError("VALIDATION", "Период: to позже from и не длиннее 31 дня");
  const status = query.get("status");
  const rows = await many<ApptRow>(
    ctx.db,
    `${APPT_SELECT}
     WHERE ($1::uuid IS NULL OR a.branch_id = $1)
       AND ($2::timestamptz IS NULL OR a.starts_at >= $2) AND ($3::timestamptz IS NULL OR a.starts_at < $3)
       AND ($4::timestamptz IS NULL OR a.updated_at > $4)
       AND ($5::text IS NULL OR a.status = $5)
       AND ($6::uuid IS NULL OR a.staff_id = $6) AND ($7::uuid IS NULL OR a.client_id = $7)
     ORDER BY ${changed ? "a.updated_at, a.id" : "a.starts_at, a.id"} LIMIT $8`,
    [branchId, start, end, changed, status || null, uuidOr(query.get("staffId")), uuidOr(query.get("clientId")), limit + 1],
  );
  const page = rows.slice(0, limit);
  return { data: page.map(presentAppt), nextUpdatedSince: changed && rows.length > limit ? iso(page[page.length - 1].updated_at) : null };
}

export async function v1Appointment(ctx: Ctx, id: string) {
  const row = await one<ApptRow>(ctx.db, `${APPT_SELECT} WHERE a.id = $1`, [uuidOr(id)]);
  if (!row || (ctx.actor.branchId && row.branch_id !== ctx.actor.branchId)) throw new AppError("NOT_FOUND", "Запись не найдена");
  return { data: presentAppt(row) };
}

/** Same rules as the desk: working hours, overlaps and the master's services are checked. */
export async function v1CreateAppointment(ctx: Ctx, body: Record<string, unknown>) {
  const branchId = branchScope(ctx, uuidOr(String(body.branchId ?? "")));
  if (!branchId) throw new AppError("VALIDATION", "Укажите branchId");
  const services = Array.isArray(body.services) ? body.services : body.serviceId ? [{ serviceId: body.serviceId }] : [];
  const client = body.client as { name?: unknown; phone?: unknown } | undefined;
  const created = await createAppointment(ctx, {
    branchId,
    staffId: String(body.staffId ?? ""),
    clientId: uuidOr(String(body.clientId ?? "")),
    newClient: !body.clientId && client?.name && client.phone ? { name: String(client.name), phone: String(client.phone) } : undefined,
    startsAt: String(body.startsAt ?? ""),
    services: services.map((item) => ({ serviceId: String((item as { serviceId?: unknown }).serviceId ?? "") })),
    comment: body.comment ? String(body.comment).slice(0, 500) : undefined,
    source: "api",
    acknowledgeSoft: true,
  });
  return v1Appointment(ctx, (created as { id: string }).id);
}

export async function v1CancelAppointment(ctx: Ctx, id: string, body: Record<string, unknown>) {
  const current = await v1Appointment(ctx, id);
  await cancelAppointment(ctx, current.data.id, { version: Number(body.version ?? current.data.version), reason: body.reason ? String(body.reason).slice(0, 200) : "Отменено через API", confirm: true });
  return v1Appointment(ctx, id);
}
