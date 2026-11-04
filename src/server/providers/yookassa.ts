/**
 * ЮKassa (API v3) with the salon's own shop: Basic auth shopId:secretKey, redirect confirmation.
 * Webhooks are not signed, so a notification is only a hint: the status is re-read from the API.
 */
import type { AcquiringProvider } from "../acquiring";
import { request, type CheckResult, type Config } from "./http";

const API = "https://api.yookassa.ru/v3";
const auth = (config: Config) => `Basic ${Buffer.from(`${config.shopId ?? ""}:${config.secretKey ?? ""}`).toString("base64")}`;
const rub = (minor: number) => (minor / 100).toFixed(2);

type Payment = { id?: string; status?: string; payment_method?: { type?: string }; confirmation?: { confirmation_url?: string }; description?: string; type?: string };

export const yookassaProvider: AcquiringProvider = {
  name: "yookassa",
  label: "ЮKassa",
  needsConfig: true,
  async createPayment(input, config = {}) {
    const { data, status } = await request<Payment>(`${API}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: auth(config), "Idempotence-Key": input.id },
      body: JSON.stringify({
        amount: { value: rub(input.amountMinor), currency: "RUB" },
        capture: true,
        confirmation: { type: "redirect", return_url: input.returnUrl },
        description: input.description,
        metadata: { online_payment_id: input.id },
      }),
    });
    if (!data?.id || !data.confirmation?.confirmation_url) throw new Error(data?.description ?? `ЮKassa ответила ${status}`);
    return { externalId: data.id, confirmationUrl: data.confirmation.confirmation_url };
  },
  externalIdOf(body) {
    const id = (body as { object?: { id?: unknown } } | null)?.object?.id;
    return typeof id === "string" ? id : null;
  },
  async parseWebhook(body, _headers, config = {}) {
    const id = this.externalIdOf!(body);
    if (!id) return null;
    const { data, ok } = await request<Payment>(`${API}/payments/${encodeURIComponent(id)}`, { headers: { Authorization: auth(config) } });
    if (!ok || data?.id !== id) return null;
    const status = data.status === "succeeded" ? "succeeded" : data.status === "canceled" ? "canceled" : "pending";
    return { externalId: id, status, method: data.payment_method?.type === "sbp" ? "sbp" : "card" };
  },
};

export async function yookassaCheck(config: Config): Promise<CheckResult> {
  const { data, ok, status } = await request<{ account_id?: string; test?: boolean; description?: string }>(`${API}/me`, { headers: { Authorization: auth(config) } });
  if (ok && data?.account_id) return { ok: true, text: `Подключено: магазин ${data.account_id}${data.test ? " (тестовый)" : ""}` };
  return { ok: false, text: status === 401 ? "ЮKassa не приняла shopId или секретный ключ" : data?.description ?? `ЮKassa ответила ${status}` };
}
