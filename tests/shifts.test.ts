import { beforeAll, describe, expect, it } from "vitest";
import { cancelAppointment, createAppointment, getAppointment } from "@/server/appointments";
import {
  appointmentPayments,
  cancelClosing,
  closeShift,
  currentShift,
  listPayments,
  listShifts,
  refundPayment,
  shiftReport,
  startClosing,
  voidPayment,
} from "@/server/cash";
import { createPayment, openShift } from "@/server/payments";
import { one } from "@/server/db";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let day = 0;

beforeAll(async () => {
  salon = await createSalon();
});

async function visit() {
  day += 1;
  const date = `2027-07-${String(day).padStart(2, "0")}`;
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId: salon.staffA,
      clientId: salon.clientId,
      startsAt: at("10:00", date),
      services: [{ serviceId: salon.serviceId }],
      acknowledgeSoft: true,
    }),
  );
}

function pay(appointmentId: string, tenders: { method: "cash" | "card" | "sbp"; amountMinor: number }[], extra: Record<string, unknown> = {}) {
  return run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId, tenders, ...extra }));
}

async function balance() {
  const row = await run(salon.admin, (ctx) =>
    one<{ balance_minor: number }>(ctx.db, "SELECT balance_minor FROM clients WHERE id = $1", [salon.clientId]),
  );
  return Number(row?.balance_minor);
}

async function shiftId() {
  const shift = await run(salon.admin, (ctx) => currentShift(ctx, salon.branchId));
  if (!shift) throw new Error("no shift");
  return shift.id;
}

