import { beforeAll, describe, expect, it } from "vitest";
import { sandboxPay } from "@/server/acquiring";
import { createAppointment, getJournal } from "@/server/appointments";
import { asOnline, confirmBooking, createHold, publicCatalog } from "@/server/booking";
import { updateService } from "@/server/catalog";
import { many, one } from "@/server/db";
import { completeEvent, enroll, markArrived, saveEvent } from "@/server/groups";
import { adjustBonus, clientLoyalty, expireBonuses, updateLoyaltySettings } from "@/server/loyalty";
import { createPayment, openShift } from "@/server/payments";
import { calculatePeriod, createPeriod } from "@/server/payroll";
import { runTenantJobs } from "@/server/reminders";
import { updateBranch } from "@/server/settings";
import { NOW, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
const DAY_MS = 86_400_000;
const later = (days: number, minutes = 0) => new Date(NOW.getTime() + days * DAY_MS + minutes * 60_000);

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
});

let day = 0;
async function paidVisit(now = NOW) {
  day += 1;
  const appt = await run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: salon.clientId, startsAt: at("10:00", `2026-12-${String(day).padStart(2, "0")}`), services: [{ serviceId: salon.serviceId }] }),
  );
  await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "card", amountMinor: appt.priceMinor }] }), now);
  return appt;
}

describe("bonus tiers and expiry (LOY)", () => {
  it("LOY-TIER-01 the tier reached by lifetime spend sets the earn rate", async () => {
    await expect(run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { tiers: [{ title: "", minSpendMinor: 0, earnBps: 500 }] }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { tiers: [{ title: "A", minSpendMinor: 0, earnBps: 500 }, { title: "B", minSpendMinor: 0, earnBps: 700 }] })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const program = await run(salon.admin, (ctx) =>
      updateLoyaltySettings(ctx, { bonusEnabled: true, bonusEarnBps: 300, tiers: [{ title: "Золото", minSpendMinor: 300000, earnBps: 1000 }, { title: "Серебро", minSpendMinor: 0, earnBps: 500 }] }),
    );
    expect(program.tiers.map((tier) => tier.title)).toEqual(["Серебро", "Золото"]);
    const first = await paidVisit();
    let card = await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId));
    expect(card.bonusBalance).toBe(Math.floor(first.priceMinor * 0.05));
    expect(card.tier?.title).toBe("Серебро");
    expect(card.nextTier).toMatchObject({ title: "Золото", leftMinor: 300000 - first.priceMinor });
    await paidVisit(); // 2 × 1500 ₽ reaches Gold with this payment
    card = await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId));
    expect(card.tier?.title).toBe("Золото");
    expect(card.bonusBalance).toBe(Math.floor(first.priceMinor * 0.05) + Math.floor(first.priceMinor * 0.1));
    await run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { tiers: [] }));
  });

  it("LOY-BONUS-EXPIRE-01 points burn FIFO after N days, once", async () => {
    const start = (await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId))).bonusBalance;
    await expect(run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { bonusExpireDays: -1 }))).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { bonusExpireDays: 30 }));
    await run(salon.admin, (ctx) => adjustBonus(ctx, salon.clientId, { delta: 10000, reason: "акция" }), later(20));
    // Spend part of the old points: FIFO takes them from the oldest.
    await run(salon.admin, (ctx) => adjustBonus(ctx, salon.clientId, { delta: -5000, reason: "списание" }), later(21));
    const soon = await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId), later(20));
    expect(soon.expiringSoon).toBe(start - 5000);
    expect(await run(salon.admin, (ctx) => expireBonuses(ctx), later(29))).toBe(0);
    expect(await run(salon.admin, (ctx) => expireBonuses(ctx), later(31))).toBe(start - 5000);
    expect(await run(salon.admin, (ctx) => expireBonuses(ctx), later(32))).toBe(0);
    expect((await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId), later(32))).bonusBalance).toBe(10000);
    expect(await run(salon.admin, (ctx) => expireBonuses(ctx), later(51))).toBe(10000);
    const ledger = (await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId), later(51))).ledger;
    expect(ledger.filter((row) => row.kind === "expire").map((row) => row.delta)).toEqual([-10000, -(start - 5000)]);
    await run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { bonusExpireDays: 0 }));
  });
});

