"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { addCalendarDays, todayInZone } from "@/domain/time";
import { api, type ApiError } from "./api";

type Totals = {
  revenueMinor: number;
  servicesMinor: number;
  productsMinor: number;
  tipsMinor: number;
  averageCheckMinor: number;
  appointments: number;
  completed: number;
  cancelled: number;
  noShow: number;
  online: number;
  clients: number;
  newClients: number;
};
type Report = {
  branchName: string;
  previous: { from: string; to: string };
  current: Totals;
  before: Totals;
  change: { revenue: number | null; averageCheck: number | null; appointments: number | null; clients: number | null };
  days: { date: string; revenueMinor: number; visits: number }[];
  staff: { staffId: string; name: string; visits: number; servicesMinor: number; tipsMinor: number; noShow: number; loadPercent: number }[];
  services: { serviceId: string; title: string; count: number; priceMinor: number }[];
  sources: { source: string; clients: number }[];
};
type Preset = "7" | "30" | "month" | "prev" | "custom";
const SOURCE: Record<string, string> = { "walk-in": "С улицы / админ", online: "Онлайн-запись", import: "Перенесены", admin: "Админ" };

function Change({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null) return <small className="muted">нет данных для сравнения</small>;
  const good = invert ? value < 0 : value > 0;
  return <small className={value === 0 ? "muted" : good ? "delta up" : "delta down"}>{value > 0 ? "+" : ""}{value}% к прошлому периоду</small>;
}

