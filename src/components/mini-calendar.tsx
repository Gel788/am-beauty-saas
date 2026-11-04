"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addCalendarDays, todayInZone } from "@/domain/time";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Month grid in the sidebar: one click opens that day in the calendar. */
export function MiniCalendar({ timezone }: { timezone: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = todayInZone(timezone);
  const selected = pathname.startsWith("/journal") ? params.get("date") || today : null;
  const [month, setMonth] = useState((selected ?? today).slice(0, 7));

  // Follow the calendar when it moves to another month by its own arrows.
  useEffect(() => {
    if (selected) setMonth(selected.slice(0, 7));
  }, [selected]);

  const first = `${month}-01`;
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = addCalendarDays(first, -weekday);
  const days = Array.from({ length: 42 }, (_, index) => addCalendarDays(start, index));
  const rows = days[35].slice(0, 7) === month ? 6 : 5;
  const title = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${first}T12:00:00Z`)).replace(" г.", "");
  const shift = (delta: number) => {
    const [year, mon] = month.split("-").map(Number);
    const next = new Date(Date.UTC(year, mon - 1 + delta, 1));
    setMonth(next.toISOString().slice(0, 7));
  };
  const open = (date: string) => {
    const query = new URLSearchParams(pathname.startsWith("/journal") ? params.toString() : "");
    query.set("date", date);
    query.delete("open");
    router.push(`/journal?${query.toString()}`);
  };

  return (
    <div className="mini-cal" aria-label="Выбор дня">
      <div className="mini-cal-head">
        <button type="button" onClick={() => shift(-1)} aria-label="Предыдущий месяц"><ChevronLeft /></button>
        <button type="button" className="mini-cal-title" onClick={() => open(today)} title="Сегодня">{title}</button>
        <button type="button" onClick={() => shift(1)} aria-label="Следующий месяц"><ChevronRight /></button>
      </div>
      <div className="mini-cal-grid">
        {WEEKDAYS.map((day) => <span key={day} className="mini-cal-wd">{day}</span>)}
        {days.slice(0, rows * 7).map((date) => {
          const classes = ["mini-cal-day"];
          if (date.slice(0, 7) !== month) classes.push("out");
          if (date === today) classes.push("today");
          if (date === selected) classes.push("on");
          return (
            <button key={date} type="button" className={classes.join(" ")} onClick={() => open(date)} aria-label={date} aria-current={date === selected ? "date" : undefined}>
              {Number(date.slice(8))}
            </button>
          );
        })}
      </div>
      {selected !== today && <button type="button" className="mini-cal-today" onClick={() => open(today)}>Сегодня</button>}
    </div>
  );
}
