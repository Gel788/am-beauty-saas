/**
 * АТОЛ Онлайн (API v4): the salon's own cloud kassa. The receipt goes to `sell` / `sell_refund`,
 * comes back registered a few seconds later (`report`), so the first answer is `sent`.
 */
import type { FiscalProvider, FiscalResult, ReceiptDocument } from "../fiscal";
import { request, type CheckResult, type Config } from "./http";

const BASE = { live: "https://online.atol.ru/possystem/v4", test: "https://testonline.atol.ru/possystem/v4" };
const tokens = new Map<string, { token: string; until: number }>();

function base(config: Config) {
  return config.mode === "test" ? BASE.test : BASE.live;
}

async function token(config: Config): Promise<string> {
  const cacheKey = `${base(config)}|${config.login}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.token;
  const { data } = await request<{ token?: string; error?: { text?: string } | null }>(`${base(config)}/getToken`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ login: config.login, pass: config.password }),
  });
  if (!data?.token) throw new Error(data?.error?.text ?? "АТОЛ не выдал токен: проверьте логин и пароль");
  // АТОЛ tokens live 24 hours.
  tokens.set(cacheKey, { token: data.token, until: Date.now() + 23 * 3600 * 1000 });
  return data.token;
}

const rub = (minor: number) => Math.round(minor) / 100;
const PAYMENT_TYPE = { cash: 0, electronic: 1, prepaid: 2 } as const;

function stamp(date: Date) {
  const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function atolReceipt(receiptId: string, document: ReceiptDocument, config: Config, now = new Date()) {
  const client = document.customer.email ? { email: document.customer.email } : document.customer.phone ? { phone: document.customer.phone } : { email: config.email || "receipts@ambeauty.local" };
  return {
    external_id: receiptId,
    timestamp: stamp(now),
    service: config.callbackUrl ? { callback_url: config.callbackUrl } : undefined,
    receipt: {
      client,
      company: { email: config.email || "", sno: document.taxation, inn: document.inn, payment_address: document.place },
      items: document.items.map((item) => ({
        name: item.name,
        price: rub(Math.round(item.sumMinor / item.quantity)),
        quantity: item.quantity,
        sum: rub(item.sumMinor),
        measurement_unit: "шт",
        payment_method: item.paymentMethod,
        payment_object: item.paymentObject,
        vat: { type: item.vat },
      })),
      payments: document.payments.map((payment) => ({ type: PAYMENT_TYPE[payment.type], sum: rub(payment.sumMinor) })),
      total: rub(document.totalMinor),
    },
  };
}

type Report = {
  status?: "done" | "wait" | "fail";
  error?: { text?: string; code?: number } | null;
  payload?: { fn_number?: string; fiscal_document_number?: number; fiscal_document_attribute?: number; receipt_datetime?: string; ofd_receipt_url?: string } | null;
};

function fromReport(uuid: string, data: Report): FiscalResult {
  if (data.status === "done" && data.payload) {
    return {
      status: "done",
      externalId: uuid,
      fnNumber: String(data.payload.fn_number ?? ""),
      fdNumber: String(data.payload.fiscal_document_number ?? ""),
      fiscalSign: String(data.payload.fiscal_document_attribute ?? ""),
      registeredAt: new Date().toISOString(),
      ofdUrl: data.payload.ofd_receipt_url ?? null,
    };
  }
  if (data.status === "fail") return { status: "failed", error: data.error?.text ?? "АТОЛ отклонил чек", retry: false };
  return { status: "sent", externalId: uuid };
}

export const atolProvider: FiscalProvider = {
  name: "atol",
  label: "АТОЛ Онлайн",
  needsConfig: true,
  async register(receiptId, document, config = {}) {
    const path = document.operation === "sell_refund" ? "sell_refund" : "sell";
    const { data, status } = await request<{ uuid?: string; status?: string; error?: { text?: string } | null }>(`${base(config)}/${config.groupCode}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", Token: await token(config) },
      body: JSON.stringify(atolReceipt(receiptId, document, config)),
    });
    if (data?.uuid) return { status: "sent", externalId: data.uuid };
    // 4xx is a problem with the receipt or the account; 5xx and timeouts are retried.
    return { status: "failed", error: data?.error?.text ?? `АТОЛ ответил ${status}`, retry: status >= 500 };
  },
  async check(uuid, config = {}) {
    const { data } = await request<Report>(`${base(config)}/${config.groupCode}/report/${uuid}`, { headers: { Token: await token(config) } });
    return fromReport(uuid, data ?? {});
  },
};

export async function atolCheck(config: Config): Promise<CheckResult> {
  tokens.clear();
  await token(config);
  return { ok: true, text: config.mode === "test" ? "Подключено к тестовой среде АТОЛ" : "Подключено к АТОЛ Онлайн" };
}
