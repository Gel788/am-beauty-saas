import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoice, platformUpdateTenant, sandboxPayInvoice } from "@/server/billing";
import { pool } from "@/server/db";
import { platformCreateTask, platformDeleteTask, platformEvents, platformInvoices, platformOverview, platformSetTaskDone, platformTasks, platformTenantDetail } from "@/server/platform";
import { bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let invoiceNumber = 0;

beforeAll(async () => {
  salon = await createSalon();
  const invoice = await run(salon.owner, (ctx) => createInvoice(ctx, { plan: "salon", months: 6 }), new Date());
  invoiceNumber = invoice.number;
  await run(salon.owner, (ctx) => sandboxPayInvoice(ctx, invoice.id), new Date());
  process.env.PLATFORM_ADMIN_EMAILS = salon.owner.email;
});
afterAll(() => {
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("platform cabinet", () => {
  it("PLAT-CABINET-00 every endpoint is closed to a salon owner who is not on the platform team", async () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    try {
      for (const call of [() => platformOverview(salon.owner), () => platformInvoices(salon.owner), () => platformTasks(salon.owner), () => platformEvents(salon.owner), () => platformTenantDetail(salon.owner, salon.tenantId)]) {
        await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    } finally {
      process.env.PLATFORM_ADMIN_EMAILS = salon.owner.email;
    }
  });

  it("PLAT-CABINET-00 platform tables are not readable by the app role directly", async () => {
    const tasks = await pool.query("SELECT count(*)::int AS n FROM platform_tasks");
    expect(tasks.rows[0].n).toBe(0);
    await expect(pool.query("INSERT INTO platform_tasks (id, title, created_by) VALUES (gen_random_uuid(), 'x', 'y')")).rejects.toThrow();
  });

  it("PLAT-CABINET-01 overview counts the paying salon into MRR by its paid invoice", async () => {
    const data = await platformOverview(salon.owner);
    expect(data.totals.active).toBeGreaterThanOrEqual(1);
    // Six months of «Салон» with −10%: per month that is 349 000 × 0.9.
    expect(data.totals.mrrMinor).toBeGreaterThanOrEqual(Math.round((349000 * 6 * 0.9) / 6));
    expect(data.months).toHaveLength(12);
    expect(data.months.at(-1)!.paidMinor).toBeGreaterThanOrEqual(Math.round(349000 * 6 * 0.9));
    expect(data.plans.find((item) => item.plan === "salon")!.count).toBeGreaterThanOrEqual(1);
  });

  it("PLAT-CABINET-02 salon card shows usage, invoices and history", async () => {
    const detail = await platformTenantDetail(salon.owner, salon.tenantId);
    expect(detail.tenant).toMatchObject({ id: salon.tenantId, plan: "salon", state: "active" });
    expect(detail.usage.branchNames).toHaveLength(2);
    expect(detail.usage.months).toHaveLength(6);
    expect(detail.invoices.map((item) => item.number)).toContain(invoiceNumber);
    expect(detail.events.map((item) => item.kind)).toEqual(expect.arrayContaining(["paid", "invoice", "signup"]));
    await expect(platformTenantDetail(salon.owner, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("PLAT-CABINET-03 to-do list: create, tie to a salon, close, delete", async () => {
    await expect(platformCreateTask(salon.owner, { title: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(platformCreateTask(salon.owner, { title: "Позвонить", dueOn: "завтра" })).rejects.toMatchObject({ code: "VALIDATION" });
    const task = await platformCreateTask(salon.owner, { title: "Позвонить владельцу", dueOn: "2026-11-10", tenantId: salon.tenantId });
    expect(task).toMatchObject({ title: "Позвонить владельцу", dueOn: "2026-11-10", tenantId: salon.tenantId, doneAt: null, createdBy: salon.owner.email });
    expect((await platformTenantDetail(salon.owner, salon.tenantId)).tasks.map((item) => item.id)).toContain(task!.id);
    const done = await platformSetTaskDone(salon.owner, task!.id, true);
    expect(done.doneAt).not.toBeNull();
    const reopened = await platformSetTaskDone(salon.owner, task!.id, false);
    expect(reopened.doneAt).toBeNull();
    await platformDeleteTask(salon.owner, task!.id);
    expect((await platformTasks(salon.owner)).some((item) => item.id === task!.id)).toBe(false);
    await expect(platformDeleteTask(salon.owner, task!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("PLAT-CABINET-04 team actions land in the event feed", async () => {
    await platformUpdateTenant(salon.owner, salon.tenantId, { extendDays: 7 });
    const feed = await platformEvents(salon.owner, 500);
    const mine = feed.filter((item) => item.tenantId === salon.tenantId);
    expect(mine.some((item) => item.kind === "action" && item.text.includes("продлено на 7 дн."))).toBe(true);
  });
});
