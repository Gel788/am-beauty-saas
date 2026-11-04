import { AppError } from "@/domain/errors";
import { addCalendarDays, localDayUtcRange } from "@/domain/time";
import { loadBranch } from "./access";
import { audit } from "./audit";
import { many, one, poolOne } from "./db";
import { loadWorkingIntervals } from "./hours";
import { days, totals, workMinutes } from "./period";
import { assertTimezone, listBranches } from "./settings";
import type { Actor, BranchRow, Ctx } from "./types";

const NETWORK_ROLES = ["owner", "admin", "accountant", "super"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Settings a new branch takes over from the branch it is copied from. Identity, links and
// the kassa (INN, provider, receipts) stay with the original and are set up per branch.
const NOT_COPIED = new Set([
  "id", "tenant_id", "name", "address", "phone", "timezone", "slug", "created_at",
  "online_logo_url", "fiscal_enabled", "fiscal_provider", "fiscal_inn", "fiscal_place", "external_receipts",
  "acquiring_enabled", "acquiring_provider",
]);

function isOwner(actor: Actor) {
  return actor.role === "owner" || actor.role === "super";
}

// ------------------------------------------------------------------ NET-SWITCH-01

/** The branch the user last picked in the shell; falls back to the first one they can see. */
export async function currentBranchId(userId: string): Promise<string | null> {
  const row = await poolOne<{ current_branch_id: string | null }>(
    "SELECT current_branch_id FROM user_preferences WHERE user_id = $1",
    [userId],
  );
  return row?.current_branch_id ?? null;
}

/** Puts the current branch first, so every screen that reads branches[0] follows the switcher. */
export function orderByCurrent<T extends { id: string }>(branches: T[], current: string | null): T[] {
  const index = branches.findIndex((branch) => branch.id === current);
  if (index <= 0) return branches;
  return [branches[index], ...branches.slice(0, index), ...branches.slice(index + 1)];
}

export async function setCurrentBranch(ctx: Ctx, branchId: string) {
  await loadBranch(ctx, branchId);
  await ctx.db.query(
    `INSERT INTO user_preferences (user_id, current_branch_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET current_branch_id = EXCLUDED.current_branch_id, updated_at = now()`,
    [ctx.actor.userId, branchId],
  );
  return { branchId };
}

// ------------------------------------------------------------------ NET-BRANCH-01

export type NewBranch = {
  name?: unknown;
  address?: unknown;
  phone?: unknown;
  timezone?: unknown;
  slug?: unknown;
  copyFrom?: unknown;
  staffIds?: unknown;
};

/** Opens a branch. Settings come from `copyFrom` (or the first branch); chosen masters work there too. */
export async function createBranch(ctx: Ctx, input: NewBranch) {
  if (!isOwner(ctx.actor)) throw new AppError("FORBIDDEN", "Филиалы открывает владелец");
  const name = String(input.name ?? "").trim();
  if (!name) throw new AppError("VALIDATION", "Укажите название филиала");
  if (name.length > 80) throw new AppError("VALIDATION", "Название не длиннее 80 символов");
  const timezone = String(input.timezone ?? "Europe/Moscow").trim() || "Europe/Moscow";
  assertTimezone(timezone);
  const slug = String(input.slug ?? "").trim().toLowerCase() || null;

  const branches = await many<BranchRow>(ctx.db, "SELECT * FROM branches ORDER BY created_at, id");
  const source = typeof input.copyFrom === "string" && input.copyFrom
    ? branches.find((branch) => branch.id === input.copyFrom)
    : branches[0];
  if (input.copyFrom && !source) throw new AppError("NOT_FOUND", "Филиал для копирования не найден");

  const id = crypto.randomUUID();
  if (source) {
    const columns = (await many<{ column_name: string }>(
      ctx.db,
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'branches' ORDER BY ordinal_position",
    )).map((row) => row.column_name).filter((column) => !NOT_COPIED.has(column));
    const list = columns.map((column) => `"${column}"`).join(", ");
    await ctx.db.query(
      `INSERT INTO branches (id, tenant_id, name, address, phone, timezone, slug${list ? `, ${list}` : ""})
       SELECT $1, tenant_id, $2, $3, $4, $5, $6${list ? `, ${list}` : ""} FROM branches WHERE id = $7`,
      [id, name, String(input.address ?? "").trim(), String(input.phone ?? "").trim().slice(0, 32), timezone, slug, source.id],
    );
  } else {
    await ctx.db.query(
      "INSERT INTO branches (id, tenant_id, name, address, phone, timezone, slug) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, ctx.actor.tenantId, name, String(input.address ?? "").trim(), String(input.phone ?? "").trim().slice(0, 32), timezone, slug],
    );
  }

  const staffIds = Array.isArray(input.staffIds) ? input.staffIds.filter((value): value is string => typeof value === "string") : [];
  if (staffIds.length) {
    const known = await many<{ id: string }>(ctx.db, "SELECT id FROM staff WHERE id = ANY($1::uuid[])", [staffIds]);
    for (const member of known) {
      await ctx.db.query(
        "INSERT INTO staff_branches (staff_id, branch_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [member.id, id, ctx.actor.tenantId],
      );
    }
  }
  await audit(ctx, { branchId: id, entity: "branch", entityId: id, action: "branch.created", diff: { name, timezone, copyFrom: source?.id ?? null, staff: staffIds.length } });
  const created = (await listBranches(ctx)).find((branch) => branch.id === id);
  return created!;
}

// ------------------------------------------------------------------ NET-DASH-01

export type BranchStats = {
  branchId: string;
  name: string;
  address: string;
  currency: string;
  revenueMinor: number;
  revenueBeforeMinor: number;
  revenueChange: number | null;
  averageCheckMinor: number;
  appointments: number;
  completed: number;
  cancelled: number;
  noShow: number;
  noShowRate: number;
  online: number;
  clients: number;
  newClients: number;
  bookedMinutes: number;
  availableMinutes: number;
  loadPercent: number;
  staff: number;
  sharePercent: number;
};

async function availableMinutes(ctx: Ctx, branchId: string, from: string, to: string) {
  const staff = await many<{ id: string }>(
    ctx.db,
    "SELECT s.id FROM staff s JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $1 WHERE s.active",
    [branchId],
  );
  let total = 0;
  for (const member of staff) {
    for (const day of days(from, to)) {
      const hours = await loadWorkingIntervals(ctx.db, branchId, member.id, day);
      if (!hours.dayOff) total += workMinutes(hours.intervals);
    }
  }
  return { total, staff: staff.length };
}

/** Compares the branches the actor can see over one period, with the previous period of the same length. */
export async function networkSummary(ctx: Ctx, raw: { from?: unknown; to?: unknown }) {
  if (!NETWORK_ROLES.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const from = String(raw.from ?? "");
  const to = String(raw.to ?? "");
  if (!DATE.test(from) || !DATE.test(to)) throw new AppError("VALIDATION", "Период: даты в формате ГГГГ-ММ-ДД");
  if (to < from) throw new AppError("VALIDATION", "Конец периода раньше начала");
  const length = days(from, to).length;
  if (length > 92) throw new AppError("VALIDATION", "Сравнение филиалов — не длиннее квартала");
  const previous = { from: addCalendarDays(from, -length), to: addCalendarDays(from, -1) };

  const visible = await listBranches(ctx);
  const rows: BranchStats[] = [];
  for (const branch of visible) {
    const filter = { branchId: branch.id, from, to };
    const now = await totals(ctx, filter, branch.timezone);
    const was = await totals(ctx, { ...filter, ...previous }, branch.timezone);
    const capacity = await availableMinutes(ctx, branch.id, from, to);
    const attended = now.appointments - now.cancelled;
    rows.push({
      branchId: branch.id,
      name: branch.name,
      address: branch.address,
      currency: branch.currency,
      revenueMinor: now.revenueMinor,
      revenueBeforeMinor: was.revenueMinor,
      revenueChange: was.revenueMinor ? Math.round(((now.revenueMinor - was.revenueMinor) / Math.abs(was.revenueMinor)) * 100) : null,
      averageCheckMinor: now.averageCheckMinor,
      appointments: now.appointments,
      completed: now.completed,
      cancelled: now.cancelled,
      noShow: now.noShow,
      noShowRate: attended ? Math.round((1000 * now.noShow) / attended) / 10 : 0,
      online: now.online,
      clients: now.clients,
      newClients: now.newClients,
      bookedMinutes: now.bookedMinutes,
      availableMinutes: capacity.total,
      loadPercent: capacity.total ? Math.round((100 * now.bookedMinutes) / capacity.total) : 0,
      staff: capacity.staff,
      sharePercent: 0,
    });
  }
  const revenue = rows.reduce((sum, row) => sum + row.revenueMinor, 0);
  for (const row of rows) row.sharePercent = revenue > 0 ? Math.round((100 * Math.max(0, row.revenueMinor)) / revenue) : 0;

  const sum = (key: keyof BranchStats) => rows.reduce((acc, row) => acc + Number(row[key]), 0);
  const before = sum("revenueBeforeMinor");
  const attended = sum("appointments") - sum("cancelled");
  const available = sum("availableMinutes");
  // Clients are shared across the network, so the network count is distinct, not a sum.
  const start = localDayUtcRange(from, visible[0]?.timezone ?? "Europe/Moscow").start.toISOString();
  const end = localDayUtcRange(to, visible[0]?.timezone ?? "Europe/Moscow").end.toISOString();
  const distinct = await one<{ n: number }>(
    ctx.db,
    `SELECT count(DISTINCT client_id)::int AS n FROM appointments
     WHERE branch_id = ANY($1::uuid[]) AND starts_at >= $2 AND starts_at < $3 AND status <> 'cancelled'`,
    [rows.map((row) => row.branchId), start, end],
  );
  const shared = await one<{ n: number }>(
    ctx.db,
    `SELECT count(*)::int AS n FROM (
       SELECT client_id FROM appointments
       WHERE branch_id = ANY($1::uuid[]) AND starts_at >= $2 AND starts_at < $3 AND status <> 'cancelled' AND client_id IS NOT NULL
       GROUP BY client_id HAVING count(DISTINCT branch_id) > 1
     ) x`,
    [rows.map((row) => row.branchId), start, end],
  );
  const currencies = [...new Set(rows.map((row) => row.currency))];
  return {
    from,
    to,
    previous,
    currency: currencies.length === 1 ? currencies[0] : null,
    branches: rows,
    total: {
      revenueMinor: revenue,
      revenueBeforeMinor: before,
      revenueChange: before ? Math.round(((revenue - before) / Math.abs(before)) * 100) : null,
      appointments: sum("appointments"),
      completed: sum("completed"),
      noShow: sum("noShow"),
      noShowRate: attended ? Math.round((1000 * sum("noShow")) / attended) / 10 : 0,
      online: sum("online"),
      clients: Number(distinct?.n ?? 0),
      clientsInSeveralBranches: Number(shared?.n ?? 0),
      newClients: sum("newClients"),
      loadPercent: available ? Math.round((100 * sum("bookedMinutes")) / available) : 0,
      averageCheckMinor: (() => {
        const paid = rows.filter((row) => row.averageCheckMinor > 0);
        const visits = paid.reduce((acc, row) => acc + row.completed, 0);
        return visits ? Math.round(paid.reduce((acc, row) => acc + row.averageCheckMinor * row.completed, 0) / visits) : 0;
      })(),
    },
  };
}
