/**
 * Messaging (MSG-*): channels, templates, delivery to a client, manual messages, desk notifications.
 * Channels are tried in the tenant's order (tenants.message_channels); the first that delivers wins.
 * - telegram: the salon's own bot (Интеграции) or the platform bot (TELEGRAM_BOT_TOKEN), for linked chats
 * - sms: the salon's SMS.ru / SMSC account (Интеграции), else the server's SMS_RU_API_KEY
 * - log: records the message without sending, so nothing is lost while channels are not connected
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@/domain/errors";
import { formatMoney } from "@/domain/money";
import { isAdminPlus } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import { activeIntegration } from "./integrations";
import { smscSend, smsRuSend } from "./providers/sms";
import { setTelegramTransport, telegramApi, telegramFaked } from "./providers/telegram";
import type { BranchRow, Ctx } from "./types";

export type Button = { text: string; data?: string; url?: string };
export type OutgoingMessage = { recipient: string; body: string; buttons?: Button[]; /** The chat was linked through the salon's own bot. */ ownBot?: boolean };
export type Delivery = { ok: true } | { ok: false; error: string };
export type Channel = {
  name: string;
  /** What the channel sends to: a phone number (default) or a linked Telegram chat. */
  address?: "phone" | "telegram";
  deliver: (message: OutgoingMessage, ctx: Ctx) => Promise<Delivery>;
};

const CHANNELS = new Map<string, Channel>();
export function registerChannel(channel: Channel) {
  CHANNELS.set(channel.name, channel);
}
export function channel(name: string) {
  return CHANNELS.get(name) ?? null;
}
registerChannel({ name: "log", deliver: async () => ({ ok: true }) });

// ---------------------------------------------------------------- Telegram

export { setTelegramTransport };

export function publicUrl() {
  return (process.env.PUBLIC_URL || "http://127.0.0.1:43123").replace(/\/$/, "");
}

/** The platform bot (env). */
export function telegramBotName() {
  return process.env.TELEGRAM_BOT_USERNAME || (telegramFaked() ? "test_bot" : "");
}
function platformBot() {
  return Boolean(telegramApi() && telegramBotName());
}

/** INT-TG-01: the salon's own bot from «Интеграции», when switched on. */
export async function tenantBot(ctx: Ctx): Promise<{ token: string; username: string; webhookSecret: string } | null> {
  const own = await activeIntegration(ctx, "telegram");
  if (!own?.config.token || !own.config.username) return null;
  return { token: own.config.token, username: own.config.username, webhookSecret: own.config.webhookSecret ?? "" };
}

/** A bot to link chats through: the salon's own one first, else the platform bot. */
export async function telegramConfigured(ctx: Ctx) {
  return Boolean((await tenantBot(ctx)) || platformBot());
}

