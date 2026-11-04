import { AppError } from "@/domain/errors";
import { validateTemplate, type Interval } from "@/domain/schedule";
import { addCalendarDays, mondayOf } from "@/domain/time";
import { assertRole, isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { reassignAppointmentStaff } from "./appointments";
import { many, one } from "./db";
import type { Ctx } from "./types";

function assertCatalog(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
}

export async function createCategory(ctx: Ctx, title: string) {
  assertCatalog(ctx);
  const name = title.trim();
  if (!name) throw new AppError("VALIDATION", "Укажите название категории");
  const id = crypto.randomUUID();
  const sort = await one<{ s: number }>(ctx.db, "SELECT COALESCE(MAX(sort), 0)::int AS s FROM service_categories");
  await ctx.db.query("INSERT INTO service_categories (id, tenant_id, title, sort) VALUES ($1,$2,$3,$4)", [
    id,
    ctx.actor.tenantId,
    name,
    Number(sort?.s ?? 0) + 1,
  ]);
  return { id, title: name };
}

export async function deleteCategory(ctx: Ctx, id: string) {
  assertCatalog(ctx);
  const services = await one(ctx.db, "SELECT 1 FROM services WHERE category_id = $1", [id]);
  if (services) throw new AppError("VALIDATION", "В категории есть услуги. Сначала перенесите их");
  const result = await ctx.db.query("DELETE FROM service_categories WHERE id = $1", [id]);
  if (result.rowCount === 0) throw new AppError("NOT_FOUND", "Категория не найдена");
}

export async function createService(
  ctx: Ctx,
  input: {
    categoryId?: string | null;
    title: string;
    durationMin: number;
    priceMinor: number;
    color?: string;
    staffIds?: string[];
    bufferAfterMin?: number;
    onlineVisible?: boolean;
  },
) {
  assertCatalog(ctx);
  const title = input.title.trim();
  if (!title) throw new AppError("VALIDATION", "Укажите название услуги");
  if (!Number.isInteger(input.durationMin) || input.durationMin < 5 || input.durationMin % 5 !== 0) {
    throw new AppError("VALIDATION", "Длительность от 5 минут и кратна 5");
  }
  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) {
    throw new AppError("VALIDATION", "Цена не может быть отрицательной");
  }
  const buffer = input.bufferAfterMin ?? 0;
  if (!Number.isInteger(buffer) || buffer < 0 || buffer % 5 !== 0) {
    throw new AppError("VALIDATION", "Пауза после услуги кратна 5 минутам");
  }
  const id = crypto.randomUUID();
  const sort = await one<{ s: number }>(ctx.db, "SELECT COALESCE(MAX(sort), 0)::int AS s FROM services");
  await ctx.db.query(
    `INSERT INTO services (id, tenant_id, category_id, title, duration_min, price_minor, color, online_visible, sort, buffer_after_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      ctx.actor.tenantId,
      input.categoryId ?? null,
      title,
      input.durationMin,
      input.priceMinor,
      input.color ?? "#f8d0e4",
      input.onlineVisible ?? true,
      Number(sort?.s ?? 0) + 1,
      buffer,
    ],
  );
  if (input.staffIds) await setServiceStaff(ctx, id, input.staffIds, true);
  return getService(ctx, id);
}

export async function updateService(
  ctx: Ctx,
  id: string,
  input: Partial<{
    title: string;
    durationMin: number;
    priceMinor: number;
    color: string;
    categoryId: string | null;
    onlineVisible: boolean;
    active: boolean;
    bufferAfterMin: number;
    rebookDays: number | null;
    onlineDepositMinor: number | null;
  }>,
) {
  assertCatalog(ctx);
  if (input.onlineDepositMinor !== undefined && input.onlineDepositMinor !== null && !(Number.isInteger(input.onlineDepositMinor) && input.onlineDepositMinor >= 0)) {
    throw new AppError("VALIDATION", "Предоплата: сумма от 0");
  }
  if (input.rebookDays !== undefined && input.rebookDays !== null && !(Number.isInteger(input.rebookDays) && input.rebookDays >= 1 && input.rebookDays <= 365)) {
    throw new AppError("VALIDATION", "Повторный визит: от 1 до 365 дней");
  }
  const current = await one<{ id: string }>(ctx.db, "SELECT id FROM services WHERE id = $1", [id]);
  if (!current) throw new AppError("NOT_FOUND", "Услуга не найдена");
  if (input.durationMin !== undefined && (input.durationMin < 5 || input.durationMin % 5 !== 0)) {
    throw new AppError("VALIDATION", "Длительность от 5 минут и кратна 5");
  }
  if (input.priceMinor !== undefined && input.priceMinor < 0) {
    throw new AppError("VALIDATION", "Цена не может быть отрицательной");
  }
  await ctx.db.query(
    `UPDATE services SET
       title = COALESCE($2, title),
       duration_min = COALESCE($3, duration_min),
       price_minor = COALESCE($4, price_minor),
       color = COALESCE($5, color),
       category_id = CASE WHEN $6 THEN $7::uuid ELSE category_id END,
       online_visible = COALESCE($8, online_visible),
       active = COALESCE($9, active),
       buffer_after_min = COALESCE($10, buffer_after_min),
       rebook_days = CASE WHEN $11 THEN $12::int ELSE rebook_days END,
       online_deposit_minor = CASE WHEN $13 THEN $14::int ELSE online_deposit_minor END
     WHERE id = $1`,
    [
      id,
      input.title?.trim() || null,
      input.durationMin ?? null,
      input.priceMinor ?? null,
      input.color ?? null,
      input.categoryId !== undefined,
      input.categoryId ?? null,
      input.onlineVisible ?? null,
      input.active ?? null,
      input.bufferAfterMin ?? null,
      input.rebookDays !== undefined,
      input.rebookDays ?? null,
      input.onlineDepositMinor !== undefined,
      input.onlineDepositMinor ?? null,
    ],
  );
  return getService(ctx, id);
}

export async function deactivateService(ctx: Ctx, id: string, hard = false) {
  assertCatalog(ctx);
  if (hard) {
    assertRole(ctx, ["owner", "super"]);
    const used = await one(ctx.db, "SELECT 1 FROM appointment_services WHERE service_id = $1", [id]);
    if (used) throw new AppError("VALIDATION", "Услуга есть в истории записей. Её можно только скрыть");
    const result = await ctx.db.query("DELETE FROM services WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new AppError("NOT_FOUND", "Услуга не найдена");
    return { deleted: true };
  }
  await ctx.db.query("UPDATE services SET active = false WHERE id = $1", [id]);
  return { deleted: false, active: false };
}

export async function setServiceStaff(ctx: Ctx, serviceId: string, staffIds: string[], acknowledgeSoft = false) {
  assertCatalog(ctx);
  const service = await one(ctx.db, "SELECT 1 FROM services WHERE id = $1", [serviceId]);
  if (!service) throw new AppError("NOT_FOUND", "Услуга не найдена");
  if (staffIds.length === 0 && !acknowledgeSoft) {
    throw new AppError("SOFT_CONFIRM", "У услуги не останется мастеров", { warnings: ["NO_STAFF"] });
  }
  await ctx.db.query("DELETE FROM service_staff WHERE service_id = $1", [serviceId]);
  for (const staffId of staffIds) {
    const staff = await one(ctx.db, "SELECT 1 FROM staff WHERE id = $1", [staffId]);
    if (!staff) throw new AppError("NOT_FOUND", "Мастер не найден");
    await ctx.db.query(
      "INSERT INTO service_staff (service_id, staff_id, tenant_id) VALUES ($1,$2,$3)",
      [serviceId, staffId, ctx.actor.tenantId],
    );
  }
  return getService(ctx, serviceId);
}

export async function reorderServices(ctx: Ctx, orderedIds: string[]) {
  assertCatalog(ctx);
  for (let i = 0; i < orderedIds.length; i += 1) {
    await ctx.db.query("UPDATE services SET sort = $2 WHERE id = $1", [orderedIds[i], i]);
  }
}

async function getService(ctx: Ctx, id: string) {
  const row = await one<{
    id: string;
    category_id: string | null;
    title: string;
    duration_min: number;
    price_minor: number;
    color: string;
    online_visible: boolean;
    active: boolean;
    sort: number;
    buffer_after_min: number;
    rebook_days: number | null;
    online_deposit_minor: number | null;
  }>(ctx.db, "SELECT * FROM services WHERE id = $1", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Услуга не найдена");
  const staff = await many<{ staff_id: string }>(ctx.db, "SELECT staff_id FROM service_staff WHERE service_id = $1", [id]);
  return {
    id: row.id,
    categoryId: row.category_id,
    title: row.title,
    durationMin: Number(row.duration_min),
    priceMinor: Number(row.price_minor),
    color: row.color,
    onlineVisible: row.online_visible,
    active: row.active,
    sort: Number(row.sort),
    bufferAfterMin: Number(row.buffer_after_min),
    rebookDays: row.rebook_days === null ? null : Number(row.rebook_days),
    onlineDepositMinor: row.online_deposit_minor === null ? null : Number(row.online_deposit_minor),
    staffIds: staff.map((item) => item.staff_id),
  };
}

export async function listCatalog(ctx: Ctx) {
  assertRole(ctx, ["owner", "admin", "master", "accountant", "super"]);
  const categories = await many<{ id: string; title: string; sort: number }>(
    ctx.db,
    "SELECT id, title, sort FROM service_categories ORDER BY sort, title",
  );
  const services = await many<{ id: string }>(ctx.db, "SELECT id FROM services ORDER BY sort, title");
  const full = [];
  for (const service of services) full.push(await getService(ctx, service.id));
  return { categories, services: full };
}

export async function createStaff(
  ctx: Ctx,
  input: {
    displayName: string;
    color?: string;
    specialties?: string;
    branchIds: string[];
    onlineBookable?: boolean;
    invite?: { email: string; password: string; name?: string };
  },
) {
  assertCatalog(ctx);
  const name = input.displayName.trim();
  if (!name) throw new AppError("VALIDATION", "Укажите имя мастера");
  if (!input.branchIds.length) throw new AppError("VALIDATION", "Выберите филиал");
  for (const branchId of input.branchIds) await loadBranch(ctx, branchId);
  let userId: string | null = null;
  if (input.invite) {
    const email = input.invite.email.trim().toLowerCase();
    if (!email.includes("@")) throw new AppError("VALIDATION", "Некорректный email");
    if (input.invite.password.length < 6) throw new AppError("VALIDATION", "Пароль не короче 6 символов");
    const { hash } = await import("bcryptjs");
    userId = crypto.randomUUID();
    await ctx.db.query("INSERT INTO users (id, email, password_hash, name) VALUES ($1,$2,$3,$4)", [
      userId,
      email,
      await hash(input.invite.password, 8),
      input.invite.name?.trim() || name,
    ]);
    await ctx.db.query(
      "INSERT INTO memberships (id, tenant_id, user_id, role, branch_id) VALUES ($1,$2,$3,'master',$4)",
      [crypto.randomUUID(), ctx.actor.tenantId, userId, input.branchIds[0]],
    );
  }
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO staff (id, tenant_id, user_id, display_name, color, specialties, online_bookable)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, ctx.actor.tenantId, userId, name, input.color ?? "#7c5cff", input.specialties?.trim() ?? "", input.onlineBookable ?? true],
  );
  for (const branchId of input.branchIds) {
    await ctx.db.query(
      "INSERT INTO staff_branches (staff_id, branch_id, tenant_id) VALUES ($1,$2,$3)",
      [id, branchId, ctx.actor.tenantId],
    );
  }
  await audit(ctx, { entity: "staff", entityId: id, action: "staff.created", diff: { name } });
  return getStaff(ctx, id);
}

export async function listStaff(ctx: Ctx) {
  assertRole(ctx, ["owner", "admin", "master", "accountant", "super"]);
  const rows = await many<{ id: string }>(ctx.db, "SELECT id FROM staff ORDER BY display_name");
  const staff = [];
  for (const row of rows) staff.push(await getStaff(ctx, row.id));
  return staff;
}

async function getStaff(ctx: Ctx, id: string) {
  const row = await one<{
    id: string;
    user_id: string | null;
    display_name: string;
    color: string;
    specialties: string;
    active: boolean;
    online_bookable: boolean;
  }>(ctx.db, "SELECT * FROM staff WHERE id = $1", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Мастер не найден");
  const branches = await many<{ branch_id: string }>(ctx.db, "SELECT branch_id FROM staff_branches WHERE staff_id = $1", [id]);
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    color: row.color,
    specialties: row.specialties,
    active: row.active,
    onlineBookable: row.online_bookable,
    branchIds: branches.map((branch) => branch.branch_id),
  };
}

export async function updateStaff(
  ctx: Ctx,
  id: string,
  input: Partial<{ displayName: string; color: string; specialties: string; onlineBookable: boolean; branchIds: string[] }>,
) {
  assertCatalog(ctx);
  const current = await getStaff(ctx, id);
  if (input.branchIds) {
    for (const branchId of input.branchIds) await loadBranch(ctx, branchId);
    await ctx.db.query("DELETE FROM staff_branches WHERE staff_id = $1", [id]);
    for (const branchId of input.branchIds) {
      await ctx.db.query("INSERT INTO staff_branches (staff_id, branch_id, tenant_id) VALUES ($1,$2,$3)", [
        id,
        branchId,
        ctx.actor.tenantId,
      ]);
    }
  }
  await ctx.db.query(
    `UPDATE staff SET display_name = $2, color = $3, specialties = $4, online_bookable = $5 WHERE id = $1`,
    [
      id,
      input.displayName?.trim() || current.displayName,
      input.color ?? current.color,
      input.specialties !== undefined ? input.specialties : current.specialties,
      input.onlineBookable ?? current.onlineBookable,
    ],
  );
  return getStaff(ctx, id);
}

export async function deactivateStaff(
  ctx: Ctx,
  id: string,
  decision?: "cancel" | "reassign",
  reassignToStaffId?: string,
) {
  assertCatalog(ctx);
  const staff = await getStaff(ctx, id);
  if (!staff.active) return staff;
  const future = await many<{ id: string; branch_id: string }>(
    ctx.db,
    `SELECT id, branch_id FROM appointments WHERE staff_id = $1 AND starts_at > $2 AND status <> 'cancelled'`,
    [id, ctx.now.toISOString()],
  );
  if (future.length && !decision) {
    throw new AppError("VALIDATION", "У мастера есть будущие записи", {
      futureCount: future.length,
      choices: ["cancel", "reassign"],
    });
  }
  if (decision === "reassign") {
    if (!reassignToStaffId || reassignToStaffId === id) throw new AppError("VALIDATION", "Выберите другого мастера");
    for (const row of future) await reassignAppointmentStaff(ctx, row.id, reassignToStaffId);
  }
  if (decision === "cancel") {
    for (const row of future) {
      await ctx.db.query(
        `UPDATE appointments SET status = 'cancelled', cancel_reason = 'Мастер деактивирован', cancelled_by = $2,
           version = version + 1, updated_by = $2, updated_at = now()
         WHERE id = $1`,
        [row.id, ctx.actor.userId],
      );
      await audit(ctx, {
        branchId: row.branch_id,
        entity: "appointment",
        entityId: row.id,
        action: "appointment.cancelled",
        diff: { reason: "Мастер деактивирован" },
      });
    }
  }
  await ctx.db.query("UPDATE staff SET active = false WHERE id = $1", [id]);
  await audit(ctx, { entity: "staff", entityId: id, action: "staff.deactivated", diff: { decision: decision ?? null } });
  return getStaff(ctx, id);
}

export async function saveWeekTemplate(
  ctx: Ctx,
  input: { staffId: string; branchId: string; intervals: Interval[] },
) {
  assertCatalog(ctx);
  await loadBranch(ctx, input.branchId);
  validateTemplate(input.intervals);
  await ctx.db.query("DELETE FROM schedule_templates WHERE staff_id = $1 AND branch_id = $2", [
    input.staffId,
    input.branchId,
  ]);
  for (const interval of input.intervals) {
    await ctx.db.query(
      `INSERT INTO schedule_templates (id, tenant_id, branch_id, staff_id, weekday, start_min, end_min, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        crypto.randomUUID(),
        ctx.actor.tenantId,
        input.branchId,
        input.staffId,
        interval.weekday,
        interval.startMin,
        interval.endMin,
        interval.kind,
      ],
    );
  }
  return getWeekTemplate(ctx, input.staffId, input.branchId);
}

