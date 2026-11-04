/**
 * PWA-PUSH-01: web push to the staff app (installed PWA or an open browser tab).
 * VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY; without them the app makes a pair once
 * and keeps the private half sealed with INTEGRATIONS_KEY.
 */
import webpush from "web-push";
import { AppError } from "@/domain/errors";
import { many, one } from "./db";
import { decryptSecrets, encryptSecrets } from "./secrets";
import type { Ctx } from "./types";

export type PushPayload = { title: string; body?: string; url?: string; tag?: string };
type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type Sender = (subscription: Subscription, payload: string, keys: { publicKey: string; privateKey: string }) => Promise<{ statusCode: number }>;

const defaultSender: Sender = (subscription, payload, keys) =>
  webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: process.env.VAPID_SUBJECT || "mailto:support@ambeauty.local", publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 3600,
    timeout: 5000,
  });

let sender: Sender = defaultSender;
/** Tests capture pushes instead of calling the browser vendors. */
export function setPushSender(next: Sender | null) {
  sender = next ?? defaultSender;
}

let cached: { publicKey: string; privateKey: string } | null = null;

export async function vapidKeys(ctx: Ctx) {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
  if (cached) return cached;
  const row = await one<{ public_value: string; sealed_secret: string }>(ctx.db, "SELECT public_value, sealed_secret FROM platform_keys WHERE name = 'vapid'");
  const stored = row ? decryptSecrets(row.sealed_secret).privateKey : undefined;
  if (row && stored) return (cached = { publicKey: row.public_value, privateKey: stored });
  const pair = webpush.generateVAPIDKeys();
  await ctx.db.query(
    `INSERT INTO platform_keys (name, public_value, sealed_secret) VALUES ('vapid', $1, $2)
     ON CONFLICT (name) DO UPDATE SET public_value = EXCLUDED.public_value, sealed_secret = EXCLUDED.sealed_secret, created_at = now()`,
    [pair.publicKey, encryptSecrets({ privateKey: pair.privateKey })],
  );
  return (cached = { publicKey: pair.publicKey, privateKey: pair.privateKey });
}

export async function pushPublicKey(ctx: Ctx) {
  return { publicKey: (await vapidKeys(ctx)).publicKey };
}

function cleanSubscription(input: unknown): Subscription {
  const raw = (input ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const p256dh = typeof raw.keys?.p256dh === "string" ? raw.keys.p256dh : "";
  const auth = typeof raw.keys?.auth === "string" ? raw.keys.auth : "";
  if (!/^https:\/\/[^\s]{8,2000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{20,200}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}={0,2}$/.test(auth)) {
    throw new AppError("VALIDATION", "Браузер прислал неполную подписку на уведомления");
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** The signed-in user turns notifications on for this device. */
export async function subscribePush(ctx: Ctx, input: { subscription?: unknown; userAgent?: string }) {
  if (ctx.actor.role === "client") throw new AppError("FORBIDDEN", "Недостаточно прав");
  const sub = cleanSubscription(input.subscription);
  await ctx.db.query(
    `INSERT INTO push_subscriptions (id, tenant_id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failures = 0`,
    [crypto.randomUUID(), ctx.actor.tenantId, ctx.actor.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, (input.userAgent ?? "").slice(0, 200), ctx.now.toISOString()],
  );
  return pushStatus(ctx);
}

export async function unsubscribePush(ctx: Ctx, endpoint?: string) {
  if (endpoint) await ctx.db.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, ctx.actor.userId]);
  else await ctx.db.query("DELETE FROM push_subscriptions WHERE user_id = $1", [ctx.actor.userId]);
  return pushStatus(ctx);
}

export async function pushStatus(ctx: Ctx) {
  const row = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [ctx.actor.userId]);
  return { devices: Number(row?.n ?? 0) };
}

/** Sends to every device of these users; dead subscriptions (404/410) are dropped. Never throws. */
export async function pushToUsers(ctx: Ctx, userIds: string[], payload: PushPayload) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return { sent: 0 };
  const subs = await many<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    ctx.db,
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::uuid[])",
    [ids],
  );
  if (!subs.length) return { sent: 0 };
  let keys: { publicKey: string; privateKey: string };
  try {
    keys = await vapidKeys(ctx);
  } catch {
    return { sent: 0 };
  }
  const body = JSON.stringify({ title: payload.title, body: payload.body ?? "", url: payload.url ?? "/journal", tag: payload.tag });
  let sent = 0;
  for (const sub of subs) {
    try {
      await sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, keys);
      sent += 1;
      await ctx.db.query("UPDATE push_subscriptions SET last_ok_at = $2, failures = 0 WHERE id = $1", [sub.id, ctx.now.toISOString()]);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await ctx.db.query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]);
      else await ctx.db.query("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1", [sub.id]);
    }
  }
  return { sent };
}

/** Owners and admins of the branch (or of every branch when the membership is not tied to one). */
export async function deskUserIds(ctx: Ctx, branchId: string | null) {
  const rows = await many<{ user_id: string }>(
    ctx.db,
    `SELECT DISTINCT user_id FROM memberships WHERE role IN ('owner', 'admin') AND (branch_id IS NULL OR $1::uuid IS NULL OR branch_id = $1)`,
    [branchId],
  );
  return rows.map((row) => row.user_id);
}

export async function staffUserId(ctx: Ctx, staffId: string | null | undefined) {
  if (!staffId) return null;
  return (await one<{ user_id: string | null }>(ctx.db, "SELECT user_id FROM staff WHERE id = $1", [staffId]))?.user_id ?? null;
}

export async function sendTestPush(ctx: Ctx) {
  const result = await pushToUsers(ctx, [ctx.actor.userId], { title: "Am Beauty", body: "Уведомления включены. Так будут приходить новые записи и отмены.", url: "/journal", tag: "test" });
  if (!result.sent) throw new AppError("VALIDATION", "Не получилось отправить: включите уведомления на этом устройстве ещё раз");
  return result;
}
