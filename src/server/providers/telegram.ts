/**
 * Telegram Bot API transport. The platform bot uses TELEGRAM_BOT_TOKEN; a salon may connect its own bot,
 * in which case its token is passed explicitly. Tests swap the whole transport.
 */
export type TelegramReply = { ok: boolean; description?: string; result?: unknown };
export type TelegramTransport = (method: string, payload: Record<string, unknown>, token?: string) => Promise<TelegramReply>;

let transport: TelegramTransport | null = null;
export function setTelegramTransport(value: TelegramTransport | null) {
  transport = value;
}
export function telegramFaked() {
  return Boolean(transport);
}

/** null when there is no bot to talk through. */
export function telegramApi(token?: string | null): ((method: string, payload: Record<string, unknown>) => Promise<TelegramReply>) | null {
  const bot = token || process.env.TELEGRAM_BOT_TOKEN;
  if (transport) return (method, payload) => transport!(method, payload, token ?? undefined);
  if (!bot) return null;
  return async (method, payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${bot}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return (await response.json()) as TelegramReply;
    } finally {
      clearTimeout(timer);
    }
  };
}
