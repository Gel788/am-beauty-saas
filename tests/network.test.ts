import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { createBranch, currentBranchId, networkSummary, orderByCurrent, setCurrentBranch } from "@/server/network";
import { listBranches } from "@/server/settings";
import { many, one } from "@/server/db";
import { addCalendarDays, formatLocalDate } from "@/domain/time";
import { TZ, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
const today = formatLocalDate(new Date(), TZ);
const tomorrow = addCalendarDays(today, 1);

beforeAll(async () => {
  salon = await createSalon();
});

describe("salon network", () => {
  it("NET-BRANCH-01 the owner opens a branch that copies settings and links chosen masters", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET online_cancel_hours = 6, require_payment_on_complete = true, fiscal_inn = '7700000000' WHERE id = $1", [salon.branchId]));
    const created = await run(salon.owner, (ctx) =>
      createBranch(ctx, { name: "Тверская", address: "Тверская, 7", phone: "+7 495 000-00-00", timezone: "Europe/Moscow", slug: "tverskaya", copyFrom: salon.branchId, staffIds: [salon.staffB] }),
    );
    expect(created).toMatchObject({ name: "Тверская", address: "Тверская, 7", phone: "+7 495 000-00-00", slug: "tverskaya", onlineCancelHours: 6, requirePaymentOnComplete: true, fiscalInn: "" });
    const links = await run(salon.owner, (ctx) => many<{ staff_id: string }>(ctx.db, "SELECT staff_id FROM staff_branches WHERE branch_id = $1", [created.id]));
    expect(links.map((row) => row.staff_id)).toEqual([salon.staffB]);
    const logged = await run(salon.owner, (ctx) => one(ctx.db, "SELECT 1 FROM audit_log WHERE entity = 'branch' AND entity_id = $1 AND action = 'branch.created'", [created.id]));
    expect(logged).toBeTruthy();
  });

  it("NET-BRANCH-01 only the owner opens branches; names, zones and links are checked", async () => {
    await expect(run(salon.admin, (ctx) => createBranch(ctx, { name: "Ещё" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.owner, (ctx) => createBranch(ctx, { name: " " }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.owner, (ctx) => createBranch(ctx, { name: "Луна", timezone: "Mars/Olympus" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.owner, (ctx) => createBranch(ctx, { name: "Дубль", slug: "tverskaya" }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("NET-SWITCH-01 the picked branch goes first; a branch admin cannot switch to another branch", async () => {
    await run(salon.owner, (ctx) => setCurrentBranch(ctx, salon.otherBranchId));
    const current = await currentBranchId(salon.owner.userId);
    expect(current).toBe(salon.otherBranchId);
    const branches = await run(salon.owner, (ctx) => listBranches(ctx));
    expect(orderByCurrent(branches, current)[0].id).toBe(salon.otherBranchId);
    expect(orderByCurrent(branches, null)[0].id).toBe(branches[0].id);
    await expect(run(salon.admin, (ctx) => setCurrentBranch(ctx, salon.otherBranchId))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("NET-DASH-01 compares branches: revenue share, load and no-show rate; clients are counted once", async () => {
    const book = (branchId: string, time: string, staffId: string) =>
      run(salon.owner, (ctx) =>
        createAppointment(ctx, { branchId, staffId, clientId: salon.clientId, startsAt: at(time, tomorrow), services: [{ serviceId: salon.serviceId }], acknowledgeSoft: true }),
      );
    await book(salon.branchId, "10:00", salon.staffB);
    const missed = await book(salon.branchId, "12:00", salon.staffB);
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE appointments SET status = 'no_show' WHERE id = $1", [missed.id]));
    await book(salon.otherBranchId, "15:00", salon.staffA);

    const report = await run(salon.owner, (ctx) => networkSummary(ctx, { from: tomorrow, to: tomorrow }));
    expect(report.branches.map((row) => row.name).sort()).toEqual(["Патриаршие", "Садовая", "Тверская"]);
    const main = report.branches.find((row) => row.branchId === salon.branchId)!;
    expect(main).toMatchObject({ appointments: 2, noShow: 1, noShowRate: 50, staff: 2 });
    expect(main.availableMinutes).toBe(2 * 12 * 60);
    expect(main.loadPercent).toBe(Math.round((100 * 60) / (2 * 12 * 60)));
    expect(report.total.appointments).toBe(3);
    expect(report.total.clients).toBe(1);
    expect(report.total.clientsInSeveralBranches).toBe(1);
    expect(report.previous.to).toBe(today);
  });

  it("NET-DASH-01 a branch admin sees only their branch; masters see nothing", async () => {
    const report = await run(salon.admin, (ctx) => networkSummary(ctx, { from: today, to: today }));
    expect(report.branches.map((row) => row.branchId)).toEqual([salon.branchId]);
    await expect(run(salon.master, (ctx) => networkSummary(ctx, { from: today, to: today }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.owner, (ctx) => networkSummary(ctx, { from: today, to: addCalendarDays(today, 120) }))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
