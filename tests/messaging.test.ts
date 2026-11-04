import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { asOnline, cancelBooking, confirmBooking, confirmVisit, createHold, getBooking, resolveBookingToken } from "@/server/booking";
import { many, one, withSession } from "@/server/db";
import {
  clientMessages,
  deliverToClient,
  listNotifications,
  listTemplates,
  markNotificationsRead,
  messagingSettings,
  notifyDesk,
  render,
  saveTemplate,
  sendManual,
  setTelegramTransport,
  telegramLink,
  updateConsents,
  updateMessagingSettings,
} from "@/server/messaging";
import { JOBS_ACTOR_ID, sendDueReminders } from "@/server/reminders";
import { handleTelegramUpdate } from "@/server/telegram-bot";
import { asAcquiring, createPayLink, resolvePayToken, sandboxPay } from "@/server/acquiring";
import { NOW, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
const sent: { method: string; payload: Record<string, unknown> }[] = [];

beforeAll(async () => {
  salon = await createSalon();
  setTelegramTransport(async (method, payload) => {
    sent.push({ method, payload });
    return { ok: true };
  });
});
afterAll(() => setTelegramTransport(null));

const chat = () => String(Math.floor(Math.random() * 1e12));
const toChat = (chatId: string) => sent.filter((row) => row.method === "sendMessage" && row.payload.chat_id === chatId);

function visit(date: string, time: string, clientId = salon.clientId, staffId = salon.staffA) {
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId, clientId, startsAt: at(time, date), services: [{ serviceId: salon.serviceId }] }),
  );
}

function reminders(now: Date) {
  return withSession({ tenantId: salon.tenantId, userId: JOBS_ACTOR_ID }, (db) =>
    sendDueReminders({
      db,
      actor: { userId: JOBS_ACTOR_ID, tenantId: salon.tenantId, role: "client", branchId: null, staffId: null, name: "", email: "" },
      now,
    }),
  );
}

async function linkClient(clientId = salon.clientId) {
  const { url } = await run(salon.admin, (ctx) => telegramLink(ctx, { clientId }));
  const token = new URL(url).searchParams.get("start")!;
  const chatId = chat();
  const result = await handleTelegramUpdate({ message: { chat: { id: chatId }, from: { username: "client" }, text: `/start ${token}` } }, NOW);
  return { chatId, token, reply: result.reply ?? "" };
}

