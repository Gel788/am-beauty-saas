import { AppError } from "@/domain/errors";
import { formatLocalTime, localDayUtcRange } from "@/domain/time";
import { loadBranch } from "./access";
import { many } from "./db";
import { loadWorkingIntervals } from "./hours";
import { LIVE_PAYMENT } from "./payments";
import type { Ctx } from "./types";

const REPORT_ROLES = ["owner", "admin", "accountant", "super"];

/** Minutes of work in a day: work intervals minus the breaks inside them. */
function workMinutes(intervals: { startMin: number; endMin: number; kind: "work" | "break" }[]) {
  const work = intervals.filter((item) => item.kind === "work").reduce((sum, item) => sum + (item.endMin - item.startMin), 0);
  const breaks = intervals.filter((item) => item.kind === "break").reduce((sum, item) => sum + (item.endMin - item.startMin), 0);
  return Math.max(0, work - breaks);
}

/** AN-DAY-01: money actually posted that local day, appointment outcomes and master load. */
export async function dayReport(ctx: Ctx, branchId: string, date: string) {
  if (!REPORT_ROLES.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("VALIDATION", "Дата в формате ГГГГ-ММ-ДД");
  const branch = await loadBranch(ctx, branchId);
  const range = localDayUtcRange(date, branch.timezone);
  const from = range.start.toISOString();
  const to = range.end.toISOString();

  // Revenue is posted money (incoming minus refunds), never the price list.
  const lines = await many<{ line_type: string; net: number; refunds: number }>(
    ctx.db,
    `SELECT pl.line_type,
            COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::int AS net,
            COALESCE(SUM(pl.amount_minor) FILTER (WHERE p.direction = 'out'), 0)::int AS refunds
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.branch_id = $1 AND ${LIVE_PAYMENT} AND p.posted_at >= $2 AND p.posted_at < $3
     GROUP BY pl.line_type`,
    [branchId, from, to],
  );
  const byType = (types: string[]) => lines.filter((row) => types.includes(row.line_type)).reduce((sum, row) => sum + Number(row.net), 0);
  const tenders = await many<{ method: string; net: number }>(
    ctx.db,
    `SELECT t.method,
            COALESCE(SUM(CASE WHEN p.direction = 'in' THEN t.amount_minor ELSE -t.amount_minor END), 0)::int AS net
     FROM payment_tenders t JOIN payments p ON p.id = t.payment_id
     WHERE p.branch_id = $1 AND ${LIVE_PAYMENT} AND p.posted_at >= $2 AND p.posted_at < $3
     GROUP BY t.method ORDER BY t.method`,
    [branchId, from, to],
  );

  const payments = await many<{
    id: string;
    posted_at: Date;
    direction: string;
    status: string;
    total_minor: number;
    client_name: string | null;
    appointment_id: string | null;
  }>(
    ctx.db,
    `SELECT p.id, p.posted_at, p.direction, p.status, p.total_minor, c.name AS client_name, p.appointment_id
     FROM payments p LEFT JOIN clients c ON c.id = p.client_id
     WHERE p.branch_id = $1 AND p.status <> 'pending' AND p.posted_at >= $2 AND p.posted_at < $3
     ORDER BY p.posted_at`,
    [branchId, from, to],
  );

  const appointments = await many<{
    id: string;
    staff_id: string;
    starts_at: Date;
    ends_at: Date;
    status: string;
    source: string;
    client_name: string | null;
    staff_name: string;
    title: string | null;
    price_minor: number;
  }>(
    ctx.db,
    `SELECT a.id, a.staff_id, a.starts_at, a.ends_at, a.status, a.source, c.name AS client_name, s.display_name AS staff_name,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title,
            (SELECT COALESCE(SUM(price_minor), 0)::int FROM appointment_services WHERE appointment_id = a.id) AS price_minor
     FROM appointments a
     JOIN staff s ON s.id = a.staff_id
     LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.branch_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3
     ORDER BY a.starts_at, s.display_name`,
    [branchId, from, to],
  );
  const created = await many<{ source: string; n: number }>(
    ctx.db,
    `SELECT source, COUNT(*)::int AS n FROM appointments
     WHERE branch_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY source`,
    [branchId, from, to],
  );
  const count = (status: string) => appointments.filter((row) => row.status === status).length;

  const staff = await many<{ id: string; display_name: string; color: string }>(
    ctx.db,
    `SELECT s.id, s.display_name, s.color FROM staff s
     JOIN staff_branches sb ON sb.staff_id = s.id AND sb.branch_id = $1
     WHERE s.active OR EXISTS (SELECT 1 FROM appointments a WHERE a.staff_id = s.id AND a.branch_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3)
     ORDER BY s.display_name, s.id`,
    [branchId, from, to],
  );
  const load = [];
  for (const member of staff) {
    const day = await loadWorkingIntervals(ctx.db, branchId, member.id, date);
    const available = day.dayOff ? 0 : workMinutes(day.intervals);
    const occupied = appointments
      .filter((row) => row.staff_id === member.id && row.status !== "cancelled")
      .reduce((sum, row) => sum + Math.round((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 60000), 0);
    if (!available && !occupied) continue;
    load.push({
      staffId: member.id,
      name: member.display_name,
      color: member.color,
      availableMin: available,
      occupiedMin: occupied,
      loadPercent: available ? Math.round((100 * occupied) / available) : null,
    });
  }
  const totalAvailable = load.reduce((sum, row) => sum + row.availableMin, 0);
  const totalOccupied = load.reduce((sum, row) => sum + row.occupiedMin, 0);

  return {
    date,
    branchName: branch.name,
    currency: branch.currency,
    revenue: {
      totalMinor: lines.reduce((sum, row) => sum + Number(row.net), 0),
      servicesMinor: byType(["service", "deposit"]),
      productsMinor: byType(["product"]),
      tipsMinor: byType(["tip"]),
      debtRepaidMinor: byType(["debt"]),
      otherMinor: byType(["loyalty"]),
      refundsMinor: lines.reduce((sum, row) => sum + Number(row.refunds), 0),
      byMethod: tenders.map((row) => ({ method: row.method, netMinor: Number(row.net) })),
      // LOY: points, certificates and memberships are prepaid or promotional, not money that came in today.
      paidByLoyaltyMinor: tenders
        .filter((row) => ["bonus", "certificate", "membership"].includes(row.method))
        .reduce((sum, row) => sum + Number(row.net), 0),
    },
    appointments: {
      total: appointments.length,
      createdToday: created.reduce((sum, row) => sum + Number(row.n), 0),
      createdOnline: Number(created.find((row) => row.source === "online")?.n ?? 0),
      completed: count("completed"),
      cancelled: count("cancelled"),
      noShow: count("no_show"),
      open: appointments.filter((row) => ["scheduled", "confirmed", "arrived", "in_progress"].includes(row.status)).length,
      online: appointments.filter((row) => row.source === "online").length,
    },
    load: {
      availableMin: totalAvailable,
      occupiedMin: totalOccupied,
      loadPercent: totalAvailable ? Math.round((100 * totalOccupied) / totalAvailable) : null,
      staff: load,
    },
    payments: payments.map((row) => ({
      id: row.id,
      time: formatLocalTime(new Date(row.posted_at), branch.timezone),
      direction: row.direction,
      status: row.status,
      totalMinor: Number(row.total_minor),
      clientName: row.client_name,
      appointmentId: row.appointment_id,
    })),
    appointmentList: appointments.map((row) => ({
      id: row.id,
      time: formatLocalTime(new Date(row.starts_at), branch.timezone),
      staffName: row.staff_name,
      clientName: row.client_name,
      title: row.title ?? "",
      status: row.status,
      source: row.source,
      priceMinor: Number(row.price_minor),
    })),
  };
}
