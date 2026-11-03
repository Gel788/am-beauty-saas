import { AppError } from "@/domain/errors";
import { normalizePhone, phoneDigits } from "@/domain/phone";
import { audit } from "./audit";
import { assertRole } from "./access";
import { many, one } from "./db";
import { clearAppointmentDebt } from "./payments";
import type { Ctx } from "./types";

export type ClientDto = {
  id: string;
  name: string;
  email: string | null;
  notes: string;
  source: string;
  balanceMinor: number;
  birthDate: string | null;
  deletedAt: string | null;
  version: number;
  phones: { phone: string; isPrimary: boolean }[];
  tags: string[];
  visitCount?: number;
  lastVisitAt?: string | null;
  createdAt: string;
};

type ClientRow = {
  id: string;
  name: string;
  email: string | null;
  notes: string;
  source: string;
  balance_minor: number;
  birth_date: Date | string | null;
  deleted_at: Date | null;
  version: number;
  created_at: Date;
  visit_count?: number;
  last_visit_at?: Date | null;
};

function dateOnly(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeEmail(email?: string | null): string | null {
  if (!email || !email.trim()) return null;
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AppError("VALIDATION", "Некорректный email");
  }
  return value;
}

async function hydrate(ctx: Ctx, row: ClientRow): Promise<ClientDto> {
  const phones = await many<{ phone_e164: string; is_primary: boolean }>(
    ctx.db,
    `SELECT phone_e164, is_primary FROM client_phones
     WHERE client_id = $1 AND deleted_at IS NULL
     ORDER BY is_primary DESC, phone_e164`,
    [row.id],
  );
  const tags = await many<{ tag: string }>(
    ctx.db,
    "SELECT tag FROM client_tags WHERE client_id = $1 ORDER BY tag",
    [row.id],
  );
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    notes: row.notes,
    source: row.source,
    balanceMinor: Number(row.balance_minor),
    birthDate: dateOnly(row.birth_date),
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    version: Number(row.version),
    phones: phones.map((phone) => ({ phone: phone.phone_e164, isPrimary: phone.is_primary })),
    tags: tags.map((tag) => tag.tag),
    visitCount: row.visit_count !== undefined ? Number(row.visit_count) : undefined,
    lastVisitAt: row.last_visit_at ? new Date(row.last_visit_at).toISOString() : row.last_visit_at,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function findByPhone(ctx: Ctx, phone: string, exceptClientId?: string) {
  return one<{ id: string; name: string }>(
    ctx.db,
    `SELECT c.id, c.name
     FROM client_phones p
     JOIN clients c ON c.id = p.client_id
     WHERE p.phone_e164 = $1 AND p.deleted_at IS NULL AND c.deleted_at IS NULL
       AND ($2::uuid IS NULL OR c.id <> $2)`,
    [phone, exceptClientId ?? null],
  );
}

export async function createClient(
  ctx: Ctx,
  input: {
    name: string;
    phone?: string;
    phones?: string[];
    email?: string | null;
    notes?: string;
    source?: string;
    tags?: string[];
    birthDate?: string | null;
  },
): Promise<ClientDto> {
  assertRole(ctx, ["owner", "admin", "master"]);
  const name = input.name?.trim() ?? "";
  if (name.length < 1 || name.length > 120) {
    throw new AppError("VALIDATION", "Имя: от 1 до 120 символов");
  }
  const rawPhones = input.phones?.length ? input.phones : input.phone ? [input.phone] : [];
  if (rawPhones.length === 0) throw new AppError("VALIDATION", "Телефон обязателен");
  const phones = rawPhones.map((phone) => normalizePhone(phone));
  for (const phone of phones) {
    const existing = await findByPhone(ctx, phone);
    if (existing) {
      throw new AppError("VALIDATION", "Клиент с таким телефоном уже есть", {
        existingClientId: existing.id,
        existingClientName: existing.name,
      });
    }
  }
  const email = normalizeEmail(input.email);
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO clients (id, tenant_id, name, email, notes, source, birth_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ctx.actor.tenantId, name, email, input.notes?.trim() ?? "", input.source?.trim() || "walk-in", input.birthDate || null],
  );
  for (let i = 0; i < phones.length; i += 1) {
    await ctx.db.query(
      `INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), ctx.actor.tenantId, id, phones[i], i === 0],
    );
  }
  for (const tag of input.tags ?? []) {
    const value = tag.trim();
    if (!value) continue;
    await ctx.db.query("INSERT INTO client_tags (client_id, tenant_id, tag) VALUES ($1, $2, $3)", [
      id,
      ctx.actor.tenantId,
      value,
    ]);
  }
  await audit(ctx, { entity: "client", entityId: id, action: "client.created", diff: { name, phones } });
  return getClient(ctx, id);
}

export async function getClient(ctx: Ctx, id: string): Promise<ClientDto> {
  assertRole(ctx, ["owner", "admin", "master", "accountant"]);
  const row = await one<ClientRow>(ctx.db, "SELECT * FROM clients WHERE id = $1", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Клиент не найден");
  return hydrate(ctx, row);
}

export async function updateClient(
  ctx: Ctx,
  id: string,
  input: {
    version: number;
    name?: string;
    phone?: string;
    phones?: string[];
    email?: string | null;
    notes?: string;
    source?: string;
    tags?: string[];
    birthDate?: string | null;
  },
): Promise<ClientDto> {
  assertRole(ctx, ["owner", "admin", "master"]);
  const current = await one<ClientRow>(ctx.db, "SELECT * FROM clients WHERE id = $1 FOR UPDATE", [id]);
  if (!current || current.deleted_at) throw new AppError("NOT_FOUND", "Клиент не найден");
  if (Number(current.version) !== input.version) {
    throw new AppError("STALE", "Карточка клиента изменена. Обновить?");
  }
  const name = (input.name ?? current.name).trim();
  if (name.length < 1 || name.length > 120) throw new AppError("VALIDATION", "Имя: от 1 до 120 символов");
  const email = input.email !== undefined ? normalizeEmail(input.email) : current.email;
  const rawPhones = input.phones ?? (input.phone ? [input.phone] : null);
  if (rawPhones) {
    if (rawPhones.length === 0) throw new AppError("VALIDATION", "Телефон обязателен");
    const phones = rawPhones.map((phone) => normalizePhone(phone));
    for (const phone of phones) {
      const existing = await findByPhone(ctx, phone, id);
      if (existing) {
        throw new AppError("VALIDATION", "Клиент с таким телефоном уже есть", {
          existingClientId: existing.id,
          existingClientName: existing.name,
        });
      }
    }
    await ctx.db.query("UPDATE client_phones SET deleted_at = now() WHERE client_id = $1 AND deleted_at IS NULL", [id]);
    for (let i = 0; i < phones.length; i += 1) {
      await ctx.db.query(
        `INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), ctx.actor.tenantId, id, phones[i], i === 0],
      );
    }
  }
  if (input.tags) {
    await ctx.db.query("DELETE FROM client_tags WHERE client_id = $1", [id]);
    for (const tag of input.tags) {
      const value = tag.trim();
      if (!value) continue;
      await ctx.db.query("INSERT INTO client_tags (client_id, tenant_id, tag) VALUES ($1, $2, $3)", [
        id,
        ctx.actor.tenantId,
        value,
      ]);
    }
  }
  await ctx.db.query(
    `UPDATE clients
     SET name = $2, email = $3, notes = $4, source = $5, birth_date = $6,
         version = version + 1, updated_at = now()
     WHERE id = $1`,
    [
      id,
      name,
      email,
      input.notes !== undefined ? input.notes : current.notes,
      input.source ?? current.source,
      input.birthDate !== undefined ? input.birthDate || null : dateOnly(current.birth_date),
    ],
  );
  await audit(ctx, {
    entity: "client",
    entityId: id,
    action: "client.updated",
    diff: { before: { name: current.name, email: current.email }, after: { name, email } },
  });
  return getClient(ctx, id);
}

