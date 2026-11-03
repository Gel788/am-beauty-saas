import { beforeAll, describe, expect, it } from "vitest";
import {
  addException,
  copyExceptionsToNextWeek,
  createCategory,
  createService,
  createStaff,
  deactivateService,
  deactivateStaff,
  deleteCategory,
  reorderServices,
  saveWeekTemplate,
  setServiceStaff,
  updateService,
} from "@/server/catalog";
import { createAppointment, getAppointment } from "@/server/appointments";
import { at, createSalon, run, bindTestDb } from "./helpers";
import { one } from "@/server/db";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
});

describe("catalog", () => {
  it("SVC-CREATE-01 and SVC-EDIT-01 validate duration and price", async () => {
    const category = await run(salon.admin, (ctx) => createCategory(ctx, "Ногти"));
    await expect(
      run(salon.admin, (ctx) => createService(ctx, { title: "Коротко", durationMin: 4, priceMinor: 100, categoryId: category.id })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const service = await run(salon.admin, (ctx) =>
      createService(ctx, {
        title: "Педикюр",
        durationMin: 60,
        priceMinor: 200000,
        categoryId: category.id,
        staffIds: [salon.staffA],
        color: "#f8d0e4",
      }),
    );
    expect(service.staffIds).toEqual([salon.staffA]);
    const updated = await run(salon.admin, (ctx) => updateService(ctx, service.id, { priceMinor: 210000, durationMin: 75 }));
    expect(updated.priceMinor).toBe(210000);
    expect(updated.durationMin).toBe(75);
  });

  it("SVC-DELETE-01 hides a service and keeps the historical snapshot", async () => {
    const service = await run(salon.admin, (ctx) =>
      createService(ctx, { title: "Архив", durationMin: 30, priceMinor: 100000, staffIds: [salon.staffA] }),
    );
    const visit = await run(salon.admin, (ctx) =>
      createAppointment(ctx, {
        branchId: salon.branchId,
        staffId: salon.staffA,
        clientId: salon.clientId,
        startsAt: at("11:00", "2027-05-03"),
        services: [{ serviceId: service.id }],
        acknowledgeSoft: true,
      }),
    );
    await run(salon.admin, (ctx) => updateService(ctx, service.id, { priceMinor: 999, durationMin: 45 }));
    const fresh = await run(salon.admin, (ctx) => getAppointment(ctx, visit.id));
    expect(fresh.services[0].priceMinor).toBe(100000);
    expect(fresh.services[0].durationMin).toBe(30);
    await run(salon.admin, (ctx) => deactivateService(ctx, service.id));
    await expect(
      run(salon.admin, (ctx) =>
        createAppointment(ctx, {
          branchId: salon.branchId,
          staffId: salon.staffA,
          clientId: salon.clientId,
          startsAt: at("12:00", "2027-05-03"),
          services: [{ serviceId: service.id }],
          acknowledgeSoft: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.owner, (ctx) => deactivateService(ctx, service.id, true))).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("SVC-STAFF-LINK-01 warns when the last master is removed", async () => {
    const service = await run(salon.admin, (ctx) =>
      createService(ctx, { title: "Связь", durationMin: 30, priceMinor: 1000, staffIds: [salon.staffA] }),
    );
    await expect(run(salon.admin, (ctx) => setServiceStaff(ctx, service.id, []))).rejects.toMatchObject({
      code: "SOFT_CONFIRM",
    });
    const cleared = await run(salon.admin, (ctx) => setServiceStaff(ctx, service.id, [], true));
    expect(cleared.staffIds).toEqual([]);
  });

  it("SVC-ORDER-01 stores the new order", async () => {
    const a = await run(salon.admin, (ctx) => createService(ctx, { title: "А", durationMin: 15, priceMinor: 100 }));
    const b = await run(salon.admin, (ctx) => createService(ctx, { title: "Б", durationMin: 15, priceMinor: 100 }));
    await run(salon.admin, (ctx) => reorderServices(ctx, [b.id, a.id]));
    const rows = await run(salon.admin, (ctx) =>
      ctx.db.query("SELECT id FROM services WHERE id = ANY($1::uuid[]) ORDER BY sort", [[b.id, a.id]]),
    );
    expect(rows.rows.map((row) => row.id)).toEqual([b.id, a.id]);
  });

  it("refuses to delete a category that still has services", async () => {
    const category = await run(salon.admin, (ctx) => createCategory(ctx, "Волосы"));
    await run(salon.admin, (ctx) =>
      createService(ctx, { title: "Стрижка", durationMin: 45, priceMinor: 180000, categoryId: category.id }),
    );
    await expect(run(salon.admin, (ctx) => deleteCategory(ctx, category.id))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("STF-CREATE-01 creates a profile and an optional login", async () => {
    const staff = await run(salon.owner, (ctx) =>
      createStaff(ctx, {
        displayName: "Денис Волков",
        branchIds: [salon.branchId],
        color: "#9ec1ff",
        invite: { email: `denis-${salon.tenantId.slice(0, 8)}@test.local`, password: "ambeauty", name: "Денис" },
      }),
    );
    expect(staff.userId).toBeTruthy();
    expect(staff.branchIds).toEqual([salon.branchId]);
    const membership = await run(salon.owner, (ctx) =>
      one<{ role: string }>(ctx.db, "SELECT role FROM memberships WHERE user_id = $1", [staff.userId]),
    );
    expect(membership?.role).toBe("master");
  });

  it("STF-PERMISSIONS-01 keeps the role separate from the staff profile", async () => {
    expect(salon.admin.staffId).toBeNull();
    expect(salon.master.role).toBe("master");
    expect(salon.master.staffId).toBe(salon.staffA);
  });

  it("STF-DEACTIVATE-01 requires a decision for future visits", async () => {
    const staff = await run(salon.owner, (ctx) =>
      createStaff(ctx, { displayName: "Временный", branchIds: [salon.branchId] }),
    );
    await run(salon.admin, (ctx) => setServiceStaff(ctx, salon.serviceId, [salon.staffA, salon.staffB, staff.id], true));
    await run(salon.admin, (ctx) =>
      saveWeekTemplate(ctx, {
        staffId: staff.id,
        branchId: salon.branchId,
        intervals: [{ weekday: 1, startMin: 540, endMin: 1260, kind: "work" }, { weekday: 2, startMin: 540, endMin: 1260, kind: "work" }, { weekday: 3, startMin: 540, endMin: 1260, kind: "work" }, { weekday: 4, startMin: 540, endMin: 1260, kind: "work" }, { weekday: 5, startMin: 540, endMin: 1260, kind: "work" }, { weekday: 6, startMin: 540, endMin: 1260, kind: "work" }, { weekday: 7, startMin: 540, endMin: 1260, kind: "work" }],
      }),
    );
    await run(salon.admin, (ctx) =>
      createAppointment(ctx, {
        branchId: salon.branchId,
        staffId: staff.id,
        clientId: salon.clientId,
        startsAt: at("13:00", "2027-05-04"),
        services: [{ serviceId: salon.serviceId }],
        acknowledgeSoft: true,
      }),
    );
    await expect(run(salon.admin, (ctx) => deactivateStaff(ctx, staff.id))).rejects.toMatchObject({
      code: "VALIDATION",
      details: { futureCount: 1 },
    });
    const cancelled = await run(salon.admin, (ctx) => deactivateStaff(ctx, staff.id, "cancel"));
    expect(cancelled.active).toBe(false);
  });

  it("SCH-WEEK-01 saves a week and copies exceptions forward", async () => {
    const week = await run(salon.admin, (ctx) =>
      saveWeekTemplate(ctx, {
        staffId: salon.staffA,
        branchId: salon.branchId,
        intervals: [
          { weekday: 2, startMin: 600, endMin: 1200, kind: "work" },
          { weekday: 2, startMin: 840, endMin: 900, kind: "break" },
        ],
      }),
    );
    expect(week).toHaveLength(2);
    await run(salon.admin, (ctx) =>
      addException(ctx, {
        staffId: salon.staffA,
        branchId: salon.branchId,
        startsOn: "2027-05-11",
        kind: "special_hours",
        startMin: 720,
        endMin: 900,
      }),
    );
    const copied = await run(salon.admin, (ctx) => copyExceptionsToNextWeek(ctx, salon.staffA, salon.branchId, "2027-05-11"));
    expect(copied.copied).toBe(1);
  });

  it("SCH-CONFLICT-01 rejects overlapping template intervals", async () => {
    await expect(
      run(salon.admin, (ctx) =>
        saveWeekTemplate(ctx, {
          staffId: salon.staffB,
          branchId: salon.branchId,
          intervals: [
            { weekday: 3, startMin: 600, endMin: 900, kind: "work" },
            { weekday: 3, startMin: 800, endMin: 1000, kind: "work" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("SCH-EXCEPTION-01 stores a day off", async () => {
    const exception = await run(salon.admin, (ctx) =>
      addException(ctx, { staffId: salon.staffB, branchId: salon.branchId, startsOn: "2027-05-20", endsOn: "2027-05-22", kind: "vacation" }),
    );
    expect(exception.id).toBeTruthy();
  });

  it("forbids a master from editing the catalog", async () => {
    await expect(
      run(salon.master, (ctx) => createService(ctx, { title: "Нет", durationMin: 30, priceMinor: 100 })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
