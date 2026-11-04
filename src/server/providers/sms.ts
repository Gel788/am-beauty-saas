/** SMS gateways the salon can connect with its own account: SMS.ru and SMSC.ru. */
import type { Delivery, OutgoingMessage } from "../messaging";
import { request, type CheckResult, type Config } from "./http";

export async function smsRuSend(config: Config, message: OutgoingMessage): Promise<Delivery> {
  const url = new URL("https://sms.ru/sms/send");
  url.searchParams.set("api_id", config.apiId ?? "");
  url.searchParams.set("to", message.recipient.replace(/^\+/, ""));
  url.searchParams.set("msg", message.body);
  url.searchParams.set("json", "1");
  if (config.sender) url.searchParams.set("from", config.sender);
  try {
    const { data } = await request<{ status?: string; status_text?: string; sms?: Record<string, { status: string; status_text?: string }> }>(url.toString());
    const sms = data?.sms ? Object.values(data.sms)[0] : null;
    if (data?.status === "OK" && (!sms || sms.status === "OK")) return { ok: true };
    return { ok: false, error: sms?.status_text ?? data?.status_text ?? "SMS не отправлено" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function smsRuCheck(config: Config): Promise<CheckResult> {
  const url = new URL("https://sms.ru/my/balance");
  url.searchParams.set("api_id", config.apiId ?? "");
  url.searchParams.set("json", "1");
  const { data } = await request<{ status?: string; status_text?: string; balance?: number }>(url.toString());
  if (data?.status === "OK") return { ok: true, text: `Подключено. Баланс: ${data.balance ?? "?"} ₽` };
  return { ok: false, text: data?.status_text ?? "SMS.ru не принял ключ" };
}

export async function smscSend(config: Config, message: OutgoingMessage): Promise<Delivery> {
  const url = new URL("https://smsc.ru/sys/send.php");
  url.searchParams.set("login", config.login ?? "");
  url.searchParams.set("psw", config.password ?? "");
  url.searchParams.set("phones", message.recipient.replace(/^\+/, ""));
  url.searchParams.set("mes", message.body);
  url.searchParams.set("fmt", "3");
  url.searchParams.set("charset", "utf-8");
  if (config.sender) url.searchParams.set("sender", config.sender);
  try {
    const { data } = await request<{ id?: number; cnt?: number; error?: string; error_code?: number }>(url.toString());
    if (data && !data.error && data.id !== undefined) return { ok: true };
    return { ok: false, error: data?.error ?? "SMS не отправлено" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function smscCheck(config: Config): Promise<CheckResult> {
  const url = new URL("https://smsc.ru/sys/balance.php");
  url.searchParams.set("login", config.login ?? "");
  url.searchParams.set("psw", config.password ?? "");
  url.searchParams.set("fmt", "3");
  const { data } = await request<{ balance?: string; error?: string }>(url.toString());
  if (data?.balance !== undefined) return { ok: true, text: `Подключено. Баланс: ${data.balance} ₽` };
  return { ok: false, text: data?.error ?? "SMSC не принял логин и пароль" };
}
