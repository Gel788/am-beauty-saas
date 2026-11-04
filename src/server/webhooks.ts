import { createHmac, randomBytes } from "node:crypto";
import { AppError } from "@/domain/errors";
import { many, one, pool, withSession } from "./db";
import { decryptSecrets, encryptSecrets } from "./secrets";
import type { Ctx } from "./types";

/** API-HOOK-01: events a salon can subscribe to, and the audit actions behind them. */
export const WEBHOOK_EVENTS: { event: string; label: string; actions: string[] }[] = [
  { event: "appointment.created", label: "Новая запись", actions: ["appointment.created", "appointment.online_booked", "appointment.rebooked"] },
  { event: "appointment.updated", label: "Запись изменена или перенесена", actions: ["appointment.updated", "appointment.moved", "appointment.resized", "appointment.confirmed", "appointment.restored", "appointment.status", "appointment.completed", "appointment.no_show"] },
  { event: "appointment.cancelled", label: "Запись отменена", actions: ["appointment.cancelled"] },
  { event: "client.created", label: "Новый клиент", actions: ["client.created"] },
  { event: "client.updated", label: "Клиент изменён", actions: ["client.updated"] },
  { event: "payment.posted", label: "Оплата", actions: ["payment.posted"] },
  { event: "payment.refunded", label: "Возврат", actions: ["payment.refunded"] },
];
const BY_ACTION = new Map(WEBHOOK_EVENTS.flatMap((item) => item.actions.map((action) => [action, item.event] as const)));
const RETRY_MIN = [1, 5, 30, 120, 360];

/** Called from audit(): queues a delivery in the same transaction, so a rolled back change sends nothing. */
export async function enqueueWebhooks(ctx: Ctx, entry: { action: string; entity: string; entityId: string; branchId?: string | null }) {
  const event = BY_ACTION.get(entry.action);
  if (!event) return;
  const hooks = await many<{ id: string }>(ctx.db, "SELECT id FROM api_webhooks WHERE active AND $1 = ANY(events)", [event]);
  for (const hook of hooks) {
    const id = crypto.randomUUID();
    // Only ids: the receiver reads the details through the API with its key, so no personal data sits in the queue.
    const payload = { id, event, occurredAt: ctx.now.toISOString(), data: { [`${entry.entity}Id`]: entry.entityId, branchId: entry.branchId ?? null, action: entry.action } };
    await ctx.db.query(
      "INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [id, ctx.actor.tenantId, hook.id, event, JSON.stringify(payload)],
    );
  }
}

function assertOwner(ctx: Ctx) {
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Вебхуки настраивает владелец");
}

/** A salon's integrations live on the internet; addresses inside our own network are refused. */
export function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("VALIDATION", "Адрес вебхука — ссылка вида https://…");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new AppError("VALIDATION", "Адрес вебхука — ссылка вида https://…");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "[::1]" || /^\[(fc|fd|fe80)/.test(host)) {
    throw new AppError("VALIDATION", "Адрес во внутренней сети не подходит: нужен адрес, доступный из интернета");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new AppError("VALIDATION", "Нужен адрес с https://");
  return url.toString();
}

type HookRow = { id: string; url: string; events: string[]; active: boolean; created_at: Date; last_status: number | null; last_error: string | null; last_delivery_at: Date | null; failures: number };
const present = (row: HookRow) => ({ id: row.id, url: row.url, events: row.events, active: row.active, createdAt: row.created_at, lastStatus: row.last_status, lastError: row.last_error, lastDeliveryAt: row.last_delivery_at, failures: Number(row.failures) });

export async function listWebhooks(ctx: Ctx) {
  assertOwner(ctx);
  const rows = await many<HookRow>(ctx.db, "SELECT * FROM api_webhooks ORDER BY created_at");
  return { events: WEBHOOK_EVENTS.map(({ event, label }) => ({ event, label })), webhooks: rows.map(present) };
}

export async function createWebhook(ctx: Ctx, input: { url?: unknown; events?: unknown }) {
  assertOwner(ctx);
  const url = assertPublicUrl(String(input.url ?? "").trim());
  const known = new Set(WEBHOOK_EVENTS.map((item) => item.event));
  const events = Array.isArray(input.events) ? [...new Set(input.events.map(String).filter((item) => known.has(item)))] : [];
  if (!events.length) throw new AppError("VALIDATION", "Выберите хотя бы одно событие");
  const count = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM api_webhooks");
  if (Number(count?.n ?? 0) >= 10) throw new AppError("VALIDATION", "Не больше 10 вебхуков");
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const id = crypto.randomUUID();
  await ctx.db.query(
    "INSERT INTO api_webhooks (id, tenant_id, url, events, sealed_secret, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, ctx.actor.tenantId, url, events, encryptSecrets({ secret }), ctx.actor.userId],
  );
  const row = await one<HookRow>(ctx.db, "SELECT * FROM api_webhooks WHERE id = $1", [id]);
  // The signing secret is shown once.
  return { ...present(row!), secret };
}

