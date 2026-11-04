import { beforeAll, describe, expect, it } from "vitest";
import { cancelAppointment, createAppointment, exportAppointmentsCsv, getAppointment, getJournal, moveAppointment, restoreAppointment, updateAppointment } from "@/server/appointments";
import { asOnline, confirmBooking, createHold, findOrCreateClient, listSlots, loadOnlineBranch, publicCatalog } from "@/server/booking";
import { createClient, listClients, updateClient } from "@/server/clients";
import { saveField } from "@/server/custom-fields";
import { many } from "@/server/db";
import { cancelEvent, completeEvent, enroll, enrollOnline, getEvent, groupStats, markArrived, paySeat, saveEvent, setParticipantStatus } from "@/server/groups";
import { mergeClients } from "@/server/merge";
import { openShift } from "@/server/payments";
import { sendDueReminders } from "@/server/reminders";
import { deleteResource, saveResource } from "@/server/resources";
import { DAY, NOW, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let roomA: string;
let roomB: string;
let laser: string;

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
});

const book = (staffId: string, time: string, extra: Record<string, unknown> = {}) =>
  run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId, clientId: salon.clientId, startsAt: at(time, "2026-11-10"), services: [{ serviceId: salon.serviceId }], acknowledgeSoft: true, forceOverlap: false, ...extra }),
  );

describe("resources (RES)", () => {
  it("RES-CRUD-01 owner/admin create; masters read only; validation", async () => {
    await expect(run(salon.master, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: "Кабинет 1" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.admin, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: " " }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.admin, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: "Х", capacity: 0 }))).rejects.toMatchObject({ code: "VALIDATION" });
    roomA = (await run(salon.admin, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: "Кабинет 1", kind: "room", serviceIds: [salon.serviceId] }))).id;
    roomB = (await run(salon.admin, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: "Кабинет 2", kind: "room", serviceIds: [salon.serviceId] }))).id;
    const device = await run(salon.admin, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: "Лазер", kind: "equipment", capacity: 1, openMin: 600, closeMin: 1080, serviceIds: [salon.serviceId] }));
    laser = device.id;
    expect(device).toMatchObject({ kind: "equipment", openMin: 600, closeMin: 1080, serviceIds: [salon.serviceId] });
  });

  it("RES-LINK-01 / RES-BOOK-01 a room and the device are picked; the second room is used when the first is busy; none free → CONFLICT_RESOURCE", async () => {
    const first = await book(salon.staffA, "11:00");
    expect(first.resources.map((row) => row.title).sort()).toEqual(["Кабинет 1", "Лазер"]);
    // Another master at the same time: rooms are fine, but the only laser is taken.
    await expect(book(salon.staffB, "11:00")).rejects.toMatchObject({ code: "CONFLICT_RESOURCE" });
    await run(salon.admin, (ctx) => saveResource(ctx, { id: laser, branchId: salon.branchId, capacity: 2 }));
    const second = await book(salon.staffB, "11:00");
    expect(second.resources.map((row) => row.title).sort()).toEqual(["Кабинет 2", "Лазер"]);
    // Outside the device's hours: a soft warning.
    await expect(run(salon.admin, (ctx) => createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: salon.clientId, startsAt: at("19:00", "2026-11-10"), services: [{ serviceId: salon.serviceId }] }))).rejects.toMatchObject({
      code: "SOFT_CONFIRM",
      details: { warnings: expect.arrayContaining(["RESOURCE_HOURS"]) },
    });

    // Moving a visit keeps its room when free and re-checks it.
    const moved = await run(salon.admin, (ctx) => moveAppointment(ctx, first.id, { version: first.version, startsAt: at("14:00", "2026-11-10"), acknowledgeSoft: true }));
    expect(moved.resources.map((row) => row.id)).toContain(roomA);
    // The desk's pick: a busy room is refused.
    await expect(book(salon.staffB, "14:00", { resourceIds: [roomA] })).rejects.toMatchObject({ code: "CONFLICT_RESOURCE" });
    // Switching rooms by hand in the drawer.
    const switched = await run(salon.admin, (ctx) => updateAppointment(ctx, first.id, { version: moved.version, resourceIds: [roomB], acknowledgeSoft: true }));
    expect(switched.resources.map((row) => row.id)).toContain(roomB);

    // Cancelled visits free the room; restoring re-takes it.
    const cancelled = await run(salon.admin, (ctx) => cancelAppointment(ctx, second.id, { version: second.version, reason: "тест" }));
    const third = await book(salon.staffA, "11:00");
    expect(third.resources.map((row) => row.id)).toContain(roomA);
    // Restoring takes whatever room is free now (the second one).
    const restored = await run(salon.admin, (ctx) => restoreAppointment(ctx, second.id, cancelled.version));
    expect(restored.resources.map((row) => row.id)).toContain(roomB);

    const journal = await run(salon.admin, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: "2026-11-10" }));
    expect(journal.resources.map((row) => row.title)).toEqual(["Кабинет 1", "Кабинет 2", "Лазер"]);
    expect(journal.appointments.find((row) => row.id === third.id)?.resourceIds).toContain(roomA);
  });

  it("RES-CRUD-01 a booked resource is only deactivated; online slots respect resources", async () => {
    expect(await run(salon.admin, (ctx) => deleteResource(ctx, roomA))).toEqual({ deleted: false, deactivated: true });
    const spare = await run(salon.admin, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: "Склад" }));
    expect(await run(salon.admin, (ctx) => deleteResource(ctx, spare.id))).toEqual({ deleted: true, deactivated: false });
    await run(salon.admin, (ctx) => saveResource(ctx, { id: roomA, branchId: salon.branchId, active: true }));
  });
});

