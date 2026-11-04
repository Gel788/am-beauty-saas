import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { createPayLink, handleWebhook, listPayLinks } from "@/server/acquiring";
import { many, one } from "@/server/db";
import { listReceipts, processReceipts } from "@/server/fiscal";
import { checkIntegration, deleteIntegration, listIntegrations, saveIntegration } from "@/server/integrations";
import { deliverToClient, issueTelegramLink, setTelegramTransport } from "@/server/messaging";
import { createPayment, openShift } from "@/server/payments";
import { setProviderHttp } from "@/server/providers/http";
import { tbankToken } from "@/server/providers/tbank";
import { updateBranch } from "@/server/settings";
import { handleTelegramUpdate, ownBotFor } from "@/server/telegram-bot";
import { NOW, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let day = 1;

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
const calls: Call[] = [];
/** The outside world: answers by URL. */
let respond: (call: Call) => { status?: number; body: unknown } = () => ({ status: 404, body: {} });
const tg: { method: string; payload: Record<string, unknown>; token?: string }[] = [];

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.owner, (ctx) => ctx.db.query("INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary) VALUES ($1,$2,$3,'+79161234567',true) ON CONFLICT DO NOTHING", [crypto.randomUUID(), salon.tenantId, salon.clientId]));
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
  setProviderHttp(async (url, init) => {
    const call = { url, method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: String(init?.body ?? "") };
    calls.push(call);
    const answer = respond(call);
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, text: async () => text };
  });
  setTelegramTransport(async (method, payload, token) => {
    tg.push({ method, payload, token });
    if (method === "getMe") return token === "123:good" ? { ok: true, result: { username: "salon_rose_bot" } } : { ok: false, description: "Unauthorized" };
    return { ok: true };
  });
});
afterAll(() => {
  setProviderHttp(null);
  setTelegramTransport(null);
});

function visit() {
  day += 1;
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: salon.clientId, startsAt: at("10:00", `2026-12-${String(day).padStart(2, "0")}`), services: [{ serviceId: salon.serviceId }] }),
  );
}