const short = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** AN-RANGE-01 + AN-EXPORT-01. */
export function PeriodView({ role }: { role: string }) {
  const [branch, setBranch] = useState<{ id: string; timezone: string } | null>(null);
  const [preset, setPreset] = useState<Preset>("30");
  const [range, setRange] = useState({ from: "", to: "" });
  const [staffId, setStaffId] = useState("");
  const [source, setSource] = useState("");
  const [staff, setStaff] = useState<{ id: string; displayName: string; active: boolean }[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ branches: { id: string; timezone: string }[] }>("/api/auth/me").then((me) => setBranch(me.branches[0] ?? null)).catch((err: ApiError) => setError(err.message));
    if (role !== "master") api<{ id: string; displayName: string; active: boolean }[]>("/api/staff").then(setStaff).catch(() => undefined);
  }, [role]);

  useEffect(() => {
    if (!branch || preset === "custom") return;
    const today = todayInZone(branch.timezone);
    if (preset === "7") setRange({ from: addCalendarDays(today, -6), to: today });
    if (preset === "30") setRange({ from: addCalendarDays(today, -29), to: today });
    if (preset === "month") setRange({ from: `${today.slice(0, 7)}-01`, to: today });
    if (preset === "prev") {
      const first = `${today.slice(0, 7)}-01`;
      const last = addCalendarDays(first, -1);
      setRange({ from: `${last.slice(0, 7)}-01`, to: last });
    }
  }, [branch, preset]);

  const query = useMemo(() => {
    if (!branch || !range.from || !range.to) return "";
    const params = new URLSearchParams({ branchId: branch.id, from: range.from, to: range.to });
    if (staffId) params.set("staffId", staffId);
    if (source) params.set("source", source);
    return params.toString();
  }, [branch, range, staffId, source]);

  useEffect(() => {
    if (!query) return;
    setReport(null);
    api<Report>(`/api/reports/period?${query}`).then((value) => { setReport(value); setError(""); }).catch((err: ApiError) => setError(err.message));
  }, [query]);

  const max = Math.max(1, ...(report?.days.map((day) => day.revenueMinor) ?? [1]));
  const money = (minor: number) => formatMoney(minor);
  return (
    <div className="reports-page">
      <div className="period-bar">
        <div className="segment">
          {([["7", "7 дней"], ["30", "30 дней"], ["month", "Этот месяц"], ["prev", "Прошлый месяц"], ["custom", "Свой"]] as [Preset, string][]).map(([value, label]) => (
            <button key={value} type="button" className={preset === value ? "on" : ""} onClick={() => setPreset(value)}>{label}</button>
          ))}
        </div>
        <input className="report-date" type="date" value={range.from} onChange={(event) => { setPreset("custom"); setRange({ ...range, from: event.target.value }); }} />
        <span className="muted">—</span>
        <input className="report-date" type="date" value={range.to} onChange={(event) => { setPreset("custom"); setRange({ ...range, to: event.target.value }); }} />
        {role !== "master" && (
          <select className="report-date" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
            <option value="">Все мастера</option>
            {staff.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
          </select>
        )}
        <select className="report-date" value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="">Все записи</option>
          <option value="online">Онлайн-запись</option>
          <option value="admin">Через администратора</option>
        </select>
        {query && role !== "master" && (
          <a className="btn" href={`/api/reports/period.csv?${query}`} style={{ marginLeft: "auto" }}><Download size={15} /> CSV для Excel</a>
        )}
      </div>
      {error && <div className="banner">{error}</div>}
      {!report && !error && <div className="skeleton" />}
      {report && (
        <>
          <div className="report-tiles period-tiles">
            <div className="panel report-tile"><span className="muted">Выручка</span><b className="display">{money(report.current.revenueMinor)}</b><Change value={report.change.revenue} /></div>
            <div className="panel report-tile"><span className="muted">Средний чек</span><b className="display">{money(report.current.averageCheckMinor)}</b><Change value={report.change.averageCheck} /></div>
            <div className="panel report-tile"><span className="muted">Записей</span><b className="display">{report.current.appointments}</b><Change value={report.change.appointments} /></div>
            <div className="panel report-tile"><span className="muted">Клиентов</span><b className="display">{report.current.clients}</b><small className="muted">из них новых {report.current.newClients}</small></div>
          </div>
          <div className="panel list">
            <div className="spread">
              <h3 style={{ margin: 0 }}>Выручка по дням</h3>
              <span className="muted" style={{ fontSize: 12 }}>сравнение с {short(report.previous.from)} — {short(report.previous.to)}: {money(report.before.revenueMinor)}</span>
            </div>
            <div className="bars" role="img" aria-label="Выручка по дням">
              {report.days.map((day) => (
                <div key={day.date} className="bar" title={`${short(day.date)}: ${money(day.revenueMinor)}, визитов ${day.visits}`}>
                  <i style={{ height: `${Math.max(2, (100 * Math.max(0, day.revenueMinor)) / max)}%` }} />
                  {report.days.length <= 31 && <small>{Number(day.date.slice(8))}</small>}
                </div>
              ))}
            </div>
            <div className="row" style={{ gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <span>Услуги <b>{money(report.current.servicesMinor)}</b></span>
              <span>Товары <b>{money(report.current.productsMinor)}</b></span>
              <span>Чаевые <b>{money(report.current.tipsMinor)}</b></span>
              <span>Онлайн-записей <b>{report.current.online}</b></span>
              <span>Отмены <b>{report.current.cancelled}</b></span>
              <span>Неявки <b>{report.current.noShow}</b></span>
            </div>
          </div>
          <div className="report-grid period-grid">
            <div className="panel list">
              <h3 style={{ margin: 0 }}>Мастера</h3>
              <table className="plain-table">
                <thead><tr><th>Мастер</th><th>Визиты</th><th>Услуги</th><th>Чаевые</th><th>Загрузка</th></tr></thead>
                <tbody>
                  {report.staff.map((row) => (
                    <tr key={row.staffId}><td>{row.name}</td><td>{row.visits}{row.noShow ? <small className="muted"> · неявок {row.noShow}</small> : null}</td><td>{money(row.servicesMinor)}</td><td>{money(row.tipsMinor)}</td><td>{row.loadPercent}%</td></tr>
                  ))}
                </tbody>
              </table>
              {report.staff.length === 0 && <span className="muted">Нет визитов за период</span>}
            </div>
            <div className="panel list">
              <h3 style={{ margin: 0 }}>Популярные услуги</h3>
              {report.services.map((row) => (
                <div key={row.serviceId} className="spread" style={{ fontSize: 13 }}><span>{row.title}</span><span className="muted">{row.count} · {money(row.priceMinor)}</span></div>
              ))}
              <h3 style={{ margin: "10px 0 0" }}>Откуда клиенты</h3>
              {report.sources.map((row) => (
                <div key={row.source} className="spread" style={{ fontSize: 13 }}><span>{SOURCE[row.source] ?? row.source}</span><span className="muted">{row.clients}</span></div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
