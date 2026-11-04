"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "@/domain/money";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Row = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  planTitle: string;
  state: "trial" | "active" | "grace" | "expired" | "suspended";
  until: string | null;
  daysLeft: number;
  suspendedReason: string;
  createdAt: string;
  ownerEmail: string;
  staff: number;
  branches: number;
  appointments30d: number;
  lastActivity: string | null;
  paidTotalMinor: number;
};
const STATE: Record<Row["state"], string> = { trial: "пробный", active: "оплачен", grace: "льготные дни", expired: "только просмотр", suspended: "приостановлен" };
const date = (value: string | null) => (value ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "2-digit" }) : "—");

/** PLAT-SUPER-01: every salon on the platform, for the platform team. */
export function PlatformView() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  useEffect(() => {
    api<Row[]>("/api/platform/tenants").then(setRows).catch((err: ApiError) => setError(err.message));
  }, []);
  const update = async (row: Row, body: Record<string, unknown>, done: string) => {
    try {
      const saved = await api<Row>(`/api/platform/tenants/${row.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setRows((list) => list?.map((item) => (item.id === row.id ? saved : item)) ?? null);
      toast(done);
    } catch (err) {
      toast((err as ApiError).message, "error");
    }
  };
  const shown = useMemo(() => (rows ?? []).filter((row) => (filter === "all" || row.state === filter) && (!query || `${row.name} ${row.slug} ${row.ownerEmail}`.toLowerCase().includes(query.toLowerCase()))), [rows, filter, query]);
  const count = (state: string) => rows?.filter((row) => row.state === state).length ?? 0;
  const mrr = (rows ?? []).filter((row) => row.state === "active").reduce((sum, row) => sum + ({ start: 149000, salon: 349000, network: 799000 }[row.plan] ?? 0), 0);
  if (error) return <div className="reports-page"><div className="banner">{error}</div></div>;
  if (!rows) return <div className="skeleton" />;
  return (
    <div className="reports-page">
      <div><div className="page-kicker">Платформа</div><h1>Салоны</h1></div>
      <div className="report-tiles period-tiles">
        <div className="panel report-tile"><span className="muted">Всего салонов</span><b className="display">{rows.length}</b><small className="muted">на пробном {count("trial")}</small></div>
        <div className="panel report-tile"><span className="muted">Платят</span><b className="display">{count("active")}</b><small className="muted">≈ {formatMoney(mrr)} в месяц</small></div>
        <div className="panel report-tile"><span className="muted">Закончилась подписка</span><b className="display">{count("grace") + count("expired")}</b><small className="muted">льготные дни {count("grace")}</small></div>
        <div className="panel report-tile"><span className="muted">Приостановлены</span><b className="display">{count("suspended")}</b><small className="muted">вручную</small></div>
      </div>
      <div className="panel list">
        <div className="period-bar">
          <div className="segment">
            {[["all", "Все"], ["trial", "Пробный"], ["active", "Платят"], ["expired", "Просмотр"], ["suspended", "Стоп"]].map(([value, label]) => (
              <button key={value} type="button" className={filter === value ? "on" : ""} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <input className="report-date" placeholder="Салон, адрес или почта" value={query} onChange={(event) => setQuery(event.target.value)} style={{ minWidth: 240 }} />
        </div>
        <table className="plain-table platform-table">
          <thead><tr><th>Салон</th><th>Тариф</th><th>До</th><th>Мастера / филиалы</th><th>Записей за 30 дн.</th><th>Оплачено</th><th /></tr></thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id}>
                <td><b>{row.name}</b><small className="muted">{row.slug} · {row.ownerEmail || "без владельца"} · с {date(row.createdAt)}</small></td>
                <td>{row.planTitle}<small className={`state-${row.state}`}>{STATE[row.state]}{row.suspendedReason ? `: ${row.suspendedReason}` : ""}</small></td>
                <td className="nowrap">{date(row.until)}{row.state !== "suspended" && <small className="muted">{row.daysLeft >= 0 ? `осталось ${row.daysLeft} дн.` : `${-row.daysLeft} дн. назад`}</small>}</td>
                <td>{row.staff} / {row.branches}</td>
                <td>{row.appointments30d}<small className="muted">активность {date(row.lastActivity)}</small></td>
                <td>{formatMoney(row.paidTotalMinor)}</td>
                <td className="platform-actions">
                  <button type="button" className="btn" onClick={() => update(row, { extendDays: 14 }, "Продлено на 14 дней")}>+14 дн.</button>
                  {row.state === "suspended" ? (
                    <button type="button" className="btn" onClick={() => update(row, { suspend: false }, "Салон снова работает")}>Включить</button>
                  ) : (
                    <button type="button" className="btn" onClick={() => {
                      const reason = window.prompt("Причина приостановки (её увидит салон)", "");
                      if (reason !== null) void update(row, { suspend: true, reason }, "Салон приостановлен");
                    }}>Приостановить</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <span className="muted">Ничего не найдено</span>}
      </div>
    </div>
  );
}
