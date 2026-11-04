/**
 * Resources (RES-*): rooms and devices a service needs. A service linked to resources needs one free
 * resource of each linked kind (a room and, say, a laser). Free = fewer overlapping visits and group
 * events than the resource's capacity. The server picks one automatically; the desk may override.
 */
import { AppError } from "@/domain/errors";
import { localMinutes } from "@/domain/time";
import { isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import type { Ctx } from "./types";

export type ResourceKind = "room" | "equipment" | "other";
export const KIND_LABEL: Record<ResourceKind, string> = { room: "Кабинет", equipment: "Аппарат", other: "Ресурс" };

type ResourceRow = {
  id: string;
  branch_id: string;
  kind: ResourceKind;
  title: string;
  color: string;
  capacity: number;
  open_min: number | null;
  close_min: number | null;
  active: boolean;
  position: number;
};

function present(row: ResourceRow, serviceIds: string[] = []) {
  return {
    id: row.id,
    branchId: row.branch_id,
    kind: row.kind,
    title: row.title,
    color: row.color,
    capacity: Number(row.capacity),
    openMin: row.open_min,
    closeMin: row.close_min,
    active: row.active,
    serviceIds,
  };
}

/** RES-CRUD-01: list for the branch. Masters read it too (journal view). */
export async function listResources(ctx: Ctx, branchId: string, input: { includeInactive?: boolean } = {}) {
  if (ctx.actor.role === "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const rows = await many<ResourceRow>(
    ctx.db,
    `SELECT * FROM resources WHERE branch_id = $1 ${input.includeInactive ? "" : "AND active"} ORDER BY position, title`,
    [branchId],
  );
  const links = await many<{ resource_id: string; service_id: string }>(
    ctx.db,
    "SELECT resource_id, service_id FROM service_resources WHERE resource_id = ANY($1::uuid[])",
    [rows.map((row) => row.id)],
  );
  return rows.map((row) => present(row, links.filter((link) => link.resource_id === row.id).map((link) => link.service_id)));
}

const minutes = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1440) throw new AppError("VALIDATION", "Часы работы: от 00:00 до 24:00");
  return number;
};

export async function saveResource(
  ctx: Ctx,
  input: { id?: string; branchId: string; kind?: unknown; title?: unknown; color?: unknown; capacity?: unknown; openMin?: unknown; closeMin?: unknown; active?: unknown; serviceIds?: unknown },
) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  await loadBranch(ctx, input.branchId);
  const current = input.id ? await one<ResourceRow>(ctx.db, "SELECT * FROM resources WHERE id = $1 FOR UPDATE", [input.id]) : null;
  if (input.id && !current) throw new AppError("NOT_FOUND", "Ресурс не найден");
  const title = String(input.title ?? current?.title ?? "").trim().slice(0, 80);
  if (!title) throw new AppError("VALIDATION", "Название обязательно");
  const kind = String(input.kind ?? current?.kind ?? "room") as ResourceKind;
  if (!KIND_LABEL[kind]) throw new AppError("VALIDATION", "Неизвестный тип ресурса");
  const capacity = Number(input.capacity ?? current?.capacity ?? 1);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw new AppError("VALIDATION", "Вместимость: от 1 до 100");
  const openMin = input.openMin !== undefined ? minutes(input.openMin) : current?.open_min ?? null;
  const closeMin = input.closeMin !== undefined ? minutes(input.closeMin) : current?.close_min ?? null;
  if ((openMin === null) !== (closeMin === null) || (openMin !== null && closeMin !== null && closeMin <= openMin)) {
    throw new AppError("VALIDATION", "Укажите время открытия и закрытия, закрытие позже открытия");
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(input.color ?? "")) ? String(input.color) : current?.color ?? "#e9e2ff";
  const active = input.active === undefined ? current?.active ?? true : Boolean(input.active);
  const id = current?.id ?? crypto.randomUUID();
  if (current) {
    await ctx.db.query(
      "UPDATE resources SET kind = $2, title = $3, color = $4, capacity = $5, open_min = $6, close_min = $7, active = $8 WHERE id = $1",
      [id, kind, title, color, capacity, openMin, closeMin, active],
    );
  } else {
    await ctx.db.query(
      `INSERT INTO resources (id, tenant_id, branch_id, kind, title, color, capacity, open_min, close_min, active, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, (SELECT COALESCE(MAX(position), 0) + 1 FROM resources WHERE branch_id = $3))`,
      [id, ctx.actor.tenantId, input.branchId, kind, title, color, capacity, openMin, closeMin, active],
    );
  }
  if (Array.isArray(input.serviceIds)) {
    const serviceIds = [...new Set(input.serviceIds.map(String))];
    await ctx.db.query("DELETE FROM service_resources WHERE resource_id = $1", [id]);
    for (const serviceId of serviceIds) {
      const service = await one(ctx.db, "SELECT 1 FROM services WHERE id = $1", [serviceId]);
      if (!service) throw new AppError("VALIDATION", "Услуга не найдена");
      await ctx.db.query("INSERT INTO service_resources (tenant_id, service_id, resource_id) VALUES ($1,$2,$3)", [ctx.actor.tenantId, serviceId, id]);
    }
  }
  await audit(ctx, { branchId: input.branchId, entity: "resource", entityId: id, action: current ? "resource.updated" : "resource.created", diff: { title, kind, capacity, active } });
  return (await listResources(ctx, input.branchId, { includeInactive: true })).find((row) => row.id === id)!;
}