export async function deleteClient(
  ctx: Ctx,
  id: string,
  decision?: "cancel_future" | "keep_future",
): Promise<{ cancelled: number }> {
  assertRole(ctx, ["owner", "admin"]);
  const current = await one<ClientRow>(ctx.db, "SELECT * FROM clients WHERE id = $1 FOR UPDATE", [id]);
  if (!current || current.deleted_at) throw new AppError("NOT_FOUND", "Клиент не найден");
  const future = await many<{ id: string }>(
    ctx.db,
    `SELECT id FROM appointments
     WHERE client_id = $1 AND starts_at > $2 AND status <> 'cancelled'`,
    [id, ctx.now.toISOString()],
  );
  if (future.length > 0 && !decision) {
    throw new AppError("VALIDATION", "У клиента есть будущие записи", {
      futureCount: future.length,
      choices: ["cancel_future", "keep_future"],
    });
  }
  let cancelled = 0;
  if (decision === "cancel_future") {
    for (const row of future) {
      await clearAppointmentDebt(ctx, row.id);
      await ctx.db.query(
        `UPDATE appointments
         SET status = 'cancelled', cancel_reason = 'Клиент удалён', cancelled_by = $2,
             version = version + 1, updated_by = $2, updated_at = now()
         WHERE id = $1`,
        [row.id, ctx.actor.userId],
      );
      await audit(ctx, {
        entity: "appointment",
        entityId: row.id,
        action: "appointment.cancelled",
        diff: { reason: "Клиент удалён" },
      });
      cancelled += 1;
    }
  }
  await ctx.db.query("UPDATE clients SET deleted_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [id]);
  await ctx.db.query("UPDATE client_phones SET deleted_at = now() WHERE client_id = $1 AND deleted_at IS NULL", [id]);
  await audit(ctx, { entity: "client", entityId: id, action: "client.deleted", diff: { decision: decision ?? null, cancelled } });
  return { cancelled };
}

export async function searchClients(ctx: Ctx, query: string): Promise<ClientDto[]> {
  assertRole(ctx, ["owner", "admin", "master"]);
  const q = query.trim();
  const digits = phoneDigits(q);
  const fullPhone = digits.length >= 10;
  if (q.length < 2 && !fullPhone) return [];
  const rows = await many<ClientRow>(
    ctx.db,
    `SELECT c.*,
        (SELECT count(*)::int FROM appointments a WHERE a.client_id = c.id AND a.status <> 'cancelled') AS visit_count,
        (SELECT max(a.starts_at) FROM appointments a WHERE a.client_id = c.id) AS last_visit_at
     FROM clients c
     WHERE c.deleted_at IS NULL
       AND (
         c.name ILIKE $1
         OR COALESCE(c.email, '') ILIKE $1
         OR ($2::text IS NOT NULL AND EXISTS (
           SELECT 1 FROM client_phones p
           WHERE p.client_id = c.id AND p.deleted_at IS NULL AND p.phone_e164 LIKE $2
         ))
       )
     ORDER BY c.name
     LIMIT 30`,
    [`%${q}%`, digits.length >= 2 ? `%${digits}%` : null],
  );
  const result: ClientDto[] = [];
  for (const row of rows) result.push(await hydrate(ctx, row));
  return result;
}

export async function listClients(ctx: Ctx, query = ""): Promise<ClientDto[]> {
  if (query.trim()) return searchClients(ctx, query);
  assertRole(ctx, ["owner", "admin", "master"]);
  const rows = await many<ClientRow>(
    ctx.db,
    `SELECT c.*,
        (SELECT count(*)::int FROM appointments a WHERE a.client_id = c.id AND a.status <> 'cancelled') AS visit_count,
        (SELECT max(a.starts_at) FROM appointments a WHERE a.client_id = c.id) AS last_visit_at
     FROM clients c
     WHERE c.deleted_at IS NULL
     ORDER BY c.name
     LIMIT 200`,
  );
  const result: ClientDto[] = [];
  for (const row of rows) result.push(await hydrate(ctx, row));
  return result;
}

export async function adjustBalance(ctx: Ctx, clientId: string, amountMinor: number, reason: string): Promise<ClientDto> {
  assertRole(ctx, ["owner", "accountant"]);
  if (!Number.isInteger(amountMinor) || amountMinor === 0) {
    throw new AppError("VALIDATION", "Сумма корректировки должна быть ненулевой и в копейках");
  }
  if (!reason?.trim()) throw new AppError("VALIDATION", "Укажите причину корректировки");
  const client = await one<ClientRow>(ctx.db, "SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [clientId]);
  if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
  await ctx.db.query("UPDATE clients SET balance_minor = balance_minor + $2, updated_at = now() WHERE id = $1", [
    clientId,
    amountMinor,
  ]);
  await ctx.db.query(
    `INSERT INTO balance_adjustments (id, tenant_id, client_id, amount_minor, reason, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [crypto.randomUUID(), ctx.actor.tenantId, clientId, amountMinor, reason.trim(), ctx.actor.userId],
  );
  await audit(ctx, {
    entity: "client",
    entityId: clientId,
    action: "client.balance_adjusted",
    diff: { amountMinor, reason: reason.trim() },
  });
  return getClient(ctx, clientId);
}

export async function clientHistory(ctx: Ctx, clientId: string, branchId?: string) {
  assertRole(ctx, ["owner", "admin", "master"]);
  await getClient(ctx, clientId);
  const visits = await many<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    status: string;
    branch_id: string;
    branch_name: string;
    comment: string;
    titles: string[] | null;
    price_minor: number;
  }>(
    ctx.db,
    `SELECT a.id, a.starts_at, a.ends_at, a.status, a.branch_id, b.name AS branch_name, a.comment,
            (SELECT array_agg(s.title_snapshot ORDER BY s.position) FROM appointment_services s WHERE s.appointment_id = a.id) AS titles,
            (SELECT COALESCE(SUM(s.price_minor), 0)::int FROM appointment_services s WHERE s.appointment_id = a.id) AS price_minor
     FROM appointments a
     JOIN branches b ON b.id = a.branch_id
     WHERE a.client_id = $1 AND ($2::uuid IS NULL OR a.branch_id = $2)
     ORDER BY a.starts_at DESC`,
    [clientId, branchId ?? null],
  );
  const payments = await many<{
    id: string;
    total_minor: number;
    status: string;
    direction: string;
    posted_at: Date | null;
    appointment_id: string | null;
  }>(
    ctx.db,
    `SELECT id, total_minor, status, direction, posted_at, appointment_id
     FROM payments
     WHERE client_id = $1 AND ($2::uuid IS NULL OR branch_id = $2)
     ORDER BY created_at DESC`,
    [clientId, branchId ?? null],
  );
  return {
    visits: visits.map((visit) => ({
      id: visit.id,
      startsAt: new Date(visit.starts_at).toISOString(),
      endsAt: new Date(visit.ends_at).toISOString(),
      status: visit.status,
      branchId: visit.branch_id,
      branchName: visit.branch_name,
      comment: visit.comment,
      titles: visit.titles ?? [],
      priceMinor: Number(visit.price_minor),
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      totalMinor: Number(payment.total_minor),
      status: payment.status,
      direction: payment.direction,
      postedAt: payment.posted_at ? new Date(payment.posted_at).toISOString() : null,
      appointmentId: payment.appointment_id,
    })),
    noShows: visits.filter((visit) => visit.status === "no_show").map((visit) => visit.id),
  };
}
