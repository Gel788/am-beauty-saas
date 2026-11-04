import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment, getAppointment, getJournal } from "@/server/appointments";
import {
  asOnline,
  cancelBooking,
  confirmBooking,
  createHold,
  getBooking,
  listSlots,
  publicCatalog,
  releaseHold,
  resolveBookingToken,
  resolvePublicBranch,
} from "@/server/booking";
import { one } from "@/server/db";
import { periodReport } from "@/server/period";
import { NOW, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let tenantSlug = "";
let branchSlug = "";

beforeAll(async () => {
  salon = await createSalon();
  const row = await run(salon.owner, (ctx) =>
    one<{ t: string; b: string }>(
      ctx.db,
      "SELECT t.slug AS t, b.slug AS b FROM tenants t JOIN branches b ON b.tenant_id = t.id WHERE b.id = $1",
      [salon.branchId],
    ),
  );
  tenantSlug = row!.t;
  branchSlug = row!.b;
});

function online<T>(fn: Parameters<typeof asOnline<T>>[1], now = NOW) {
  return asOnline(salon.tenantId, fn, now);
}

function minutesLater(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60000);
}

async function slotsOn(date: string, staffId?: string) {
  const result = await online((ctx) => listSlots(ctx, salon.branchId, { serviceId: salon.serviceId, staffId, from: date, days: 1 }));
  return result.days[0].slots;
}

let phoneSeq = 0;
function freshPhone() {
  phoneSeq += 1;
  return `+7900${salon.tenantId.replace(/\D/g, "").slice(0, 5).padEnd(5, "0")}${String(phoneSeq).padStart(2, "0")}`;
}

