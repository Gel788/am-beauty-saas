import { beforeAll, describe, expect, it } from "vitest";
import { cancelAppointment, createAppointment, getAppointment } from "@/server/appointments";
import { refundPayment, voidPayment } from "@/server/cash";
import { one } from "@/server/db";
import {
  adjustBonus,
  applyPromo,
  clientLoyalty,
  createPlan,
  createPromo,
  extendMembership,
  findCertificate,
  freezeMembership,
  removePromo,
  updateLoyaltySettings,
  voidCertificate,
} from "@/server/loyalty";
import { createPayment, openShift } from "@/server/payments";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let day = 1;

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
});

/** Each visit on its own future day, so the schedule never clashes. */
function visit(serviceId = salon.serviceId) {
  day += 1;
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId: salon.staffA,
      clientId: salon.clientId,
      startsAt: at("10:00", `2026-12-${String(day).padStart(2, "0")}`),
      services: [{ serviceId }],
    }),
  );
}

const balance = async () => (await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId))).bonusBalance;

describe("loyalty", () => {
  it("LOY settings: only owner/admin configure the programme", async () => {
    await expect(run(salon.master, (ctx) => updateLoyaltySettings(ctx, { bonusEnabled: true }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { bonusEarnBps: 20000 }))).rejects.toMatchObject({ code: "VALIDATION" });
    const program = await run(salon.admin, (ctx) => updateLoyaltySettings(ctx, { bonusEnabled: true, bonusEarnBps: 500, bonusBurnMaxBps: 3000 }));
    expect(program).toMatchObject({ bonusEnabled: true, bonusEarnBps: 500 });
  });

  it("LOY-BONUS-EARN-01 earns on paid services, not on tips", async () => {
    const appt = await visit();
    await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "card", amountMinor: 160000 }], tipMinor: 10000 }),
    );
    expect(await balance()).toBe(7500);
  });

  it("LOY-BONUS-BURN-01 pays with points within the cap; refund gives points back and claws back the earn", async () => {
    const appt = await visit();
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "bonus", amountMinor: 9000 }, { method: "card", amountMinor: 141000 }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" }); // more than the balance
    await run(salon.admin, (ctx) => adjustBonus(ctx, salon.clientId, { delta: 60000, reason: "подарок на день рождения" }));
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "bonus", amountMinor: 50000 }, { method: "card", amountMinor: 100000 }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { maxBonusMinor: 45000 } });
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "bonus", amountMinor: 40000 }, { method: "card", amountMinor: 110000 }] }),
    );
    // 67 500 − 40 000 spent + 5% of the 110 000 paid in money.
    expect(await balance()).toBe(67500 - 40000 + 5500);

    await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { reason: "жалоба" }));
    expect(await balance()).toBe(67500);
    const ledger = (await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId))).ledger.map((row) => row.kind);
    expect(ledger.slice(0, 2).sort()).toEqual(["burn_refund", "clawback"]);
    await expect(run(salon.master, (ctx) => adjustBonus(ctx, salon.clientId, { delta: 100, reason: "x" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("LOY-BONUS-BURN-02 points-only payment is capped by the whole visit, and paying in parts cannot beat it", async () => {
    const appt = await visit();
    // 30% of the 150 000 visit.
    const first = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "bonus", amountMinor: 30000 }], acknowledgePartial: true }),
    );
    expect(first.id).toBeTruthy();
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "bonus", amountMinor: 20000 }], acknowledgePartial: true }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { maxBonusMinor: 15000 } });
  });

  it("LOY-CERT-01/02/03 certificate: sold, spent in parts, no change from it, voided by owner", async () => {
    const sale = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "certificate", amountMinor: 200000, tenders: [{ method: "cash", amountMinor: 200000 }] }),
    );
    const code = sale.issued![0].code!;
    expect(await run(salon.admin, (ctx) => findCertificate(ctx, code))).toMatchObject({ balanceMinor: 200000, state: "active" });

    const first = await visit();
    await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: first.id, tenders: [{ method: "certificate", amountMinor: 150000, certificateCode: code.toLowerCase() }] }),
    );
    expect((await run(salon.admin, (ctx) => findCertificate(ctx, code))).balanceMinor).toBe(50000);

    const second = await visit();
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, appointmentId: second.id, tenders: [{ method: "certificate", amountMinor: 60000, certificateCode: code }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" }); // more than is left
    // 500 ₽ left on the certificate, the rest in cash: fine. Change can only come from cash.
    const mixed = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: second.id,
        tenders: [{ method: "certificate", amountMinor: 50000, certificateCode: code }, { method: "cash", amountMinor: 100000 }],
      }),
    );
    expect(mixed.paidMinor).toBe(150000);
    expect((await run(salon.admin, (ctx) => findCertificate(ctx, code))).state).toBe("used");
    // Refunding the visit puts the money back on the certificate first.
    await run(salon.admin, (ctx) => refundPayment(ctx, mixed.id, { amountMinor: 30000, reason: "скидка" }));
    expect((await run(salon.admin, (ctx) => findCertificate(ctx, code))).balanceMinor).toBe(30000);

    const cert = await run(salon.admin, (ctx) => findCertificate(ctx, code));
    await expect(run(salon.admin, (ctx) => voidCertificate(ctx, cert.id, { reason: "утерян" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const voided = await run(salon.owner, (ctx) => voidCertificate(ctx, cert.id, { reason: "утерян" }));
    expect(voided).toMatchObject({ state: "void", voidedMinor: 30000, balanceMinor: 0 });

    // An expired certificate is refused.
    const old = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "certificate", amountMinor: 50000, tenders: [{ method: "card", amountMinor: 50000 }] }),
    );
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE certificates SET valid_to = '2026-01-01' WHERE id = $1", [old.issued![0].id]));
    const third = await visit();
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, appointmentId: third.id, tenders: [{ method: "certificate", amountMinor: 50000, certificateCode: old.issued![0].code }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", message: "Срок сертификата истёк" });
    // A cash sale voided in the same shift voids the unused certificate.
    const cashSale = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "certificate", amountMinor: 10000, tenders: [{ method: "cash", amountMinor: 10000 }] }),
    );
    await run(salon.admin, (ctx) => voidPayment(ctx, cashSale.id, { reason: "ошибка" }));
    expect((await run(salon.admin, (ctx) => findCertificate(ctx, cashSale.issued![0].code!))).state).toBe("void");
  });

  it("LOY-SUB-01/02/03 membership: sold to a client, one visit per eligible service, restored on refund, freeze and extend", async () => {
    const plan = await run(salon.admin, (ctx) => createPlan(ctx, { title: "5 маникюров", visits: 2, validDays: 60, priceMinor: 250000, serviceIds: [salon.serviceId] }));
    await expect(
      run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, kind: "membership", planId: plan.id, tenders: [{ method: "card", amountMinor: 250000 }] })),
    ).rejects.toMatchObject({ code: "VALIDATION" }); // needs a client
    const sale = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "membership", planId: plan.id, clientId: salon.clientId, tenders: [{ method: "card", amountMinor: 250000 }] }),
    );
    const membershipId = sale.issued![0].id;

    const other = await visit(salon.serviceOnlyA);
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, appointmentId: other.id, tenders: [{ method: "membership", amountMinor: 50000, membershipId }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", message: "Услуги этой записи не входят в абонемент" });

    const a = await visit();
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: a.id, tenders: [{ method: "membership", amountMinor: 150000, membershipId }] }),
    );
    expect(paid.paidMinor).toBe(150000);
    const left = async () => (await run(salon.admin, (ctx) => clientLoyalty(ctx, salon.clientId))).memberships.find((m) => m.id === membershipId)!;
    expect((await left()).visitsLeft).toBe(1);
    // No points are earned on a visit paid by membership.
    const before = await balance();

    // The visit is cancelled and refunded: the visit goes back onto the membership.
    await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { reason: "отмена" }));
    expect((await left()).visitsLeft).toBe(2);
    expect(await balance()).toBe(before);

    for (let i = 0; i < 2; i += 1) {
      const v = await visit();
      await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: v.id, tenders: [{ method: "membership", amountMinor: 150000, membershipId }] }));
    }
    const extra = await visit();
    await expect(
      run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: extra.id, tenders: [{ method: "membership", amountMinor: 150000, membershipId }] })),
    ).rejects.toMatchObject({ code: "VALIDATION", message: "Визиты по абонементу закончились. Примите обычную оплату" });

    const validTo = (await left()).validTo;
    const frozen = await run(salon.admin, (ctx) => freezeMembership(ctx, membershipId, { from: "2026-11-10", to: "2026-11-19", reason: "отпуск" }));
    expect(frozen.frozenFrom).toBe("2026-11-10");
    expect(frozen.validTo > validTo).toBe(true);
    const extended = await run(salon.admin, (ctx) => extendMembership(ctx, membershipId, { days: 7, reason: "болезнь мастера" }));
    expect(extended.validTo > frozen.validTo).toBe(true);
    await expect(run(salon.admin, (ctx) => extendMembership(ctx, membershipId, { days: 7 }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("LOY-PROMO-01 promo: discount before payment, limits per code and per phone, released on cancel", async () => {
    await run(salon.admin, (ctx) => createPromo(ctx, { code: "Winter10", kind: "percent", value: 1000, maxUses: 1, perPhoneLimit: 1 }));
    await run(salon.admin, (ctx) => createPromo(ctx, { code: "SITE500", kind: "fixed", value: 50000, onlineOnly: true }));
    await run(salon.admin, (ctx) => createPromo(ctx, { code: "BIG", kind: "fixed", value: 10000, minCheckMinor: 500000 }));

    const a = await visit();
    const applied = await run(salon.admin, (ctx) => applyPromo(ctx, a.id, "winter10"));
    expect(applied).toMatchObject({ code: "WINTER10", discountMinor: 15000, priceMinor: 135000 });
    expect((await run(salon.admin, (ctx) => getAppointment(ctx, a.id))).priceMinor).toBe(135000);

    const b = await visit();
    await expect(run(salon.admin, (ctx) => applyPromo(ctx, b.id, "WINTER10"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.admin, (ctx) => applyPromo(ctx, b.id, "SITE500"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.admin, (ctx) => applyPromo(ctx, b.id, "BIG"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.admin, (ctx) => applyPromo(ctx, b.id, "NOPE"))).rejects.toMatchObject({ code: "VALIDATION" });

    // Cancelling the first visit frees the single use.
    const fresh = await run(salon.admin, (ctx) => getAppointment(ctx, a.id));
    await run(salon.admin, (ctx) => cancelAppointment(ctx, a.id, { version: fresh.version, reason: "заболела" }));
    expect((await run(salon.admin, (ctx) => applyPromo(ctx, b.id, "WINTER10"))).priceMinor).toBe(135000);

    // Removing restores the price; after a payment the promo is locked in.
    await run(salon.admin, (ctx) => removePromo(ctx, b.id));
    expect((await run(salon.admin, (ctx) => getAppointment(ctx, b.id))).priceMinor).toBe(150000);
    await run(salon.admin, (ctx) => applyPromo(ctx, b.id, "WINTER10"));
    await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: b.id, tenders: [{ method: "card", amountMinor: 135000 }] }));
    await expect(run(salon.admin, (ctx) => removePromo(ctx, b.id))).rejects.toMatchObject({ code: "VALIDATION" });
    const debt = await run(salon.owner, (ctx) => one<{ debt_minor: number }>(ctx.db, "SELECT debt_minor FROM appointments WHERE id = $1", [b.id]));
    expect(Number(debt?.debt_minor)).toBe(0);
  });
});