/** Edge case 3: a resource that was ever booked is deactivated, never deleted. */
export async function deleteResource(ctx: Ctx, id: string) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const row = await one<ResourceRow>(ctx.db, "SELECT * FROM resources WHERE id = $1 FOR UPDATE", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Ресурс не найден");
  const used = await one(ctx.db, "SELECT 1 FROM appointment_resources WHERE resource_id = $1 UNION ALL SELECT 1 FROM group_events WHERE resource_id = $1 LIMIT 1", [id]);
  if (used) {
    await ctx.db.query("UPDATE resources SET active = false WHERE id = $1", [id]);
    await audit(ctx, { branchId: row.branch_id, entity: "resource", entityId: id, action: "resource.deactivated", diff: {} });
    return { deleted: false, deactivated: true };
  }
  await ctx.db.query("DELETE FROM resources WHERE id = $1", [id]);
  await audit(ctx, { branchId: row.branch_id, entity: "resource", entityId: id, action: "resource.deleted", diff: { title: row.title } });
  return { deleted: true, deactivated: false };
}

/** How many visits and group events hold the resource over [starts, ends). */
async function load(ctx: Ctx, resourceId: string, starts: Date, ends: Date, exclude: { appointmentId?: string; eventId?: string }) {
  const row = await one<{ n: number }>(
    ctx.db,
    `SELECT (
       SELECT count(*) FROM appointment_resources ar JOIN appointments a ON a.id = ar.appointment_id
       WHERE ar.resource_id = $1 AND a.status NOT IN ('cancelled', 'no_show') AND a.id <> COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000')
         AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange($2, $3, '[)')
     ) + (
       SELECT count(*) * 1000 FROM group_events g
       WHERE g.resource_id = $1 AND g.status <> 'cancelled' AND g.id <> COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000')
         AND tstzrange(g.starts_at, g.ends_at, '[)') && tstzrange($2, $3, '[)')
     ) AS n`,
    [resourceId, starts.toISOString(), ends.toISOString(), exclude.appointmentId ?? null, exclude.eventId ?? null],
  );
  // A group event takes the whole room whatever its capacity.
  return Number(row?.n ?? 0);
}

export async function resourceFree(ctx: Ctx, resource: { id: string; capacity: number }, starts: Date, ends: Date, exclude: { appointmentId?: string; eventId?: string } = {}) {
  return (await load(ctx, resource.id, starts, ends, exclude)) < Number(resource.capacity);
}

function outsideHours(resource: ResourceRow, starts: Date, ends: Date, timeZone: string) {
  if (resource.open_min === null || resource.close_min === null) return false;
  const from = localMinutes(starts, timeZone);
  const to = localMinutes(ends, timeZone) || 1440;
  return from < resource.open_min || to > resource.close_min;
}

/**
 * RES-LINK-01 / RES-BOOK-01: picks resources for a visit. Keeps the current ones when still free,
 * honours the desk's choice, otherwise takes the first free one of each kind. None free → CONFLICT_RESOURCE.
 */
export async function planResources(
  ctx: Ctx,
  input: { appointmentId?: string; branchId: string; serviceIds: string[]; starts: Date; ends: Date; timeZone: string; preferred?: string[] },
): Promise<{ resourceIds: string[]; warnings: string[] }> {
  if (!input.serviceIds.length) return { resourceIds: [], warnings: [] };
  const linked = await many<ResourceRow>(
    ctx.db,
    `SELECT r.* FROM resources r
     WHERE r.id IN (SELECT resource_id FROM service_resources WHERE service_id = ANY($1::uuid[])) AND r.branch_id = $2 AND r.active
     ORDER BY r.position, r.title FOR UPDATE`,
    [input.serviceIds, input.branchId],
  );
  if (!linked.length) return { resourceIds: [], warnings: [] };
  const current = input.appointmentId
    ? (await many<{ resource_id: string }>(ctx.db, "SELECT resource_id FROM appointment_resources WHERE appointment_id = $1", [input.appointmentId])).map((row) => row.resource_id)
    : [];
  const preferred = new Set(input.preferred ?? []);
  const keep = new Set(current);
  const kinds = [...new Set(linked.map((row) => row.kind))];
  const chosen: string[] = [];
  const warnings: string[] = [];
  for (const kind of kinds) {
    const candidates = linked.filter((row) => row.kind === kind);
    // The desk's pick first, then what the visit already holds, then the list order.
    const ordered = [
      ...candidates.filter((row) => preferred.has(row.id)),
      ...candidates.filter((row) => !preferred.has(row.id) && keep.has(row.id)),
      ...candidates.filter((row) => !preferred.has(row.id) && !keep.has(row.id)),
    ];
    const wanted = ordered[0] && preferred.has(ordered[0].id) ? ordered[0] : null;
    let picked: ResourceRow | null = null;
    for (const resource of ordered) {
      if (await resourceFree(ctx, resource, input.starts, input.ends, { appointmentId: input.appointmentId })) {
        picked = resource;
        break;
      }
      if (resource === wanted) throw new AppError("CONFLICT_RESOURCE", `${resource.title} занят в это время`, { resourceId: resource.id, kind });
    }
    if (!picked) {
      throw new AppError("CONFLICT_RESOURCE", `Нет свободного ресурса: ${candidates.map((row) => row.title).join(", ")}`, { kind, resourceIds: candidates.map((row) => row.id) });
    }
    if (outsideHours(picked, input.starts, input.ends, input.timeZone)) warnings.push("RESOURCE_HOURS");
    chosen.push(picked.id);
  }
  return { resourceIds: chosen, warnings };
}

