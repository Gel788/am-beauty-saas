import { AppError } from "@/domain/errors";
import { validateTemplate, type Interval } from "@/domain/schedule";
import { isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { addException, getWeekTemplate, saveWeekTemplate } from "./catalog";
import { many, one } from "./db";
import type { Ctx } from "./types";
import { notifyDesk } from "./messaging";

// SCH-*: exceptions list, removal, and the master's change requests (03-services-staff §3–4).

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ["day_off", "vacation", "special_hours"] as const;
type ExceptionKind = (typeof KINDS)[number];
type ExceptionInput = { startsOn: string; endsOn?: string; kind: ExceptionKind; startMin?: number; endMin?: number; note?: string };

const dateText = (value: string | Date) => {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
};

/** Admins see everyone's schedule; a master sees only their own. */
export function assertScheduleRead(ctx: Ctx, staffId: string) {
  if (isAdminPlus(ctx.actor)) return;
  if (ctx.actor.role === "master" && ctx.actor.staffId === staffId) return;
  throw new AppError("FORBIDDEN", "Недостаточно прав");
}

export async function readWeekTemplate(ctx: Ctx, staffId: string, branchId: string) {
  assertScheduleRead(ctx, staffId);
  return getWeekTemplate(ctx, staffId, branchId);
}

export function validateException(input: ExceptionInput) {
  if (!KINDS.includes(input.kind)) throw new AppError("VALIDATION", "Тип: выходной, отпуск или особые часы");
  if (!DATE.test(input.startsOn ?? "")) throw new AppError("VALIDATION", "Укажите дату");
  const endsOn = input.endsOn || input.startsOn;
  if (!DATE.test(endsOn) || endsOn < input.startsOn) throw new AppError("VALIDATION", "Дата окончания раньше начала");
  if (input.kind === "special_hours" && endsOn !== input.startsOn) throw new AppError("VALIDATION", "Особые часы задаются на один день");
  if (input.kind === "special_hours") {
    const start = Number(input.startMin);
    const end = Number(input.endMin);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start) throw new AppError("VALIDATION", "Укажите особые часы");
    if (start % 5 || end % 5) throw new AppError("VALIDATION", "Интервал кратен 5 минутам");
  }
  const days = Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${input.startsOn}T00:00:00Z`)) / 86400000) + 1;
  if (days > 366) throw new AppError("VALIDATION", "Не больше года за раз");
  return { ...input, endsOn };
}

export async function listExceptions(ctx: Ctx, staffId: string, branchId: string, from: string) {
  assertScheduleRead(ctx, staffId);
  if (!DATE.test(from)) throw new AppError("VALIDATION", "Укажите дату");
  const rows = await many<{ id: string; starts_on: Date; ends_on: Date; kind: ExceptionKind; start_min: number | null; end_min: number | null; note: string }>(
    ctx.db,
    `SELECT id, starts_on, ends_on, kind, start_min, end_min, note FROM schedule_exceptions
     WHERE staff_id = $1 AND branch_id = $2 AND ends_on >= $3::date ORDER BY starts_on LIMIT 200`,
    [staffId, branchId, from],
  );
  return rows.map((row) => ({
    id: row.id,
    startsOn: dateText(row.starts_on),
    endsOn: dateText(row.ends_on),
    kind: row.kind,
    startMin: row.start_min === null ? null : Number(row.start_min),
    endMin: row.end_min === null ? null : Number(row.end_min),
    note: row.note,
  }));
}

/** Future visits that a new exception would leave outside working hours: a soft warning, never a block. */
async function affectedVisits(ctx: Ctx, staffId: string, branchId: string, input: ReturnType<typeof validateException>) {
  const branch = await loadBranch(ctx, branchId);
  const rows = await many<{ id: string; local_date: string; start_min: number; end_min: number }>(
    ctx.db,
    `SELECT id,
            to_char(starts_at AT TIME ZONE $4, 'YYYY-MM-DD') AS local_date,
            (EXTRACT(HOUR FROM starts_at AT TIME ZONE $4) * 60 + EXTRACT(MINUTE FROM starts_at AT TIME ZONE $4))::int AS start_min,
            (EXTRACT(HOUR FROM ends_at AT TIME ZONE $4) * 60 + EXTRACT(MINUTE FROM ends_at AT TIME ZONE $4))::int AS end_min
     FROM appointments
     WHERE staff_id = $1 AND branch_id = $2 AND status NOT IN ('cancelled', 'no_show', 'completed')
       AND (starts_at AT TIME ZONE $4)::date BETWEEN $3::date AND $5::date`,
    [staffId, branchId, input.startsOn, branch.timezone, input.endsOn],
  );
  if (input.kind !== "special_hours") return rows.length;
  return rows.filter((row) => row.start_min < Number(input.startMin) || row.end_min > Number(input.endMin)).length;
}

export async function createException(ctx: Ctx, staffId: string, branchId: string, raw: ExceptionInput, acknowledgeSoft = false) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const input = validateException(raw);
  const affected = await affectedVisits(ctx, staffId, branchId, input);
  if (affected && !acknowledgeSoft) {
    throw new AppError("SOFT_CONFIRM", `На эти дни у мастера ${affected} ${plural(affected)}. Записи останутся, перенесите их в журнале`, {
      warnings: ["VISITS_OUTSIDE_HOURS"],
      affected,
    });
  }
  const { id } = await addException(ctx, { staffId, branchId, ...input });
  if (input.note?.trim()) await ctx.db.query("UPDATE schedule_exceptions SET note = $2 WHERE id = $1", [id, input.note.trim()]);
  await audit(ctx, { branchId, entity: "staff", entityId: staffId, action: "schedule.exception_added", diff: { ...input, affected } });
  return { id, affected };
}

export async function deleteException(ctx: Ctx, id: string) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const row = await one<{ staff_id: string; branch_id: string; kind: string; starts_on: Date; ends_on: Date }>(
    ctx.db,
    "SELECT staff_id, branch_id, kind, starts_on, ends_on FROM schedule_exceptions WHERE id = $1",
    [id],
  );
  if (!row) throw new AppError("NOT_FOUND", "Исключение не найдено");
  await ctx.db.query("DELETE FROM schedule_exceptions WHERE id = $1", [id]);
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "staff",
    entityId: row.staff_id,
    action: "schedule.exception_removed",
    diff: { kind: row.kind, startsOn: dateText(row.starts_on), endsOn: dateText(row.ends_on) },
  });
  return { ok: true };
}

const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "запись" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "записи" : "записей");

// ---------- Change requests from a master ----------

type RequestRow = {
  id: string;
  branch_id: string;
  staff_id: string;
  staff_name: string;
  kind: "template" | "exception";
  payload: { intervals?: Interval[] } & Partial<ExceptionInput>;
  comment: string;
  status: string;
  decision_note: string | null;
  decided_at: Date | null;
  created_at: Date;
};

function presentRequest(row: RequestRow) {
  return {
    id: row.id,
    branchId: row.branch_id,
    staffId: row.staff_id,
    staffName: row.staff_name,
    kind: row.kind,
    payload: row.payload,
    comment: row.comment,
    status: row.status,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function createScheduleRequest(
  ctx: Ctx,
  input: { branchId: string; kind: "template" | "exception"; intervals?: Interval[]; exception?: ExceptionInput; comment?: string },
) {
  if (ctx.actor.role !== "master" || !ctx.actor.staffId) throw new AppError("FORBIDDEN", "Запрос на смену графика отправляет мастер");
  const staffId = ctx.actor.staffId;
  const linked = await one(ctx.db, "SELECT 1 FROM staff_branches WHERE staff_id = $1 AND branch_id = $2", [staffId, input.branchId]);
  if (!linked) throw new AppError("VALIDATION", "Вы не работаете в этом филиале");
  let payload: Record<string, unknown>;
  if (input.kind === "template") {
    const intervals = input.intervals ?? [];
    validateTemplate(intervals);
    payload = { intervals };
  } else if (input.kind === "exception") {
    payload = validateException(input.exception as ExceptionInput);
  } else throw new AppError("VALIDATION", "Что меняем: неделю или день");
  const comment = input.comment?.trim() ?? "";
  if (input.kind === "exception" && !comment) throw new AppError("VALIDATION", "Напишите причину");
  const open = await one<{ n: number }>(
    ctx.db,
    "SELECT COUNT(*)::int AS n FROM schedule_requests WHERE staff_id = $1 AND status = 'pending'",
    [staffId],
  );
  if (Number(open?.n ?? 0) >= 5) throw new AppError("VALIDATION", "Уже 5 запросов ждут решения");
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO schedule_requests (id, tenant_id, branch_id, staff_id, kind, payload, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [id, ctx.actor.tenantId, input.branchId, staffId, input.kind, JSON.stringify(payload), comment, ctx.actor.userId],
  );
  await audit(ctx, { branchId: input.branchId, entity: "staff", entityId: staffId, action: "schedule.request_created", diff: { kind: input.kind, comment } });
  const staff = await one<{ display_name: string }>(ctx.db, "SELECT display_name FROM staff WHERE id = $1", [staffId]);
  await notifyDesk(ctx, {
    branchId: input.branchId,
    kind: "schedule.request",
    title: `Запрос по графику: ${staff?.display_name ?? "мастер"}`,
    body: comment || "Откройте «График» и примите решение.",
    entity: "schedule_request",
    entityId: id,
  });
  return requestById(ctx, id);
}

async function requestById(ctx: Ctx, id: string) {
  const row = await one<RequestRow>(
    ctx.db,
    "SELECT r.*, s.display_name AS staff_name FROM schedule_requests r JOIN staff s ON s.id = r.staff_id WHERE r.id = $1",
    [id],
  );
  if (!row) throw new AppError("NOT_FOUND", "Запрос не найден");
  return presentRequest(row);
}

export async function listScheduleRequests(ctx: Ctx, branchId: string, filter: { status?: string } = {}) {
  const master = ctx.actor.role === "master";
  if (!master && !isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const rows = await many<RequestRow>(
    ctx.db,
    `SELECT r.*, s.display_name AS staff_name FROM schedule_requests r JOIN staff s ON s.id = r.staff_id
     WHERE r.branch_id = $1 AND ($2::uuid IS NULL OR r.staff_id = $2) AND ($3::text IS NULL OR r.status = $3)
     ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 100`,
    [branchId, master ? (ctx.actor.staffId ?? "00000000-0000-0000-0000-000000000000") : null, filter.status ?? null],
  );
  return rows.map(presentRequest);
}

export async function decideScheduleRequest(ctx: Ctx, id: string, input: { approve: boolean; note?: string; acknowledgeSoft?: boolean }) {
  const row = await one<RequestRow>(ctx.db, "SELECT r.*, '' AS staff_name FROM schedule_requests r WHERE r.id = $1 FOR UPDATE", [id]);
  if (!row) throw new AppError("NOT_FOUND", "Запрос не найден");
  const own = ctx.actor.role === "master" && ctx.actor.staffId === row.staff_id;
  if (row.status !== "pending") throw new AppError("VALIDATION", "Запрос уже решён");
  if (own && !input.approve) {
    // The master can take back their own request.
    await ctx.db.query("UPDATE schedule_requests SET status = 'withdrawn', decided_by = $2, decided_at = now() WHERE id = $1", [id, ctx.actor.userId]);
    return requestById(ctx, id);
  }
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Решение принимает администратор");
  const note = input.note?.trim() ?? "";
  if (!input.approve && !note) throw new AppError("VALIDATION", "Напишите мастеру, почему отказ");
  if (input.approve) {
    if (row.kind === "template") {
      await saveWeekTemplate(ctx, { staffId: row.staff_id, branchId: row.branch_id, intervals: row.payload.intervals ?? [] });
    } else {
      await createException(ctx, row.staff_id, row.branch_id, row.payload as ExceptionInput, input.acknowledgeSoft);
    }
  }
  await ctx.db.query(
    "UPDATE schedule_requests SET status = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE id = $1",
    [id, input.approve ? "approved" : "rejected", note || null, ctx.actor.userId],
  );
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "staff",
    entityId: row.staff_id,
    action: input.approve ? "schedule.request_approved" : "schedule.request_rejected",
    diff: { requestId: id, note },
  });
  return requestById(ctx, id);
}
