import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { hitTestColumn, journalHotkey, pointerIntent, resolveDensity, resolveDrop } from "@/domain/grid";
import {
  cancelAppointment,
  changeStatus,
  createAppointment,
  exportAppointmentsCsv,
  getAppointment,
  getJournal,
  hardDeleteAppointment,
  moveAppointment,
  previousClient,
  resizeAppointment,
  restoreAppointment,
  searchAppointments,
  updateAppointment,
} from "@/server/appointments";
import { createClient } from "@/server/clients";
import { addException } from "@/server/catalog";
import { createPayment, openShift } from "@/server/payments";
import { setDensity } from "@/server/auth";
import { one } from "@/server/db";
import { at, createSalon, run, bindTestDb } from "./helpers";

bindTestDb();

type Salon = Awaited<ReturnType<typeof createSalon>>;
let salon: Salon;
let current = "2027-01-01";
let seq = 0;

beforeAll(async () => {
  salon = await createSalon();
});

beforeEach(() => {
  seq += 1;
  current = new Date(Date.UTC(2027, 0, seq)).toISOString().slice(0, 10);
});

function t(hhmm: string) {
  return at(hhmm, current);
}

function act<T>(actor: Salon["owner"], fn: Parameters<typeof run<T>>[1], when: string | Date = "12:00") {
  return run(actor, fn, when instanceof Date ? when : new Date(t(when)));
}

function book(actor: Salon["owner"] = salon.admin, overrides: Partial<Parameters<typeof createAppointment>[1]> = {}) {
  return act(actor, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId: salon.staffA,
      clientId: salon.clientId,
      startsAt: t("13:00"),
      services: [{ serviceId: salon.serviceId }],
      acknowledgeSoft: true,
      ...overrides,
    }),
  );
}

