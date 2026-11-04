/**
 * Т-Банк интернет-эквайринг (API v2): Init → PaymentURL. Requests and notifications carry
 * a Token: sha256 of the root-level values sorted by key, with the terminal password mixed in.
 * The bank expects the plain text "OK" in answer to a notification.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { AcquiringProvider } from "../acquiring";
import { request, type CheckResult, type Config } from "./http";

const API = "https://securepay.tinkoff.ru/v2";

export function tbankToken(params: Record<string, unknown>, password: string) {
  const flat: Record<string, string> = { Password: password };
  for (const [key, value] of Object.entries(params)) {
    if (key === "Token" || value === null || value === undefined || typeof value === "object") continue;
    flat[key] = String(value);
  }
  const joined = Object.keys(flat).sort().map((key) => flat[key]).join("");
  return createHash("sha256").update(joined).digest("hex");
}

async function call<T>(method: string, params: Record<string, unknown>, config: Config) {
  const body = { TerminalKey: config.terminalKey ?? "", ...params };
  const { data } = await request<T & { Success?: boolean; ErrorCode?: string; Message?: string; Details?: string }>(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, Token: tbankToken(body, config.password ?? "") }),
  });
  return data;
}

const CANCELED = new Set(["REJECTED", "CANCELED", "REVERSED", "DEADLINE_EXPIRED", "AUTH_FAIL", "REFUNDED"]);

export const tbankProvider: AcquiringProvider = {
  name: "tbank",
  label: "Т-Банк",
  needsConfig: true,
  ack: "OK",
  async createPayment(input, config = {}) {
    const data = await call<{ PaymentId?: string | number; PaymentURL?: string }>(
      "Init",
      {
        Amount: input.amountMinor,
        OrderId: input.id,
        Description: input.description,
        SuccessURL: input.returnUrl,
        FailURL: input.returnUrl,
        RedirectDueDate: input.expiresAt.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
      },
      config,
    );
    if (!data?.Success || !data.PaymentURL || data.PaymentId == null) throw new Error(data?.Message ? `${data.Message}${data.Details ? `: ${data.Details}` : ""}` : "Т-Банк не создал платёж");
    return { externalId: String(data.PaymentId), confirmationUrl: data.PaymentURL };
  },
  externalIdOf(body) {
    const id = (body as { PaymentId?: unknown } | null)?.PaymentId;
    return id == null ? null : String(id);
  },
  async parseWebhook(body, _headers, config = {}) {
    const event = body as Record<string, unknown> | null;
    if (!event || typeof event.Token !== "string" || event.TerminalKey !== config.terminalKey) return null;
    const expected = Buffer.from(tbankToken(event, config.password ?? ""));
    const given = Buffer.from(event.Token.toLowerCase());
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const status = String(event.Status ?? "");
    return {
      externalId: String(event.PaymentId),
      status: status === "CONFIRMED" ? "succeeded" : CANCELED.has(status) ? "canceled" : "pending",
      method: typeof event.Pan === "string" && event.Pan ? "card" : "sbp",
    };
  },
};

/** No "who am I" call exists: CheckOrder on a made-up order answers "not found" only to a valid terminal and password. */
export async function tbankCheck(config: Config): Promise<CheckResult> {
  const data = await call<unknown>("CheckOrder", { OrderId: "am-beauty-connection-check" }, config);
  if (data?.Success) return { ok: true, text: "Подключено к Т-Банку" };
  const text = [data?.Message, data?.Details].filter(Boolean).join(": ");
  if (/token|токен|терминал|terminal|пароль/i.test(text) || !data) return { ok: false, text: text || "Т-Банк не ответил" };
  return { ok: true, text: "Подключено к Т-Банку" };
}
