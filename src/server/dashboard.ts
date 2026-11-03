import { localDayUtcRange, todayInZone, addCalendarDays } from "@/domain/time";
import { loadBranch } from "./access";
import { many, one } from "./db";
import { getJournal } from "./appointments";
import type { Ctx } from "./types";

export async function dashboard(ctx: Ctx, branchId: string) {
  const branch = await loadBranch(ctx, branchId);
  const today = todayInZone(branch.timezone, ctx.now);
  const monthStart = `${today.slice(0, 8)}01`;
  const range = localDayUtcRange(monthStart, branch.timezone);
  const nextMonth = addCalendarDays(monthStart, 32).slice(0, 8) + "01";
  const monthEnd = localDayUtcRange(nextMonth, branch.timezone).start;
  const revenue = await one<{ s: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(pl.amount_minor), 0)::int AS s
     FROM payment_lines pl
     JOIN payments p ON p.id = pl.payment_id
     WHERE p.branch_id = $1 AND p.status = 'posted' AND p.direction = 'in'
       AND pl.line_type IN ('service', 'deposit')
       AND p.posted_at >= $2 AND p.posted_at < $3`,
    [branchId, range.start.toISOString(), monthEnd.toISOString()],
  );
  const series = await many<{ day: string; total: number }>(
    ctx.db,
    `SELECT to_char((p.posted_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(pl.amount_minor), 0)::int AS total
     FROM payments p
     JOIN payment_lines pl ON pl.payment_id = p.id
     WHERE p.branch_id = $1 AND p.status = 'posted' AND p.direction = 'in'
       AND pl.line_type IN ('service', 'deposit')
       AND p.posted_at >= $2 AND p.posted_at < $3
     GROUP BY 1 ORDER BY 1`,
    [branchId, range.start.toISOString(), monthEnd.toISOString(), branch.timezone],
  );
  const top = await many<{ title: string; total: number; visits: number }>(
    ctx.db,
    `SELECT s.title_snapshot AS title, COALESCE(SUM(s.price_minor), 0)::int AS total, COUNT(*)::int AS visits
     FROM appointment_services s
     JOIN appointments a ON a.id = s.appointment_id
     WHERE a.branch_id = $1 AND a.status <> 'cancelled' AND a.starts_at >= $2 AND a.starts_at < $3
     GROUP BY s.title_snapshot
     ORDER BY total DESC
     LIMIT 5`,
    [branchId, range.start.toISOString(), monthEnd.toISOString()],
  );
  let journal = null;
  if (ctx.actor.role !== "accountant" && ctx.actor.role !== "client") {
    journal = await getJournal(ctx, { branchId, date: today });
  }
  const todayPaid = await one<{ s: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(pl.amount_minor), 0)::int AS s
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.branch_id = $1 AND p.status = 'posted' AND p.direction = 'in'
       AND pl.line_type IN ('service', 'deposit')
       AND p.posted_at >= $2 AND p.posted_at < $3`,
    [branchId, localDayUtcRange(today, branch.timezone).start.toISOString(), localDayUtcRange(today, branch.timezone).end.toISOString()],
  );
  return {
    today,
    branchName: branch.name,
    monthRevenueMinor: Number(revenue?.s ?? 0),
    todayPaidMinor: Number(todayPaid?.s ?? 0),
    series: series.map((row) => ({ day: row.day, totalMinor: Number(row.total) })),
    topServices: top.map((row) => ({ title: row.title, totalMinor: Number(row.total), visits: Number(row.visits) })),
    journal: journal
      ? {
          expectedRevenueMinor: journal.stats.expectedRevenueMinor,
          appointmentCount: journal.stats.appointmentCount,
          loadPercent: journal.stats.loadPercent,
          newClients: journal.stats.newClients,
          staff: journal.staff.map((staff) => ({ id: staff.id, name: staff.name, color: staff.color, loadPercent: staff.loadPercent })),
        }
      : null,
  };
}