export async function deleteWebhook(ctx: Ctx, id: string) {
  assertOwner(ctx);
  await ctx.db.query("DELETE FROM api_webhooks WHERE id = $1", [id]);
  return { ok: true };
}

/** Sends a test event right away, so the owner sees whether the receiver answers. */
export async function pingWebhook(ctx: Ctx, id: string) {
  assertOwner(ctx);
  const hook = await one<{ id: string; url: string; sealed_secret: string }>(ctx.db, "SELECT id, url, sealed_secret FROM api_webhooks WHERE id = $1", [id]);
  if (!hook) throw new AppError("NOT_FOUND", "Вебхук не найден");
  const delivery = crypto.randomUUID();
  const body = JSON.stringify({ id: delivery, event: "ping", occurredAt: ctx.now.toISOString(), data: {} });
  const result = await send(hook.url, body, decryptSecrets(hook.sealed_secret).secret ?? "", "ping", delivery);
  await ctx.db.query("UPDATE api_webhooks SET last_status = $2, last_error = $3, last_delivery_at = now() WHERE id = $1", [id, result.status, result.ok ? null : result.error]);
  return result;
}

// ------------------------------------------------------------------ delivery

export function signature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type Sender = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
let sender: Sender = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
  return { status: response.status };
};
/** Tests swap the network for a recorder. */
export function setWebhookSender(next: Sender | null) {
  sender = next ?? (async (url, init) => ({ status: (await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) })).status }));
}

async function send(url: string, body: string, secret: string, event: string, delivery: string) {
  try {
    const { status } = await sender(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "AmBeauty-Webhooks/1", "x-ambeauty-event": event, "x-ambeauty-delivery": delivery, "x-ambeauty-signature": signature(secret, body) },
      body,
    });
    return { ok: status >= 200 && status < 300, status, error: status >= 200 && status < 300 ? null : `Ответ ${status}` };
  } catch (error) {
    return { ok: false, status: null as number | null, error: (error as Error).message.slice(0, 200) };
  }
}

async function deliverTenant(tenantId: string, now: Date) {
  return withSession({ tenantId }, async (db) => {
    const due = await many<{ id: string; event: string; payload: unknown; attempts: number; webhook_id: string; url: string; sealed_secret: string; active: boolean }>(
      db,
      `SELECT d.id, d.event, d.payload, d.attempts, d.webhook_id, w.url, w.sealed_secret, w.active
       FROM webhook_deliveries d JOIN api_webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'pending' AND d.next_at <= $1 ORDER BY d.created_at LIMIT 50 FOR UPDATE OF d SKIP LOCKED`,
      [now],
    );
    let sent = 0;
    let failed = 0;
    for (const row of due) {
      if (!row.active) {
        await db.query("UPDATE webhook_deliveries SET status = 'failed', error = 'Вебхук выключен' WHERE id = $1", [row.id]);
        continue;
      }
      const body = JSON.stringify(row.payload);
      const result = await send(row.url, body, decryptSecrets(row.sealed_secret).secret ?? "", row.event, row.id);
      const attempts = Number(row.attempts) + 1;
      if (result.ok) {
        sent += 1;
        await db.query("UPDATE webhook_deliveries SET status = 'sent', attempts = $2, response_status = $3, sent_at = $4, error = NULL WHERE id = $1", [row.id, attempts, result.status, now]);
        await db.query("UPDATE api_webhooks SET last_status = $2, last_error = NULL, last_delivery_at = $3, failures = 0 WHERE id = $1", [row.webhook_id, result.status, now]);
      } else {
        failed += 1;
        const giveUp = attempts > RETRY_MIN.length;
        const next = new Date(now.getTime() + (RETRY_MIN[Math.min(attempts - 1, RETRY_MIN.length - 1)] ?? 360) * 60000);
        await db.query(
          "UPDATE webhook_deliveries SET status = $2, attempts = $3, response_status = $4, error = $5, next_at = $6 WHERE id = $1",
          [row.id, giveUp ? "failed" : "pending", attempts, result.status, result.error, next],
        );
        await db.query("UPDATE api_webhooks SET last_status = $2, last_error = $3, last_delivery_at = $4, failures = failures + 1 WHERE id = $1", [row.webhook_id, result.status, result.error, now]);
      }
    }
    return { sent, failed };
  });
}

/** Cron (`POST /api/jobs/webhooks`) and a kick after each change; retries 1, 5, 30, 120, 360 minutes, then gives up. */
export async function runWebhookJob(now = new Date()) {
  const tenants = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM webhook_tenants()");
  const total = { tenants: 0, sent: 0, failed: 0 };
  for (const { tenant_id: tenantId } of tenants.rows) {
    const result = await deliverTenant(tenantId, now);
    total.tenants += 1;
    total.sent += result.sent;
    total.failed += result.failed;
  }
  return total;
}

export async function runWebhooksForTenant(tenantId: string, now = new Date()) {
  return deliverTenant(tenantId, now);
}