describe("custom fields (CF)", () => {
  it("CF-DEF-01 keys, options and limits are validated", async () => {
    await expect(run(salon.master, (ctx) => saveField(ctx, { entity: "client", key: "skin", label: "Кожа" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.admin, (ctx) => saveField(ctx, { entity: "client", key: "Кожа", label: "Кожа" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.admin, (ctx) => saveField(ctx, { entity: "client", key: "skin", label: "Кожа", type: "select" }))).rejects.toMatchObject({ code: "VALIDATION" });
    const fields = await run(salon.admin, (ctx) => saveField(ctx, { entity: "client", key: "skin", label: "Тип кожи", type: "select", options: ["сухая", "жирная", "комбинированная"], showInOnline: true }));
    expect(fields.find((field) => field.key === "skin")).toMatchObject({ type: "select", showInOnline: true });
    await expect(run(salon.admin, (ctx) => saveField(ctx, { entity: "client", key: "skin", label: "Ещё раз" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.admin, (ctx) => saveField(ctx, { entity: "appointment", key: "length", label: "Длина волос, см", type: "number", required: true, showInJournal: true }));
    await run(salon.admin, (ctx) => saveField(ctx, { entity: "appointment", key: "source", label: "Откуда узнали", type: "multiselect", options: ["Instagram", "2ГИС", "Друзья"], showInOnline: true }));
  });

  it("CF-VAL-01 values are typed, required ones enforced, shown on the block and in the export", async () => {
    await expect(run(salon.admin, (ctx) => createClient(ctx, { name: "Вера", phone: "+79990001122", custom: { skin: "нормальная" } }))).rejects.toMatchObject({ code: "VALIDATION", details: { field: "skin" } });
    const client = await run(salon.admin, (ctx) => createClient(ctx, { name: "Вера", phone: "+79990001122", custom: { skin: "сухая" } }));
    expect(client.custom).toEqual({ skin: "сухая" });
    const updated = await run(salon.admin, (ctx) => updateClient(ctx, client.id, { version: client.version, custom: { skin: "" } }));
    expect(updated.custom).toEqual({});
    await run(salon.admin, (ctx) => updateClient(ctx, client.id, { version: updated.version, custom: { skin: "жирная" } }));
    const filtered = await run(salon.admin, (ctx) => listClients(ctx, "", { field: "skin", value: "жирная" }));
    expect(filtered.map((row) => row.id)).toEqual([client.id]);

    const make = (custom: Record<string, unknown>) =>
      run(salon.admin, (ctx) => createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: client.id, startsAt: at("10:00", "2026-11-12"), services: [{ serviceId: salon.serviceId }], acknowledgeSoft: true, custom }));
    await expect(make({})).rejects.toMatchObject({ code: "VALIDATION", details: { field: "length" } });
    await expect(make({ length: "длинные" })).rejects.toMatchObject({ code: "VALIDATION", details: { field: "length" } });
    const appt = await make({ length: "45,5", source: ["2ГИС", "Друзья"] });
    expect(appt.custom).toEqual({ length: 45.5, source: ["2ГИС", "Друзья"] });
    expect(appt.customView).toEqual([
      { key: "length", label: "Длина волос, см", value: "45.5", stale: false },
      { key: "source", label: "Откуда узнали", value: "2ГИС, Друзья", stale: false },
    ]);
    const journal = await run(salon.admin, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: "2026-11-12" }));
    expect(journal.appointments.find((row) => row.id === appt.id)?.note).toBe("45.5");
    const csv = await run(salon.admin, (ctx) => exportAppointmentsCsv(ctx, { branchId: salon.branchId, date: "2026-11-12" }));
    expect(csv.split("\n")[0]).toContain("cf_length,cf_source");
    expect(csv).toContain('"2ГИС, Друзья"');

    // Edge 2: the type of a used field is frozen.
    const field = (await run(salon.admin, (ctx) => saveField(ctx, { entity: "appointment", key: "note2", label: "Тест" }))).find((row) => row.key === "length")!;
    await expect(run(salon.admin, (ctx) => saveField(ctx, { id: field.id, type: "text" }))).rejects.toMatchObject({ code: "VALIDATION" });
    // Not required any more, so other tests can book without it.
    await run(salon.admin, (ctx) => saveField(ctx, { id: field.id, required: false }));
  });

  it("CF-ONLINE-01 online fields come with the catalog and are saved on the visit and the card", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET slug = $2 WHERE id = $1", [salon.tenantId, `s${salon.tenantId.slice(0, 6)}`]));
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET online_enabled = true, slug = 'main', online_min_notice_min = 0 WHERE id = $1", [salon.branchId]));
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE services SET online_visible = true WHERE id = $1", [salon.serviceId]));
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE staff SET online_bookable = true"));
    const catalog = await asOnline(salon.tenantId, (ctx) => publicCatalog(ctx, salon.branchId), NOW);
    expect(catalog.fields.map((field) => field.key).sort()).toEqual(["skin", "source"]);

    const slots = await asOnline(salon.tenantId, (ctx) => listSlots(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, from: "2026-11-10", days: 1 }), NOW);
    // 11:00: both rooms are taken; 12:00 is free.
    const times = slots.days[0].slots.map((slot) => slot.time);
    expect(times).not.toContain("11:00");
    expect(times).toContain("12:00");
    // The master is free at 14:00, but with one laser (held by the 14:00 visit) the slot is gone.
    const slotsB = (capacity: number) =>
      run(salon.admin, (ctx) => saveResource(ctx, { id: laser, branchId: salon.branchId, capacity })).then(() =>
        asOnline(salon.tenantId, (ctx) => listSlots(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffB, from: "2026-11-10", days: 1 }), NOW),
      );
    expect((await slotsB(1)).days[0].slots.map((slot) => slot.time)).not.toContain("14:00");
    expect((await slotsB(3)).days[0].slots.map((slot) => slot.time)).toContain("14:00");
    const hold = await asOnline(salon.tenantId, (ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: slots.days[0].slots.find((slot) => slot.time === "12:00")!.startsAt }), NOW);
    const done = await asOnline(salon.tenantId, (ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Онлайн Вера", phone: "+79990003344", consent: true, custom: { skin: "сухая", source: ["Instagram"] } }), NOW);
    const appt = await run(salon.admin, (ctx) => getAppointment(ctx, String(done.appointmentId)));
    expect(appt.custom).toEqual({ source: ["Instagram"] });
    expect(appt.resources.length).toBe(2);
    const card = await run(salon.admin, (ctx) => listClients(ctx, "", { field: "skin", value: "сухая" }));
    expect(card.map((row) => row.name)).toContain("Онлайн Вера");
  });
});

describe("group events (GRP)", () => {
  let eventId: string;
  const people: string[] = [];

  it("GRP-CREATE-01 an event with a hall: the hall is taken whole; host busy is a soft warning; weekly series", async () => {
    const hall = await run(salon.admin, (ctx) => saveResource(ctx, { branchId: salon.branchId, title: "Зал", kind: "room", capacity: 10 }));
    const input = { branchId: salon.branchId, title: "Мастер-класс: макияж", staffId: salon.staffA, resourceId: hall.id, startsAt: at("18:00", DAY), durationMin: 90, capacity: 2, priceMinor: 300000 };
    await expect(run(salon.master, (ctx) => saveEvent(ctx, null, input))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const event = await run(salon.admin, (ctx) => saveEvent(ctx, null, { ...input, repeatWeeks: 2 }));
    eventId = event.id;
    expect(event).toMatchObject({ capacity: 2, freeSeats: 2, resourceTitle: "Зал", staffName: "Алина" });
    const series = await run(salon.admin, (ctx) => many<{ starts_at: Date }>(ctx.db, "SELECT starts_at FROM group_events WHERE series_id = (SELECT series_id FROM group_events WHERE id = $1) ORDER BY starts_at", [eventId]));
    expect(series).toHaveLength(3);
    await expect(run(salon.admin, (ctx) => saveEvent(ctx, null, { ...input, staffId: salon.staffB }))).rejects.toMatchObject({ code: "CONFLICT_RESOURCE" });
    await expect(run(salon.admin, (ctx) => saveEvent(ctx, null, { ...input, resourceId: null }))).rejects.toMatchObject({ code: "SOFT_CONFIRM" });
  });

  it("GRP-ENROLL-01 / GRP-WAIT-01 seats, duplicates, waitlist and FIFO promotion with a message", async () => {
    for (const name of ["Ира", "Оля", "Катя"]) {
      people.push((await run(salon.admin, (ctx) => createClient(ctx, { name, phone: `+7999${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}` }))).id);
    }
    const a = await run(salon.admin, (ctx) => enroll(ctx, eventId, { clientId: people[0] }));
    expect(a.status).toBe("enrolled");
    await expect(run(salon.admin, (ctx) => enroll(ctx, eventId, { clientId: people[0] }))).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.admin, (ctx) => enroll(ctx, eventId, { clientId: people[1] }));
    await expect(run(salon.admin, (ctx) => enroll(ctx, eventId, { clientId: people[2] }))).rejects.toMatchObject({ code: "VALIDATION", details: { full: true } });
    const waiting = await run(salon.admin, (ctx) => enroll(ctx, eventId, { clientId: people[2], waitlist: true }));
    expect(waiting.status).toBe("waitlisted");
    await expect(run(salon.admin, (ctx) => saveEvent(ctx, eventId, { capacity: 1 }))).rejects.toMatchObject({ code: "VALIDATION" });

    const event = await run(salon.admin, (ctx) => getEvent(ctx, eventId));
    const olya = event.participants.find((row) => row.clientId === people[1])!;
    const left = await run(salon.admin, (ctx) => setParticipantStatus(ctx, olya.id, "cancelled"));
    expect(left.promoted).toHaveLength(1);
    expect(left.event.participants.find((row) => row.clientId === people[2])?.status).toBe("enrolled");
    const told = await run(salon.admin, (ctx) => many<{ kind: string }>(ctx.db, "SELECT kind FROM outbound_messages WHERE client_id = $1 ORDER BY created_at", [people[2]]));
    expect(told.map((row) => row.kind)).toEqual(["group_seat"]);
  });

  it("GRP-PAY-01 / GRP-STATUS-01 / GRP-COMPLETE-01 a seat is paid at the till, arrivals ticked, the rest are no-shows", async () => {
    const event = await run(salon.admin, (ctx) => getEvent(ctx, eventId));
    const ira = event.participants.find((row) => row.clientId === people[0])!;
    await expect(run(salon.admin, (ctx) => paySeat(ctx, ira.id, { tenders: [{ method: "cash", amountMinor: 100 }] }))).rejects.toMatchObject({ code: "VALIDATION" });
    const paid = await run(salon.admin, (ctx) => paySeat(ctx, ira.id, { tenders: [{ method: "card", amountMinor: 300000 }] }));
    expect(paid.event.paid).toBe(1);
    const line = await run(salon.admin, (ctx) => many<{ line_type: string; title: string }>(ctx.db, "SELECT line_type, title FROM payment_lines WHERE payment_id = $1", [paid.paymentId]));
    expect(line).toEqual([{ line_type: "service", title: "Групповое занятие: Мастер-класс: макияж" }]);
    await expect(run(salon.admin, (ctx) => paySeat(ctx, ira.id, { tenders: [{ method: "card", amountMinor: 300000 }] }))).rejects.toMatchObject({ code: "VALIDATION" });

    // The host (master) runs the list of their own event.
    const after = await run(salon.master, (ctx) => markArrived(ctx, eventId, [ira.id]), new Date("2026-11-03T15:05:00Z"));
    expect(after).toMatchObject({ status: "in_progress", arrived: 1 });
    const closed = await run(salon.master, (ctx) => completeEvent(ctx, eventId), new Date("2026-11-03T16:40:00Z"));
    expect(closed.status).toBe("completed");
    expect(closed.participants.find((row) => row.clientId === people[2])?.status).toBe("no_show");
    const stats = await run(salon.admin, (ctx) => groupStats(ctx, { branchId: salon.branchId, from: DAY, to: DAY }));
    expect(stats[0]).toMatchObject({ title: "Мастер-класс: макияж", seats: 2, enrolled: 2, arrived: 1, fillPercent: 100, noShowPercent: 50, revenueMinor: 300000 });
  });

  it("GRP-ONLINE-01 / GRP-REMIND-01 / GRP-CANCEL-01 online seat, last-seat race, reminder once, cancel tells everyone", async () => {
    const next = (await run(salon.admin, (ctx) => many<{ id: string }>(ctx.db, "SELECT id FROM group_events WHERE series_id = (SELECT series_id FROM group_events WHERE id = $1) AND id <> $1 ORDER BY starts_at LIMIT 1", [eventId])))[0].id;
    const catalog = await asOnline(salon.tenantId, (ctx) => publicCatalog(ctx, salon.branchId), NOW);
    expect(catalog.groups.find((row) => row.id === next)).toMatchObject({ freeSeats: 2, priceMinor: 300000 });
    const online = (name: string, phone: string, waitlist = false) =>
      asOnline(salon.tenantId, async (ctx) => enrollOnline(ctx, await loadOnlineBranch(ctx, salon.branchId), next, { name, phone, consent: true, waitlist }, findOrCreateClient), NOW);
    expect(await online("Первая", "+79995550000")).toMatchObject({ status: "enrolled" });
    await online("Вторая", "+79995550001");
    await expect(online("Третья", "+79995550002")).rejects.toMatchObject({ code: "VALIDATION", details: { full: true } });
    expect(await online("Третья", "+79995550002", true)).toMatchObject({ status: "waitlisted" });

    // Reminder window: the job sends it to the seated ones, once.
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET reminder_enabled = true, reminder_hours = 168, quiet_start_min = 0, quiet_end_min = 0 WHERE id = $1", [salon.branchId]));
    const jobCtx = (fn: Parameters<typeof run>[1]) => run(salon.owner, fn, new Date("2026-11-04T12:00:00Z"));
    await jobCtx((ctx) => sendDueReminders(ctx));
    await jobCtx((ctx) => sendDueReminders(ctx));
    const reminders = await run(salon.admin, (ctx) => many<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM outbound_messages WHERE kind = 'group_reminder'"));
    expect(reminders[0].n).toBe(2);

    await expect(run(salon.admin, (ctx) => cancelEvent(ctx, next, {}))).rejects.toMatchObject({ code: "VALIDATION" });
    const off = await run(salon.admin, (ctx) => cancelEvent(ctx, next, { reason: "Мастер заболел" }));
    expect(off.notified).toBe(3);
    expect(off.event.participants.every((row) => row.status === "cancelled")).toBe(true);
  });

  it("merging two cards on the same event keeps one seat", async () => {
    const third = (await run(salon.admin, (ctx) => many<{ id: string }>(ctx.db, "SELECT id FROM group_events WHERE series_id = (SELECT series_id FROM group_events WHERE id = $1) AND status = 'scheduled' ORDER BY starts_at DESC LIMIT 1", [eventId])))[0].id;
    await run(salon.admin, (ctx) => enroll(ctx, third, { clientId: people[0] }));
    await run(salon.admin, (ctx) => enroll(ctx, third, { clientId: people[1] }));
    await run(salon.admin, (ctx) => mergeClients(ctx, people[0], people[1]));
    const event = await run(salon.admin, (ctx) => getEvent(ctx, third));
    expect(event.participants.filter((row) => row.status !== "cancelled").map((row) => row.clientId)).toEqual([people[0]]);
  });
});