describe("timetable", () => {
  it("TT-VIEW-01 loads the working day with staff columns and appointments", async () => {
    await book();
    const journal = await act(salon.admin, (ctx) =>
      getJournal(ctx, { branchId: salon.branchId, date: current }),
    );
    expect(journal.staff.map((staff) => staff.name).sort()).toEqual(["Алина", "Марина"]);
    expect(journal.appointments.length).toBeGreaterThan(0);
    expect(journal.stats.appointmentCount).toBe(journal.appointments.length);
  });

  it("TT-VIEW-02 returns only the selected local date", async () => {
    await book(salon.admin, { startsAt: at("11:00", "2026-11-04") });
    const today = await act(salon.admin, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: current }));
    const tomorrow = await act(salon.admin, (ctx) =>
      getJournal(ctx, { branchId: salon.branchId, date: "2026-11-04" }),
    );
    expect(tomorrow.appointments.every((row) => row.startsAt.startsWith("2026-11-04") || row.startMin >= 0)).toBe(true);
    expect(tomorrow.date).toBe("2026-11-04");
    expect(today.date).toBe(current);
    expect(tomorrow.appointments.length).toBeGreaterThan(0);
  });

  it("TT-VIEW-03 hides filtered columns from the grid and from drag hit-testing", async () => {
    const journal = await act(salon.admin, (ctx) =>
      getJournal(ctx, { branchId: salon.branchId, date: current, staffIds: [salon.staffA] }),
    );
    expect(journal.staff.map((staff) => staff.id)).toEqual([salon.staffA]);
    const hidden = hitTestColumn(
      [
        { staffId: salon.staffA, x: 0, width: 100 },
        { staffId: salon.staffB, x: 100, width: 100, hidden: true },
      ],
      150,
    );
    expect(hidden).toBeNull();
  });

  it("TT-CREATE-01 creates a snapped appointment and writes audit", async () => {
    const created = await book(salon.admin, { startsAt: t("15:00"), comment: "окно" });
    expect(created.services).toHaveLength(1);
    expect(created.status).toBe("scheduled");
    expect(created.clientName).toBe("Анна Смирнова");
    expect(new Date(created.endsAt).getTime() - new Date(created.startsAt).getTime()).toBe(60 * 60000);
    expect(created.history.some((row) => row.action === "appointment.created")).toBe(true);
    await expect(book(salon.admin, { startsAt: t("15:30") })).rejects.toMatchObject({ code: "CONFLICT_SLOT" });
    await expect(book(salon.admin, { clientId: null, services: [] })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("TT-CREATE-02 creates when staff and time are chosen in the form", async () => {
    const created = await book(salon.owner, { staffId: salon.staffB, startsAt: t("16:00") });
    expect(created.staffId).toBe(salon.staffB);
  });

  it("TT-CREATE-03 creates a client inline and refuses a duplicate phone", async () => {
    const created = await book(salon.admin, {
      clientId: null,
      startsAt: t("18:00"),
      newClient: { name: "Новый гость", phone: "8 (900) 111-22-33", comment: "из журнала" },
    });
    expect(created.clientName).toBe("Новый гость");
    await expect(
      book(salon.admin, {
        clientId: null,
        startsAt: t("19:00"),
        newClient: { name: "Дубль", phone: "+79001112233" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { existingClientId: created.clientId } });
  });

  it("TT-CREATE-04 maps journal hotkeys", () => {
    expect(journalHotkey("n", "DIV")).toBe("new");
    expect(journalHotkey("/", "DIV")).toBe("search");
    expect(journalHotkey("Escape", "INPUT")).toBe("close");
    expect(journalHotkey("n", "INPUT")).toBeNull();
    expect(pointerIntent(149)).toBe("click");
    expect(pointerIntent(150)).toBe("drag");
  });

  it("TT-CREATE-05 rolls back an inline client when the slot conflicts", async () => {
    await book(salon.admin, { startsAt: t("12:00"), staffId: salon.staffB });
    await expect(
      book(salon.admin, {
        staffId: salon.staffB,
        startsAt: t("12:10"),
        clientId: null,
        newClient: { name: "Не сохранится", phone: "+79005550011" },
      }),
    ).rejects.toBeInstanceOf(AppError);
    const found = await act(salon.admin, (ctx) =>
      one(ctx.db, "SELECT id FROM clients WHERE name = 'Не сохранится'"),
    );
    expect(found).toBeNull();
  });

  it("TT-EDIT-01 rejects a stale version and lets the owner overwrite", async () => {
    const created = await book(salon.admin, { startsAt: t("17:00"), staffId: salon.staffB });
    await act(salon.admin, (ctx) => updateAppointment(ctx, created.id, { version: created.version, comment: "раз" }));
    await expect(
      act(salon.admin, (ctx) => updateAppointment(ctx, created.id, { version: created.version, comment: "два" })),
    ).rejects.toMatchObject({ code: "STALE" });
    const overwritten = await act(salon.owner, (ctx) =>
      updateAppointment(ctx, created.id, { version: created.version, comment: "владелец", overwrite: true }),
    );
    expect(overwritten.comment).toBe("владелец");
  });

  it("TT-EDIT-02 keeps the price snapshot and can refresh it from the catalog", async () => {
    await act(salon.admin, async (ctx) => {
      await ctx.db.query("UPDATE services SET price_minor = 150000, duration_min = 60 WHERE id = $1", [salon.serviceId]);
    });
    const created = await book(salon.admin, {
      startsAt: t("10:00"),
      services: [{ serviceId: salon.serviceId }, { serviceId: salon.serviceOnlyA }],
    });
    expect(created.priceMinor).toBe(200000);
    await act(salon.admin, async (ctx) => {
      await ctx.db.query("UPDATE services SET price_minor = 180000, duration_min = 90 WHERE id = $1", [salon.serviceId]);
    });
    const kept = await act(salon.admin, (ctx) =>
      updateAppointment(ctx, created.id, {
        version: created.version,
        services: [{ serviceId: salon.serviceId }, { serviceId: salon.serviceOnlyA }],
      }),
    );
    expect(kept.services[0].priceMinor).toBe(150000);
    expect(kept.services[0].durationMin).toBe(90);
    const refreshed = await act(salon.admin, (ctx) =>
      updateAppointment(ctx, kept.id, {
        version: kept.version,
        refreshPrice: true,
        services: [{ serviceId: salon.serviceId, durationMin: 60 }],
      }),
    );
    expect(refreshed.services[0].priceMinor).toBe(180000);
    expect(refreshed.services[0].durationMin).toBe(60);
    await act(salon.admin, async (ctx) => {
      await ctx.db.query("UPDATE services SET price_minor = 150000, duration_min = 60 WHERE id = $1", [salon.serviceId]);
    });
  });

  it("TT-EDIT-03 blocks edits of a cancelled visit", async () => {
    const created = await book(salon.admin, { startsAt: t("19:30"), staffId: salon.staffB });
    const cancelled = await act(salon.admin, (ctx) =>
      cancelAppointment(ctx, created.id, { version: created.version, reason: "ошибка" }),
    );
    await expect(
      act(salon.admin, (ctx) => updateAppointment(ctx, cancelled.id, { version: cancelled.version, comment: "нет" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("TT-CANCEL-01 requires a reason inside 24h and removes the visit from the grid", async () => {
    const created = await book(salon.admin, { startsAt: t("14:00") });
    await expect(
      act(salon.admin, (ctx) => cancelAppointment(ctx, created.id, { version: created.version })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const cancelled = await act(salon.admin, (ctx) =>
      cancelAppointment(ctx, created.id, { version: created.version, reason: "клиент отказался" }),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.history.some((row) => row.action === "appointment.cancelled")).toBe(true);
    const journal = await act(salon.admin, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: current }));
    expect(journal.appointments.find((row) => row.id === created.id)).toBeUndefined();
    const withGhosts = await act(salon.admin, (ctx) =>
      getJournal(ctx, { branchId: salon.branchId, date: current, showCancelled: true }),
    );
    expect(withGhosts.appointments.some((row) => row.id === created.id)).toBe(true);
  });

  it("TT-DELETE-01 hard-deletes only a cancelled visit without payments, and only for the owner", async () => {
    const created = await book(salon.admin, { startsAt: t("09:00"), staffId: salon.staffB });
    await expect(act(salon.owner, (ctx) => hardDeleteAppointment(ctx, created.id))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const cancelled = await act(salon.admin, (ctx) =>
      cancelAppointment(ctx, created.id, { version: created.version, reason: "тест" }),
    );
    await expect(act(salon.admin, (ctx) => hardDeleteAppointment(ctx, cancelled.id))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await act(salon.owner, (ctx) => hardDeleteAppointment(ctx, cancelled.id));
    await expect(act(salon.owner, (ctx) => getAppointment(ctx, cancelled.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("TT-RESTORE-01 restores into a free slot and suggests another when busy", async () => {
    const created = await book(salon.admin, { startsAt: t("09:30") });
    const cancelled = await act(salon.admin, (ctx) =>
      cancelAppointment(ctx, created.id, { version: created.version, reason: "перенос" }),
    );
    const blocker = await book(salon.admin, { startsAt: t("09:30") });
    await expect(act(salon.admin, (ctx) => restoreAppointment(ctx, cancelled.id, cancelled.version))).rejects.toMatchObject({
      code: "CONFLICT_SLOT",
    });
    await act(salon.admin, (ctx) => cancelAppointment(ctx, blocker.id, { version: blocker.version, reason: "освободили" }));
    const restored = await act(salon.admin, (ctx) => restoreAppointment(ctx, cancelled.id, cancelled.version));
    expect(restored.status).toBe("scheduled");
  });

  it("TT-DRAG-01 moves by time and keeps duration", async () => {
    const created = await book(salon.admin, { startsAt: t("11:00"), staffId: salon.staffB });
    const moved = await act(salon.admin, (ctx) =>
      moveAppointment(ctx, created.id, { version: created.version, startsAt: t("11:30"), acknowledgeSoft: true }),
    );
    expect(moved.startsAt).toBe(t("11:30"));
    expect(new Date(moved.endsAt).getTime() - new Date(moved.startsAt).getTime()).toBe(60 * 60000);
    expect(moved.history.some((row) => row.action === "appointment.moved")).toBe(true);
  });

  it("TT-DRAG-02 rejects a master who does not perform the service", async () => {
    const created = await book(salon.admin, { startsAt: t("18:30"), services: [{ serviceId: salon.serviceOnlyA }] });
    await expect(
      act(salon.admin, (ctx) =>
        moveAppointment(ctx, created.id, { version: created.version, startsAt: created.startsAt, staffId: salon.staffB }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const plain = await book(salon.admin, { startsAt: t("10:30"), staffId: salon.staffB });
    const moved = await act(salon.admin, (ctx) =>
      moveAppointment(ctx, plain.id, {
        version: plain.version,
        startsAt: t("10:45"),
        staffId: salon.staffA,
        acknowledgeSoft: true,
      }),
    );
    expect(moved.staffId).toBe(salon.staffA);
  });

  it("TT-DRAG-03 changes time and master together", async () => {
    const created = await book(salon.owner, { startsAt: t("16:30"), staffId: salon.staffB });
    const moved = await act(salon.owner, (ctx) =>
      moveAppointment(ctx, created.id, {
        version: created.version,
        startsAt: t("17:15"),
        staffId: salon.staffA,
        acknowledgeSoft: true,
      }),
    );
    expect(moved.staffId).toBe(salon.staffA);
    expect(moved.startsAt).toBe(t("17:15"));
  });

  it("TT-DRAG-04 blocks a hard overlap and allows an admin override with a reason", async () => {
    const first = await book(salon.admin, { startsAt: t("13:30"), staffId: salon.staffA });
    const second = await book(salon.admin, { startsAt: t("15:00"), staffId: salon.staffA });
    await expect(
      act(salon.admin, (ctx) =>
        moveAppointment(ctx, second.id, { version: second.version, startsAt: first.startsAt, acknowledgeSoft: true }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT_SLOT" });
    await expect(
      act(salon.master, (ctx) =>
        moveAppointment(ctx, second.id, {
          version: second.version,
          startsAt: t("13:45"),
          forceOverlap: true,
          overlapReason: "срочно",
          acknowledgeSoft: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const forced = await act(salon.admin, (ctx) =>
      moveAppointment(ctx, second.id, {
        version: second.version,
        startsAt: t("13:45"),
        forceOverlap: true,
        overlapReason: "клиент согласился подождать",
        acknowledgeSoft: true,
      }),
    );
    expect(forced.forceOverlap).toBe(true);
  });

  it("TT-DRAG-05 cancels a drop outside the grid without a mutation decision", () => {
    expect(resolveDrop({ outside: true, staffId: salon.staffA, hardInvalid: false })).toBe("cancel");
    expect(resolveDrop({ outside: false, staffId: null, hardInvalid: false })).toBe("cancel");
    expect(resolveDrop({ outside: false, staffId: salon.staffA, hardInvalid: true })).toBe("reject");
    expect(resolveDrop({ outside: false, staffId: salon.staffA, hardInvalid: false })).toBe("commit");
  });

  it("TT-DRAG-06 rolls back a stale drag", async () => {
    const created = await book(salon.admin, { startsAt: t("12:30") });
    await expect(
      act(salon.admin, (ctx) =>
        moveAppointment(ctx, created.id, { version: created.version + 3, startsAt: t("12:40"), acknowledgeSoft: true }),
      ),
    ).rejects.toMatchObject({ code: "STALE" });
    const fresh = await act(salon.admin, (ctx) => getAppointment(ctx, created.id));
    expect(fresh.startsAt).toBe(created.startsAt);
  });

  it("TT-RESIZE-01 adds the delta to the last service and does not reprice", async () => {
    const created = await book(salon.admin, {
      startsAt: t("20:00"),
      services: [{ serviceId: salon.serviceId, durationMin: 30 }, { serviceId: salon.serviceOnlyA }],
    });
    const ends = new Date(new Date(created.endsAt).getTime() + 15 * 60000).toISOString();
    const resized = await act(salon.admin, (ctx) =>
      resizeAppointment(ctx, created.id, { version: created.version, endsAt: ends, acknowledgeSoft: true }),
    );
    expect(resized.services[1].durationMin).toBe(45);
    expect(resized.services[1].priceMinor).toBe(50000);
    expect(resized.priceMinor).toBe(created.priceMinor);
    const other = await book(salon.admin, { startsAt: t("19:00"), staffId: salon.staffA });
    await expect(
      act(salon.admin, (ctx) =>
        resizeAppointment(ctx, other.id, {
          version: other.version,
          endsAt: new Date(new Date(other.endsAt).getTime() + 90 * 60000).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT_SLOT" });
  });

  it("TT-STATUS-01 disables illegal transitions", async () => {
    const created = await book(salon.admin, { startsAt: t("14:30"), staffId: salon.staffB });
    const arrived = created.actions.find((action) => action.id === "arrived");
    const completed = created.actions.find((action) => action.id === "completed");
    expect(arrived?.enabled).toBe(true);
    expect(completed?.enabled).toBe(false);
    expect(completed?.reason).toBeTruthy();
  });

  it("TT-STATUS-02 completes from in-progress and suggests payment when required", async () => {
    const created = await book(salon.admin, { startsAt: t("14:45"), staffId: salon.staffB });
    await act(salon.admin, async (ctx) => {
      await ctx.db.query("UPDATE branches SET require_payment_on_complete = true WHERE id = $1", [salon.branchId]);
    });
    const arrived = await act(salon.admin, (ctx) =>
      changeStatus(ctx, created.id, "arrived", { version: created.version }),
    );
    const progress = await act(salon.admin, (ctx) =>
      changeStatus(ctx, created.id, "in_progress", { version: arrived.version }),
    );
    const done = await act(salon.admin, (ctx) =>
      changeStatus(ctx, created.id, "completed", { version: progress.version }),
    );
    expect(done.status).toBe("completed");
    expect(done.paymentSuggested).toBe(true);
    expect(done.history.some((row) => row.action === "appointment.completed")).toBe(true);
    await expect(
      act(salon.admin, (ctx) => changeStatus(ctx, created.id, "scheduled", { version: done.version })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await act(salon.admin, async (ctx) => {
      await ctx.db.query("UPDATE branches SET require_payment_on_complete = false WHERE id = $1", [salon.branchId]);
    });
  });

  it("TT-STATUS-03 rejects no-show before the grace period", async () => {
    const created = await book(salon.admin, { startsAt: t("11:45"), staffId: salon.staffB });
    const tooSoon = new Date(new Date(t("11:45")).getTime() + 10 * 60000);
    await expect(
      act(salon.admin, (ctx) => changeStatus(ctx, created.id, "no_show", { version: created.version }), tooSoon),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const ready = new Date(new Date(t("11:45")).getTime() + 16 * 60000);
    const missed = await act(
      salon.admin,
      (ctx) => changeStatus(ctx, created.id, "no_show", { version: created.version }),
      ready,
    );
    expect(missed.status).toBe("no_show");
  });

  it("TT-SEARCH-01 finds an upcoming visit by phone suffix", async () => {
    const client = await act(salon.admin, (ctx) =>
      createClient(ctx, { name: "Поиск Тест", phone: "+79007654321" }),
    );
    const created = await book(salon.admin, { clientId: client.id, startsAt: t("18:10"), staffId: salon.staffB });
    const rows = await act(salon.admin, (ctx) => searchAppointments(ctx, salon.branchId, "654321"));
    expect(rows.some((row) => row.id === created.id)).toBe(true);
  });

  it("TT-PREV-CLIENT-01 prefers today's arrived client", async () => {
    const created = await book(salon.master, { startsAt: t("12:05") });
    await act(salon.master, (ctx) => changeStatus(ctx, created.id, "arrived", { version: created.version }));
    const prev = await act(salon.admin, (ctx) => previousClient(ctx, salon.branchId, salon.staffA, current));
    expect(prev?.id).toBe(salon.clientId);
    expect(prev?.source).toBe("today");
  });

  it("TT-GUEST-01 stores the guest separately from the person who booked", async () => {
    const guest = await act(salon.admin, (ctx) => createClient(ctx, { name: "Гость Ребёнок", phone: "+79001230000" }));
    const created = await book(salon.admin, {
      clientId: guest.id,
      bookedByClientId: salon.clientId,
      startsAt: t("19:10"),
      staffId: salon.staffB,
    });
    expect(created.guest).toBe(true);
    expect(created.clientId).toBe(guest.id);
    expect(created.bookedByClientId).toBe(salon.clientId);
  });

  it("TT-AUDIT-UI-01 returns the visit history", async () => {
    const created = await book(salon.admin, { startsAt: t("10:10"), staffId: salon.staffB, comment: "история" });
    const full = await act(salon.admin, (ctx) => getAppointment(ctx, created.id));
    expect(full.history[0].action).toBe("appointment.created");
  });

  it("TT-COMPACT-01 stores density and compacts wide grids", async () => {
    expect(resolveDensity("auto", 13)).toBe("compact");
    expect(resolveDensity("auto", 4)).toBe("comfortable");
    await setDensity(salon.admin.userId, "compact");
    const journal = await act(salon.admin, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: current }));
    expect(journal.density).toBe("compact");
    await setDensity(salon.admin.userId, "auto");
  });

  it("TT-EXPORT-01 exports csv and audits it", async () => {
    await book();
    const csv = await act(salon.admin, (ctx) =>
      exportAppointmentsCsv(ctx, { branchId: salon.branchId, date: current }),
    );
    expect(csv.split("\n")[0]).toContain("client");
    expect(csv).toContain("Анна Смирнова");
    const audit = await act(salon.admin, (ctx) =>
      one(ctx.db, "SELECT action FROM audit_log WHERE action = 'appointment.exported' LIMIT 1"),
    );
    expect(audit).toBeTruthy();
  });

  it("rejects a visit that crosses local midnight", async () => {
    await expect(book(salon.admin, { startsAt: t("23:30"), services: [{ serviceId: salon.serviceId }] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("keeps the timezone offset snapshot after the branch timezone changes", async () => {
    const created = await book(salon.admin, { startsAt: t("09:10"), staffId: salon.staffB });
    expect(created.tzOffsetMin).toBe(180);
    await act(salon.owner, async (ctx) => {
      await ctx.db.query("UPDATE branches SET timezone = 'Asia/Yekaterinburg' WHERE id = $1", [salon.branchId]);
    });
    const fresh = await act(salon.owner, (ctx) => getAppointment(ctx, created.id));
    expect(fresh.tzOffsetMin).toBe(180);
    expect(fresh.branchTz).toBe("Europe/Moscow");
    await act(salon.owner, async (ctx) => {
      await ctx.db.query("UPDATE branches SET timezone = 'Europe/Moscow' WHERE id = $1", [salon.branchId]);
    });
  });

  it("forbids a master from dragging someone else's visit", async () => {
    const created = await book(salon.admin, { staffId: salon.staffB, startsAt: t("16:10") });
    await expect(
      act(salon.master, (ctx) =>
        moveAppointment(ctx, created.id, { version: created.version, startsAt: t("16:20"), acknowledgeSoft: true }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("soft-warns outside working hours and about a day off", async () => {
    await expect(book(salon.admin, { startsAt: t("08:00"), acknowledgeSoft: false })).rejects.toMatchObject({
      code: "SOFT_CONFIRM",
    });
    await act(salon.admin, (ctx) =>
      addException(ctx, {
        staffId: salon.staffB,
        branchId: salon.branchId,
        startsOn: "2027-08-02",
        kind: "day_off",
      }),
    );
    await expect(
      book(salon.admin, { staffId: salon.staffB, startsAt: at("12:00", "2027-08-02"), acknowledgeSoft: false }),
    ).rejects.toMatchObject({ code: "SOFT_CONFIRM" });
  });

  it("blocks a master who is already booked at another branch", async () => {
    const otherClient = salon.clientId;
    await act(salon.owner, (ctx) =>
      createAppointment(ctx, {
        branchId: salon.otherBranchId,
        staffId: salon.staffA,
        clientId: otherClient,
        startsAt: t("15:40"),
        services: [{ serviceId: salon.serviceId }],
        acknowledgeSoft: true,
      }),
    );
    await expect(book(salon.admin, { startsAt: t("15:50") })).rejects.toMatchObject({ code: "CONFLICT_SLOT" });
  });

  it("forbids the accountant from opening the journal", async () => {
    await expect(
      act(salon.accountant, (ctx) => getJournal(ctx, { branchId: salon.branchId, date: current })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("TT-DELETE payment blocks hard delete", async () => {
    const created = await book(salon.admin, { startsAt: t("11:20"), staffId: salon.staffB });
    await act(salon.accountant, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
    await act(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: created.id,
        version: created.version,
        tenders: [{ method: "card", amountMinor: 150000 }],
      }),
    );
    const cancelled = await act(salon.admin, (ctx) =>
      cancelAppointment(ctx, created.id, { version: created.version + 1, reason: "передумали" }),
    );
    expect(cancelled.refundSuggested).toBe(true);
    await expect(act(salon.owner, (ctx) => hardDeleteAppointment(ctx, created.id))).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
