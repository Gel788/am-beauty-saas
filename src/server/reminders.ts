import { AppError } from "@/domain/errors";
import { localMinutes } from "@/domain/time";
import { isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { many, pool, withSession } from "./db";
import { createHash, randomBytes } from "node:crypto";
import { appointmentValues, deliverToClient, publicUrl, render, templateBody } from "./messaging";
import { sendGroupReminders } from "./groups";
import type { Actor, BranchRow, Ctx } from "./types";

/** The reminder job acts under this fixed id, like the online channel. */
export const JOBS_ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";

export { registerChannel, type Channel, type Delivery, type OutgoingMessage } from "./messaging";

function jobsActor(tenantId: string): Actor {
  return { userId: JOBS_ACTOR_ID, tenantId, role: "client", branchId: null, staffId: null, name: "Напоминания", email: "" };
}

/** Quiet hours wrap midnight by default (22:00–09:00 local). */
export function inQuietHours(now: Date, branch: Pick<BranchRow, "timezone" | "quiet_start_min" | "quiet_end_min">) {
  const minute = localMinutes(now, branch.timezone);
  const start = Number(branch.quiet_start_min);
  const end = Number(branch.quiet_end_min);
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** A manage link of its own, so the online-booking link keeps working. */
export async function manageLink(ctx: Ctx, appointmentId: string) {
  const token = randomBytes(32).toString("hex");
  await ctx.db.query("UPDATE appointments SET reminder_token_hash = $2 WHERE id = $1", [appointmentId, createHash("sha256").update(token).digest("hex")]);
  return `${publicUrl()}/booking/${token}`;
}

/** MSG-AUTO-01 for one tenant: every live appointment inside the reminder window, once. */
export async function sendDueReminders(ctx: Ctx) {
  const template = await templateBody(ctx, "reminder");
  const branches = await many<BranchRow>(ctx.db, "SELECT * FROM branches WHERE reminder_enabled ORDER BY created_at");
  const result = { sent: 0, failed: 0, deferred: 0 };
  for (const branch of branches) {
    const due = await many<{
      id: string;
      client_id: string;
      starts_at: Date;
      staff_name: string;
      phone: string | null;
      title: string | null;
      price_minor: number;
    }>(
      ctx.db,
      `SELECT a.id, a.client_id, a.starts_at, s.display_name AS staff_name,
              (SELECT phone_e164 FROM client_phones p WHERE p.client_id = a.client_id AND p.deleted_at IS NULL ORDER BY p.is_primary DESC LIMIT 1) AS phone,
              (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title,
              (SELECT COALESCE(SUM(price_minor), 0)::int FROM appointment_services WHERE appointment_id = a.id) AS price_minor
       FROM appointments a
       JOIN staff s ON s.id = a.staff_id
       WHERE a.branch_id = $1 AND a.status IN ('scheduled', 'confirmed') AND a.client_id IS NOT NULL
         AND a.starts_at > $2 AND a.starts_at <= $2::timestamptz + make_interval(hours => $3)
         AND NOT EXISTS (SELECT 1 FROM outbound_messages m WHERE m.appointment_id = a.id AND m.kind = 'reminder')
       ORDER BY a.starts_at
       FOR UPDATE OF a SKIP LOCKED`,
      [branch.id, ctx.now.toISOString(), Number(branch.reminder_hours)],
    );
    // GRP-REMIND-01: group events go out in the same window and also wait out quiet hours.
    if (!inQuietHours(ctx.now, branch)) {
      const groups = await sendGroupReminders(ctx, branch);
      result.sent += groups.sent;
      result.failed += groups.failed;
    }
    if (!due.length) continue;
    // Edge: never in quiet hours. The job runs again later and the appointments are still due.
    if (inQuietHours(ctx.now, branch)) {
      result.deferred += due.length;
      continue;
    }
    for (const row of due) {
      const link = await manageLink(ctx, row.id);
      const { values } = await appointmentValues(ctx, row.id, { ссылка: link });
      const sent = await deliverToClient(ctx, {
        clientId: row.client_id,
        branchId: branch.id,
        appointmentId: row.id,
        kind: "reminder",
        body: render(template, values),
        buttons: [
          { text: "Подтверждаю", data: `c:${row.id}` },
          { text: "Отменить", data: `x:${row.id}` },
        ],
        once: true,
      });
      if (!sent) continue;
      const delivered = { channel: sent.channel, error: sent.error };
      await audit(ctx, {
        branchId: branch.id,
        entity: "appointment",
        entityId: row.id,
        action: delivered.error ? "reminder.failed" : "reminder.sent",
        diff: { channel: delivered.channel, error: delivered.error },
      });
      if (delivered.error) result.failed += 1;
      else result.sent += 1;
    }
  }
  return result;
}

/** Entry point for cron: walks every tenant that has reminders on, each in its own transaction. */
export async function runReminderJob(now = new Date()) {
  const tenants = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM reminder_tenants()");
  const total = { tenants: 0, sent: 0, failed: 0, deferred: 0 };
  for (const { tenant_id: tenantId } of tenants.rows) {
    const result = await withSession({ tenantId, userId: JOBS_ACTOR_ID }, (db) =>
      sendDueReminders({ db, actor: jobsActor(tenantId), now }),
    );
    total.tenants += 1;
    total.sent += result.sent;
    total.failed += result.failed;
    total.deferred += result.deferred;
  }
  return total;
}

/** Admin view of what went out (MSG log). */
export async function listMessages(ctx: Ctx, branchId: string, limit = 50) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  await loadBranch(ctx, branchId);
  const rows = await many<{
    id: string;
    appointment_id: string | null;
    channel: string;
    recipient: string;
    body: string;
    status: string;
    error: string | null;
    created_at: Date;
    client_name: string | null;
  }>(
    ctx.db,
    `SELECT m.id, m.appointment_id, m.channel, m.recipient, m.body, m.status, m.error, m.created_at, c.name AS client_name
     FROM outbound_messages m LEFT JOIN clients c ON c.id = m.client_id
     WHERE m.branch_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
    [branchId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    id: row.id,
    appointmentId: row.appointment_id,
    channel: row.channel,
    recipient: row.recipient,
    body: row.body,
    status: row.status,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    clientName: row.client_name,
  }));
}
