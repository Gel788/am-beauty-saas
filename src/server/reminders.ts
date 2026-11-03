import { AppError } from "@/domain/errors";
import { formatMoney } from "@/domain/money";
import { localMinutes } from "@/domain/time";
import { isAdminPlus, loadBranch } from "./access";
import { audit } from "./audit";
import { many, one, pool, withSession } from "./db";
import type { Actor, BranchRow, Ctx } from "./types";

/** The reminder job acts under this fixed id, like the online channel. */
export const JOBS_ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";

export type OutgoingMessage = { recipient: string; body: string };
export type Delivery = { ok: true } | { ok: false; error: string };

/**
 * A delivery channel. MSG-AUTO-01 order is Telegram → WhatsApp → SMS → push; each tenant lists
 * the ones it has connected in tenants.message_channels and the first that delivers wins.
 */
export type Channel = { name: string; deliver: (message: OutgoingMessage) => Promise<Delivery> };

/** Records the message instead of sending it, until a real channel is connected. */
const logChannel: Channel = { name: "log", deliver: async () => ({ ok: true }) };

const CHANNELS = new Map<string, Channel>([[logChannel.name, logChannel]]);

export function registerChannel(channel: Channel) {
  CHANNELS.set(channel.name, channel);
}

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

function reminderText(row: { starts_at: Date; title: string | null; staff_name: string; price_minor: number }, branch: BranchRow) {
  const when = new Intl.DateTimeFormat("ru-RU", {
    timeZone: branch.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(row.starts_at));
  const address = branch.address ? `, ${branch.address}` : "";
  return `Напоминаем о записи в ${branch.name}${address}: ${when}. ${row.title ?? "Визит"}, мастер ${row.staff_name}, ${formatMoney(Number(row.price_minor), branch.currency)}. Если планы изменились, предупредите нас, пожалуйста.`;
}

/** MSG-AUTO-01 for one tenant: every live appointment inside the reminder window, once. */
export async function sendDueReminders(ctx: Ctx) {
  const channelsRow = await one<{ message_channels: string[] }>(ctx.db, "SELECT message_channels FROM tenants WHERE id = $1", [
    ctx.actor.tenantId,
  ]);
  const channels = (channelsRow?.message_channels ?? ["log"]).map((name) => CHANNELS.get(name)).filter(Boolean) as Channel[];
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
    if (!due.length) continue;
    // Edge: never in quiet hours. The job runs again later and the appointments are still due.
    if (inQuietHours(ctx.now, branch)) {
      result.deferred += due.length;
      continue;
    }
    for (const row of due) {
      const body = reminderText(row, branch);
      let delivered: { channel: string; error: string | null } = { channel: channels[0]?.name ?? "none", error: "Нет подключённого канала" };
      if (!row.phone) delivered = { channel: delivered.channel, error: "У клиента нет телефона" };
      else {
        for (const channel of channels) {
          const outcome = await channel.deliver({ recipient: row.phone, body });
          if (outcome.ok) {
            delivered = { channel: channel.name, error: null };
            break;
          }
          delivered = { channel: channel.name, error: outcome.error };
        }
      }
      await ctx.db.query(
        `INSERT INTO outbound_messages (id, tenant_id, branch_id, appointment_id, client_id, kind, channel, recipient, body, status, error, created_at)
         VALUES ($1,$2,$3,$4,$5,'reminder',$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [
          crypto.randomUUID(),
          ctx.actor.tenantId,
          branch.id,
          row.id,
          row.client_id,
          delivered.channel,
          row.phone ?? "",
          body,
          delivered.error ? "failed" : "delivered",
          delivered.error,
          ctx.now.toISOString(),
        ],
      );
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
