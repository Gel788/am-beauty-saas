export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function offsetMinutes(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

export function formatLocalDate(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function formatLocalTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function localMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

export function zonedDateTimeToUtc(date: string, minutes: number, timeZone: string): Date {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const iso = `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`;
  const guess = new Date(iso);
  const offset = offsetMinutes(guess, timeZone);
  let utc = new Date(guess.getTime() - offset * 60000);
  const offset2 = offsetMinutes(utc, timeZone);
  if (offset2 !== offset) {
    utc = new Date(guess.getTime() - offset2 * 60000);
  }
  return utc;
}

export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function mondayOf(date: string): string {
  return addCalendarDays(date, -(isoWeekday(date) - 1));
}

export function localDayUtcRange(date: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedDateTimeToUtc(date, 0, timeZone),
    end: zonedDateTimeToUtc(addCalendarDays(date, 1), 0, timeZone),
  };
}

/** P1: appointment must finish on the same local day. End exactly at next midnight is allowed. */
export function sameLocalDay(start: Date, end: Date, timeZone: string): boolean {
  if (end.getTime() <= start.getTime()) return false;
  const endInclusive = new Date(end.getTime() - 1);
  return formatLocalDate(start, timeZone) === formatLocalDate(endInclusive, timeZone);
}

export function weekdayLabel(date: string, timeZone = "Europe/Moscow"): string {
  const instant = zonedDateTimeToUtc(date, 12 * 60, timeZone);
  const label = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(instant);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function todayInZone(timeZone: string, now = new Date()): string {
  return formatLocalDate(now, timeZone);
}
