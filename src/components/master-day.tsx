"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Phone } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { formatPhone } from "@/domain/phone";
import { addCalendarDays } from "@/domain/time";
import { STATUS_LABEL, type AppointmentStatus } from "@/domain/status";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Day = {
  date: string;
  today: string;
  branchName: string;
  staffName: string;
  dayOff: boolean;
  hours: { startMin: number; endMin: number; kind: "work" | "break" }[];
  servicesMinor: number;
  tipsMinor: number;
  expectedMinor: number;
  appointments: {
    id: string;
    version: number;
    time: string;
    endTime: string;
    status: AppointmentStatus;
    now: boolean;
    clientId: string | null;
    clientName: string | null;
    clientNotes: string;
    phone: string | null;
    firstVisit: boolean;
    visits: number;
    title: string;
    comment: string;
    priceMinor: number;
  }[];
  upcoming: { date: string; count: number }[];
};

const NEXT: Partial<Record<AppointmentStatus, [AppointmentStatus, string]>> = {
  scheduled: ["arrived", "Клиент пришёл"],
  confirmed: ["arrived", "Клиент пришёл"],
  arrived: ["in_progress", "Начать"],
  in_progress: ["completed", "Завершить"],
};
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const label = (date: string) => {
  const text = new Date(`${date}T12:00:00Z`).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** MASTER-DAY-01: the master's day on a phone — who comes, what to know about them, what was earned. */
export function MasterDay() {
  const toast = useToast();
  const [date, setDate] = useState("");
  const [day, setDay] = useState<Day | null>(null);
  const [error, setError] = useState("");

  const load = useCallback((value = date) => {
    api<Day>(`/api/me/day${value ? `?date=${value}` : ""}`)
      .then((data) => { setDay(data); setDate(data.date); setError(""); })
      .catch((err: ApiError) => setError(err.message));
  }, [date]);
  useEffect(() => {
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function advance(appt: Day["appointments"][number]) {
    const next = NEXT[appt.status];
    if (!next) return;
    try {
      await api(`/api/appointments/${appt.id}/status`, { method: "POST", body: JSON.stringify({ status: next[0], version: appt.version, acknowledgeSoft: true }) });
      load();
    } catch (err) {
      toast((err as ApiError).message, "error");
    }
  }

  if (error) return <div className="banner">{error}</div>;
  if (!day) return <div className="skeleton" />;
  const work = day.hours.filter((item) => item.kind === "work");
  return (
    <div className="me-page">
      <div className="me-head">
        <button className="chev" type="button" aria-label="Предыдущий день" onClick={() => load(addCalendarDays(date, -1))}><ChevronLeft size={16} /></button>
        <div style={{ textAlign: "center", flex: 1 }}>
          <div className="page-kicker">{day.date === day.today ? "Сегодня" : day.branchName}</div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{label(day.date)}</h1>
          <span className="muted" style={{ fontSize: 13 }}>{day.dayOff || !work.length ? "Выходной" : work.map((item) => `${clock(item.startMin)}–${clock(item.endMin)}`).join(", ")}</span>
        </div>
        <button className="chev" type="button" aria-label="Следующий день" onClick={() => load(addCalendarDays(date, 1))}><ChevronRight size={16} /></button>
      </div>
      <div className="me-money">
        <div><b>{day.appointments.length}</b><span>клиентов</span></div>
        <div><b>{formatMoney(day.servicesMinor)}</b><span>оплачено услуг</span></div>
        <div><b>{formatMoney(day.tipsMinor)}</b><span>чаевые</span></div>
      </div>
      {day.appointments.length === 0 && <div className="panel empty">Записей нет{day.upcoming[0] ? `. Следующие — ${label(day.upcoming[0].date).toLowerCase()}` : ""}.</div>}
      {day.appointments.map((appt) => (
        <div key={appt.id} className={`panel me-card ${appt.now ? "now" : ""} st-${appt.status}`}>
          <div className="spread">
            <b className="me-time">{appt.time}–{appt.endTime}</b>
            <span className="tag">{STATUS_LABEL[appt.status]}</span>
          </div>
          <div className="me-client">
            <strong>{appt.clientName ?? "Без клиента"}</strong>
            {appt.firstVisit ? <span className="tag tag-warn">первый визит</span> : <span className="muted" style={{ fontSize: 12 }}>визит № {appt.visits + 1}</span>}
          </div>
          <span style={{ fontSize: 14 }}>{appt.title} · {formatMoney(appt.priceMinor)}</span>
          {appt.clientNotes && <div className="me-note">{appt.clientNotes}</div>}
          {appt.comment && <div className="me-note soft">К записи: {appt.comment}</div>}
          <div className="row" style={{ gap: 8 }}>
            {NEXT[appt.status] && day.date === day.today && (
              <button className="btn-gradient" type="button" onClick={() => advance(appt)}>{NEXT[appt.status]![1]}</button>
            )}
            {appt.phone && <a className="btn" href={`tel:${appt.phone}`}><Phone size={14} /> {formatPhone(appt.phone)}</a>}
          </div>
        </div>
      ))}
      {day.upcoming.length > 0 && (
        <div className="panel list">
          <h3 style={{ margin: 0, fontSize: 14 }}>Дальше</h3>
          {day.upcoming.map((item) => (
            <button key={item.date} type="button" className="spread me-next" onClick={() => load(item.date)}>
              <span>{label(item.date)}</span><span className="muted">{item.count} {item.count === 1 ? "запись" : item.count < 5 ? "записи" : "записей"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
