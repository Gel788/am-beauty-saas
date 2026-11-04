import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { createPayment, openShift } from "@/server/payments";
import { calculatePeriod, createPeriod, createRule, getPeriod } from "@/server/payroll";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
  await run(salon.owner, async (ctx) => {
    // Алина works Monday to Friday; Wednesday 7 October is a day off.
    await ctx.db.query("DELETE FROM schedule_templates WHERE staff_id = $1 AND weekday IN (6, 7)", [salon.staffA]);
    await ctx.db.query(
      "INSERT INTO schedule_exceptions (id, tenant_id, branch_id, staff_id, starts_on, ends_on, kind) VALUES ($1, $2, $3, $4, '2026-10-07', '2026-10-07', 'day_off')",
      [crypto.randomUUID(), salon.tenantId, salon.branchId, salon.staffA],
    );
  });
});

async function visit(day: string, time: string, staffId: string) {
  const appt = await run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId, clientId: salon.clientId, startsAt: at(time, day), services: [{ serviceId: salon.serviceId }], acknowledgeSoft: true }),
  );
  const payment = await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "card", amountMinor: 150000 }] }));
  await run(salon.owner, async (ctx) => {
    await ctx.db.query("UPDATE payments SET posted_at = $2 WHERE id = $1", [payment.id, at(time, day)]);
    await ctx.db.query("UPDATE appointments SET status = 'completed' WHERE id = $1", [appt.id]);
    await ctx.db.query("UPDATE appointments SET completed_at = $2 WHERE id = $1", [appt.id, at(time, day)]);
  });
}

const salaryLine = (item: { lines: { type: string; resultMinor: number; title: string }[] }) => item.lines.find((line) => line.type === "salary");

describe("payroll per shift", () => {
  it("PAYROLL-SHIFT-00 a guarantee only makes sense with shift rate plus percent", async () => {
    await expect(
      run(salon.admin, (ctx) => createRule(ctx, { staffId: salon.staffA, scheme: "salary", salaryMinor: 200000, periodUnit: "shift", guarantee: true, validFrom: "2026-10-01" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("PAYROLL-SHIFT-01 rate × shifts by the schedule, minus days off, plus an off-schedule day with a visit, plus percent", async () => {
    await run(salon.admin, (ctx) => createRule(ctx, { staffId: salon.staffA, scheme: "hybrid", salaryMinor: 200000, periodUnit: "shift", percentBps: 1000, validFrom: "2026-10-01" }));
    await run(salon.admin, (ctx) =>
      createRule(ctx, { staffId: salon.staffB, scheme: "hybrid", salaryMinor: 100000, periodUnit: "shift", percentBps: 4000, guarantee: true, validFrom: "2026-10-01", validTo: "2026-10-11" }),
    );
    await visit("2026-10-10", "12:00", salon.staffA); // Saturday, not in Алина's schedule
    await visit("2026-10-06", "12:00", salon.staffB);
    const period = await run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-10-05", endsOn: "2026-10-11" }));
    await run(salon.admin, (ctx) => calculatePeriod(ctx, period.id));
    const result = await run(salon.admin, (ctx) => getPeriod(ctx, period.id));
    const alina = result.items.find((item) => item.staffId === salon.staffA)!;
    // Mon, Tue, Thu, Fri by the schedule + Saturday with a visit = 5 shifts × 2 000 ₽, plus 10 % of 1 500 ₽.
    expect(salaryLine(alina)).toMatchObject({ resultMinor: 5 * 200000 });
    expect(salaryLine(alina)!.title).toContain("5 смен");
    expect(alina.accrualMinor).toBe(5 * 200000 + 15000);
    // Марина: 40 % of 1 500 ₽ = 600 ₽, below 7 shifts × 1 000 ₽, so the CRM adds the shortfall.
    const marina = result.items.find((item) => item.staffId === salon.staffB)!;
    expect(salaryLine(marina)).toMatchObject({ resultMinor: 7 * 100000 - 60000 });
    expect(marina.accrualMinor).toBe(7 * 100000);
  });

  it("PAYROLL-SHIFT-02 no top-up when the percent beats the shift rate", async () => {
    await run(salon.admin, (ctx) =>
      createRule(ctx, { staffId: salon.staffB, scheme: "hybrid", salaryMinor: 10000, periodUnit: "shift", percentBps: 4000, guarantee: true, validFrom: "2026-10-12" }),
    );
    await visit("2026-10-12", "12:00", salon.staffB);
    await visit("2026-10-13", "12:00", salon.staffB);
    const period = await run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-10-12", endsOn: "2026-10-13" }));
    await run(salon.admin, (ctx) => calculatePeriod(ctx, period.id));
    const marina = (await run(salon.admin, (ctx) => getPeriod(ctx, period.id))).items.find((item) => item.staffId === salon.staffB)!;
    expect(salaryLine(marina)).toMatchObject({ resultMinor: 0 });
    expect(marina.accrualMinor).toBe(2 * 60000);
  });

  it("PAYROLL-SHIFT-03 days that have not come yet are not counted", async () => {
    const period = await run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-11-02", endsOn: "2026-11-08" }));
    await run(salon.admin, (ctx) => calculatePeriod(ctx, period.id));
    const alina = (await run(salon.admin, (ctx) => getPeriod(ctx, period.id))).items.find((item) => item.staffId === salon.staffA)!;
    // NOW is Tuesday 3 November: Monday and Tuesday only.
    expect(salaryLine(alina)).toMatchObject({ resultMinor: 2 * 200000 });
  });
});
