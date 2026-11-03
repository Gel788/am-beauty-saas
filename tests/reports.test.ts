import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { refundPayment } from "@/server/cash";
import { createPayment, openShift } from "@/server/payments";
import { dayReport } from "@/server/reports";
import { formatLocalDate } from "@/domain/time";
import { TZ, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
// Payments are stamped with the database clock, so the report day is the real local day.
const today = formatLocalDate(new Date(), TZ);

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
});

function visit(time: string, staffId = salon.staffA) {
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId,
      clientId: salon.clientId,
      startsAt: at(time, today),
      services: [{ serviceId: salon.serviceId }],
      acknowledgeSoft: true,
    }),
  );
}

async function setStatus(id: string, status: string) {
  await run(salon.owner, (ctx) => ctx.db.query("UPDATE appointments SET status = $2 WHERE id = $1", [id, status]));
}

describe("day report", () => {
  it("AN-DAY-01 revenue is posted money split by services, products and tips, net of refunds", async () => {
    const a = await visit("10:00");
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: a.id, tenders: [{ method: "card", amountMinor: 160000 }], tipMinor: 10000 }),
    );
    await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "misc", title: "Крем", tenders: [{ method: "cash", amountMinor: 30000 }] }),
    );
    await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 20000, reason: "скидка" }));
    // A visit with no payment adds nothing to revenue, whatever its price.
    await visit("12:00");

    const report = await run(salon.accountant, (ctx) => dayReport(ctx, salon.branchId, today));
    expect(report.revenue.servicesMinor).toBe(130000);
    expect(report.revenue.tipsMinor).toBe(10000);
    expect(report.revenue.productsMinor).toBe(30000);
    expect(report.revenue.refundsMinor).toBe(20000);
    expect(report.revenue.totalMinor).toBe(170000);
    expect(report.revenue.byMethod).toEqual([
      { method: "card", netMinor: 140000 },
      { method: "cash", netMinor: 30000 },
    ]);
    expect(report.payments.map((row) => row.direction)).toEqual(["in", "in", "out"]);
  });

  it("AN-DAY-01 counts appointments by outcome and master load", async () => {
    const done = await visit("14:00");
    const cancelled = await visit("16:00");
    const missed = await visit("18:00");
    await visit("10:00", salon.staffB);
    await setStatus(done.id, "completed");
    await setStatus(cancelled.id, "cancelled");
    await setStatus(missed.id, "no_show");

    const report = await run(salon.admin, (ctx) => dayReport(ctx, salon.branchId, today));
    expect(report.appointments.total).toBe(6);
    expect(report.appointments.completed).toBe(1);
    expect(report.appointments.cancelled).toBe(1);
    expect(report.appointments.noShow).toBe(1);
    expect(report.appointments.open).toBe(3);
    expect(report.appointments.createdToday).toBe(6);

    // Work 09:00–21:00 = 720 min; Alina has 4 live hour-long visits (the cancelled one does not count).
    const alina = report.load.staff.find((row) => row.staffId === salon.staffA)!;
    expect(alina.availableMin).toBe(720);
    expect(alina.occupiedMin).toBe(240);
    expect(alina.loadPercent).toBe(33);
    const marina = report.load.staff.find((row) => row.staffId === salon.staffB)!;
    expect(marina.occupiedMin).toBe(60);
    expect(report.load.loadPercent).toBe(Math.round((100 * 300) / 1440));
    expect(report.appointmentList.map((row) => row.time)).toEqual(["10:00", "10:00", "12:00", "14:00", "16:00", "18:00"]);
  });

  it("AN-DAY-01 a day off shows no available time; masters cannot open the report", async () => {
    await run(salon.owner, (ctx) =>
      ctx.db.query(
        `INSERT INTO schedule_exceptions (id, tenant_id, branch_id, staff_id, starts_on, ends_on, kind)
         VALUES ($1, $2, $3, $4, '2027-01-05', '2027-01-05', 'day_off')`,
        [crypto.randomUUID(), salon.tenantId, salon.branchId, salon.staffB],
      ),
    );
    const report = await run(salon.admin, (ctx) => dayReport(ctx, salon.branchId, "2027-01-05"));
    expect(report.load.staff.find((row) => row.staffId === salon.staffB)).toBeUndefined();
    expect(report.revenue.totalMinor).toBe(0);
    await expect(run(salon.master, (ctx) => dayReport(ctx, salon.branchId, today))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.admin, (ctx) => dayReport(ctx, salon.branchId, "03.11.2026"))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
