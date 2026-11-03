import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { refundPayment } from "@/server/cash";
import { many, one } from "@/server/db";
import { createPayment, openShift } from "@/server/payments";
import {
  addManualLine,
  approvePeriod,
  calculatePeriod,
  createPeriod,
  createRule,
  deleteRule,
  getPeriod,
  listPeriods,
  lockPeriod,
  payPeriod,
  removeManualLine,
  setPayrollExclusion,
  unapprovePeriod,
} from "@/server/payroll";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
});

/** A finished visit: completed (and paid, if asked) on a given local day. */
async function visit(day: string, time: string, opts: { staffId?: string; payMinor?: number; tipMinor?: number } = {}) {
  const appt = await run(salon.admin, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId: opts.staffId ?? salon.staffA,
      clientId: salon.clientId,
      startsAt: at(time, day),
      services: [{ serviceId: salon.serviceId }],
      acknowledgeSoft: true,
    }),
  );
  let paymentId: string | null = null;
  if (opts.payMinor) {
    const payment = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        tenders: [{ method: "card", amountMinor: opts.payMinor! + (opts.tipMinor ?? 0) }],
        tipMinor: opts.tipMinor,
      }),
    );
    paymentId = payment.id;
    await stampPayment(payment.id, at(time, day));
  }
  await run(salon.owner, async (ctx) => {
    await ctx.db.query("UPDATE appointments SET status = 'completed' WHERE id = $1", [appt.id]);
    // The trigger stamps the real clock; tests put the completion on the visit's day.
    await ctx.db.query("UPDATE appointments SET completed_at = $2 WHERE id = $1", [appt.id, at(time, day)]);
  });
  return { id: appt.id, paymentId };
}

function stampPayment(id: string, iso: string) {
  return run(salon.owner, (ctx) => ctx.db.query("UPDATE payments SET posted_at = $2 WHERE id = $1", [id, iso]));
}

