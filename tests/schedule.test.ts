import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { getWeekTemplate } from "@/server/catalog";
import { loadWorkingIntervals } from "@/server/hours";
import {
  createException,
  createScheduleRequest,
  decideScheduleRequest,
  deleteException,
  listExceptions,
  listScheduleRequests,
  readWeekTemplate,
} from "@/server/schedule";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
});

describe("schedule", () => {
  it("SCH read: a master sees only their own week", async () => {
    const own = await run(salon.master, (ctx) => readWeekTemplate(ctx, salon.staffA, salon.branchId));
    expect(own).toHaveLength(7);
    await expect(run(salon.master, (ctx) => readWeekTemplate(ctx, salon.staffB, salon.branchId))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.master, (ctx) => listExceptions(ctx, salon.staffB, salon.branchId, "2026-11-01"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("SCH-EXCEPTION-01 day off warns about booked visits, then removes the working day; deleting restores it", async () => {
    await run(salon.admin, (ctx) =>
      createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffB, clientId: salon.clientId, startsAt: at("12:00", "2026-11-20"), services: [{ serviceId: salon.serviceId }] }),
    );
    await expect(
      run(salon.admin, (ctx) => createException(ctx, salon.staffB, salon.branchId, { kind: "day_off", startsOn: "2026-11-20" })),
    ).rejects.toMatchObject({ code: "SOFT_CONFIRM", details: { affected: 1 } });
    await expect(run(salon.master, (ctx) => createException(ctx, salon.staffA, salon.branchId, { kind: "day_off", startsOn: "2026-11-20" }))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const { id } = await run(salon.admin, (ctx) =>
      createException(ctx, salon.staffB, salon.branchId, { kind: "day_off", startsOn: "2026-11-20", note: "семейные дела" }, true),
    );
    const list = await run(salon.admin, (ctx) => listExceptions(ctx, salon.staffB, salon.branchId, "2026-11-01"));
    expect(list).toEqual([expect.objectContaining({ id, kind: "day_off", startsOn: "2026-11-20", endsOn: "2026-11-20", note: "семейные дела" })]);
    expect((await run(salon.admin, (ctx) => loadWorkingIntervals(ctx.db, salon.branchId, salon.staffB, "2026-11-20"))).dayOff).toBe(true);
    await run(salon.admin, (ctx) => deleteException(ctx, id));
    expect((await run(salon.admin, (ctx) => loadWorkingIntervals(ctx.db, salon.branchId, salon.staffB, "2026-11-20"))).dayOff).toBe(false);
  });

  it("SCH-EXCEPTION validation: special hours need a valid single-day interval", async () => {
    await expect(
      run(salon.admin, (ctx) => createException(ctx, salon.staffB, salon.branchId, { kind: "special_hours", startsOn: "2026-11-21", startMin: 900, endMin: 600 })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      run(salon.admin, (ctx) => createException(ctx, salon.staffB, salon.branchId, { kind: "special_hours", startsOn: "2026-11-21", endsOn: "2026-11-22", startMin: 600, endMin: 900 })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      run(salon.admin, (ctx) => createException(ctx, salon.staffB, salon.branchId, { kind: "vacation", startsOn: "2026-11-25", endsOn: "2026-11-24" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("SCH request: master asks, admin approves the week; rejection needs a note; master can withdraw", async () => {
    const week = [1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, startMin: 600, endMin: 1140, kind: "work" as const },
      { weekday, startMin: 840, endMin: 900, kind: "break" as const },
    ]);
    await expect(
      run(salon.admin, (ctx) => createScheduleRequest(ctx, { branchId: salon.branchId, kind: "template", intervals: week })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      run(salon.master, (ctx) =>
        createScheduleRequest(ctx, { branchId: salon.branchId, kind: "template", intervals: [...week, { weekday: 1, startMin: 1000, endMin: 1200, kind: "work" }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" }); // SCH-CONFLICT-01 overlap

    const asked = await run(salon.master, (ctx) => createScheduleRequest(ctx, { branchId: salon.branchId, kind: "template", intervals: week, comment: "учусь по выходным" }));
    expect(asked.status).toBe("pending");
    await expect(run(salon.master, (ctx) => decideScheduleRequest(ctx, asked.id, { approve: true }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const approved = await run(salon.admin, (ctx) => decideScheduleRequest(ctx, asked.id, { approve: true }));
    expect(approved.status).toBe("approved");
    const template = await run(salon.admin, (ctx) => getWeekTemplate(ctx, salon.staffA, salon.branchId));
    expect(template).toHaveLength(10);
    await expect(run(salon.admin, (ctx) => decideScheduleRequest(ctx, asked.id, { approve: false, note: "x" }))).rejects.toMatchObject({ code: "VALIDATION" });

    const leave = await run(salon.master, (ctx) =>
      createScheduleRequest(ctx, { branchId: salon.branchId, kind: "exception", exception: { kind: "vacation", startsOn: "2026-12-10", endsOn: "2026-12-20" }, comment: "отпуск" }),
    );
    await expect(run(salon.admin, (ctx) => decideScheduleRequest(ctx, leave.id, { approve: false }))).rejects.toMatchObject({ code: "VALIDATION" });
    const rejected = await run(salon.admin, (ctx) => decideScheduleRequest(ctx, leave.id, { approve: false, note: "в декабре пик, давайте январь" }));
    expect(rejected).toMatchObject({ status: "rejected", decisionNote: "в декабре пик, давайте январь" });

    const again = await run(salon.master, (ctx) =>
      createScheduleRequest(ctx, { branchId: salon.branchId, kind: "exception", exception: { kind: "vacation", startsOn: "2027-01-10", endsOn: "2027-01-20" }, comment: "отпуск" }),
    );
    expect((await run(salon.master, (ctx) => decideScheduleRequest(ctx, again.id, { approve: false }))).status).toBe("withdrawn");

    const mine = await run(salon.master, (ctx) => listScheduleRequests(ctx, salon.branchId));
    expect(mine.map((row) => row.status).sort()).toEqual(["approved", "rejected", "withdrawn"]);
  });
});