export async function writeResources(ctx: Ctx, appointmentId: string, resourceIds: string[]) {
  await ctx.db.query("DELETE FROM appointment_resources WHERE appointment_id = $1", [appointmentId]);
  for (const resourceId of resourceIds) {
    await ctx.db.query("INSERT INTO appointment_resources (tenant_id, appointment_id, resource_id) VALUES ($1,$2,$3)", [ctx.actor.tenantId, appointmentId, resourceId]);
  }
}

export async function resourcesOf(ctx: Ctx, appointmentId: string) {
  return many<{ id: string; title: string; kind: ResourceKind; color: string }>(
    ctx.db,
    "SELECT r.id, r.title, r.kind, r.color FROM appointment_resources ar JOIN resources r ON r.id = ar.resource_id WHERE ar.appointment_id = $1 ORDER BY r.position",
    [appointmentId],
  );
}

/** Options for the drawer: the linked resources of the visit's services, with whether each is free. */
export async function resourceOptions(ctx: Ctx, input: { appointmentId?: string; branchId: string; serviceIds: string[]; startsAt: string; durationMin: number }) {
  const starts = new Date(input.startsAt);
  const ends = new Date(starts.getTime() + input.durationMin * 60000);
  const linked = await many<ResourceRow>(
    ctx.db,
    `SELECT DISTINCT r.* FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
     WHERE sr.service_id = ANY($1::uuid[]) AND r.branch_id = $2 AND r.active ORDER BY r.position, r.title`,
    [input.serviceIds, input.branchId],
  );
  const out = [];
  for (const row of linked) {
    out.push({ id: row.id, title: row.title, kind: row.kind, free: await resourceFree(ctx, row, starts, ends, { appointmentId: input.appointmentId }) });
  }
  return out;
}

/** RES-VIEW-01 data: which visits hold which resource in the day. */
export async function resourceDay(ctx: Ctx, branchId: string, from: Date, to: Date) {
  return many<{ appointment_id: string; resource_id: string }>(
    ctx.db,
    `SELECT ar.appointment_id, ar.resource_id FROM appointment_resources ar JOIN appointments a ON a.id = ar.appointment_id
     WHERE a.branch_id = $1 AND a.starts_at < $3 AND a.ends_at > $2`,
    [branchId, from.toISOString(), to.toISOString()],
  );
}

/**
 * Online slots (OB-SLOT-01 + RES-BOOK-01): returns a checker that says whether a window has a free
 * resource of every kind the service needs. One query per day instead of one per slot.
 */
export async function resourceChecker(ctx: Ctx, branchId: string, serviceId: string, from: Date, to: Date) {
  const linked = await many<{ id: string; kind: ResourceKind; capacity: number }>(
    ctx.db,
    `SELECT r.id, r.kind, r.capacity FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
     WHERE sr.service_id = $1 AND r.branch_id = $2 AND r.active`,
    [serviceId, branchId],
  );
  if (!linked.length) return () => true;
  const busy = await many<{ resource_id: string; starts_at: Date; ends_at: Date; whole: boolean }>(
    ctx.db,
    `SELECT ar.resource_id, a.starts_at, a.ends_at, false AS whole FROM appointment_resources ar JOIN appointments a ON a.id = ar.appointment_id
     WHERE ar.resource_id = ANY($1::uuid[]) AND a.status NOT IN ('cancelled', 'no_show') AND a.starts_at < $3 AND a.ends_at > $2
     UNION ALL
     SELECT g.resource_id, g.starts_at, g.ends_at, true AS whole FROM group_events g
     WHERE g.resource_id = ANY($1::uuid[]) AND g.status <> 'cancelled' AND g.starts_at < $3 AND g.ends_at > $2`,
    [linked.map((row) => row.id), from.toISOString(), to.toISOString()],
  );
  const kinds = [...new Set(linked.map((row) => row.kind))];
  return (startMs: number, endMs: number) =>
    kinds.every((kind) =>
      linked
        .filter((row) => row.kind === kind)
        .some((row) => {
          const hits = busy.filter((item) => item.resource_id === row.id && new Date(item.starts_at).getTime() < endMs && new Date(item.ends_at).getTime() > startMs);
          if (hits.some((item) => item.whole)) return false;
          return hits.length < Number(row.capacity);
        }),
    );
}
