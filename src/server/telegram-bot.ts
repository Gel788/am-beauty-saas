/**
 * MSG-TG-BOT-01: the platform bot's webhook. One bot serves every salon:
 * - /start <token> links the chat to a client or a staff member (token picks the tenant);
 * - buttons under a reminder confirm (c:<id>) or cancel (x:<id>) the visit;
 * - /stop unlinks the chat everywhere.
 */
import { createHash } from "node:crypto";
import { asOnline, cancelBooking, confirmVisit } from "./booking";
import { one, poolMany, poolOne } from "./db";
import { isAppError } from "@/domain/errors";
import { bindTelegram, telegramAnswer, telegramSend, unbindTelegram } from "./messaging";

type Update = {
  message?: { chat?: { id?: number | string }; from?: { username?: string }; text?: string };
  callback_query?: { id?: string; data?: string; from?: { username?: string }; message?: { chat?: { id?: number | string } } };
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Telegram sends the secret we set with setWebhook; without TELEGRAM_WEBHOOK_SECRET the check is skipped (dev). */
export function telegramSecretOk(header: string | null) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  return !expected || header === expected;
}

export async function handleTelegramUpdate(update: Update, now = new Date()): Promise<{ ok: true; reply?: string }> {
  if (update.callback_query) return handleCallback(update.callback_query, now);
  const message = update.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
  const text = (message?.text ?? "").trim();
  if (!chatId || !text) return { ok: true };

  let reply: string;
  if (text.startsWith("/start")) {
    const token = text.split(/\s+/)[1] ?? "";
    reply = await start(token, chatId, message?.from?.username ?? null, now);
  } else if (text === "/stop") {
    const tenants = await poolMany<{ tenant_id: string }>("SELECT tenant_id FROM telegram_chat_lookup($1)", [chatId]);
    for (const row of tenants) await asOnline(row.tenant_id, (ctx) => unbindTelegram(ctx, chatId), now);
    reply = tenants.length ? "Готово, больше не будем писать сюда. Вернуться можно по новой ссылке от салона." : "Этот чат и так ни к чему не подключён.";
  } else {
    reply = "Я присылаю напоминания о записях. Чтобы ответить салону, позвоните или напишите администратору.";
  }
  await telegramSend(chatId, reply);
  return { ok: true, reply };
}

async function start(token: string, chatId: string, username: string | null, now: Date) {
  if (!/^[a-f0-9]{32}$/.test(token)) return "Откройте бота по ссылке от салона, чтобы получать напоминания.";
  const row = await poolOne<{ tenant_id: string }>("SELECT tenant_id FROM telegram_token_lookup($1)", [sha256(token)]);
  if (!row) return "Ссылка устарела. Попросите салон прислать новую.";
  return asOnline(row.tenant_id, (ctx) => bindTelegram(ctx, token, { chatId, username }), now);
}

async function handleCallback(query: NonNullable<Update["callback_query"]>, now: Date): Promise<{ ok: true; reply?: string }> {
  const chatId = query.message?.chat?.id != null ? String(query.message.chat.id) : null;
  const match = /^([cx]):([0-9a-f-]{36})$/.exec(query.data ?? "");
  let reply = "Кнопка устарела";
  if (chatId && match) {
    const [, action, appointmentId] = match;
    const tenants = await poolMany<{ tenant_id: string }>("SELECT tenant_id FROM telegram_chat_lookup($1)", [chatId]);
    for (const { tenant_id } of tenants) {
      const result = await asOnline(tenant_id, async (ctx) => {
        // Only the client this chat is linked to may answer for the visit.
        const owned = await one<{ id: string }>(
          ctx.db,
          `SELECT a.id FROM appointments a JOIN telegram_links l ON l.client_id = a.client_id
           WHERE a.id = $1 AND l.chat_id = $2`,
          [appointmentId, chatId],
        );
        if (!owned) return null;
        try {
          if (action === "c") {
            const done = await confirmVisit(ctx, appointmentId, "telegram");
            return done.outcome === "already_confirmed" ? "Визит уже подтверждён. Ждём вас!" : "Спасибо, визит подтверждён. Ждём вас!";
          }
          const done = await cancelBooking(ctx, appointmentId, { reason: "Отменено в Telegram", notifyClient: false });
          if (done.outcome === "requested") return "До визита осталось мало времени, отменить онлайн уже нельзя. Мы передали просьбу администратору, с вами свяжутся.";
          return "Запись отменена. Будем рады видеть вас снова!";
        } catch (error) {
          if (isAppError(error)) return error.message;
          throw error;
        }
      }, now);
      if (result) {
        reply = result;
        break;
      }
    }
  }
  if (query.id) await telegramAnswer(query.id, reply.length <= 200 ? reply : undefined);
  if (chatId) await telegramSend(chatId, reply);
  return { ok: true, reply };
}
