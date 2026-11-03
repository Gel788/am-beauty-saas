import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { createClient } from "@/server/clients";
import { createPayment, openShift } from "@/server/payments";
import { at, createSalon, run, useDb } from "./helpers";
import { one } from "@/server/db";

useDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 500000, note: "утро" }));
});

async function visit(startsAt: string) {
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId: salon.staffA,
      clientId: salon.clientId,
      startsAt,
      services: [{ serviceId: salon.serviceId }],
      acknowledgeSoft: true,
    }),
  );
}

describe("payments", () => {
  it("SHIFT-OPEN-01 opens a shift and SHIFT-OPEN-02 blocks a second one", async () => {
    const current = await run(salon.admin, async (ctx) => {
      const row = await one<{ id: string }>(ctx.db, "SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open'", [
        salon.branchId,
      ]);
      return row;
    });
    expect(current?.id).toBeTruthy();
    await expect(
      run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: -1 })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("PAY-CREATE-01 posts a full payment with change and audit", async () => {
    const appt = await visit(at("10:00", "2027-06-01"));
    const payment = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        version: appt.version,
        tenders: [{ method: "cash", amountMinor: 200000 }],
      }),
    );
    expect(payment.totalMinor).toBe(150000);
    expect(payment.changeMinor).toBe(50000);
    expect(payment.paidMinor).toBe(150000);
    expect(payment.partial).toBe(false);
    const audit = await run(salon.admin, (ctx) =>
      one(ctx.db, "SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'payment.posted'", [payment.id]),
    );
    expect(audit).toBeTruthy();
  });

  it("PAY-CREATE-02 allows several partial payments and refuses to exceed the remainder", async () => {
    const appt = await visit(at("11:00", "2027-06-01"));
    const first = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        version: appt.version,
        tenders: [{ method: "card", amountMinor: 50000 }],
      }),
    );
    expect(first.partial).toBe(true);
    expect(first.paidMinor).toBe(50000);
    expect(first.debtMinor).toBe(100000);
    const client = await run(salon.admin, (ctx) =>
      one<{ balance_minor: number }>(ctx.db, "SELECT balance_minor FROM clients WHERE id = $1", [salon.clientId]),
    );
    expect(Number(client?.balance_minor)).toBeGreaterThanOrEqual(100000);
    const second = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        tenders: [{ method: "card", amountMinor: 100000 }],
      }),
    );
    expect(second.paidMinor).toBe(150000);
    expect(second.debtMinor).toBe(0);
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, {
          branchId: salon.branchId,
          appointmentId: appt.id,
          tenders: [{ method: "card", amountMinor: 1000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("PAY-CREATE-03 counts a deposit toward the final payment without booking debt early", async () => {
    const appt = await visit(at("12:00", "2027-06-02"));
    const deposit = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        kind: "deposit",
        appointmentId: appt.id,
        version: appt.version,
        tenders: [{ method: "sbp", amountMinor: 40000 }],
      }),
    );
    expect(deposit.paidMinor).toBe(40000);
    expect(deposit.debtMinor).toBe(0);
    const finalPay = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        tenders: [{ method: "card", amountMinor: 110000 }],
      }),
    );
    expect(finalPay.paidMinor).toBe(150000);
    expect(finalPay.debtMinor).toBe(0);
  });

  it("PAY-CREATE-04 posts a payment without a visit", async () => {
    const payment = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        kind: "misc",
        title: "Розница",
        tenders: [{ method: "cash", amountMinor: 30000 }],
      }),
    );
    expect(payment.totalMinor).toBe(30000);
    await expect(
      run(salon.master, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, kind: "misc", title: "нет", tenders: [{ method: "cash", amountMinor: 100 }] }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("PAY-CREATE-05 records a tip outside the service total", async () => {
    const appt = await visit(at("13:00", "2027-06-02"));
    const payment = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        version: appt.version,
        tipMinor: 20000,
        tenders: [{ method: "card", amountMinor: 170000 }],
      }),
    );
    expect(payment.totalMinor).toBe(170000);
    expect(payment.paidMinor).toBe(150000);
  });

  it("PAY-DEBT-01 increases balance on a short payment and reduces it when the debt is paid", async () => {
    const appt = await visit(at("14:00", "2027-06-03"));
    await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        version: appt.version,
        tenders: [{ method: "cash", amountMinor: 60000 }],
      }),
    );
    const before = await run(salon.admin, (ctx) =>
      one<{ balance_minor: number }>(ctx.db, "SELECT balance_minor FROM clients WHERE id = $1", [salon.clientId]),
    );
    const balance = Number(before?.balance_minor);
    expect(balance).toBeGreaterThanOrEqual(90000);
    const debt = await run(salon.accountant, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        kind: "debt",
        clientId: salon.clientId,
        tenders: [{ method: "cash", amountMinor: 90000 }],
      }),
    );
    expect(debt.totalMinor).toBe(90000);
    const after = await run(salon.admin, (ctx) =>
      one<{ balance_minor: number }>(ctx.db, "SELECT balance_minor FROM clients WHERE id = $1", [salon.clientId]),
    );
    expect(Number(after?.balance_minor)).toBe(balance - 90000);
    await expect(
      run(salon.accountant, (ctx) =>
        createPayment(ctx, {
          branchId: salon.branchId,
          kind: "debt",
          clientId: salon.clientId,
          tenders: [{ method: "cash", amountMinor: 50_000_000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("returns SHIFT_REQUIRED when the policy is on and no shift is open", async () => {
    await run(salon.owner, async (ctx) => {
      await ctx.db.query("UPDATE cash_shifts SET status = 'closed', closed_at = now() WHERE branch_id = $1 AND status = 'open'", [
        salon.branchId,
      ]);
    });
    const appt = await visit(at("15:00", "2027-06-03"));
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, {
          branchId: salon.branchId,
          appointmentId: appt.id,
          version: appt.version,
          tenders: [{ method: "card", amountMinor: 150000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "SHIFT_REQUIRED" });
  });

  it("returns SHIFT_CLOSED while a shift is closing", async () => {
    await run(salon.owner, async (ctx) => {
      await ctx.db.query(
        `INSERT INTO cash_shifts (id, tenant_id, branch_id, opened_by, opening_cash_minor, status)
         VALUES ($1, $2, $3, $4, 0, 'closing')`,
        [crypto.randomUUID(), salon.tenantId, salon.branchId, salon.owner.userId],
      );
    });
    const appt = await visit(at("16:00", "2027-06-04"));
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, {
          branchId: salon.branchId,
          appointmentId: appt.id,
          tenders: [{ method: "card", amountMinor: 150000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "SHIFT_CLOSED" });
  });

  it("rejects card overpay that cannot be given back as change", async () => {
    await run(salon.owner, async (ctx) => {
      await ctx.db.query("DELETE FROM cash_shifts WHERE branch_id = $1 AND status = 'closing'", [salon.branchId]);
      await ctx.db.query(
        `INSERT INTO cash_shifts (id, tenant_id, branch_id, opened_by, opening_cash_minor, status)
         VALUES ($1, $2, $3, $4, 0, 'open')`,
        [crypto.randomUUID(), salon.tenantId, salon.branchId, salon.owner.userId],
      );
    });
    const appt = await visit(at("17:00", "2027-06-04"));
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, {
          branchId: salon.branchId,
          appointmentId: appt.id,
          version: appt.version,
          tenders: [{ method: "card", amountMinor: 180000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  void createClient;
});
