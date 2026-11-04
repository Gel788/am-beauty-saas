import { beforeAll, describe, expect, it } from "vitest";
import { cancelAppointment, createAppointment } from "@/server/appointments";
import { asOnline, confirmBooking, createHold } from "@/server/booking";
import { many, one } from "@/server/db";
import {
  createWaitlistEntry,
  listReviews,
  listWaitlist,
  matchWaitlistOnCancel,
  moderateReview,
  offerWaitlistSlot,
  publicReviewInfo,
  publicReviews,
  rebookAppointment,
  rebookDue,
  resolveReviewToken,
  reviewsCsv,
  runRetentionForTenant,
  sendRebookReminder,
  submitReview,
  updateRetentionSettings,
} from "@/server/retention";
import { addCalendarDays, formatLocalDate } from "@/domain/time";
import { DAY, NOW, TZ, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
});

let seq = 0;
async function newClient(opts: { marketing?: boolean; birth?: string } = {}) {
  seq += 1;
  const id = crypto.randomUUID();
  const phone = `+7901${salon.tenantId.replace(/\D/g, "").slice(0, 5).padEnd(5, "0")}${String(seq).padStart(2, "0")}`;
  await run(salon.owner, async (ctx) => {
    await ctx.db.query("INSERT INTO clients (id, tenant_id, name, source, consent_marketing, birth_date) VALUES ($1,$2,$3,'walk-in',$4,$5)", [id, salon.tenantId, `Клиент ${seq} Тестова`, opts.marketing ?? false, opts.birth ?? null]);
    await ctx.db.query("INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary) VALUES ($1,$2,$3,$4,true)", [crypto.randomUUID(), salon.tenantId, id, phone]);
  });
  return { id, phone };
}

async function visit(clientId: string, day: string, time: string, status?: string, staffId = salon.staffA) {
  const created = await run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId, clientId, startsAt: at(time, day), services: [{ serviceId: salon.serviceId }], acknowledgeSoft: true }),
  );
  if (status) await run(salon.owner, (ctx) => ctx.db.query("UPDATE appointments SET status = $2 WHERE id = $1", [created.id, status]));
  return created;
}

function messages(clientId: string, kind: string) {
  return run(salon.owner, (ctx) => many<{ body: string; status: string }>(ctx.db, "SELECT body, status FROM outbound_messages WHERE client_id = $1 AND kind = $2 ORDER BY created_at", [clientId, kind]));
}