describe("cash shifts and refunds", () => {
  it("SHIFT-OPEN-01 shows the active shift with live expected cash", async () => {
    await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 300000 }));
    const shift = await run(salon.admin, (ctx) => currentShift(ctx, salon.branchId));
    expect(shift?.status).toBe("open");
    expect(shift?.openedByName).toBe("Админ");
    expect(shift?.totals.expected.cash).toBe(300000);
    expect(shift?.staleWarning).toBe(false);
  });

  it("CASH acceptance: open → pay → partial → refund → close with variance", async () => {
    const a = await visit();
    await pay(a.id, [{ method: "cash", amountMinor: 200000 }]); // 150000 + 50000 change
    const b = await visit();
    const partial = await pay(b.id, [{ method: "card", amountMinor: 50000 }]);
    expect(partial.partial).toBe(true);
    const refund = await run(salon.admin, (ctx) => refundPayment(ctx, partial.id, { amountMinor: 20000, reason: "скидка" }));
    expect(refund.full).toBe(false);
    expect(refund.tenders).toEqual([{ method: "card", amountMinor: 20000 }]);
    expect(refund.paidMinor).toBe(30000);

    const id = await shiftId();
    const closing = await run(salon.admin, (ctx) => startClosing(ctx, id));
    expect(closing.status).toBe("closing");
    expect(closing.totals.expected.cash).toBe(300000 + 150000);
    expect(closing.totals.expected.card).toBe(30000);
    expect(closing.totals.refundsMinor).toBe(20000);
    expect(closing.totals.revenue.servicesMinor).toBe(180000);

    await expect(run(salon.admin, (ctx) => closeShift(ctx, id, { countedCashMinor: 449000 }))).rejects.toMatchObject({
      code: "VALIDATION",
      details: { varianceMinor: -1000 },
    });
    const report = await run(salon.admin, (ctx) =>
      closeShift(ctx, id, { countedCashMinor: 449000, varianceReason: "сдача без чека" }),
    );
    expect(report.shift.status).toBe("closed");
    expect(report.shift.varianceMinor).toBe(-1000);
    expect(report.shift.expectedCashMinor).toBe(450000);
    expect(report.shift.closedByName).toBe("Админ");
    expect(report.payments.length).toBe(3);
    const auditRow = await run(salon.admin, (ctx) =>
      one<{ diff: { varianceMinor: number } }>(ctx.db, "SELECT diff FROM audit_log WHERE entity_id = $1 AND action = 'shift.closed'", [id]),
    );
    expect(auditRow?.diff.varianceMinor).toBe(-1000);
  });

  it("SHIFT-CLOSE-01 freezes the snapshot: later money does not move a closed report", async () => {
    const shifts = await run(salon.admin, (ctx) => listShifts(ctx, salon.branchId));
    const closed = shifts.find((shift) => shift.status === "closed")!;
    await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 100000 }));
    const c = await visit();
    await pay(c.id, [{ method: "cash", amountMinor: 150000 }]);
    const again = await run(salon.admin, (ctx) => shiftReport(ctx, closed.id));
    expect(again.shift.totals.expected.cash).toBe(450000);
    expect(again.shift.totals.paymentCount).toBe(2);
  });

  it("SHIFT-CLOSE-02 cancels closing only for the starter or the owner", async () => {
    const id = await shiftId();
    await run(salon.admin, (ctx) => startClosing(ctx, id));
    await expect(run(salon.accountant, (ctx) => cancelClosing(ctx, id))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const back = await run(salon.owner, (ctx) => cancelClosing(ctx, id));
    expect(back.status).toBe("open");
    expect(back.closingStartedById).toBeNull();
  });

  it("SHIFT-CLOSE-03 blocks payments, refunds and voids while closing", async () => {
    const d = await visit();
    const paid = await pay(d.id, [{ method: "cash", amountMinor: 150000 }]);
    const id = await shiftId();
    await run(salon.admin, (ctx) => startClosing(ctx, id));
    const e = await visit();
    await expect(pay(e.id, [{ method: "card", amountMinor: 150000 }])).rejects.toMatchObject({ code: "SHIFT_CLOSED" });
    await expect(run(salon.admin, (ctx) => refundPayment(ctx, paid.id))).rejects.toMatchObject({ code: "SHIFT_CLOSED" });
    await expect(run(salon.admin, (ctx) => voidPayment(ctx, paid.id, { reason: "ошибка" }))).rejects.toMatchObject({
      code: "SHIFT_CLOSED",
    });
    await expect(run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await run(salon.admin, (ctx) => closeShift(ctx, id, { countedCashMinor: 100000 + 150000 + 150000 }));
  });

  it("SHIFT-CLOSE-04 never reopens a closed shift; payments need a new one", async () => {
    const shifts = await run(salon.admin, (ctx) => listShifts(ctx, salon.branchId));
    const closed = shifts[0];
    expect(closed.status).toBe("closed");
    await expect(run(salon.admin, (ctx) => startClosing(ctx, closed.id))).rejects.toMatchObject({ code: "SHIFT_CLOSED" });
    await expect(run(salon.admin, (ctx) => closeShift(ctx, closed.id, { countedCashMinor: 0 }))).rejects.toMatchObject({
      code: "SHIFT_CLOSED",
    });
    const f = await visit();
    await expect(pay(f.id, [{ method: "card", amountMinor: 150000 }])).rejects.toMatchObject({ code: "SHIFT_REQUIRED" });
  });

  it("SHIFT-CLOSE-01 requires a reason when declared card differs from expected", async () => {
    await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
    const g = await visit();
    await pay(g.id, [{ method: "card", amountMinor: 150000 }]);
    const id = await shiftId();
    await run(salon.admin, (ctx) => startClosing(ctx, id));
    await expect(
      run(salon.admin, (ctx) => closeShift(ctx, id, { countedCashMinor: 0, declared: { card: 140000 } })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const report = await run(salon.admin, (ctx) =>
      closeShift(ctx, id, { countedCashMinor: 0, declared: { card: 140000 }, varianceReason: "терминал не прошёл" }),
    );
    expect(report.shift.declared.card).toBe(140000);
    expect(report.shift.varianceMinor).toBe(0);
  });

  it("honours the branch variance threshold", async () => {
    await run(salon.owner, async (ctx) => {
      await ctx.db.query("UPDATE branches SET shift_variance_threshold_minor = 5000 WHERE id = $1", [salon.branchId]);
    });
    await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 10000 }));
    const id = await shiftId();
    await run(salon.admin, (ctx) => startClosing(ctx, id));
    const report = await run(salon.admin, (ctx) => closeShift(ctx, id, { countedCashMinor: 7000 }));
    expect(report.shift.varianceMinor).toBe(-3000);
    expect(report.shift.varianceReason).toBeNull();
    await run(salon.owner, async (ctx) => {
      await ctx.db.query("UPDATE branches SET shift_variance_threshold_minor = 0 WHERE id = $1", [salon.branchId]);
    });
  });

  it("closing permissions: master cannot start or close a shift", async () => {
    await run(salon.accountant, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
    const id = await shiftId();
    await expect(run(salon.master, (ctx) => startClosing(ctx, id))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.master, (ctx) => shiftReport(ctx, id))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.master, (ctx) => listPayments(ctx, salon.branchId))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("warns about a shift left open for 36+ hours", async () => {
    const later = new Date(Date.now() + 37 * 3_600_000);
    const shift = await run(salon.admin, (ctx) => currentShift(ctx, salon.branchId), later);
    expect(shift?.staleWarning).toBe(true);
  });

  it("PAY-REFUND-01 full refund marks the original refunded and clears paid", async () => {
    const h = await visit();
    const paid = await pay(h.id, [{ method: "card", amountMinor: 100000 }, { method: "cash", amountMinor: 50000 }]);
    const refund = await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { reason: "жалоба" }));
    expect(refund.full).toBe(true);
    expect(refund.amountMinor).toBe(150000);
    expect(refund.tenders).toEqual([
      { method: "card", amountMinor: 100000 },
      { method: "cash", amountMinor: 50000 },
    ]);
    const appt = await run(salon.admin, (ctx) => getAppointment(ctx, h.id));
    expect(appt.paidMinor).toBe(0);
    expect(appt.debtMinor).toBe(0);
    const original = await run(salon.admin, (ctx) => one<{ status: string }>(ctx.db, "SELECT status FROM payments WHERE id = $1", [paid.id]));
    expect(original?.status).toBe("refunded");
    await expect(run(salon.admin, (ctx) => refundPayment(ctx, paid.id))).rejects.toMatchObject({ code: "VALIDATION" });
    const ledger = await run(salon.admin, (ctx) => appointmentPayments(ctx, h.id));
    expect(ledger.map((item) => item.direction).sort()).toEqual(["in", "out"]);
    expect(ledger.find((item) => item.direction === "in")?.refundableMinor).toBe(0);
  });

  it("PAY-REFUND-02 partial refund is capped by what remains and by the method", async () => {
    const i = await visit();
    const paid = await pay(i.id, [{ method: "card", amountMinor: 160000 }], { tipMinor: 10000 });
    await expect(
      run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 10000, method: "cash" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const first = await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 30000 }));
    expect(first.full).toBe(false);
    expect(first.refundableMinor).toBe(130000);
    await expect(run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 130001 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const lines = await run(salon.admin, (ctx) =>
      ctx.db.query<{ id: string; line_type: string }>("SELECT id, line_type FROM payment_lines WHERE payment_id = $1", [paid.id]),
    );
    const tip = lines.rows.find((line) => line.line_type === "tip")!;
    const tipBack = await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { lines: [{ lineId: tip.id, amountMinor: 10000 }] }));
    expect(tipBack.paidMinor).toBe(120000);
    await expect(
      run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { lines: [{ lineId: tip.id, amountMinor: 1 }] })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const rest = await run(salon.admin, (ctx) => refundPayment(ctx, paid.id));
    expect(rest.full).toBe(true);
    expect(rest.amountMinor).toBe(120000);
  });

  it("PAY-REFUND-01 refunds a deposit after the visit is cancelled", async () => {
    const j = await visit();
    const deposit = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "deposit", appointmentId: j.id, tenders: [{ method: "sbp", amountMinor: 40000 }] }),
    );
    const fresh = await run(salon.admin, (ctx) => getAppointment(ctx, j.id));
    const cancelled = await run(salon.admin, (ctx) => cancelAppointment(ctx, j.id, { version: fresh.version, reason: "заболела", confirm: true } as never));
    expect(cancelled.refundSuggested).toBe(true);
    const refund = await run(salon.admin, (ctx) => refundPayment(ctx, deposit.id));
    expect(refund.tenders).toEqual([{ method: "sbp", amountMinor: 40000 }]);
    expect(refund.paidMinor).toBe(0);
  });

  it("PAY-REFUND-01 refunding a debt repayment puts the debt back", async () => {
    const k = await visit();
    await pay(k.id, [{ method: "card", amountMinor: 50000 }]);
    const before = await balance();
    const repay = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "debt", clientId: salon.clientId, tenders: [{ method: "card", amountMinor: 100000 }] }),
    );
    expect(await balance()).toBe(before - 100000);
    await run(salon.admin, (ctx) => refundPayment(ctx, repay.id));
    expect(await balance()).toBe(before);
  });

  it("refund permissions follow the matrix", async () => {
    const l = await visit();
    const paid = await pay(l.id, [{ method: "card", amountMinor: 150000 }]);
    await expect(run(salon.master, (ctx) => refundPayment(ctx, paid.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const byAccountant = await run(salon.accountant, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 1000 }));
    expect(byAccountant.amountMinor).toBe(1000);
    const audit = await run(salon.admin, (ctx) =>
      one(ctx.db, "SELECT id FROM audit_log WHERE entity_id = $1 AND action = 'payment.refunded'", [paid.id]),
    );
    expect(audit).toBeTruthy();
  });

  it("PAY-VOID-01 voids a same-shift cash payment and refuses card", async () => {
    const m = await visit();
    const cash = await pay(m.id, [{ method: "cash", amountMinor: 150000 }]);
    await expect(run(salon.admin, (ctx) => voidPayment(ctx, cash.id, {}))).rejects.toMatchObject({ code: "VALIDATION" });
    const voided = await run(salon.admin, (ctx) => voidPayment(ctx, cash.id, { reason: "провели дважды" }));
    expect(voided.status).toBe("void");
    expect(voided.paidMinor).toBe(0);
    const n = await visit();
    const card = await pay(n.id, [{ method: "card", amountMinor: 150000 }]);
    await expect(run(salon.admin, (ctx) => voidPayment(ctx, card.id, { reason: "ошибка" }))).rejects.toMatchObject({ code: "VALIDATION" });
    const listed = await run(salon.admin, (ctx) => listPayments(ctx, salon.branchId, { shiftId: undefined }));
    expect(listed.find((item) => item.id === card.id)?.canVoid).toBe(false);
    const id = await shiftId();
    await run(salon.admin, (ctx) => startClosing(ctx, id));
    const closing = await run(salon.admin, (ctx) => currentShift(ctx, salon.branchId));
    expect(closing?.totals.voidCount).toBe(1);
    expect(closing?.totals.expected.cash).toBe(0);
    await run(salon.admin, (ctx) => cancelClosing(ctx, id));
  });

  it("PAY-VOID-01 refuses to void a payment from a closed shift", async () => {
    const shifts = await run(salon.admin, (ctx) => listShifts(ctx, salon.branchId));
    const closed = shifts[shifts.length - 1]; // the acceptance shift: has a cash payment
    const report = await run(salon.admin, (ctx) => shiftReport(ctx, closed.id));
    const cashPayment = report.payments.find((item) => item.direction === "in" && item.tenders.every((t) => t.method === "cash"));
    expect(cashPayment).toBeTruthy();
    expect(cashPayment?.canVoid).toBe(false);
    await expect(run(salon.admin, (ctx) => voidPayment(ctx, cashPayment!.id, { reason: "поздно" }))).rejects.toMatchObject({
      code: "SHIFT_CLOSED",
    });
  });

  it("PAY-REFUND-02 partial refund of a fully paid visit leaves no debt", async () => {
    const z = await visit();
    const paid = await pay(z.id, [{ method: "card", amountMinor: 150000 }]);
    const before = await balance();
    const refund = await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 30000, reason: "компенсация" }));
    expect(refund.paidMinor).toBe(120000);
    expect(refund.debtMinor).toBe(0);
    expect(await balance()).toBe(before);
  });
});