describe("online booking deposit (OB-PAY-01)", () => {
  const online = <T,>(fn: Parameters<typeof asOnline<T>>[1], now = NOW) => asOnline(salon.tenantId, fn, now);
  let phone = 0;
  async function book(time: string, date = "2026-11-06") {
    phone += 1;
    const hold = await online((ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at(time, date) }));
    return online((ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Депозит", phone: `+7901555000${phone}`, consent: true }));
  }

  it("deposit is asked online, paid through the link and confirms the booking", async () => {
    await expect(run(salon.admin, (ctx) => updateBranch(ctx, salon.branchId, { onlineDepositBps: 3000 }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalInn: "770123456789", fiscalPlace: "Москва", acquiringEnabled: true, onlineDepositBps: 3000, onlineDepositMinutes: 30 }));
    const catalog = await online((ctx) => publicCatalog(ctx, salon.branchId));
    const service = catalog.services.find((row) => row.id === salon.serviceId)!;
    expect(service.depositMinor).toBe(Math.round(service.priceMinor * 0.3));

    const booking = await book("10:00");
    expect(booking.deposit).toMatchObject({ amountMinor: service.depositMinor, payUrl: expect.stringMatching(/\/pay\/[a-f0-9]{64}$/) });
    const journal = await run(salon.admin, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: "2026-11-06" }));
    expect(journal.appointments.find((row) => row.id === booking.appointmentId)?.depositDueAt).toBeTruthy();

    const link = await run(salon.admin, (ctx) => one<{ id: string }>(ctx.db, "SELECT id FROM online_payments WHERE appointment_id = $1", [booking.appointmentId]));
    await run(salon.admin, (ctx) => sandboxPay(ctx, link!.id, "card"), later(0, 10));
    const row = await run(salon.admin, (ctx) => one<{ deposit_due_at: Date | null; status: string }>(ctx.db, "SELECT deposit_due_at, status FROM appointments WHERE id = $1", [booking.appointmentId]));
    expect(row).toMatchObject({ deposit_due_at: null, status: "scheduled" });
    const lines = await run(salon.admin, (ctx) => many<{ line_type: string; amount_minor: number }>(ctx.db, "SELECT pl.line_type, pl.amount_minor FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id WHERE p.appointment_id = $1", [booking.appointmentId]));
    expect(lines).toEqual([{ line_type: "deposit", amount_minor: service.depositMinor }]);
    // Nothing to cancel for the paid booking.
    await run(salon.admin, (ctx) => runTenantJobs(ctx), later(0, 45));
    expect((await run(salon.admin, (ctx) => one<{ status: string }>(ctx.db, "SELECT status FROM appointments WHERE id = $1", [booking.appointmentId])))?.status).toBe("scheduled");
  });

  it("unpaid booking is cancelled after the deadline and the slot frees up; a service can opt out", async () => {
    const booking = await book("13:00");
    await run(salon.admin, (ctx) => runTenantJobs(ctx), later(0, 20));
    expect((await run(salon.admin, (ctx) => one<{ status: string }>(ctx.db, "SELECT status FROM appointments WHERE id = $1", [booking.appointmentId])))?.status).toBe("scheduled");
    await run(salon.admin, (ctx) => runTenantJobs(ctx), later(0, 31));
    const row = await run(salon.admin, (ctx) => one<{ status: string; cancel_reason: string; deposit_due_at: Date | null }>(ctx.db, "SELECT status, cancel_reason, deposit_due_at FROM appointments WHERE id = $1", [booking.appointmentId]));
    expect(row).toMatchObject({ status: "cancelled", cancel_reason: "Не внесена предоплата", deposit_due_at: null });
    const links = await run(salon.admin, (ctx) => many<{ status: string }>(ctx.db, "SELECT status FROM online_payments WHERE appointment_id = $1", [booking.appointmentId]));
    expect(links.map((link) => link.status)).toEqual(["canceled"]);
    // The same slot can be booked again.
    const again = await online((ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("13:00", "2026-11-06") }), later(0, 32));
    expect(again.holdId).toBeTruthy();

    await run(salon.admin, (ctx) => updateService(ctx, salon.serviceId, { onlineDepositMinor: 0 }));
    const free = await book("16:00");
    expect(free.deposit).toBeNull();
    await run(salon.admin, (ctx) => updateService(ctx, salon.serviceId, { onlineDepositMinor: null }));
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { onlineDepositBps: 0 }));
  });
});

describe("group host pay (GRP-COMPLETE-01)", () => {
  it("host earns per arrived participant in the payroll period", async () => {
    const created = await run(salon.admin, (ctx) =>
      saveEvent(ctx, null, { branchId: salon.branchId, title: "Мастер-класс", startsAt: at("18:00", "2026-11-03"), durationMin: 60, capacity: 5, priceMinor: 100000, staffId: salon.staffB, hostPayMode: "per_attendee", hostPayMinor: 50000 }),
    );
    const eventId = (created as { id: string }).id;
    await expect(run(salon.admin, (ctx) => saveEvent(ctx, eventId, { hostPayMode: "bogus" }))).rejects.toMatchObject({ code: "VALIDATION" });
    const seat = await run(salon.admin, (ctx) => enroll(ctx, eventId, { clientId: salon.clientId }));
    const detail = seat.event!;
    await run(salon.admin, (ctx) => markArrived(ctx, eventId, [detail.participants[0].id]), new Date("2026-11-03T15:05:00Z"));
    await run(salon.admin, (ctx) => completeEvent(ctx, eventId), new Date("2026-11-03T16:10:00Z"));
    const period = await run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-11-01", endsOn: "2026-11-30" }));
    const sheet = await run(salon.admin, (ctx) => calculatePeriod(ctx, period.id), new Date("2026-11-05T10:00:00Z"));
    const host = sheet.items.find((item) => item.staffId === salon.staffB)!;
    expect(host.lines.filter((line) => line.type === "group").map((line) => line.resultMinor)).toEqual([50000]);
    expect(host.payoutMinor).toBeGreaterThanOrEqual(50000);
  });
});