export async function getWeekTemplate(ctx: Ctx, staffId: string, branchId: string) {
  assertRole(ctx, ["owner", "admin", "master", "super"]);
  const rows = await many<{ weekday: number; start_min: number; end_min: number; kind: "work" | "break" }>(
    ctx.db,
    `SELECT weekday, start_min, end_min, kind FROM schedule_templates
     WHERE staff_id = $1 AND branch_id = $2 ORDER BY weekday, start_min`,
    [staffId, branchId],
  );
  return rows.map((row) => ({
    weekday: Number(row.weekday),
    startMin: Number(row.start_min),
    endMin: Number(row.end_min),
    kind: row.kind,
  }));
}

export async function addException(
  ctx: Ctx,
  input: {
    staffId: string;
    branchId: string;
    startsOn: string;
    endsOn?: string;
    kind: "day_off" | "vacation" | "special_hours";
    startMin?: number;
    endMin?: number;
  },
) {
  assertCatalog(ctx);
  await loadBranch(ctx, input.branchId);
  const endsOn = input.endsOn ?? input.startsOn;
  if (input.kind === "special_hours") {
    if (input.startMin == null || input.endMin == null || input.endMin <= input.startMin) {
      throw new AppError("VALIDATION", "Укажите особые часы");
    }
    const existing = await many<{ start_min: number; end_min: number }>(
      ctx.db,
      `SELECT start_min, end_min FROM schedule_exceptions
       WHERE staff_id = $1 AND branch_id = $2 AND kind = 'special_hours' AND starts_on = $3::date`,
      [input.staffId, input.branchId, input.startsOn],
    );
    for (const row of existing) {
      if (input.startMin < Number(row.end_min) && Number(row.start_min) < input.endMin) {
        throw new AppError("VALIDATION", "Особые часы пересекаются");
      }
    }
  }
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO schedule_exceptions (id, tenant_id, branch_id, staff_id, starts_on, ends_on, kind, start_min, end_min)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9)`,
    [
      id,
      ctx.actor.tenantId,
      input.branchId,
      input.staffId,
      input.startsOn,
      endsOn,
      input.kind,
      input.startMin ?? null,
      input.endMin ?? null,
    ],
  );
  return { id };
}

export async function copyExceptionsToNextWeek(ctx: Ctx, staffId: string, branchId: string, date: string) {
  assertCatalog(ctx);
  const start = mondayOf(date);
  const end = addCalendarDays(start, 6);
  const nextStart = addCalendarDays(start, 7);
  const rows = await many<{
    starts_on: Date | string;
    ends_on: Date | string;
    kind: string;
    start_min: number | null;
    end_min: number | null;
  }>(
    ctx.db,
    `SELECT starts_on, ends_on, kind, start_min, end_min FROM schedule_exceptions
     WHERE staff_id = $1 AND branch_id = $2 AND starts_on >= $3::date AND starts_on <= $4::date`,
    [staffId, branchId, start, end],
  );
  await ctx.db.query(
    `DELETE FROM schedule_exceptions
     WHERE staff_id = $1 AND branch_id = $2 AND starts_on >= $3::date AND starts_on <= $4::date`,
    [staffId, branchId, nextStart, addCalendarDays(nextStart, 6)],
  );
  for (const row of rows) {
    const from = pgDate(row.starts_on);
    const to = pgDate(row.ends_on);
    await ctx.db.query(
      `INSERT INTO schedule_exceptions (id, tenant_id, branch_id, staff_id, starts_on, ends_on, kind, start_min, end_min)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9)`,
      [
        crypto.randomUUID(),
        ctx.actor.tenantId,
        branchId,
        staffId,
        addCalendarDays(from, 7),
        addCalendarDays(to, 7),
        row.kind,
        row.start_min,
        row.end_min,
      ],
    );
  }
  return { copied: rows.length };
}

function pgDate(value: Date | string): string {
  if (value instanceof Date) {
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${value.getUTCFullYear()}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}