describe("messaging", () => {
  it("MSG-TPL-01 templates: custom text, unknown placeholders rejected, reset to default", async () => {
    const saved = await run(salon.admin, (ctx) => saveTemplate(ctx, "reminder", "Ждём вас {когда}, {имя}! {ссылка}"));
    expect(saved).toMatchObject({ custom: true, body: "Ждём вас {когда}, {имя}! {ссылка}" });
    await expect(run(salon.admin, (ctx) => saveTemplate(ctx, "reminder", "Привет {фамилия}"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.master, (ctx) => listTemplates(ctx))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const reset = await run(salon.admin, (ctx) => saveTemplate(ctx, "reminder", null));
    expect(reset.custom).toBe(false);
    expect(render("{салон}{адрес}: {когда} .", { салон: "Студия", адрес: "", когда: "завтра" })).toBe("Студия: завтра.");
  });

  it("MSG-TG-LINK-01 the client links Telegram; reminders then go there with buttons", async () => {
    await run(salon.owner, (ctx) => updateMessagingSettings(ctx, { order: ["telegram", "log"] }));
    const { chatId, reply } = await linkClient();
    expect(reply).toContain("Готово");
    const info = await run(salon.admin, (ctx) => clientMessages(ctx, salon.clientId));
    expect(info.telegram?.username).toBe("client");

    const appt = await visit("2026-11-04", "10:00");
    await reminders(NOW);
    const message = toChat(chatId).at(-1)!;
    expect(String(message.payload.text)).toContain("Напоминаем");
    expect(JSON.stringify(message.payload.reply_markup)).toContain(`c:${appt.id}`);
    const logged = await run(salon.owner, (ctx) =>
      one<{ channel: string; status: string }>(ctx.db, "SELECT channel, status FROM outbound_messages WHERE appointment_id = $1 AND kind = 'reminder'", [appt.id]),
    );
    expect(logged).toEqual({ channel: "telegram", status: "delivered" });

    // A used token does not work twice.
    const again = await run(salon.admin, (ctx) => telegramLink(ctx, { clientId: salon.clientId }));
    const token = new URL(again.url).searchParams.get("start")!;
    await handleTelegramUpdate({ message: { chat: { id: chatId }, text: `/start ${token}` } }, NOW);
    const stale = await handleTelegramUpdate({ message: { chat: { id: chat() }, text: `/start ${token}` } }, NOW);
    expect(stale.reply).toContain("устарела");
  });

  it("MSG-CONFIRM-01 the Telegram button confirms the visit; a foreign chat cannot", async () => {
    const appt = await visit("2026-11-05", "11:00");
    const { chatId } = await linkClient();
    const stranger = await handleTelegramUpdate({ callback_query: { id: "q1", data: `c:${appt.id}`, message: { chat: { id: chat() } } } }, NOW);
    expect(stranger.reply).toBe("Кнопка устарела");

    const done = await handleTelegramUpdate({ callback_query: { id: "q2", data: `c:${appt.id}`, message: { chat: { id: chatId } } } }, NOW);
    expect(done.reply).toContain("подтверждён");
    const row = await run(salon.admin, (ctx) => one<{ status: string; confirmed_via: string }>(ctx.db, "SELECT status, confirmed_via FROM appointments WHERE id = $1", [appt.id]));
    expect(row).toEqual({ status: "confirmed", confirmed_via: "telegram" });
    expect(sent.some((call) => call.method === "answerCallbackQuery" && call.payload.callback_query_id === "q2")).toBe(true);

    const desk = await run(salon.admin, (ctx) => listNotifications(ctx));
    expect(desk.items.find((item) => item.entityId === appt.id)?.kind).toBe("booking.confirmed");

    const cancel = await handleTelegramUpdate({ callback_query: { id: "q3", data: `x:${appt.id}`, message: { chat: { id: chatId } } } }, NOW);
    expect(cancel.reply).toContain("отменена");
  });

  it("MSG-CONFIRM-02 the reminder link confirms by page; past visits cannot be confirmed", async () => {
    await run(salon.owner, (ctx) => updateMessagingSettings(ctx, { order: ["log"] }));
    const appt = await visit("2026-11-04", "11:00", salon.clientId, salon.staffB);
    await reminders(NOW);
    const body = await run(salon.owner, (ctx) =>
      one<{ body: string }>(ctx.db, "SELECT body FROM outbound_messages WHERE appointment_id = $1 AND kind = 'reminder'", [appt.id]),
    );
    const token = /booking\/([a-f0-9]{64})/.exec(body!.body)![1];
    const { tenantId, appointmentId } = await resolveBookingToken(token);
    expect(appointmentId).toBe(appt.id);
    const page = await asOnline(tenantId, (ctx) => getBooking(ctx, appointmentId), NOW);
    expect(page.canConfirm).toBe(true);
    const result = await asOnline(tenantId, (ctx) => confirmVisit(ctx, appointmentId, "link"), NOW);
    expect(result).toMatchObject({ outcome: "confirmed", status: "confirmed" });
    expect((await asOnline(tenantId, (ctx) => confirmVisit(ctx, appointmentId, "link"), NOW)).outcome).toBe("already_confirmed");

    const later = new Date("2026-11-04T14:00:00.000Z");
    const old = await visit("2026-11-04", "09:00", salon.clientId, salon.staffA);
    await expect(asOnline(salon.tenantId, (ctx) => confirmVisit(ctx, old.id, "link"), later)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("MSG-TG-BOT /stop unlinks the chat; messages fall back to the next channel", async () => {
    await run(salon.owner, (ctx) => updateMessagingSettings(ctx, { order: ["telegram", "log"] }));
    const { chatId } = await linkClient();
    const stop = await handleTelegramUpdate({ message: { chat: { id: chatId }, text: "/stop" } }, NOW);
    expect(stop.reply).toContain("больше не будем");
    const result = await run(salon.admin, (ctx) => sendManual(ctx, salon.clientId, { body: "Проверка" }));
    expect(result).toMatchObject({ channel: "log", status: "delivered" });
  });

  it("MSG-MANUAL-01 the desk writes to a client; history shows it; masters cannot", async () => {
    const result = await run(salon.admin, (ctx) => sendManual(ctx, salon.clientId, { body: "Вы забыли зонт у нас" }));
    expect(result.status).toBe("delivered");
    const history = await run(salon.admin, (ctx) => clientMessages(ctx, salon.clientId));
    expect(history.messages.find((row) => row.body === "Вы забыли зонт у нас")?.kind).toBe("manual");
    await expect(run(salon.admin, (ctx) => sendManual(ctx, salon.clientId, { body: "  " }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.master, (ctx) => sendManual(ctx, salon.clientId, { body: "Привет" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("MSG-CONSENT-01 online booking needs the 152-ФЗ consent; marketing is separate and can be withdrawn", async () => {
    const hold = await asOnline(
      salon.tenantId,
      (ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("16:00", "2026-11-10") }),
      NOW,
    );
    const phone = `+7911${salon.tenantId.replace(/\D/g, "").slice(0, 7).padEnd(7, "1")}`;
    await expect(
      asOnline(salon.tenantId, (ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Вера", phone }), NOW),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const booking = await asOnline(
      salon.tenantId,
      (ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Вера", phone, consent: true, marketing: true }),
      NOW,
    );
    expect(booking.telegramUrl).toMatch(/^https:\/\/t\.me\/test_bot\?start=/);
    const client = await run(salon.admin, (ctx) =>
      one<{ client_id: string }>(ctx.db, "SELECT client_id FROM appointments WHERE id = $1", [booking.appointmentId]),
    );
    const info = await run(salon.admin, (ctx) => clientMessages(ctx, client!.client_id));
    expect(info.consents).toMatchObject({ pdSource: "online", marketing: true });
    expect(info.consents.pdAt).not.toBeNull();
    const kinds = info.messages.map((row) => row.kind);
    expect(kinds).toContain("booking_created");

    const desk = await run(salon.admin, (ctx) => listNotifications(ctx));
    expect(desk.items.some((item) => item.entityId === booking.appointmentId && item.kind === "booking.online")).toBe(true);

    const withdrawn = await run(salon.admin, (ctx) => updateConsents(ctx, client!.client_id, { pd: false }));
    expect(withdrawn).toMatchObject({ pdAt: null, marketing: false });
    const regiven = await run(salon.admin, (ctx) => updateConsents(ctx, client!.client_id, { pd: true, marketing: false }));
    expect(regiven).toMatchObject({ pdSource: "desk", marketing: false });

    await asOnline(salon.tenantId, (ctx) => cancelBooking(ctx, booking.appointmentId as string), NOW);
    const after = await run(salon.admin, (ctx) => clientMessages(ctx, client!.client_id));
    expect(after.messages.map((row) => row.kind)).toContain("booking_cancelled");
  });

  it("MSG-PAY-01 a pay link goes to the client; the paid link lands in the desk feed", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET acquiring_enabled = true WHERE id = $1", [salon.branchId]));
    const appt = await visit("2026-11-06", "12:00");
    const link = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: "https://salon.test", send: true }));
    expect(link.sent).toMatchObject({ status: "delivered" });
    const message = await run(salon.owner, (ctx) =>
      one<{ body: string }>(ctx.db, "SELECT body FROM outbound_messages WHERE appointment_id = $1 AND kind = 'pay_link'", [appt.id]),
    );
    expect(message!.body).toContain(link.url!);
    const { tenantId, id } = await resolvePayToken(link.url!.split("/pay/")[1]);
    await asAcquiring(tenantId, (ctx) => sandboxPay(ctx, id, "sbp"), NOW);
    const desk = await run(salon.admin, (ctx) => listNotifications(ctx));
    expect(desk.items.find((item) => item.entityId === appt.id && item.kind === "payment.online")?.body).toContain("СБП");
  });

  it("MSG-DESK-01 notifications: staff Telegram, read marks, who sees them", async () => {
    const { url } = await run(salon.admin, (ctx) => telegramLink(ctx, { self: true }));
    const chatId = chat();
    const greeting = await handleTelegramUpdate({ message: { chat: { id: chatId }, text: `/start ${new URL(url).searchParams.get("start")}` } }, NOW);
    expect(greeting.reply).toContain("уведомления");
    expect((await run(salon.admin, (ctx) => messagingSettings(ctx))).telegram.selfLinked).toBe(true);

    await run(salon.admin, (ctx) => notifyDesk(ctx, { branchId: salon.branchId, kind: "test", title: "Новая запись", body: "Завтра 10:00" }));
    expect(toChat(chatId).at(-1)?.payload.text).toBe("Новая запись\nЗавтра 10:00");
    // The other branch's news do not reach this admin's chat.
    await run(salon.owner, (ctx) => notifyDesk(ctx, { branchId: salon.otherBranchId, kind: "test", title: "Другой филиал" }));
    expect(toChat(chatId).at(-1)?.payload.text).toBe("Новая запись\nЗавтра 10:00");

    const before = await run(salon.admin, (ctx) => listNotifications(ctx));
    expect(before.unread).toBeGreaterThan(0);
    expect(before.items.some((item) => item.title === "Другой филиал")).toBe(false);
    const after = await run(salon.admin, (ctx) => markNotificationsRead(ctx));
    expect(after.unread).toBe(0);
    expect((await run(salon.owner, (ctx) => listNotifications(ctx))).unread).toBeGreaterThan(0);
    expect(await run(salon.master, (ctx) => listNotifications(ctx))).toEqual({ unread: 0, items: [] });
  });

  it("MSG-SET-01 channels and operator details are owner-only and validated", async () => {
    await expect(run(salon.admin, (ctx) => updateMessagingSettings(ctx, { order: ["log"] }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.owner, (ctx) => updateMessagingSettings(ctx, { order: ["pigeon"] }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.owner, (ctx) => updateMessagingSettings(ctx, { legalInn: "123" }))).rejects.toMatchObject({ code: "VALIDATION" });
    const saved = await run(salon.owner, (ctx) =>
      updateMessagingSettings(ctx, { order: ["sms", "telegram", "log"], legalName: "ИП Иванова О. А.", legalInn: "770123456789", privacyEmail: "PD@Salon.ru" }),
    );
    expect(saved).toMatchObject({ order: ["sms", "telegram", "log"], legalName: "ИП Иванова О. А.", privacyEmail: "pd@salon.ru" });
    const rows = await run(salon.owner, (ctx) => many<{ action: string }>(ctx.db, "SELECT action FROM audit_log WHERE action = 'messaging.settings'"));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("MSG-SEND-01 every attempt is logged, including clients nobody can reach", async () => {
    const lonely = crypto.randomUUID();
    await run(salon.owner, (ctx) => ctx.db.query("INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Без связи')", [lonely, salon.tenantId]));
    const result = await run(salon.admin, (ctx) => deliverToClient(ctx, { clientId: lonely, branchId: salon.branchId, kind: "manual", body: "Тест" }));
    expect(result).toMatchObject({ status: "failed" });
  });
});
