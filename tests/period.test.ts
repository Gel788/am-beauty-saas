import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { createPayment, openShift } from "@/server/payments";
import { getCalendar, masterDay, periodReport, periodReportCsv } from "@/server/period";
import { many } from "@/server/db";
import { addCalendarDays, formatLocalDate, mondayOf } from "@/domain/time";
import { TZ, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
// Payments are stamped with the database clock, so the period is built around the real local day.
const now = new Date();
const today = formatLocalDate(now, TZ);
const tomorrow = addCalendarDays(today, 1);

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
});

function visit(day: string, time: string, staffId = salon.staffA, source?: "online") {
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId, clientId: salon.clientId, startsAt: at(time, day), services: [{ serviceId: salon.serviceId }], acknowledgeSoft: true, ...(source ? { source } : {}) }),
  );
}

describe("week and month journal", () => {
  it("TT-VIEW-04 groups a week by local day; masters see only themselves when columns are hidden", async () => {
    const monday = mondayOf(tomorrow);
    const a = await visit(tomorrow, "10:00");
    const b = await visit(tomorrow, "13:00", salon.staffB);
    const week = await run(salon.admin, (ctx) => getCalendar(ctx, { branchId: salon.branchId, from: monday, days: 7 }));
    expect(week.days).toHaveLength(7);
    const day = week.days.find((item) => item.date === tomorrow)!;
    expect(day.appointments.map((row) => row.id)).toEqual([a.id, b.id]);
    expect(day.appointments[0]).toMatchObject({ time: "10:00", staffName: expect.any(String) });
    expect(day.expectedMinor).toBeGreaterThan(0);

    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET master_sees_all_columns = false WHERE id = $1", [salon.branchId]));
    const own = await run(salon.master, (ctx) => getCalendar(ctx, { branchId: salon.branchId, from: monday, days: 7 }));
    expect(own.days.flatMap((item) => item.appointments).every((row) => row.staffId === salon.staffA)).toBe(true);
    await expect(run(salon.accountant, (ctx) => getCalendar(ctx, { branchId: salon.branchId, from: monday, days: 7 }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const month = await run(salon.admin, (ctx) => getCalendar(ctx, { branchId: salon.branchId, from: monday, days: 99 }));
    expect(month.days).toHaveLength(42);
  });
});

describe("period report", () => {
  it("AN-RANGE-01 totals, staff split, filters and comparison with the previous period", async () => {
    const a = await visit(today, "09:00");
    const b = await visit(today, "11:00", salon.staffB, "online");
    await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: a.id, tenders: [{ method: "card", amountMinor: 150000 }], tipMinor: 20000 }));
    await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: b.id, tenders: [{ method: "cash", amountMinor: 150000 }] }));
    const from = addCalendarDays(today, -6);
    const report = await run(salon.accountant, (ctx) => periodReport(ctx, { branchId: salon.branchId, from, to: today }));
    expect(report.current.servicesMinor).toBe(280000); // the tip is inside the card amount
    expect(report.current.tipsMinor).toBe(20000);
    expect(report.current.averageCheckMinor).toBe(140000);
    expect(report.previous).toEqual({ from: addCalendarDays(from, -7), to: addCalendarDays(from, -1) });
    expect(report.days).toHaveLength(7);
    expect(report.days.at(-1)!.revenueMinor).toBe(300000);
    expect(report.staff.find((row) => row.staffId === salon.staffA)).toMatchObject({ servicesMinor: 130000, tipsMinor: 20000, visits: 1 });
    expect(report.services[0]).toMatchObject({ serviceId: salon.serviceId });

    const onlyB = await run(salon.admin, (ctx) => periodReport(ctx, { branchId: salon.branchId, from, to: today, staffId: salon.staffB }));
    expect(onlyB.current.revenueMinor).toBe(150000);
    const online = await run(salon.admin, (ctx) => periodReport(ctx, { branchId: salon.branchId, from, to: today, source: "online" }));
    expect(online.current.online).toBe(1);
    expect(online.current.revenueMinor).toBe(150000);

    // A master sees their own numbers whatever filter they send.
    const mine = await run(salon.master, (ctx) => periodReport(ctx, { branchId: salon.branchId, from, to: today, staffId: salon.staffB }));
    expect(mine.current.servicesMinor).toBe(130000);
    expect(mine.staff.every((row) => row.staffId === salon.staffA)).toBe(true);

    await expect(run(salon.admin, (ctx) => periodReport(ctx, { branchId: salon.branchId, from: today, to: from }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("AN-EXPORT-01 CSV for Excel, with an audit record", async () => {
    const file = await run(salon.accountant, (ctx) => periodReportCsv(ctx, { branchId: salon.branchId, from: today, to: today }));
    expect(file.fileName).toBe(`otchet_${today}_${today}.csv`);
    expect(file.body.startsWith("﻿Отчёт за период")).toBe(true);
    expect(file.body).toContain("Выручка, ₽;");
    const rows = await run(salon.owner, (ctx) => many<{ action: string }>(ctx.db, "SELECT action FROM audit_log WHERE action = 'report.exported'"));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("master's day", () => {
  it("MASTER-DAY-01 own visits with client notes, first-visit flag and today's money", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE clients SET notes = 'Аллергия на латекс' WHERE id = $1", [salon.clientId]));
    const day = await run(salon.master, (ctx) => masterDay(ctx, { date: today }), now);
    expect(day.appointments.length).toBeGreaterThan(0);
    expect(day.appointments[0]).toMatchObject({ clientNotes: "Аллергия на латекс", time: "09:00" });
    expect(day.servicesMinor).toBe(130000);
    expect(day.tipsMinor).toBe(20000);
    await expect(run(salon.admin, (ctx) => masterDay(ctx, {}))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