export async function telegramSend(chatId: string, body: string, buttons?: Button[], token?: string): Promise<Delivery> {
  const api = telegramApi(token);
  if (!api) return { ok: false, error: "Telegram-бот не настроен" };
  const reply_markup = buttons?.length
    ? { inline_keyboard: [buttons.map((button) => (button.url ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data }))] }
    : undefined;
  try {
    const result = await api("sendMessage", { chat_id: chatId, text: body, ...(reply_markup ? { reply_markup } : {}) });
    return result.ok ? { ok: true } : { ok: false, error: result.description ?? "Telegram отклонил сообщение" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Stops the spinner on an inline button. */
export async function telegramAnswer(callbackQueryId: string, text?: string, token?: string) {
  const api = telegramApi(token);
  if (!api) return;
  try {
    await api("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  } catch {
    // the follow-up message still reaches the chat
  }
}

/** A chat is written to through the bot it was linked with. */
async function sendToChat(ctx: Ctx, chatId: string, ownBot: boolean, body: string, buttons?: Button[]): Promise<Delivery> {
  if (!ownBot) return telegramSend(chatId, body, buttons);
  const bot = await tenantBot(ctx);
  if (!bot) return { ok: false, error: "Свой Telegram-бот салона отключён" };
  return telegramSend(chatId, body, buttons, bot.token);
}

registerChannel({ name: "telegram", address: "telegram", deliver: (message, ctx) => sendToChat(ctx, message.recipient, Boolean(message.ownBot), message.body, message.buttons) });

// ---------------------------------------------------------------- SMS

/** INT-SMS-01: the salon's own SMS gateway first; the server-wide SMS.ru key (env) is the fallback. */
async function smsGateway(ctx: Ctx): Promise<{ label: string; send: (message: OutgoingMessage) => Promise<Delivery> } | null> {
  const own = await activeIntegration(ctx, "sms");
  if (own?.provider === "smsc") return { label: "SMSC.ru", send: (message) => smscSend(own.config, message) };
  if (own?.provider === "sms_ru") return { label: "SMS.ru", send: (message) => smsRuSend(own.config, message) };
  if (process.env.SMS_RU_API_KEY) {
    const config = { apiId: process.env.SMS_RU_API_KEY, sender: process.env.SMS_SENDER ?? "" };
    return { label: "SMS.ru (ключ сервера)", send: (message) => smsRuSend(config, message) };
  }
  return null;
}

registerChannel({
  name: "sms",
  async deliver(message, ctx) {
    const gateway = await smsGateway(ctx);
    if (!gateway) return { ok: false, error: "SMS не подключены: «Настройки → Интеграции»" };
    return gateway.send(message);
  },
});

/** For the settings screen: which channels can deliver for this salon right now. */
export async function channelCatalog(ctx: Ctx) {
  const bot = await tenantBot(ctx);
  const sms = await smsGateway(ctx);
  const telegramHint = bot ? `@${bot.username} (свой бот)` : platformBot() ? `@${telegramBotName()}` : "Подключите своего бота в «Интеграциях»";
  return [
    { name: "telegram", label: "Telegram-бот", available: Boolean(bot) || platformBot(), hint: telegramHint },
    { name: "sms", label: "SMS", available: Boolean(sms), hint: sms ? sms.label : "Подключите SMS.ru или SMSC в «Интеграциях»" },
    { name: "log", label: "Только журнал", available: true, hint: "Сообщение записывается, но не уходит клиенту" },
  ];
}

// ---------------------------------------------------------------- Templates

export type TemplateKey = "reminder" | "booking_created" | "booking_cancelled" | "pay_link" | "review_request" | "waitlist_offer" | "rebook" | "birthday";
export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  reminder: "Напоминаем о записи в {салон}{адрес}: {когда}. {услуги}, мастер {мастер}. Подтвердите или отмените визит: {ссылка}",
  booking_created: "Вы записаны в {салон}: {когда}, {услуги}, мастер {мастер}. Управлять записью: {ссылка}",
  booking_cancelled: "Запись в {салон} на {когда} отменена. Будем рады видеть вас снова!",
  pay_link: "{салон}: ссылка на оплату {сумма} — {ссылка}",
  review_request: "{имя}, спасибо, что были у нас в {салон}! Как вам визит к мастеру {мастер}? Оцените, это займёт минуту: {ссылка}",
  waitlist_offer: "{имя}, освободилось время в {салон}: {когда}, мастер {мастер}. Записаться: {ссылка}",
  rebook: "{имя}, с последнего визита в {салон} прошло {дней} дн. — самое время обновить {услуги}. Записаться: {ссылка}",
  birthday: "{имя}, {салон} поздравляет вас с днём рождения! Ждём в гости: {ссылка}",
};
export const TEMPLATE_LABEL: Record<TemplateKey, string> = {
  reminder: "Напоминание о визите",
  booking_created: "Запись создана",
  booking_cancelled: "Запись отменена",
  pay_link: "Ссылка на оплату",
  review_request: "Просьба об отзыве",
  waitlist_offer: "Предложение окна из листа ожидания",
  rebook: "Пора на повторный визит",
  birthday: "Поздравление с днём рождения",
};
export const PLACEHOLDERS = ["{имя}", "{салон}", "{адрес}", "{когда}", "{услуги}", "{мастер}", "{сумма}", "{ссылка}", "{дней}"];

export function render(template: string, values: Record<string, string>) {
  return template
    .replace(/\{([а-яё]+)\}/gi, (match, key: string) => (key.toLowerCase() in values ? values[key.toLowerCase()] : match))
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function templateBody(ctx: Ctx, key: TemplateKey) {
  const row = await one<{ body: string }>(ctx.db, "SELECT body FROM message_templates WHERE tenant_id = $1 AND key = $2", [ctx.actor.tenantId, key]);
  return row?.body ?? DEFAULT_TEMPLATES[key];
}

export async function listTemplates(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const rows = await many<{ key: TemplateKey; body: string }>(ctx.db, "SELECT key, body FROM message_templates WHERE tenant_id = $1", [ctx.actor.tenantId]);
  return (Object.keys(DEFAULT_TEMPLATES) as TemplateKey[]).map((key) => {
    const custom = rows.find((row) => row.key === key);
    return { key, label: TEMPLATE_LABEL[key], body: custom?.body ?? DEFAULT_TEMPLATES[key], custom: Boolean(custom), defaultBody: DEFAULT_TEMPLATES[key] };
  });
}

export async function saveTemplate(ctx: Ctx, key: string, body: string | null) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  if (!(key in DEFAULT_TEMPLATES)) throw new AppError("VALIDATION", "Неизвестный шаблон");
  if (body === null || body.trim() === "" || body.trim() === DEFAULT_TEMPLATES[key as TemplateKey]) {
    await ctx.db.query("DELETE FROM message_templates WHERE tenant_id = $1 AND key = $2", [ctx.actor.tenantId, key]);
  } else {
    const text = body.trim();
    if (text.length > 1000) throw new AppError("VALIDATION", "Шаблон длиннее 1000 символов");
    const unknown = (text.match(/\{[^}]*\}/g) ?? []).filter((token) => !PLACEHOLDERS.includes(token.toLowerCase()));
    if (unknown.length) throw new AppError("VALIDATION", `Неизвестная подстановка: ${unknown.join(", ")}`);
    await ctx.db.query(
      `INSERT INTO message_templates (tenant_id, key, body, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, key) DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.actor.tenantId, key, text, ctx.actor.userId],
    );
  }
  return (await listTemplates(ctx)).find((row) => row.key === key)!;
}

/** Values for an appointment's template. */
export async function appointmentValues(ctx: Ctx, appointmentId: string, extra: Record<string, string> = {}) {
  const row = await one<{
    starts_at: Date;
    staff_name: string;
    client_name: string | null;
    title: string | null;
    price_minor: number;
    branch_id: string;
  }>(
    ctx.db,
    `SELECT a.starts_at, a.branch_id, s.display_name AS staff_name, c.name AS client_name,
            (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title,
            (SELECT COALESCE(SUM(price_minor), 0)::int FROM appointment_services WHERE appointment_id = a.id) AS price_minor
     FROM appointments a JOIN staff s ON s.id = a.staff_id LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = $1`,
    [appointmentId],
  );
  if (!row) throw new AppError("NOT_FOUND", "Запись не найдена");
  const branch = await one<BranchRow>(ctx.db, "SELECT * FROM branches WHERE id = $1", [row.branch_id]);
  const when = new Intl.DateTimeFormat("ru-RU", {
    timeZone: branch!.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(row.starts_at));
  return {
    branch: branch!,
    values: {
      имя: row.client_name ?? "",
      салон: branch!.name,
      адрес: branch!.address ? `, ${branch!.address}` : "",
      когда: when,
      услуги: row.title ?? "Визит",
      мастер: row.staff_name,
      сумма: formatMoney(Number(row.price_minor), branch!.currency),
      ссылка: "",
      ...extra,
    },
  };
}

// ---------------------------------------------------------------- Delivery

export type SendResult = { id: string; status: "delivered" | "failed"; channel: string; error: string | null };

async function clientAddress(ctx: Ctx, clientId: string) {
  const row = await one<{ phone: string | null; chat_id: string | null; own_bot: boolean | null }>(
    ctx.db,
    `SELECT (SELECT phone_e164 FROM client_phones p WHERE p.client_id = c.id AND p.deleted_at IS NULL ORDER BY p.is_primary DESC LIMIT 1) AS phone,
            (SELECT chat_id FROM telegram_links t WHERE t.client_id = c.id LIMIT 1) AS chat_id,
            (SELECT own_bot FROM telegram_links t WHERE t.client_id = c.id LIMIT 1) AS own_bot
     FROM clients c WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [clientId],
  );
  return row;
}

/**
 * MSG-SEND-01: one message to one client through the first channel that can reach them.
 * Everything is logged in outbound_messages, sent or not.
 */
export async function deliverToClient(
  ctx: Ctx,
  input: {
    clientId: string;
    branchId: string | null;
    appointmentId?: string | null;
    kind: "reminder" | "manual" | "booking_created" | "booking_cancelled" | "pay_link" | "review_request" | "waitlist_offer" | "rebook" | "birthday";
    body: string;
    buttons?: Button[];
    /** Unique kinds (reminder) skip silently when already logged. */
    once?: boolean;
  },
): Promise<SendResult | null> {
  const channelsRow = await one<{ message_channels: string[] }>(ctx.db, "SELECT message_channels FROM tenants WHERE id = $1", [ctx.actor.tenantId]);
  const names = channelsRow?.message_channels?.length ? channelsRow.message_channels : ["log"];
  const address = await clientAddress(ctx, input.clientId);
  let outcome: { channel: string; recipient: string; error: string | null } = {
    channel: names[0] ?? "none",
    recipient: address?.phone ?? "",
    error: "Нет канала, через который можно связаться с клиентом",
  };
  for (const name of names) {
    const target = CHANNELS.get(name);
    if (!target) continue;
    const recipient = target.address === "telegram" ? address?.chat_id : address?.phone;
    if (!recipient) {
      if (outcome.error?.startsWith("Нет канала")) outcome = { channel: name, recipient: address?.phone ?? "", error: target.address === "telegram" ? "Клиент не подключил Telegram" : "У клиента нет телефона" };
      continue;
    }
    // A Telegram chat shows buttons; elsewhere links stay in the text.
    const telegram = target.address === "telegram";
    const result = await target.deliver({ recipient, body: input.body, buttons: telegram ? input.buttons : undefined, ownBot: telegram && Boolean(address?.own_bot) }, ctx);
    if (result.ok) {
      outcome = { channel: name, recipient, error: null };
      break;
    }
    outcome = { channel: name, recipient, error: result.error };
  }
  const id = crypto.randomUUID();
  const inserted = await ctx.db.query(
    `INSERT INTO outbound_messages (id, tenant_id, branch_id, appointment_id, client_id, kind, channel, recipient, body, status, error, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ${input.once ? "ON CONFLICT DO NOTHING" : ""}`,
    [
      id,
      ctx.actor.tenantId,
      input.branchId,
      input.appointmentId ?? null,
      input.clientId,
      input.kind,
      outcome.channel,
      outcome.recipient,
      input.body,
      outcome.error ? "failed" : "delivered",
      outcome.error,
      ctx.now.toISOString(),
      ctx.actor.userId,
    ],
  );
  if (input.once && inserted.rowCount === 0) return null;
  return { id, status: outcome.error ? "failed" : "delivered", channel: outcome.channel, error: outcome.error };
}

/** MSG-MANUAL-01: the desk writes to a client (free text or a template). */
export async function sendManual(ctx: Ctx, clientId: string, input: { body: string; appointmentId?: string | null; branchId?: string | null }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const body = (input.body ?? "").trim();
  if (!body) throw new AppError("VALIDATION", "Напишите текст сообщения");
  if (body.length > 1000) throw new AppError("VALIDATION", "Сообщение длиннее 1000 символов");
  const client = await one<{ id: string }>(ctx.db, "SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL", [clientId]);
  if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
  const branchId = input.branchId ?? ctx.actor.branchId ?? null;
  const result = await deliverToClient(ctx, { clientId, branchId, appointmentId: input.appointmentId ?? null, kind: "manual", body });
  await audit(ctx, { branchId, entity: "client", entityId: clientId, action: "message.sent", diff: { channel: result?.channel, status: result?.status } });
  return result!;
}

export async function clientMessages(ctx: Ctx, clientId: string) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const rows = await many<{ id: string; kind: string; channel: string; body: string; status: string; error: string | null; created_at: Date }>(
    ctx.db,
    "SELECT id, kind, channel, body, status, error, created_at FROM outbound_messages WHERE client_id = $1 ORDER BY created_at DESC LIMIT 50",
    [clientId],
  );
  const link = await one<{ username: string | null; linked_at: Date }>(ctx.db, "SELECT username, linked_at FROM telegram_links WHERE client_id = $1", [clientId]);
  const consent = await one<{ consent_pd_at: Date | null; consent_pd_source: string | null; consent_marketing: boolean; consent_marketing_at: Date | null }>(
    ctx.db,
    "SELECT consent_pd_at, consent_pd_source, consent_marketing, consent_marketing_at FROM clients WHERE id = $1",
    [clientId],
  );
  if (!consent) throw new AppError("NOT_FOUND", "Клиент не найден");
  return {
    telegramConfigured: await telegramConfigured(ctx),
    consents: {
      pdAt: consent.consent_pd_at ? new Date(consent.consent_pd_at).toISOString() : null,
      pdSource: consent.consent_pd_source,
      marketing: consent.consent_marketing,
      marketingAt: consent.consent_marketing_at ? new Date(consent.consent_marketing_at).toISOString() : null,
    },
    telegram: link ? { username: link.username, linkedAt: new Date(link.linked_at).toISOString() } : null,
    messages: rows.map((row) => ({ id: row.id, kind: row.kind, channel: row.channel, body: row.body, status: row.status, error: row.error, createdAt: new Date(row.created_at).toISOString() })),
  };
}

// ---------------------------------------------------------------- Telegram linking

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** MSG-TG-LINK-01: a deep link the client (or a staff member) opens to connect the bot. Valid 7 days. */
export async function telegramLink(ctx: Ctx, target: { clientId?: string; self?: boolean }) {
  if (!(await telegramConfigured(ctx))) throw new AppError("VALIDATION", "Telegram-бот не подключён: «Настройки → Интеграции»");
  if (target.clientId && !isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  if (target.self && !isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  return issueTelegramLink(ctx, target);
}

/** No permission check: the online booking offers the link to the client who just booked. */
export async function issueTelegramLink(ctx: Ctx, target: { clientId?: string; self?: boolean }) {
  const token = randomBytes(16).toString("hex");
  const own = await tenantBot(ctx);
  await ctx.db.query(
    `INSERT INTO telegram_link_tokens (token_hash, tenant_id, client_id, user_id, expires_at, own_bot)
     VALUES ($1,$2,$3,$4,$5::timestamptz + interval '7 days',$6)`,
    [sha256(token), ctx.actor.tenantId, target.clientId ?? null, target.self ? ctx.actor.userId : null, ctx.now.toISOString(), Boolean(own)],
  );
  return { url: `https://t.me/${own?.username ?? telegramBotName()}?start=${token}` };
}

/** /start <token> from the bot: binds the chat. Returns the greeting. */
export async function bindTelegram(ctx: Ctx, token: string, chat: { chatId: string; username?: string | null }, ownBot = false) {
  const row = await one<{ token_hash: string; client_id: string | null; user_id: string | null; expires_at: Date; used_at: Date | null; own_bot: boolean }>(
    ctx.db,
    "SELECT * FROM telegram_link_tokens WHERE token_hash = $1 FOR UPDATE",
    [sha256(token)],
  );
  // A link made for the salon's own bot works only there, and the other way round.
  if (!row || row.used_at || new Date(row.expires_at) <= ctx.now || Boolean(row.own_bot) !== ownBot) return "Ссылка устарела. Попросите салон прислать новую.";
  await ctx.db.query("UPDATE telegram_link_tokens SET used_at = $2 WHERE token_hash = $1", [row.token_hash, ctx.now.toISOString()]);
  if (row.client_id) {
    await ctx.db.query("DELETE FROM telegram_links WHERE client_id = $1", [row.client_id]);
  } else {
    await ctx.db.query("DELETE FROM telegram_links WHERE user_id = $1", [row.user_id]);
  }
  await ctx.db.query("INSERT INTO telegram_links (id, tenant_id, client_id, user_id, chat_id, username, own_bot) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    crypto.randomUUID(),
    ctx.actor.tenantId,
    row.client_id,
    row.user_id,
    chat.chatId,
    chat.username ?? null,
    ownBot,
  ]);
  const salon = await one<{ name: string }>(ctx.db, "SELECT name FROM tenants WHERE id = $1", [ctx.actor.tenantId]);
  return row.client_id
    ? `Готово! Теперь ${salon?.name ?? "салон"} будет присылать сюда напоминания о записях. Отключиться можно командой /stop.`
    : `Готово! Сюда будут приходить уведомления ${salon?.name ?? "салона"}: новые записи, отмены и оплаты.`;
}

/** /stop: drops the links made through this bot. Returns how many. */
export async function unbindTelegram(ctx: Ctx, chatId: string, ownBot = false) {
  const done = await ctx.db.query("DELETE FROM telegram_links WHERE chat_id = $1 AND own_bot = $2", [chatId, ownBot]);
  return done.rowCount ?? 0;
}

// ---------------------------------------------------------------- Desk notifications

/** MSG-DESK-01: something the admins must see. In-app, plus Telegram for staff who linked the bot. */
export async function notifyDesk(
  ctx: Ctx,
  input: { branchId: string | null; kind: string; title: string; body?: string; entity?: string; entityId?: string | null },
) {
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO notifications (id, tenant_id, branch_id, kind, title, body, entity, entity_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.actor.tenantId, input.branchId, input.kind, input.title, input.body ?? "", input.entity ?? null, input.entityId ?? null, ctx.now.toISOString()],
  );
  {
    const staff = await many<{ chat_id: string; own_bot: boolean }>(
      ctx.db,
      `SELECT DISTINCT l.chat_id, l.own_bot FROM telegram_links l
       JOIN memberships m ON m.user_id = l.user_id AND m.tenant_id = l.tenant_id
       WHERE l.user_id IS NOT NULL AND m.role IN ('owner', 'admin') AND (m.branch_id IS NULL OR $1::uuid IS NULL OR m.branch_id = $1)`,
      [input.branchId],
    );
    for (const row of staff) await sendToChat(ctx, row.chat_id, row.own_bot, input.body ? `${input.title}\n${input.body}` : input.title);
  }
  return id;
}

export async function listNotifications(ctx: Ctx, input: { unreadOnly?: boolean } = {}) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") return { unread: 0, items: [] };
  const where = "AND ($1::uuid IS NULL OR branch_id IS NULL OR branch_id = $1)";
  const items = await many<{ id: string; kind: string; title: string; body: string; entity: string | null; entity_id: string | null; read_at: Date | null; created_at: Date }>(
    ctx.db,
    `SELECT id, kind, title, body, entity, entity_id, read_at, created_at FROM notifications
     WHERE TRUE ${where} ${input.unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 30`,
    [ctx.actor.branchId],
  );
  const unread = await one<{ n: number }>(ctx.db, `SELECT COUNT(*)::int AS n FROM notifications WHERE read_at IS NULL ${where}`, [ctx.actor.branchId]);
  return {
    unread: Number(unread?.n ?? 0),
    items: items.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      entity: row.entity,
      entityId: row.entity_id,
      read: Boolean(row.read_at),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function markNotificationsRead(ctx: Ctx, ids?: string[]) {
  if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") throw new AppError("FORBIDDEN", "Недостаточно прав");
  if (ids?.length) {
    await ctx.db.query("UPDATE notifications SET read_at = $2, read_by = $3 WHERE id = ANY($1::uuid[]) AND read_at IS NULL", [ids, ctx.now.toISOString(), ctx.actor.userId]);
  } else {
    await ctx.db.query(
      `UPDATE notifications SET read_at = $1, read_by = $2 WHERE read_at IS NULL ${ctx.actor.branchId ? "AND (branch_id IS NULL OR branch_id = $3)" : ""}`,
      ctx.actor.branchId ? [ctx.now.toISOString(), ctx.actor.userId, ctx.actor.branchId] : [ctx.now.toISOString(), ctx.actor.userId],
    );
  }
  return listNotifications(ctx);
}


// ---------------------------------------------------------------- Consents (152-ФЗ / 38-ФЗ)

/** MSG-CONSENT-01: the desk records a consent given on paper or in person; withdrawals are kept in the audit. */
export async function updateConsents(ctx: Ctx, clientId: string, input: { pd?: boolean; marketing?: boolean }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const row = await one<{ id: string }>(ctx.db, "SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [clientId]);
  if (!row) throw new AppError("NOT_FOUND", "Клиент не найден");
  const now = ctx.now.toISOString();
  if (input.pd === true) {
    await ctx.db.query("UPDATE clients SET consent_pd_at = COALESCE(consent_pd_at, $2), consent_pd_source = COALESCE(consent_pd_source, 'desk') WHERE id = $1", [clientId, now]);
  } else if (input.pd === false) {
    // Withdrawn: marketing goes with it, and the salon no longer writes first.
    await ctx.db.query("UPDATE clients SET consent_pd_at = NULL, consent_pd_source = NULL, consent_marketing = false, consent_marketing_at = NULL WHERE id = $1", [clientId]);
  }
  if (input.marketing !== undefined && input.pd !== false) {
    await ctx.db.query(
      "UPDATE clients SET consent_marketing = $2, consent_marketing_at = CASE WHEN $2 THEN COALESCE(consent_marketing_at, $3::timestamptz) ELSE NULL END WHERE id = $1",
      [clientId, input.marketing, now],
    );
  }
  await audit(ctx, { branchId: ctx.actor.branchId ?? null, entity: "client", entityId: clientId, action: "client.consents", diff: input });
  return (await clientMessages(ctx, clientId)).consents;
}

// ---------------------------------------------------------------- Tenant settings

export async function messagingSettings(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const tenant = await one<{ message_channels: string[]; legal_name: string; legal_inn: string; privacy_email: string; name: string }>(
    ctx.db,
    "SELECT message_channels, legal_name, legal_inn, privacy_email, name FROM tenants WHERE id = $1",
    [ctx.actor.tenantId],
  );
  const self = await one<{ username: string | null }>(ctx.db, "SELECT username FROM telegram_links WHERE user_id = $1", [ctx.actor.userId]);
  return {
    channels: await channelCatalog(ctx),
    order: tenant?.message_channels?.length ? tenant.message_channels : ["log"],
    legalName: tenant?.legal_name ?? "",
    legalInn: tenant?.legal_inn ?? "",
    privacyEmail: tenant?.privacy_email ?? "",
    templates: await listTemplates(ctx),
    placeholders: PLACEHOLDERS,
    telegram: { configured: await telegramConfigured(ctx), bot: (await tenantBot(ctx))?.username ?? (telegramBotName() || null), selfLinked: Boolean(self), selfUsername: self?.username ?? null },
  };
}

export async function updateMessagingSettings(ctx: Ctx, input: { order?: unknown; legalName?: unknown; legalInn?: unknown; privacyEmail?: unknown }) {
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Каналы и реквизиты меняет владелец");
  if (input.order !== undefined) {
    const order = Array.isArray(input.order) ? input.order.map(String) : [];
    const known = new Set((await channelCatalog(ctx)).map((row) => row.name));
    const clean = [...new Set(order.filter((name) => known.has(name)))];
    if (!clean.length) throw new AppError("VALIDATION", "Выберите хотя бы один канал");
    await ctx.db.query("UPDATE tenants SET message_channels = $2 WHERE id = $1", [ctx.actor.tenantId, clean]);
  }
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  if (input.legalInn !== undefined) {
    const inn = text(input.legalInn, 12);
    if (inn && !/^(\d{10}|\d{12})$/.test(inn)) throw new AppError("VALIDATION", "ИНН: 10 или 12 цифр");
    await ctx.db.query("UPDATE tenants SET legal_inn = $2 WHERE id = $1", [ctx.actor.tenantId, inn]);
  }
  if (input.legalName !== undefined) await ctx.db.query("UPDATE tenants SET legal_name = $2 WHERE id = $1", [ctx.actor.tenantId, text(input.legalName, 200)]);
  if (input.privacyEmail !== undefined) {
    const email = text(input.privacyEmail, 200).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("VALIDATION", "Некорректный email");
    await ctx.db.query("UPDATE tenants SET privacy_email = $2 WHERE id = $1", [ctx.actor.tenantId, email]);
  }
  await audit(ctx, { branchId: null, entity: "tenant", entityId: ctx.actor.tenantId, action: "messaging.settings", diff: input as Record<string, unknown> });
  return messagingSettings(ctx);
}

export async function unlinkSelfTelegram(ctx: Ctx) {
  await ctx.db.query("DELETE FROM telegram_links WHERE user_id = $1", [ctx.actor.userId]);
  return messagingSettings(ctx);
}

/** Operator details for the public privacy page of the online booking. */
export async function privacyInfo(ctx: Ctx, branchId: string) {
  const row = await one<{ name: string; legal_name: string; legal_inn: string; privacy_email: string; branch: string; address: string }>(
    ctx.db,
    `SELECT t.name, t.legal_name, t.legal_inn, t.privacy_email, b.name AS branch, b.address
     FROM tenants t JOIN branches b ON b.tenant_id = t.id WHERE b.id = $1`,
    [branchId],
  );
  if (!row) throw new AppError("NOT_FOUND", "Не найдено");
  return { salon: row.name, operator: row.legal_name || row.name, inn: row.legal_inn, email: row.privacy_email, branch: row.branch, address: row.address };
}
