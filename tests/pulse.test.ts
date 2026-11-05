import { describe, expect, it } from "vitest";
import { buildPulse, freeGaps, type PulseDay } from "@/domain/pulse";

const appt = (over: Partial<PulseDay["appointments"][number]>): PulseDay["appointments"][number] => ({
  id: "a1",
  staffId: "s1",
  clientId: "c1",
  clientName: "Анна Смирнова",
  startMin: 600,
  endMin: 660,
  status: "scheduled",
  version: 1,
  priceMinor: 300000,
  paidMinor: 0,
  debtMinor: 0,
  services: [{ title: "Маникюр" }],
  ...over,
});

const day = (appointments: PulseDay["appointments"], date = "2026-11-05"): PulseDay => ({
  date,
  staff: [
    { id: "s1", name: "Алина Ковалёва", dayOff: false, intervals: [{ startMin: 600, endMin: 1140, kind: "work" }, { startMin: 840, endMin: 900, kind: "break" }] },
    { id: "s2", name: "Марина Соколова", dayOff: true, intervals: [] },
  ],
  appointments,
});

const empty = { slots: [], entries: [], due: [], lowStock: [] };

describe("PULSE-01 Пульт дня", () => {
  it("finds free stretches around visits and the break", () => {
    const today = day([appt({ startMin: 600, endMin: 720 }), appt({ id: "a2", startMin: 960, endMin: 1020 })]);
    expect(freeGaps(today, "s1", 0)).toEqual([
      { startMin: 720, endMin: 840 },
      { startMin: 900, endMin: 960 },
      { startMin: 1020, endMin: 1140 },
    ]);
    // From 15:10 on: the next quarter hour, and gaps under an hour are dropped.
    expect(freeGaps(today, "s1", 910)).toEqual([{ startMin: 1020, endMin: 1140 }]);
    expect(freeGaps(today, "s2", 0)).toEqual([]);
  });

  it("flags a late client with arrived / no-show buttons", () => {
    const { cards } = buildPulse({ ...empty, today: day([appt({ startMin: 600, endMin: 660 })]), tomorrow: null, nowMin: 615 });
    const late = cards.find((card) => card.key === "late-a1");
    expect(late?.title).toBe("Анна Смирнова опаздывает на 15 мин");
    expect(late?.actions.map((action) => action.kind === "status" && action.status)).toEqual(["arrived", "no_show", false]);
  });

  it("offers to book free time and to confirm tomorrow", () => {
    const tomorrow = day([appt({ id: "t1", startMin: 660, clientName: "Мария Ильина" }), appt({ id: "t2", status: "confirmed" })], "2026-11-06");
    const { cards, summary } = buildPulse({ ...empty, today: day([]), tomorrow, nowMin: 1000 });
    const gaps = cards.find((card) => card.key === "gaps");
    expect(gaps?.title).toBe("Свободно: Алина 16:45–19:00");
    expect(gaps?.actions[0]).toMatchObject({ kind: "book", text: "запиши к Алина сегодня в 16:45 " });
    const confirm = cards.find((card) => card.key === "confirm");
    expect(confirm?.title).toBe("Завтра не подтвердили 1");
    expect(confirm?.actions[0]).toMatchObject({ kind: "status", status: "confirmed", appointmentId: "t1" });
    expect(summary.freeMin).toBe(135);
  });

  it("counts the day and surfaces debts, waiting list, due clients and stock", () => {
    const today = day([
      appt({ status: "completed", paidMinor: 300000 }),
      appt({ id: "a2", startMin: 720, endMin: 780, debtMinor: 120000 }),
      appt({ id: "a3", startMin: 800, endMin: 840, status: "cancelled" }),
    ]);
    const { cards, summary } = buildPulse({
      today,
      tomorrow: null,
      nowMin: 700,
      slots: [{ appointmentId: "x", staffName: "Алина Ковалёва", startsAt: "2026-11-05T13:00:00Z", date: "2026-11-05", services: "Маникюр", matches: ["w1"] }],
      entries: [{ id: "w1", clientName: "Ольга Петрова" }],
      due: [{ clientId: "c9", clientName: "Ирина Ким", marketing: true, staffName: "Алина Ковалёва", services: "Маникюр", overdueDays: 4, remindedAt: null }],
      lowStock: ["Гель-лак", "Ремувер"],
    });
    expect(summary).toMatchObject({ visits: 2, done: 1, left: 1, expectedMinor: 600000, paidMinor: 300000 });
    expect(cards.map((card) => card.key)).toEqual(["next", "debts", "wait-x", "gaps", "due", "stock"]);
    expect(cards.find((card) => card.key === "wait-x")?.actions[0]).toMatchObject({ kind: "offer", entryId: "w1", appointmentId: "x" });
    expect(cards.find((card) => card.key === "stock")?.title).toBe("Заканчивается 2 позиции");
  });
});
