import { beforeAll, describe, expect, it } from "vitest";
import { accessState, invoiceAmount } from "@/domain/plans";
import { billingSummary, createInvoice, platformTenants, platformUpdateTenant, sandboxPayInvoice, tenantAccess } from "@/server/billing";
import { createStaff } from "@/server/catalog";
import { bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
const DAY = 86400000;

beforeAll(async () => {
  salon = await createSalon();
});

describe("plans", () => {
  it("PLAT-BILLING-01 prices longer periods with a discount", () => {
    expect(invoiceAmount("start", 1)).toBe(149000);
    expect(invoiceAmount("salon", 6)).toBe(Math.round(349000 * 6 * 0.9));
    expect(invoiceAmount("network", 12)).toBe(Math.round(799000 * 12 * 0.8));
  });

  it("PLAT-TENANT-01 trial → grace → read-only; suspension always wins", () => {
    const now = new Date("2026-11-04T12:00:00Z");
    const base = { plan: "trial" as const, paidUntil: null, suspendedAt: null };
    expect(accessState({ ...base, trialEndsAt: new Date(now.getTime() + 5 * DAY) }, now)).toMatchObject({ state: "trial", daysLeft: 5 });
    expect(accessState({ ...base, trialEndsAt: new Date(now.getTime() - DAY) }, now).state).toBe("grace");
    expect(accessState({ ...base, trialEndsAt: new Date(now.getTime() - 4 * DAY) }, now).state).toBe("expired");
    expect(accessState({ plan: "salon", trialEndsAt: new Date(now.getTime() - 40 * DAY), paidUntil: new Date(now.getTime() + 20 * DAY), suspendedAt: null }, now).state).toBe("active");
    expect(accessState({ ...base, trialEndsAt: new Date(now.getTime() + 5 * DAY), suspendedAt: now }, now).state).toBe("suspended");
  });
});

describe("subscription", () => {
  it("PLAT-TENANT-01 a new salon starts on a trial with everything open", async () => {
    const summary = await run(salon.owner, (ctx) => billingSummary(ctx), new Date());
    expect(summary).toMatchObject({ plan: "trial", state: "trial", provider: "test", usage: { staff: 2, branches: 2 } });
    expect(summary.daysLeft).toBeGreaterThan(10);
    expect(summary.plans.find((plan) => plan.id === "start")?.fits).toBe(false);
  });

  it("PLAT-BILLING-01 only the owner buys; a plan that does not fit is refused", async () => {
    await expect(run(salon.admin, (ctx) => createInvoice(ctx, { plan: "salon", months: 1 }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.owner, (ctx) => createInvoice(ctx, { plan: "start", months: 1 }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.owner, (ctx) => createInvoice(ctx, { plan: "salon", months: 3 }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("PLAT-BILLING-01 paying keeps the rest of the trial and switches the plan", async () => {
    const now = new Date();
    const before = await run(salon.owner, (ctx) => billingSummary(ctx), now);
    const invoice = await run(salon.owner, (ctx) => createInvoice(ctx, { plan: "salon", months: 1 }), now);
    expect(invoice).toMatchObject({ number: 1, status: "pending", amountMinor: 349000, provider: "test" });
    const paid = await run(salon.owner, (ctx) => sandboxPayInvoice(ctx, invoice.id), now);
    expect(paid).toMatchObject({ plan: "salon", state: "active", limits: { staffLimit: 10, branchLimit: 2 } });
    const until = new Date(paid.paidUntil!);
    const expected = new Date(before.trialEndsAt);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(Math.abs(until.getTime() - expected.getTime())).toBeLessThan(5000);
    expect(paid.invoices[0]).toMatchObject({ status: "paid" });
  });

  it("PLAT-BILLING-01 the database refuses a master or branch over the plan", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET plan = 'start' WHERE id = $1", [salon.tenantId]));
    await expect(run(salon.owner, (ctx) => createStaff(ctx, { displayName: "Третья", branchIds: [salon.branchId] }))).resolves.toBeTruthy();
    await expect(run(salon.owner, (ctx) => createStaff(ctx, { displayName: "Четвёртая", branchIds: [salon.branchId] }))).rejects.toMatchObject({ code: "PLAN_LIMIT", details: { limit: "staff", max: 3 } });
    await expect(
      run(salon.owner, (ctx) => ctx.db.query("INSERT INTO branches (id, tenant_id, name) VALUES ($1, $2, 'Лишний')", [crypto.randomUUID(), salon.tenantId])),
    ).rejects.toMatchObject({ code: "PLAN_LIMIT" });
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET plan = 'salon' WHERE id = $1", [salon.tenantId]));
  });

  it("PLAT-BILLING-01 an ended subscription makes the salon read-only", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET paid_until = now() - interval '5 days', trial_ends_at = now() - interval '40 days' WHERE id = $1", [salon.tenantId]));
    expect(await tenantAccess(salon.tenantId)).toMatchObject({ state: "expired", readOnly: true });
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET paid_until = now() - interval '1 day' WHERE id = $1", [salon.tenantId]));
    expect(await tenantAccess(salon.tenantId)).toMatchObject({ state: "grace", readOnly: false });
  });
});

describe("platform admin", () => {
  it("PLAT-SUPER-01 is closed to salon owners and open to the platform team", async () => {
    await expect(platformTenants(salon.owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    process.env.PLATFORM_ADMIN_EMAILS = `ops@platform.local, ${salon.owner.email.toUpperCase()}`;
    try {
      const list = await platformTenants(salon.owner);
      const mine = list.find((row) => row.id === salon.tenantId)!;
      expect(mine).toMatchObject({ ownerEmail: salon.owner.email, branches: 2, paidTotalMinor: 349000 });

      const suspended = await platformUpdateTenant(salon.owner, salon.tenantId, { suspend: true, reason: "долг" });
      expect(suspended).toMatchObject({ state: "suspended", suspendedReason: "долг" });
      expect(await tenantAccess(salon.tenantId)).toMatchObject({ readOnly: true, reason: "долг" });

      const back = await platformUpdateTenant(salon.owner, salon.tenantId, { suspend: false, extendDays: 30 });
      expect(back).toMatchObject({ state: "active" });
      expect(back!.daysLeft).toBeGreaterThanOrEqual(29);
    } finally {
      delete process.env.PLATFORM_ADMIN_EMAILS;
    }
  });
});