describe("integrations (INT)", () => {
  it("INT-SAVE-01 owner only; keys are checked before switching on, sealed at rest and shown masked", async () => {
    await expect(run(salon.admin, (ctx) => listIntegrations(ctx))).rejects.toMatchObject({ code: "FORBIDDEN" });
    respond = (call) => (call.url.includes("sms.ru/my/balance") ? { body: call.url.includes("api_id=GOOD-KEY-9876") ? { status: "OK", balance: 412.5 } : { status: "ERROR", status_text: "Неправильный api_id" } } : { status: 404, body: {} });
    await expect(run(salon.owner, (ctx) => saveIntegration(ctx, "sms_ru", { values: { apiId: "bad" }, enabled: true }))).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("Неправильный api_id") });
    const list = await run(salon.owner, (ctx) => saveIntegration(ctx, "sms_ru", { values: { apiId: "GOOD-KEY-9876", sender: "RoseSalon" }, enabled: true }));
    const sms = list.find((item) => item.provider === "sms_ru")!;
    expect(sms).toMatchObject({ enabled: true, status: "ok", statusText: "Подключено. Баланс: 412.5 ₽", values: { apiId: "••••9876", sender: "RoseSalon" } });
    const raw = await run(salon.owner, (ctx) => one<{ secrets: string }>(ctx.db, "SELECT secrets FROM tenant_integrations WHERE provider = 'sms_ru'"));
    expect(raw!.secrets).toMatch(/^v1\./);
    expect(raw!.secrets).not.toContain("GOOD-KEY");
    // Masked value sent back unchanged keeps the stored key.
    await run(salon.owner, (ctx) => saveIntegration(ctx, "sms_ru", { values: { apiId: "••••9876", sender: "Rose" } }));
    expect((await run(salon.owner, (ctx) => checkIntegration(ctx, "sms_ru"))).find((item) => item.provider === "sms_ru")?.status).toBe("ok");
  });

  it("INT-SMS-01 messages go through the salon's gateway; turning on another one switches the first off", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET message_channels = '{sms}' WHERE id = $1", [salon.tenantId]));
    respond = (call) => {
      if (call.url.includes("sms.ru/sms/send")) return { body: { status: "OK", sms: { "79161234567": { status: "OK" } } } };
      if (call.url.includes("smsc.ru/sys/balance")) return { body: { balance: "99.00" } };
      if (call.url.includes("smsc.ru/sys/send")) return { body: { id: 1, cnt: 1 } };
      return { status: 404, body: {} };
    };
    const first = await run(salon.admin, (ctx) => deliverToClient(ctx, { clientId: salon.clientId, branchId: salon.branchId, kind: "manual", body: "Привет" }));
    expect(first).toMatchObject({ status: "delivered", channel: "sms" });
    const send = calls.filter((call) => call.url.includes("sms.ru/sms/send")).at(-1)!;
    expect(new URL(send.url).searchParams.get("from")).toBe("Rose");

    const list = await run(salon.owner, (ctx) => saveIntegration(ctx, "smsc", { values: { login: "rose", password: "pw" }, enabled: true }));
    expect(list.filter((item) => item.kind === "sms" && item.enabled).map((item) => item.provider)).toEqual(["smsc"]);
    await run(salon.admin, (ctx) => deliverToClient(ctx, { clientId: salon.clientId, branchId: salon.branchId, kind: "manual", body: "Через SMSC" }));
    expect(calls.at(-1)!.url).toContain("smsc.ru/sys/send.php");
    await run(salon.owner, (ctx) => saveIntegration(ctx, "smsc", { enabled: false }));
    const off = await run(salon.admin, (ctx) => deliverToClient(ctx, { clientId: salon.clientId, branchId: salon.branchId, kind: "manual", body: "Никуда" }));
    expect(off).toMatchObject({ status: "failed", error: expect.stringContaining("Интеграции") });
  });

  it("INT-TG-01 the salon's own bot: links, replies and reminders go through its token", async () => {
    await expect(run(salon.owner, (ctx) => saveIntegration(ctx, "telegram_bot", { values: { token: "123:bad" }, enabled: true }))).rejects.toMatchObject({ code: "VALIDATION" });
    const list = await run(salon.owner, (ctx) => saveIntegration(ctx, "telegram_bot", { values: { token: "123:good" }, enabled: true }));
    expect(list.find((item) => item.provider === "telegram_bot")).toMatchObject({ enabled: true, account: "@salon_rose_bot" });
    const hook = tg.find((call) => call.method === "setWebhook")!;
    expect(hook).toMatchObject({ token: "123:good", payload: { url: expect.stringContaining(`/api/webhooks/telegram/t/${salon.tenantId}`) } });
    const secret = String(hook.payload.secret_token);

    expect(await ownBotFor(salon.tenantId, "wrong")).toBeNull();
    const bot = (await ownBotFor(salon.tenantId, secret))!;
    expect(bot).toEqual({ tenantId: salon.tenantId, token: "123:good" });

    const { url } = await run(salon.admin, (ctx) => issueTelegramLink(ctx, { clientId: salon.clientId }));
    expect(url).toMatch(/^https:\/\/t\.me\/salon_rose_bot\?start=/);
    const token = new URL(url).searchParams.get("start")!;
    // A link for the own bot does not work through the platform bot.
    expect((await handleTelegramUpdate({ message: { chat: { id: 5551 }, text: `/start ${token}` } }, NOW)).reply).toMatch(/устарела/);
    const greeting = await handleTelegramUpdate({ message: { chat: { id: 5551 }, text: `/start ${token}` } }, NOW, bot);
    expect(greeting.reply).toMatch(/Готово/);
    expect(tg.at(-1)).toMatchObject({ method: "sendMessage", token: "123:good" });

    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET message_channels = '{telegram}' WHERE id = $1", [salon.tenantId]));
    const sent = await run(salon.admin, (ctx) => deliverToClient(ctx, { clientId: salon.clientId, branchId: salon.branchId, kind: "manual", body: "Ждём вас" }));
    expect(sent).toMatchObject({ status: "delivered", channel: "telegram" });
    expect(tg.at(-1)).toMatchObject({ method: "sendMessage", token: "123:good", payload: { chat_id: "5551", text: "Ждём вас" } });

    await run(salon.owner, (ctx) => saveIntegration(ctx, "telegram_bot", { enabled: false }));
    expect(tg.at(-1)).toMatchObject({ method: "deleteWebhook", token: "123:good" });
    const off = await run(salon.admin, (ctx) => deliverToClient(ctx, { clientId: salon.clientId, branchId: salon.branchId, kind: "manual", body: "Никуда" }));
    expect(off).toMatchObject({ status: "failed", error: expect.stringContaining("отключён") });
  });

  it("INT-ACQ-01 ЮKassa: the branch can pick it only once connected; the webhook is re-checked with the salon's keys", async () => {
    await expect(run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { acquiringProvider: "yookassa" }))).rejects.toMatchObject({ code: "VALIDATION" });
    let status = "pending";
    respond = (call) => {
      const auth = call.headers.Authorization;
      if (auth !== `Basic ${Buffer.from("506751:test_secret").toString("base64")}`) return { status: 401, body: { type: "error", description: "Ошибка аутентификации" } };
      if (call.url.endsWith("/v3/me")) return { body: { account_id: "506751", test: true } };
      if (call.url.endsWith("/v3/payments") && call.method === "POST") return { body: { id: "2d0a-yk-1", status: "pending", confirmation: { type: "redirect", confirmation_url: "https://yoomoney.ru/checkout/payments/v2/contract?orderId=2d0a-yk-1" } } };
      if (call.url.endsWith("/v3/payments/2d0a-yk-1")) return { body: { id: "2d0a-yk-1", status, payment_method: { type: "sbp" } } };
      return { status: 404, body: {} };
    };
    const list = await run(salon.owner, (ctx) => saveIntegration(ctx, "yookassa", { values: { shopId: "506751", secretKey: "test_secret" }, enabled: true }));
    expect(list.find((item) => item.provider === "yookassa")).toMatchObject({ status: "ok", statusText: "Подключено: магазин 506751 (тестовый)", webhookUrl: expect.stringContaining("/api/webhooks/acquiring/yookassa") });
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { acquiringEnabled: true, acquiringProvider: "yookassa" }));

    const appt = await visit();
    const link = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: "https://crm.test" }));
    const create = calls.find((call) => call.url.endsWith("/v3/payments") && call.method === "POST")!;
    expect(create.headers["Idempotence-Key"]).toBe(link.id);
    expect(JSON.parse(create.body)).toMatchObject({ amount: { value: "1500.00", currency: "RUB" }, capture: true });

    // A forged "succeeded" while the API still says pending changes nothing.
    await handleWebhook("yookassa", { event: "payment.succeeded", object: { id: "2d0a-yk-1", status: "succeeded" } }, new Headers());
    expect((await run(salon.admin, (ctx) => listPayLinks(ctx, appt.id))).links[0].status).toBe("pending");
    status = "succeeded";
    await handleWebhook("yookassa", { event: "payment.succeeded", object: { id: "2d0a-yk-1" } }, new Headers());
    const [paid] = (await run(salon.admin, (ctx) => listPayLinks(ctx, appt.id))).links;
    expect(paid).toMatchObject({ status: "succeeded", method: "sbp" });
  });

  it("INT-ACQ-02 Т-Банк: Init is signed, a notification with a wrong token is ignored, the answer is OK", async () => {
    respond = (call) => {
      const body = JSON.parse(call.body || "{}");
      if (body.Token !== tbankToken(body, "tpass")) return { body: { Success: false, ErrorCode: "204", Message: "Неверный токен" } };
      if (call.url.endsWith("/CheckOrder")) return { body: { Success: false, ErrorCode: "7", Message: "Заказ не найден" } };
      if (call.url.endsWith("/Init")) return { body: { Success: true, PaymentId: 7001, PaymentURL: "https://securepay.tinkoff.ru/new/7001" } };
      return { status: 404, body: {} };
    };
    await expect(run(salon.owner, (ctx) => saveIntegration(ctx, "tbank", { values: { terminalKey: "TK1", password: "wrong" }, enabled: true }))).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.owner, (ctx) => saveIntegration(ctx, "tbank", { values: { terminalKey: "TK1", password: "tpass" }, enabled: true }));
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { acquiringProvider: "tbank" }));
    const appt = await visit();
    const link = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: "https://crm.test" }));
    expect(link.status).toBe("pending");

    const event = { TerminalKey: "TK1", OrderId: link.id, Success: true, Status: "CONFIRMED", PaymentId: 7001, ErrorCode: "0", Amount: 150000, Pan: "430000******0777" };
    const forged = await handleWebhook("tbank", { ...event, Token: tbankToken(event, "guess") }, new Headers());
    expect(forged).toMatchObject({ ignored: true, ack: "OK" });
    const real = await handleWebhook("tbank", { ...event, Token: tbankToken(event, "tpass") }, new Headers());
    expect(real).toEqual({ ok: true, ack: "OK" });
    expect((await run(salon.admin, (ctx) => listPayLinks(ctx, appt.id))).links[0]).toMatchObject({ status: "succeeded", method: "card" });
  });

  it("INT-FISC-01 АТОЛ Онлайн: a receipt is sent with the salon's account and comes back registered", async () => {
    respond = (call) => {
      if (call.url.endsWith("/getToken")) return { body: JSON.parse(call.body).pass === "apass" ? { token: "atol-token" } : { error: { text: "Неверный логин или пароль" } } };
      if (call.headers.Token !== "atol-token") return { status: 401, body: { error: { text: "Токен" } } };
      if (call.url.endsWith("/grp1/sell")) return { body: { uuid: "atol-uuid-1", status: "wait" } };
      if (call.url.endsWith("/grp1/report/atol-uuid-1")) return { body: { status: "done", payload: { fn_number: "9960440300000001", fiscal_document_number: 42, fiscal_document_attribute: 1234567890, ofd_receipt_url: "https://ofd.test/r/42" } } };
      return { status: 404, body: {} };
    };
    await expect(run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalProvider: "atol" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.owner, (ctx) => saveIntegration(ctx, "atol", { values: { login: "rose", password: "apass", groupCode: "grp1", mode: "test", email: "kassa@rose.test" }, enabled: true }));
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalEnabled: true, fiscalInn: "770123456789", fiscalPlace: "Москва, Садовая 14", fiscalProvider: "atol" }));
    const appt = await visit();
    const paid = await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "card", amountMinor: 150000 }] }));
    await run(salon.admin, (ctx) => processReceipts(ctx));
    const sell = calls.filter((call) => call.url.endsWith("/grp1/sell")).at(-1)!;
    expect(sell.url).toContain("testonline.atol.ru");
    expect(JSON.parse(sell.body)).toMatchObject({ receipt: { company: { inn: "770123456789", email: "kassa@rose.test" }, total: 1500, payments: [{ type: 1, sum: 1500 }] } });
    expect((await run(salon.admin, (ctx) => listReceipts(ctx, salon.branchId, { paymentId: paid.id })))[0]).toMatchObject({ status: "sent" });
    await run(salon.admin, (ctx) => ctx.db.query("UPDATE fiscal_receipts SET next_try_at = '2026-11-01' WHERE payment_id = $1", [paid.id]));
    await run(salon.admin, (ctx) => processReceipts(ctx, 20));
    expect((await run(salon.admin, (ctx) => listReceipts(ctx, salon.branchId, { paymentId: paid.id })))[0]).toMatchObject({ status: "done", fdNumber: "42" });

    // Deleting the integration returns the branch to the test kassa and turns receipts off.
    await run(salon.owner, (ctx) => deleteIntegration(ctx, "atol"));
    const branch = await run(salon.owner, (ctx) => many<{ fiscal_provider: string; fiscal_enabled: boolean }>(ctx.db, "SELECT fiscal_provider, fiscal_enabled FROM branches WHERE id = $1", [salon.branchId]));
    expect(branch[0]).toEqual({ fiscal_provider: "test", fiscal_enabled: false });
  });
});