describe("reviews", () => {
  it("REV-REQUEST/CREATE/MOD: request after the visit, one review per visit, moderation, public ratings", async () => {
    const client = await newClient();
    const done = await visit(client.id, DAY, "08:30", "completed");
    const fresh = await visit(client.id, DAY, "10:30", "completed", salon.staffB); // ends 11:30, too recent
    const first = await run(salon.owner, (ctx) => runRetentionForTenant(ctx));
    expect(first.reviews).toBe(1);
    const again = await run(salon.owner, (ctx) => runRetentionForTenant(ctx));
    expect(again.reviews).toBe(0);
    const [request] = await messages(client.id, "review_request");
    expect(request.body).toContain("Алина");
    const token = request.body.match(/\/r\/([a-f0-9]{64})/)![1];
    const resolved = await resolveReviewToken(token);
    expect(resolved).toEqual({ tenantId: salon.tenantId, appointmentId: done.id });
    expect(fresh.id).not.toBe(done.id);

    const online = <T,>(fn: Parameters<typeof asOnline<T>>[1]) => asOnline(salon.tenantId, fn, NOW);
    const info = await online((ctx) => publicReviewInfo(ctx, done.id));
    expect(info).toMatchObject({ staffName: "Алина", services: "Маникюр", review: null });
    await expect(online((ctx) => submitReview(ctx, done.id, { rating: 7 }))).rejects.toMatchObject({ code: "VALIDATION" });
    const created = await online((ctx) => submitReview(ctx, done.id, { rating: 5, body: "Очень аккуратно, спасибо!" }));
    expect(created.status).toBe("pending");
    await expect(online((ctx) => submitReview(ctx, done.id, { rating: 4 }))).rejects.toMatchObject({ code: "VALIDATION" });

    // Masters see what was said about them, without moderation rights.
    const mine = await run(salon.master, (ctx) => listReviews(ctx, { branchId: salon.branchId }));
    expect(mine.items.map((row) => row.id)).toEqual([created.id]);
    await expect(run(salon.master, (ctx) => moderateReview(ctx, created.id, { action: "publish" }))).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await online((ctx) => publicReviews(ctx, salon.branchId))).staff).toEqual([]);
    const published = await run(salon.admin, (ctx) => moderateReview(ctx, created.id, { action: "publish", reply: "Спасибо, ждём снова!" }));
    expect(published).toMatchObject({ status: "published", reply: "Спасибо, ждём снова!" });
    const widget = await online((ctx) => publicReviews(ctx, salon.branchId));
    expect(widget.staff).toEqual([{ staffId: salon.staffA, rating: 5, count: 1 }]);
    expect(widget.latest[0]).toMatchObject({ rating: 5, author: "Клиент" });

    await expect(run(salon.admin, (ctx) => moderateReview(ctx, created.id, { action: "reject" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.admin, (ctx) => moderateReview(ctx, created.id, { action: "delete" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const csv = await run(salon.admin, (ctx) => reviewsCsv(ctx, salon.branchId, DAY, DAY));
    expect(csv).toContain("Очень аккуратно");
  });

  it("a low score reaches the desk right away; a cancelled visit takes no review", async () => {
    const client = await newClient();
    const done = await visit(client.id, DAY, "07:00", "completed");
    await run(salon.owner, (ctx) => updateRetentionSettings(ctx, salon.branchId, { reviewModeration: false }));
    const result = await asOnline(salon.tenantId, (ctx) => submitReview(ctx, done.id, { rating: 2, body: "Долго ждала" }), NOW);
    expect(result.status).toBe("published");
    const note = await run(salon.owner, (ctx) => one<{ title: string }>(ctx.db, "SELECT title FROM notifications WHERE entity_id = $1", [result.id]));
    expect(note!.title).toContain("Низкая оценка");
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [done.id]));
    await expect(asOnline(salon.tenantId, (ctx) => publicReviewInfo(ctx, done.id), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await run(salon.owner, (ctx) => updateRetentionSettings(ctx, salon.branchId, { reviewModeration: true }));
  });
});

describe("waitlist", () => {
  it("WAIT-MATCH/OFFER: a cancelled slot is matched and offered to the waiting client", async () => {
    const day = addCalendarDays(DAY, 2);
    const waiting = await newClient();
    const other = await newClient();
    const entry = await run(salon.admin, (ctx) =>
      createWaitlistEntry(ctx, { branchId: salon.branchId, clientId: waiting.id, staffId: salon.staffA, serviceId: salon.serviceId, dateFrom: DAY, dateTo: day, timeFromMin: 600, timeToMin: 840 }),
    );
    // Too late in the day for this client.
    await run(salon.admin, (ctx) => createWaitlistEntry(ctx, { branchId: salon.branchId, clientId: other.id, dateFrom: day, timeFromMin: 1080, timeToMin: 1260 }));
    await expect(run(salon.admin, (ctx) => createWaitlistEntry(ctx, { branchId: salon.branchId, clientId: other.id, dateFrom: "2020-01-01" }))).rejects.toMatchObject({ code: "VALIDATION" });

    const booked = await visit(other.id, day, "11:00");
    await run(salon.admin, (ctx) => cancelAppointment(ctx, booked.id, { version: booked.version, reason: "заболела" }));
    expect(await run(salon.admin, (ctx) => matchWaitlistOnCancel(ctx, booked.id))).toBe(1);
    const list = await run(salon.admin, (ctx) => listWaitlist(ctx, salon.branchId));
    const slot = list.slots.find((item) => item.appointmentId === booked.id)!;
    expect(slot.matches).toEqual([entry.id]);

    const offer = await run(salon.admin, (ctx) => offerWaitlistSlot(ctx, entry.id, { appointmentId: booked.id }));
    expect(offer.sent).toBe(true);
    const [message] = await messages(waiting.id, "waitlist_offer");
    expect(message.body).toContain("Клиент");
    expect(message.body).toContain("/b/");

    // Someone takes the time: the window is no longer free.
    await visit(other.id, day, "11:00");
    const after = await run(salon.admin, (ctx) => listWaitlist(ctx, salon.branchId));
    expect(after.slots.find((item) => item.appointmentId === booked.id)).toBeUndefined();
    await expect(run(salon.master, (ctx) => listWaitlist(ctx, salon.branchId))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("no-show policy", () => {
  it("NOSHOW-01 online booking asks a client with two no-shows to call", async () => {
    const client = await newClient();
    await visit(client.id, addCalendarDays(DAY, -10), "10:00", "no_show");
    await visit(client.id, addCalendarDays(DAY, -3), "10:00", "no_show");
    const day = addCalendarDays(DAY, 3);
    const hold = await asOnline(salon.tenantId, (ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("12:00", day) }), NOW);
    await expect(
      asOnline(salon.tenantId, (ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Клиент", phone: client.phone, consent: true }), NOW),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "NOSHOW_LIMIT" } });
    await run(salon.owner, (ctx) => updateRetentionSettings(ctx, salon.branchId, { noshowBlockAfter: 0 }));
    const ok = await asOnline(salon.tenantId, (ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Клиент", phone: client.phone, consent: true }), NOW);
    expect(ok.appointmentId).toBeTruthy();
    await run(salon.owner, (ctx) => updateRetentionSettings(ctx, salon.branchId, { noshowBlockAfter: 2 }));
  });
});

describe("coming back", () => {
  it("REBOOK-01 books the same master and time N weeks later, or the nearest free time", async () => {
    const client = await newClient();
    const done = await visit(client.id, DAY, "15:00", "completed");
    const target = addCalendarDays(DAY, 21);
    const first = await run(salon.admin, (ctx) => rebookAppointment(ctx, done.id, { weeks: 3 }));
    expect(first.exact).toBe(true);
    expect(first.appointment.startsAt).toBe(at("15:00", target));
    expect(first.appointment.staffId).toBe(salon.staffA);
    // The same time is now taken: the next one moves by half an hour.
    const second = await run(salon.admin, (ctx) => rebookAppointment(ctx, done.id, { weeks: 3 }));
    expect(second.exact).toBe(false);
    expect(second.appointment.startsAt).toBe(at("16:00", target));
    const scheduled = await visit(client.id, addCalendarDays(DAY, 5), "10:00");
    await expect(run(salon.admin, (ctx) => rebookAppointment(ctx, scheduled.id, { weeks: 3 }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("REBOOK-DUE-01 due list, consent-gated reminders, once per visit", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE services SET rebook_days = 21 WHERE id = $1", [salon.serviceId]));
    const yes = await newClient({ marketing: true });
    const no = await newClient();
    await visit(yes.id, addCalendarDays(DAY, -25), "10:00", "completed");
    await visit(no.id, addCalendarDays(DAY, -24), "10:00", "completed");
    const due = await run(salon.admin, (ctx) => rebookDue(ctx, salon.branchId));
    const row = due.find((item) => item.clientId === yes.id)!;
    expect(row).toMatchObject({ rebookDays: 21, overdueDays: 4, marketing: true, remindedAt: null });
    expect(due.some((item) => item.clientId === no.id)).toBe(true);
    await expect(run(salon.admin, (ctx) => sendRebookReminder(ctx, salon.branchId, no.id))).rejects.toMatchObject({ code: "VALIDATION" });

    await run(salon.owner, (ctx) => updateRetentionSettings(ctx, salon.branchId, { rebookEnabled: true }));
    const job = await run(salon.owner, (ctx) => runRetentionForTenant(ctx));
    expect(job.rebook).toBeGreaterThanOrEqual(1);
    expect(await messages(yes.id, "rebook")).toHaveLength(1);
    expect(await messages(no.id, "rebook")).toHaveLength(0);
    await run(salon.owner, (ctx) => runRetentionForTenant(ctx));
    expect(await messages(yes.id, "rebook")).toHaveLength(1);
    expect((await run(salon.admin, (ctx) => rebookDue(ctx, salon.branchId))).find((item) => item.clientId === yes.id)!.remindedAt).not.toBeNull();
    // A future booking takes the client off the list.
    await visit(yes.id, addCalendarDays(DAY, 4), "10:00");
    expect((await run(salon.admin, (ctx) => rebookDue(ctx, salon.branchId))).some((item) => item.clientId === yes.id)).toBe(false);
    await run(salon.owner, (ctx) => updateRetentionSettings(ctx, salon.branchId, { rebookEnabled: false }));
  });

  it("BIRTHDAY-01 greets once a year, only with marketing consent", async () => {
    const today = formatLocalDate(NOW, TZ);
    const birth = `1990-${today.slice(5)}`;
    const yes = await newClient({ marketing: true, birth });
    const no = await newClient({ birth });
    await visit(yes.id, addCalendarDays(DAY, -40), "10:00", "completed");
    await visit(no.id, addCalendarDays(DAY, -40), "11:00", "completed");
    await run(salon.owner, (ctx) => updateRetentionSettings(ctx, salon.branchId, { birthdayEnabled: true }));
    await run(salon.owner, (ctx) => runRetentionForTenant(ctx));
    await run(salon.owner, (ctx) => runRetentionForTenant(ctx));
    const sent = await messages(yes.id, "birthday");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/^Клиент, .*поздравляет/);
    expect(await messages(no.id, "birthday")).toHaveLength(0);
  });
});