async function book(date: string, time: string, staffId: string | null = salon.staffA, phone = freshPhone()) {
  const hold = await online((ctx) =>
    createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId, startsAt: at(time, date) }),
  );
  const booking = await online((ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Онлайн Клиент", phone, consent: true }));
  return { hold, booking };
}

describe("online booking", () => {
  it("resolves the public page by slugs and hides disabled branches", async () => {
    const ids = await resolvePublicBranch(tenantSlug, branchSlug);
    expect(ids).toEqual({ tenantId: salon.tenantId, branchId: salon.branchId });
    await expect(resolvePublicBranch(tenantSlug, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET online_enabled = false WHERE id = $1", [salon.otherBranchId]));
    const other = await run(salon.owner, (ctx) => one<{ slug: string }>(ctx.db, "SELECT slug FROM branches WHERE id = $1", [salon.otherBranchId]));
    await expect(resolvePublicBranch(tenantSlug, other!.slug)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("OB step 1: catalog lists only online_visible active services with a master", async () => {
    const hidden = crypto.randomUUID();
    await run(salon.owner, (ctx) =>
      ctx.db.query(
        "INSERT INTO services (id, tenant_id, title, duration_min, price_minor, online_visible) VALUES ($1, $2, 'Скрытая', 30, 1000, false)",
        [hidden, salon.tenantId],
      ),
    );
    const catalog = await online((ctx) => publicCatalog(ctx, salon.branchId));
    const ids = catalog.services.map((service) => service.id);
    expect(ids).toContain(salon.serviceId);
    expect(ids).not.toContain(hidden);
    expect(catalog.services.find((service) => service.id === salon.serviceId)?.staffIds.sort()).toEqual([salon.staffA, salon.staffB].sort());
    await expect(
      online((ctx) => listSlots(ctx, salon.branchId, { serviceId: hidden })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("OB-SLOT-01 respects working hours, notice, busy time and the advance window", async () => {
    // NOW is 12:00 local; notice 60 min → first slot 13:00. Work 09:00–21:00, service 60 min → last 20:00.
    const today = await slotsOn("2026-11-03", salon.staffA);
    expect(today[0].time).toBe("13:00");
    expect(today.at(-1)?.time).toBe("20:00");
    expect(today.every((slot) => new Date(slot.startsAt).getTime() > NOW.getTime())).toBe(true);

    await run(salon.admin, (ctx) =>
      createAppointment(ctx, {
        branchId: salon.branchId,
        staffId: salon.staffA,
        clientId: salon.clientId,
        startsAt: at("14:00", "2026-11-04"),
        services: [{ serviceId: salon.serviceId }],
      }),
    );
    const times = (await slotsOn("2026-11-04", salon.staffA)).map((slot) => slot.time);
    expect(times).toContain("13:00");
    expect(times).not.toContain("13:15");
    expect(times).not.toContain("14:45");
    expect(times).toContain("15:00");
    const any = await slotsOn("2026-11-04");
    expect(any.find((slot) => slot.time === "14:00")?.staffIds).toEqual([salon.staffB]);

    expect(await slotsOn("2026-11-02")).toEqual([]);
    expect(await slotsOn("2026-12-10")).toEqual([]);
  });

  it("OB-SLOT-01 counts the service buffer", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE services SET buffer_after_min = 15 WHERE id = $1", [salon.serviceId]));
    const times = (await slotsOn("2026-11-05", salon.staffA)).map((slot) => slot.time);
    expect(times.at(-1)).toBe("19:45");
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE services SET buffer_after_min = 0 WHERE id = $1", [salon.serviceId]));
  });

  it("OB-SLOT-02 a hold takes the slot; «любой» falls through to the next master", async () => {
    const first = await online((ctx) =>
      createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: null, startsAt: at("10:00", "2026-11-06") }),
    );
    const second = await online((ctx) =>
      createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: null, startsAt: at("10:00", "2026-11-06") }),
    );
    expect(new Set([first.staffId, second.staffId])).toEqual(new Set([salon.staffA, salon.staffB]));
    await expect(
      online((ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: null, startsAt: at("10:00", "2026-11-06") })),
    ).rejects.toMatchObject({ code: "CONFLICT_SLOT" });
    expect((await slotsOn("2026-11-06")).find((slot) => slot.time === "10:00")).toBeUndefined();

    await online((ctx) => releaseHold(ctx, salon.branchId, first.holdId));
    expect((await slotsOn("2026-11-06")).find((slot) => slot.time === "10:00")?.staffIds).toEqual([first.staffId]);
  });

  it("OB-SLOT-02 race: two clients grab the same slot, exactly one wins", async () => {
    const attempt = () =>
      online((ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("11:00", "2026-11-07") }));
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.every((result) => result.reason.code === "CONFLICT_SLOT")).toBe(true);
  });

  it("OB-SLOT-02 an expired hold cannot be confirmed and frees the slot", async () => {
    const hold = await online((ctx) =>
      createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("12:00", "2026-11-08") }),
    );
    const later = minutesLater(11);
    await expect(
      online((ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Ира", phone: freshPhone(), consent: true }), later),
    ).rejects.toMatchObject({ code: "CONFLICT_SLOT", details: { reason: "HOLD_EXPIRED" } });
    const result = await online(
      (ctx) => listSlots(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, from: "2026-11-08", days: 1 }),
      later,
    );
    expect(result.days[0].slots.map((slot) => slot.time)).toContain("12:00");
  });

  it("OB-CLIENT-01 confirm creates an online appointment, reusing the client by phone", async () => {
    const existing = await run(salon.owner, (ctx) =>
      one<{ phone_e164: string }>(ctx.db, "SELECT phone_e164 FROM client_phones WHERE client_id = $1", [salon.clientId]),
    );
    const { booking } = await book("2026-11-09", "10:00", salon.staffA, existing!.phone_e164.replace("+7", "8"));
    const appt = await run(salon.admin, (ctx) => getAppointment(ctx, booking.appointmentId as string));
    expect(appt.source).toBe("online");
    expect(appt.status).toBe("scheduled");
    expect(appt.clientId).toBe(salon.clientId);
    expect(appt.history.some((entry) => entry.action === "appointment.online_booked")).toBe(true);

    const phone = freshPhone();
    const second = await book("2026-11-09", "12:00", salon.staffA, phone);
    const created = await run(salon.admin, (ctx) => getAppointment(ctx, second.booking.appointmentId as string));
    expect(created.clientId).not.toBe(salon.clientId);
    expect(created.clientName).toBe("Онлайн Клиент");

    const journal = await run(salon.admin, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: "2026-11-09" }));
    expect(JSON.stringify(journal)).toContain('"source":"online"');
  });

  it("OB edge 4: double submit with the same idempotency key returns the same booking", async () => {
    const hold = await online((ctx) =>
      createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffB, startsAt: at("10:00", "2026-11-10") }),
    );
    const phone = freshPhone();
    const input = { holdId: hold.holdId, name: "Лена", phone, idempotencyKey: "k-1", consent: true };
    const a = await online((ctx) => confirmBooking(ctx, salon.branchId, input));
    const b = await online((ctx) => confirmBooking(ctx, salon.branchId, input));
    expect(b).toEqual(a);
    await expect(
      online((ctx) => confirmBooking(ctx, salon.branchId, { ...input, idempotencyKey: "k-2" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("OB edge 1: master deactivated after the hold fails on confirm", async () => {
    const hold = await online((ctx) =>
      createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffB, startsAt: at("15:00", "2026-11-11") }),
    );
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE staff SET online_bookable = false WHERE id = $1", [salon.staffB]));
    try {
      await expect(
        online((ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Оля", phone: freshPhone(), consent: true })),
      ).rejects.toMatchObject({ code: "CONFLICT_SLOT", details: { reason: "STAFF_UNAVAILABLE" } });
    } finally {
      await run(salon.owner, (ctx) => ctx.db.query("UPDATE staff SET online_bookable = true WHERE id = $1", [salon.staffB]));
    }
  });

  it("OB-SLOT-02 an admin booking over the hold wins; the client is sent back to step 2", async () => {
    const hold = await online((ctx) =>
      createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("16:00", "2026-11-12") }),
    );
    await run(salon.admin, (ctx) =>
      createAppointment(ctx, {
        branchId: salon.branchId,
        staffId: salon.staffA,
        clientId: salon.clientId,
        startsAt: at("16:30", "2026-11-12"),
        services: [{ serviceId: salon.serviceOnlyA }],
      }),
    );
    await expect(
      online((ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Оля", phone: freshPhone(), consent: true })),
    ).rejects.toMatchObject({ code: "CONFLICT_SLOT", details: { reason: "SLOT_TAKEN" } });
  });

  it("OB abuse: caps active future online bookings per phone", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET online_max_active_per_phone = 2 WHERE id = $1", [salon.branchId]));
    const phone = freshPhone();
    await book("2026-11-13", "10:00", salon.staffA, phone);
    await book("2026-11-13", "12:00", salon.staffA, phone);
    await expect(book("2026-11-13", "14:00", salon.staffA, phone)).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET online_max_active_per_phone = 3 WHERE id = $1", [salon.branchId]));
  });

  it("OB-CANCEL-01 the client cancels inside the window by link", async () => {
    const { booking } = await book("2026-11-14", "10:00", salon.staffB);
    const { appointmentId } = await resolveBookingToken(booking.cancelToken as string);
    expect(appointmentId).toBe(booking.appointmentId);
    const view = await online((ctx) => getBooking(ctx, appointmentId));
    expect(view.canCancel).toBe(true);
    const result = await online((ctx) => cancelBooking(ctx, appointmentId, { reason: "заболела" }));
    expect(result.outcome).toBe("cancelled");
    expect(result.status).toBe("cancelled");
    expect((await slotsOn("2026-11-14", salon.staffB)).map((slot) => slot.time)).toContain("10:00");
    await expect(resolveBookingToken("0".repeat(64))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("OB-CANCEL-01 after the window it becomes a request to the admin", async () => {
    const { booking } = await book("2026-11-03", "18:00", salon.staffB);
    const result = await online((ctx) => cancelBooking(ctx, booking.appointmentId as string));
    expect(result.outcome).toBe("requested");
    expect(result.status).toBe("scheduled");
    const appt = await run(salon.admin, (ctx) => getAppointment(ctx, booking.appointmentId as string));
    expect(appt.history.some((entry) => entry.action === "appointment.cancel_requested")).toBe(true);
  });

  it("OB-SRC-01 the link's ?src= is kept on the visit and on a new client, and shows in the period report", async () => {
    const hold = await online((ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("16:00", "2026-11-16") }));
    const booking = await online((ctx) =>
      confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "С Карт", phone: freshPhone(), consent: true, channel: "YandexMaps" }),
    );
    const appt = await run(salon.admin, (ctx) => getAppointment(ctx, booking.appointmentId as string));
    expect(appt.channel).toBe("yandex");
    const client = await run(salon.admin, (ctx) => one<{ channel: string }>(ctx.db, "SELECT channel FROM clients WHERE id = $1", [appt.clientId]));
    expect(client?.channel).toBe("yandex");
    // A junk value is dropped instead of failing the booking.
    const junk = await online((ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("18:00", "2026-11-16") }));
    const plain = await online((ctx) => confirmBooking(ctx, salon.branchId, { holdId: junk.holdId, name: "Без метки", phone: freshPhone(), consent: true, channel: "!!!" }));
    expect((await run(salon.admin, (ctx) => getAppointment(ctx, plain.appointmentId as string))).channel).toBeNull();
    const report = await run(salon.owner, (ctx) => periodReport(ctx, { branchId: salon.branchId, from: "2026-11-16", to: "2026-11-16" }));
    expect(report.channels).toEqual(expect.arrayContaining([{ channel: "yandex", bookings: 1, completed: 0 }, { channel: null, bookings: 1, completed: 0 }]));
    expect(report.sources).toEqual(expect.arrayContaining([{ source: "online:yandex", clients: 1 }]));
  });
});
