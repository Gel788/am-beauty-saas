"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { addCalendarDays, mondayOf } from "@/domain/time";
import { STATUS_LABEL, type AppointmentStatus } from "@/domain/status";
import { api, type ApiError } from "./api";

type Day = {
  date: string;
  count: number;
  expectedMinor: number;
  loadPercent: number | null;
  staffWorking: number;
  appointments: { id: string; time: string; endTime: string; staffId: string; staffName: string; color: string; clientName: string | null; title: string; status: string; source: string; priceMinor: number }[];
};
type Calendar = { from: string; to: string; today: string; staff: { id: string; name: string; color: string }[]; days: Day[] };

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const monthTitle = (date: string) => {
  const label = new Date(`${date}T12:00:00Z`).toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
  return label.charAt(0).toUpperCase() + label.slice(1);
};
const dayTitle = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

function heat(load: number | null) {
  if (load === null) return "off";
  if (load >= 85) return "hot";
  if (load >= 50) return "warm";
  return "cool";
}

/** TT-VIEW-04 (week: columns are days) and TT-VIEW-05 (month grid). A click opens the day or the visit. */
export function CalendarRange({
  view,
  branchId,
  date,
  onOpenDay,
  onOpenAppointment,
}: {
  view: "week" | "month";
  branchId: string;
  date: string;
  onOpenDay: (date: string) => void;
  onOpenAppointment: (id: string, date: string) => void;
}) {
  const [anchor, setAnchor] = useState(date);
  const [staffId, setStaffId] = useState("");
  const [data, setData] = useState<Calendar | null>(null);
  const [error, setError] = useState("");
  useEffect(() => setAnchor(date), [date]);

  const from = view === "week" ? mondayOf(anchor) : mondayOf(`${anchor.slice(0, 7)}-01`);
  const days = view === "week" ? 7 : 42;
  useEffect(() => {
    if (!branchId || !anchor) return;
    const controller = new AbortController();
    api<Calendar>(`/api/journal/calendar?branchId=${branchId}&from=${from}&days=${days}${staffId ? `&staffId=${staffId}` : ""}`, { signal: controller.signal })
      .then((value) => { setData(value); setError(""); })
      .catch((err: ApiError) => { if (err.name !== "AbortError") setError(err.message); });
    return () => controller.abort();
  }, [branchId, from, days, staffId, anchor]);

  const shift = (step: number) => {
    if (view === "week") setAnchor(addCalendarDays(anchor, step * 7));
    else {
      const [y, m] = anchor.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1 + step, 1));
      setAnchor(next.toISOString().slice(0, 10));
    }
  };
  const total = data?.days.filter((day) => view === "week" || day.date.slice(0, 7) === anchor.slice(0, 7));
  const sum = total?.reduce((acc, day) => acc + day.expectedMinor, 0) ?? 0;
  const visits = total?.reduce((acc, day) => acc + day.count, 0) ?? 0;

  return (
    <div className="range-wrap">
      <div className="range-bar">
        <button className="chev" type="button" aria-label="Назад" onClick={() => shift(-1)}><ChevronLeft size={16} /></button>
        <strong>{view === "week" ? `${dayTitle(from)} — ${dayTitle(addCalendarDays(from, 6))}` : monthTitle(anchor)}</strong>
        <button className="chev" type="button" aria-label="Вперёд" onClick={() => shift(1)}><ChevronRight size={16} /></button>
        <span className="muted" style={{ fontSize: 13 }}>{visits} записей · {formatMoney(sum)} по прайсу</span>
        <div className="row" style={{ marginLeft: "auto", gap: 4, flexWrap: "wrap" }}>
          <button type="button" className={`chip ${staffId ? "" : "on"}`} onClick={() => setStaffId("")}>Все мастера</button>
          {data?.staff.map((member) => (
            <button key={member.id} type="button" className={`chip ${staffId === member.id ? "on" : ""}`} onClick={() => setStaffId(member.id)}>
              <span className="dot" style={{ background: member.color }} /> {member.name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && view === "week" && (
        <div className="week-grid">
          {data.days.map((day, index) => (
            <div key={day.date} className={`week-col ${day.date === data.today ? "today" : ""}`}>
              <button type="button" className="week-head" onClick={() => onOpenDay(day.date)}>
                <span>{WEEKDAYS[index]}, {dayTitle(day.date)}</span>
                <small>{day.count ? `${day.count} · ${formatMoney(day.expectedMinor)}` : day.staffWorking ? "свободно" : "выходной"}{day.loadPercent !== null && day.count ? ` · ${day.loadPercent}%` : ""}</small>
                <i className={`load-bar ${heat(day.loadPercent)}`} style={{ width: `${Math.min(100, day.loadPercent ?? 0)}%` }} />
              </button>
              <div className="week-list">
                {day.appointments.map((appt) => (
                  <button key={appt.id} type="button" className={`week-appt st-${appt.status}`} style={{ borderLeftColor: appt.color }} onClick={() => onOpenAppointment(appt.id, day.date)}>
                    <b>{appt.time}–{appt.endTime}</b> {appt.source === "online" && <span className="tag" style={{ padding: "0 5px", fontSize: 10 }}>онлайн</span>}
                    <span>{appt.clientName ?? "Без клиента"}</span>
                    <small>{appt.title} · {appt.staffName.split(" ")[0]}</small>
                    {appt.status !== "scheduled" && <small className="week-status">{STATUS_LABEL[appt.status as AppointmentStatus] ?? appt.status}</small>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {data && view === "month" && (
        <div className="month-grid">
          {WEEKDAYS.map((label) => <div key={label} className="month-wd">{label}</div>)}
          {data.days.map((day) => {
            const other = day.date.slice(0, 7) !== anchor.slice(0, 7);
            return (
              <button key={day.date} type="button" className={`month-cell ${other ? "other" : ""} ${day.date === data.today ? "today" : ""} heat-${heat(day.loadPercent)}`} onClick={() => onOpenDay(day.date)}>
                <span className="month-num">{Number(day.date.slice(8))}</span>
                {day.count > 0 && (
                  <>
                    <b>{day.count} {day.count === 1 ? "запись" : day.count < 5 ? "записи" : "записей"}</b>
                    <small>{formatMoney(day.expectedMinor)}</small>
                    {day.loadPercent !== null && <small>загрузка {day.loadPercent}%</small>}
                  </>
                )}
                {day.count === 0 && !other && <small>{day.staffWorking ? "свободно" : "выходной"}</small>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
