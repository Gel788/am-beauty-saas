import { AppError } from "./errors";

export type Interval = { startMin: number; endMin: number; kind: "work" | "break"; weekday?: number };

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

export function validateTemplate(rows: Interval[]): void {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const items = rows.filter((row) => row.weekday === weekday);
    const works = items.filter((row) => row.kind === "work");
    const breaks = items.filter((row) => row.kind === "break");
    assertNoOverlap(works, "Рабочие интервалы пересекаются");
    assertNoOverlap(breaks, "Перерывы пересекаются");
    for (const item of breaks) {
      const inside = works.some((work) => item.startMin >= work.startMin && item.endMin <= work.endMin);
      if (!inside) throw new AppError("VALIDATION", "Перерыв должен быть внутри рабочего интервала");
    }
    for (const item of items) {
      if (item.endMin <= item.startMin) throw new AppError("VALIDATION", "Конец интервала должен быть позже начала");
      if (item.startMin % 5 !== 0 || item.endMin % 5 !== 0) {
        throw new AppError("VALIDATION", "Интервал кратен 5 минутам");
      }
    }
  }
}

function assertNoOverlap(items: Interval[], message: string) {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (intervalsOverlap(items[i], items[j])) throw new AppError("VALIDATION", message);
    }
  }
}

export function isInsideWorkingHours(intervals: Interval[], startMin: number, endMin: number): boolean {
  const works = intervals.filter((item) => item.kind === "work");
  const breaks = intervals.filter((item) => item.kind === "break");
  const inside = works.some((work) => startMin >= work.startMin && endMin <= work.endMin);
  const hitsBreak = breaks.some((item) => intervalsOverlap(item, { startMin, endMin, kind: "work" }));
  return inside && !hitsBreak;
}
