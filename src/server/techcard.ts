/**
 * CL-TECH-01..04: the client's tech card. Allergies and contraindications show up wherever the
 * client is about to be served (record, master's day); formulas and before/after photos keep
 * what worked. Owner, admin and masters; the accountant has no business here.
 */
import { AppError } from "@/domain/errors";
import { isAdminPlus } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import type { Ctx } from "./types";

export const FORMULA_KINDS = ["color", "nails", "lashes", "brows", "care", "other"] as const;
export type FormulaKind = (typeof FORMULA_KINDS)[number];
const PHOTO_KINDS = ["before", "after", "other"] as const;
const MAX_PHOTO = 1572864;
const MIME: Record<string, (bytes: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

function assertAccess(ctx: Ctx) {
  if (!(isAdminPlus(ctx.actor) || ctx.actor.role === "master")) throw new AppError("FORBIDDEN", "Техкарта доступна мастерам и администраторам");
}

async function assertClient(ctx: Ctx, clientId: string) {
  const row = await one<{ id: string }>(ctx.db, "SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL", [clientId]);
  if (!row) throw new AppError("NOT_FOUND", "Клиент не найден");
}

/** An appointment given with a formula or photo must be this client's. */
async function checkAppointment(ctx: Ctx, clientId: string, appointmentId: unknown) {
  if (typeof appointmentId !== "string" || !appointmentId) return { appointmentId: null, staffId: ctx.actor.staffId };
  const row = await one<{ client_id: string | null; staff_id: string }>(ctx.db, "SELECT client_id, staff_id FROM appointments WHERE id = $1", [appointmentId]);
  if (!row || row.client_id !== clientId) throw new AppError("VALIDATION", "Запись другого клиента");
  return { appointmentId, staffId: row.staff_id };
}

export async function getTechCard(ctx: Ctx, clientId: string) {
  assertAccess(ctx);
  const client = await one<{ allergies: string; contraindications: string; health_consent_at: Date | null }>(
    ctx.db,
    "SELECT allergies, contraindications, health_consent_at FROM clients WHERE id = $1 AND deleted_at IS NULL",
    [clientId],
  );
  if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
  const formulas = await many<{ id: string; kind: FormulaKind; body: string; created_at: Date; created_by: string; staff_name: string | null; starts_at: Date | null; title: string | null }>(
    ctx.db,
    `SELECT f.id, f.kind, f.body, f.created_at, f.created_by, s.display_name AS staff_name, a.starts_at,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = f.appointment_id) AS title
     FROM client_formulas f LEFT JOIN staff s ON s.id = f.staff_id LEFT JOIN appointments a ON a.id = f.appointment_id
     WHERE f.client_id = $1 AND f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT 100`,
    [clientId],
  );
  const photos = await many<{ id: string; kind: string; caption: string; created_at: Date; created_by: string; staff_name: string | null; appointment_id: string | null }>(
    ctx.db,
    `SELECT p.id, p.kind, p.caption, p.created_at, p.created_by, s.display_name AS staff_name, p.appointment_id
     FROM client_photos p LEFT JOIN staff s ON s.id = p.staff_id
     WHERE p.client_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 60`,
    [clientId],
  );
  const mine = (createdBy: string) => isAdminPlus(ctx.actor) || createdBy === ctx.actor.userId;
  return {
    allergies: client.allergies,
    contraindications: client.contraindications,
    healthConsentAt: client.health_consent_at ? new Date(client.health_consent_at).toISOString() : null,
    formulas: formulas.map((row) => ({
      id: row.id,
      kind: row.kind,
      body: row.body,
      staffName: row.staff_name,
      services: row.title,
      visitAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      canDelete: mine(row.created_by),
    })),
    photos: photos.map((row) => ({
      id: row.id,
      kind: row.kind,
      caption: row.caption,
      staffName: row.staff_name,
      appointmentId: row.appointment_id,
      url: `/api/clients/${clientId}/photos/${row.id}`,
      createdAt: new Date(row.created_at).toISOString(),
      canDelete: mine(row.created_by),
    })),
  };
}

/** CL-TECH-01: allergies / contraindications. Saving health data records the client's consent. */
export async function updateHealth(ctx: Ctx, clientId: string, input: { allergies?: unknown; contraindications?: unknown; consent?: unknown }) {
  assertAccess(ctx);
  await assertClient(ctx, clientId);
  const text = (value: unknown, label: string) => {
    if (value === undefined) return null;
    const result = typeof value === "string" ? value.trim() : "";
    if (result.length > 500) throw new AppError("VALIDATION", `${label}: не длиннее 500 символов`);
    return result;
  };
  const allergies = text(input.allergies, "Аллергии");
  const contra = text(input.contraindications, "Противопоказания");
  const before = await one<{ allergies: string; contraindications: string; health_consent_at: Date | null }>(ctx.db, "SELECT allergies, contraindications, health_consent_at FROM clients WHERE id = $1", [clientId]);
  const filled = (allergies ?? before!.allergies) || (contra ?? before!.contraindications);
  if (filled && !before!.health_consent_at && input.consent !== true) {
    throw new AppError("VALIDATION", "Отметьте, что клиент согласился на хранение сведений о здоровье", { reason: "HEALTH_CONSENT" });
  }
  await ctx.db.query(
    `UPDATE clients SET allergies = COALESCE($2, allergies), contraindications = COALESCE($3, contraindications),
       health_consent_at = CASE WHEN $4 AND health_consent_at IS NULL THEN $5::timestamptz ELSE health_consent_at END,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [clientId, allergies, contra, input.consent === true, ctx.now.toISOString()],
  );
  await audit(ctx, { entity: "client", entityId: clientId, action: "client.health_updated", diff: { allergies, contraindications: contra } });
  return getTechCard(ctx, clientId);
}

export async function addFormula(ctx: Ctx, clientId: string, input: { kind?: unknown; body?: unknown; appointmentId?: unknown }) {
  assertAccess(ctx);
  await assertClient(ctx, clientId);
  const kind = FORMULA_KINDS.includes(input.kind as FormulaKind) ? (input.kind as FormulaKind) : "other";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new AppError("VALIDATION", "Запишите формулу или заметку");
  if (body.length > 2000) throw new AppError("VALIDATION", "Не длиннее 2000 символов");
  const link = await checkAppointment(ctx, clientId, input.appointmentId);
  const id = crypto.randomUUID();
  await ctx.db.query(
    "INSERT INTO client_formulas (id, tenant_id, client_id, appointment_id, staff_id, kind, body, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id, ctx.actor.tenantId, clientId, link.appointmentId, link.staffId, kind, body, ctx.actor.userId, ctx.now.toISOString()],
  );
  await audit(ctx, { entity: "client", entityId: clientId, action: "client.formula_added", diff: { id, kind } });
  return getTechCard(ctx, clientId);
}

async function assertOwnOrAdmin(ctx: Ctx, createdBy: string) {
  if (!isAdminPlus(ctx.actor) && createdBy !== ctx.actor.userId) throw new AppError("FORBIDDEN", "Удалить может автор или администратор");
}

export async function deleteFormula(ctx: Ctx, clientId: string, id: string) {
  assertAccess(ctx);
  const row = await one<{ created_by: string }>(ctx.db, "SELECT created_by FROM client_formulas WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL", [id, clientId]);
  if (!row) throw new AppError("NOT_FOUND", "Запись не найдена");
  await assertOwnOrAdmin(ctx, row.created_by);
  await ctx.db.query("UPDATE client_formulas SET deleted_at = $2 WHERE id = $1", [id, ctx.now.toISOString()]);
  await audit(ctx, { entity: "client", entityId: clientId, action: "client.formula_deleted", diff: { id } });
  return getTechCard(ctx, clientId);
}

/** CL-TECH-03: a photo arrives as base64 (already resized on the device). The bytes must be a real image. */
export async function addPhoto(ctx: Ctx, clientId: string, input: { data?: unknown; mime?: unknown; kind?: unknown; caption?: unknown; appointmentId?: unknown }) {
  assertAccess(ctx);
  await assertClient(ctx, clientId);
  const mime = String(input.mime ?? "");
  if (!MIME[mime]) throw new AppError("VALIDATION", "Подходят фото JPEG, PNG или WebP");
  const raw = typeof input.data === "string" ? input.data.replace(/^data:[^,]+,/, "") : "";
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length) throw new AppError("VALIDATION", "Пустой файл");
  if (bytes.length > MAX_PHOTO) throw new AppError("VALIDATION", "Фото больше 1,5 МБ");
  if (!MIME[mime](bytes)) throw new AppError("VALIDATION", "Файл не похож на фото");
  const kind = PHOTO_KINDS.includes(input.kind as (typeof PHOTO_KINDS)[number]) ? String(input.kind) : "other";
  const caption = typeof input.caption === "string" ? input.caption.trim().slice(0, 200) : "";
  const link = await checkAppointment(ctx, clientId, input.appointmentId);
  const count = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM client_photos WHERE client_id = $1 AND deleted_at IS NULL", [clientId]);
  if (Number(count?.n ?? 0) >= 60) throw new AppError("VALIDATION", "У клиента уже 60 фото. Удалите старые");
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO client_photos (id, tenant_id, client_id, appointment_id, staff_id, kind, caption, mime, size_bytes, data, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ctx.actor.tenantId, clientId, link.appointmentId, link.staffId, kind, caption, mime, bytes.length, bytes, ctx.actor.userId, ctx.now.toISOString()],
  );
  await audit(ctx, { entity: "client", entityId: clientId, action: "client.photo_added", diff: { id, kind, size: bytes.length } });
  return getTechCard(ctx, clientId);
}

export async function getPhoto(ctx: Ctx, clientId: string, id: string) {
  assertAccess(ctx);
  const row = await one<{ mime: string; data: Buffer }>(ctx.db, "SELECT mime, data FROM client_photos WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL", [id, clientId]);
  if (!row) throw new AppError("NOT_FOUND", "Фото не найдено");
  return { mime: row.mime, data: row.data };
}

export async function deletePhoto(ctx: Ctx, clientId: string, id: string) {
  assertAccess(ctx);
  const row = await one<{ created_by: string }>(ctx.db, "SELECT created_by FROM client_photos WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL", [id, clientId]);
  if (!row) throw new AppError("NOT_FOUND", "Фото не найдено");
  await assertOwnOrAdmin(ctx, row.created_by);
  // Soft delete keeps the audit trail; the bytes go so the photo is really gone.
  await ctx.db.query("UPDATE client_photos SET deleted_at = $2, data = '\\x00'::bytea, size_bytes = 1 WHERE id = $1", [id, ctx.now.toISOString()]);
  await audit(ctx, { entity: "client", entityId: clientId, action: "client.photo_deleted", diff: { id } });
  return getTechCard(ctx, clientId);
}

/** One line for the record and the master's day: what to watch out for. */
export function healthAlert(allergies: string | null | undefined, contraindications: string | null | undefined) {
  const parts = [allergies?.trim() ? `Аллергия: ${allergies.trim()}` : "", contraindications?.trim() ? `Противопоказания: ${contraindications.trim()}` : ""].filter(Boolean);
  return parts.join(". ") || null;
}