describe("payroll", () => {
  let september: string;
  let a1: Awaited<ReturnType<typeof visit>>;

  it("PAYROLL-RULE-01 rules: roles, levels and no overlap at the same level", async () => {
    await expect(
      run(salon.master, (ctx) => createRule(ctx, { scheme: "percent", percentBps: 4000, validFrom: "2026-01-01" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await run(salon.admin, (ctx) => createRule(ctx, { scheme: "percent", percentBps: 4000, validFrom: "2026-01-01" }));
    await expect(
      run(salon.admin, (ctx) => createRule(ctx, { scheme: "percent", percentBps: 5000, validFrom: "2026-06-01" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    // Марина: оклад + 10 %, без чаевых.
    await run(salon.accountant, (ctx) =>
      createRule(ctx, {
        staffId: salon.staffB,
        scheme: "hybrid",
        percentBps: 1000,
        salaryMinor: 3000000,
        includeTips: false,
        validFrom: "2026-01-01",
      }),
    );
    // A service rule must name the master.
    await expect(
      run(salon.admin, (ctx) => createRule(ctx, { serviceId: salon.serviceId, scheme: "fixed_per_service", fixedMinor: 1, validFrom: "2026-01-01" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("PAYROLL-CALC-01 accrues percent, hybrid salary and tips; warns about unpaid visits", async () => {
    a1 = await visit("2026-09-10", "10:00", { payMinor: 150000, tipMinor: 10000 });
    const unpaid = await visit("2026-09-11", "10:00");
    await visit("2026-09-12", "10:00", { staffId: salon.staffB, payMinor: 150000, tipMinor: 5000 });
    const excluded = await visit("2026-09-13", "10:00", { payMinor: 150000 });
    await expect(run(salon.admin, (ctx) => setPayrollExclusion(ctx, excluded.id, { exclude: true }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await run(salon.admin, (ctx) => setPayrollExclusion(ctx, excluded.id, { exclude: true, reason: "переделка за счёт салона" }));
    // Outside the period: not counted.
    await visit("2026-10-01", "10:00", { payMinor: 150000 });

    september = (await run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-09-01", endsOn: "2026-09-30" }))).id;
    await expect(
      run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-09-20", endsOn: "2026-10-10" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const sheet = await run(salon.admin, (ctx) => calculatePeriod(ctx, september));
    expect(sheet.status).toBe("calculated");
    const alina = sheet.items.find((item) => item.staffId === salon.staffA)!;
    expect(alina.accrualMinor).toBe(60000);
    expect(alina.tipMinor).toBe(10000);
    expect(alina.totalMinor).toBe(70000);
    expect(alina.lines.find((line) => line.type === "service")?.rate).toMatchObject({ scheme: "percent", percentBps: 4000 });

    const marina = sheet.items.find((item) => item.staffId === salon.staffB)!;
    expect(marina.lines.map((line) => [line.type, line.resultMinor]).sort()).toEqual([
      ["salary", 3000000],
      ["service", 15000],
    ]);
    expect(marina.tipMinor).toBe(0);

    expect(sheet.warnings.map((warning) => [warning.code, warning.appointmentId])).toContainEqual(["UNPAID", unpaid.id]);
  });

  it("PAYROLL-ADJ-01 manual lines need a reason and survive recalculation", async () => {
    await expect(
      run(salon.admin, (ctx) => addManualLine(ctx, september, { staffId: salon.staffA, type: "bonus", amountMinor: 5000, reason: "план" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      run(salon.accountant, (ctx) => addManualLine(ctx, september, { staffId: salon.staffA, type: "bonus", amountMinor: 5000, reason: " " })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.accountant, (ctx) => addManualLine(ctx, september, { staffId: salon.staffA, type: "bonus", amountMinor: 5000, reason: "план" }));
    const fined = await run(salon.accountant, (ctx) =>
      addManualLine(ctx, september, { staffId: salon.staffA, type: "penalty", amountMinor: 1000, reason: "опоздание" }),
    );
    const penalty = fined.items.find((item) => item.staffId === salon.staffA)!.lines.find((line) => line.type === "penalty")!;
    expect(penalty.resultMinor).toBe(-1000);
    await run(salon.accountant, (ctx) => removeManualLine(ctx, september, penalty.id));

    const again = await run(salon.admin, (ctx) => calculatePeriod(ctx, september));
    const alina = again.items.find((item) => item.staffId === salon.staffA)!;
    expect(alina.lines.filter((line) => line.manual).map((line) => [line.type, line.reason])).toEqual([["bonus", "план"]]);
    expect(alina.totalMinor).toBe(75000);
  });

  it("PAYROLL-VIEW-SELF-01 a master sees only their own approved sheet", async () => {
    await expect(run(salon.master, (ctx) => getPeriod(ctx, september))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await run(salon.master, (ctx) => listPeriods(ctx, salon.branchId))).toEqual([]);

    await expect(run(salon.admin, (ctx) => approvePeriod(ctx, september))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await run(salon.accountant, (ctx) => approvePeriod(ctx, september));
    await expect(run(salon.admin, (ctx) => calculatePeriod(ctx, september))).rejects.toMatchObject({ code: "VALIDATION" });

    const own = await run(salon.master, (ctx) => getPeriod(ctx, september));
    expect(own.items.map((item) => item.staffId)).toEqual([salon.staffA]);
    expect(own.warnings).toEqual([]);
    expect(Object.keys(own.items[0].lines[0].rate).sort()).toEqual(["fixedMinor", "percentBps", "scheme"]);
    const list = await run(salon.master, (ctx) => listPeriods(ctx, salon.branchId));
    expect(list[0]).toMatchObject({ id: september, totalMinor: 75000 });
  });

  it("PAYROLL-PAY-01 / LOCK-01 pay per master, then lock; paid periods cannot be unapproved", async () => {
    const partly = await run(salon.accountant, (ctx) =>
      payPeriod(ctx, september, { staffId: salon.staffA, paidOn: "2026-10-05", method: "transfer", reference: "п/п 12" }),
    );
    expect(partly.status).toBe("approved");
    expect(partly.items.find((item) => item.staffId === salon.staffA)).toMatchObject({ status: "paid", paidMethod: "transfer" });
    await expect(run(salon.accountant, (ctx) => unapprovePeriod(ctx, september))).rejects.toMatchObject({ code: "VALIDATION" });

    const paid = await run(salon.accountant, (ctx) => payPeriod(ctx, september, { paidOn: "2026-10-05", method: "cash" }));
    expect(paid.status).toBe("paid");
    await expect(run(salon.accountant, (ctx) => lockPeriod(ctx, september))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await run(salon.owner, (ctx) => lockPeriod(ctx, september))).status).toBe("locked");

    const history = await run(salon.owner, (ctx) =>
      many<{ action: string }>(ctx.db, "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at", [september]),
    );
    expect(history.map((row) => row.action)).toEqual(
      expect.arrayContaining(["payroll.period_created", "payroll.calculated", "payroll.bonus", "payroll.approved", "payroll.paid", "payroll.locked"]),
    );
  });

  it("PAYROLL-CALC-02 a refund after payout claws back in the next period and can leave a debt", async () => {
    const refund = await run(salon.admin, (ctx) => refundPayment(ctx, a1.paymentId!, { amountMinor: 75000, reason: "жалоба" }));
    await stampPayment(refund.id, at("12:00", "2026-10-03"));
    const october = (await run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-10-02", endsOn: "2026-10-31" }))).id;
    const sheet = await run(salon.admin, (ctx) => calculatePeriod(ctx, october));
    const alina = sheet.items.find((item) => item.staffId === salon.staffA)!;
    const clawback = alina.lines.find((line) => line.type === "refund_clawback")!;
    expect(clawback.resultMinor).toBe(-30000);
    expect(alina).toMatchObject({ totalMinor: -30000, payoutMinor: 0, carryDebt: true });
    expect(sheet.warnings.map((warning) => warning.code)).toContain("NEGATIVE_TOTAL");

    // The locked period is untouched.
    const locked = await run(salon.owner, (ctx) => getPeriod(ctx, september));
    expect(locked.items.find((item) => item.staffId === salon.staffA)?.totalMinor).toBe(75000);
  });

  it("PAYROLL-RULE-02 a rule used in a paid period is closed, not deleted", async () => {
    const rule = await run(salon.owner, (ctx) =>
      one<{ id: string }>(ctx.db, "SELECT id FROM payroll_rules WHERE staff_id IS NULL AND tenant_id = $1", [salon.tenantId]),
    );
    const result = await run(salon.admin, (ctx) => deleteRule(ctx, rule!.id));
    expect(result).toMatchObject({ outcome: "closed" });
    const row = await run(salon.owner, (ctx) =>
      one<{ valid_to: Date | null }>(ctx.db, "SELECT valid_to FROM payroll_rules WHERE id = $1", [rule!.id]),
    );
    expect(row?.valid_to).not.toBeNull();
  });
});
