"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/domain/money";
import { STATUS_LABEL, type AppointmentStatus } from "@/domain/status";
import { addCalendarDays, todayInZone } from "@/domain/time";
import { api, type ApiError } from "./api";

type Report = {
  date: string;
  branchName: string;
  currency: string;
  revenue: {
    totalMinor: number;
    servicesMinor: number;
    productsMinor: number;
    tipsMinor: number;
    debtRepaidMinor: number;
    otherMinor: number;
    refundsMinor: number;
    byMethod: { method: string; netMinor: number }[];
  };
  appointments: { total: number; createdToday: number; createdOnline: number; completed: number; cancelled: number; noShow: number; open: number; online: number };
  load: {
    availableMin: number;
    occupiedMin: number;
    loadPercent: number | null;
    staff: { staffId: string; name: string; color: string; availableMin: number; occupiedMin: number; loadPercent: number | null }[];
  };
  payments: { id: string; time: string; direction: string; status: string; totalMinor: number; clientName: string | null }[];
  appointmentList: { id: string; time: string; staffName: string; clientName: string | null; title: string; status: string; source: string; priceMinor: number }[];
};

const METHODS: Record<string, string> = { cash: "Наличные", card: "Карта", sbp: "СБП", transfer: "Перевод", bonus: "Бонусы", certificate: "Сертификат" };

function hours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function dateLabel(date: string) {
  const label = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function ReportsView() {
  const [branch, setBranch] = useState<{ id: string; timezone: string } | null>(null);
  const [date, setDate] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"payments" | "appointments">("payments");

  useEffect(() => {
    api<{ branches: { id: string; timezone: string }[] }>("/api/auth/me")
      .then((me) => {
        const first = me.branches[0];
        if (!first) return;
        setBranch(first);
        setDate(todayInZone(first.timezone));
      })
      .catch((err: ApiError) => setError(err.message));
  }, []);

  const load = useCallback(async () => {
    if (!branch || !date) return;
    setReport(null);
    setError("");
    try {
      setReport(await api<Report>(`/api/reports/day?branchId=${branch.id}&date=${date}`));
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, [branch, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: number) => formatMoney(minor, report?.currency ?? "RUB");

  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">{report?.branchName ?? "Отчёт дня"}</div>
          <h1 className="date-title">{date ? dateLabel(date) : "Отчёт дня"}</h1>
        </div>
        <div className="journal-toolbar">
          <button className="icon-btn" aria-label="Предыдущий день" onClick={() => setDate(addCalendarDays(date, -1))}>‹</button>
          <input className="report-date" type="date" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} />
          <button className="icon-btn" aria-label="Следующий день" onClick={() => setDate(addCalendarDays(date, 1))}>›</button>
          {branch && <button className="btn-ghost" onClick={() => setDate(todayInZone(branch.timezone))}>Сегодня</button>}
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {!report && !error && <div className="skeleton" />}
      {report && (
        <>
          <div className="report-tiles">
            <div className="panel report-tile">
              <span className="muted">Выручка за день</span>
              <b className="display">{money(report.revenue.totalMinor)}</b>
              <small className="muted">поступило по оплатам, за вычетом возвратов</small>
            </div>
            <div className="panel report-tile">
              <span className="muted">Записей на день</span>
              <b className="display">{report.appointments.total}</b>
              <small className="muted">создано сегодня: {report.appointments.createdToday}, онлайн: {report.appointments.createdOnline}</small>
            </div>
            <div className="panel report-tile">
              <span className="muted">Загрузка мастеров</span>
              <b className="display">{report.load.loadPercent == null ? "—" : `${report.load.loadPercent}%`}</b>
              <small className="muted">{hours(report.load.occupiedMin)} из {hours(report.load.availableMin)}</small>
            </div>
          </div>

          <div className="report-grid">
            <div className="panel list">
              <h2 className="report-h">Из чего выручка</h2>
              <div className="spread"><span>Услуги</span><b>{money(report.revenue.servicesMinor)}</b></div>
              <div className="spread"><span>Товары и прочий приход</span><b>{money(report.revenue.productsMinor)}</b></div>
              <div className="spread"><span>Чаевые</span><b>{money(report.revenue.tipsMinor)}</b></div>
              {report.revenue.debtRepaidMinor !== 0 && <div className="spread"><span>Погашение долгов</span><b>{money(report.revenue.debtRepaidMinor)}</b></div>}
              {report.revenue.otherMinor !== 0 && <div className="spread"><span>Прочее</span><b>{money(report.revenue.otherMinor)}</b></div>}
              {report.revenue.refundsMinor > 0 && <div className="spread muted"><span>Возвраты (уже вычтены)</span><span>−{money(report.revenue.refundsMinor)}</span></div>}
              <h2 className="report-h">По способам оплаты</h2>
              {report.revenue.byMethod.length === 0 && <span className="muted">Оплат не было</span>}
              {report.revenue.byMethod.map((row) => (
                <div key={row.method} className="spread"><span>{METHODS[row.method] ?? row.method}</span><b>{money(row.netMinor)}</b></div>
              ))}
            </div>

            <div className="panel list">
              <h2 className="report-h">Записи</h2>
              <div className="spread"><span>Завершено</span><b>{report.appointments.completed}</b></div>
              <div className="spread"><span>Ещё впереди или идут</span><b>{report.appointments.open}</b></div>
              <div className="spread"><span>Отменено</span><b>{report.appointments.cancelled}</b></div>
              <div className="spread"><span>Неявки</span><b>{report.appointments.noShow}</b></div>
              <div className="spread"><span>Из них онлайн</span><b>{report.appointments.online}</b></div>
              <h2 className="report-h">Загрузка по мастерам</h2>
              {report.load.staff.length === 0 && <span className="muted">В этот день никто не работает</span>}
              {report.load.staff.map((row) => (
                <div key={row.staffId} className="report-load">
                  <div className="spread">
                    <span className="row"><i className="dot" style={{ background: row.color }} />{row.name}</span>
                    <span className="muted">{hours(row.occupiedMin)} / {hours(row.availableMin)}</span>
                  </div>
                  <div className="report-bar"><span style={{ width: `${Math.min(100, row.loadPercent ?? 100)}%`, background: row.color }} /></div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel list">
            <div className="segment" style={{ alignSelf: "flex-start" }}>
              <button className={tab === "payments" ? "on" : ""} onClick={() => setTab("payments")}>Платежи · {report.payments.length}</button>
              <button className={tab === "appointments" ? "on" : ""} onClick={() => setTab("appointments")}>Записи · {report.appointmentList.length}</button>
            </div>
            {tab === "payments" && (
              <table className="report-table">
                <thead><tr><th>Время</th><th>Клиент</th><th>Тип</th><th className="num">Сумма</th></tr></thead>
                <tbody>
                  {report.payments.length === 0 && <tr><td colSpan={4} className="muted">Платежей нет</td></tr>}
                  {report.payments.map((row) => (
                    <tr key={row.id} className={row.status === "void" ? "void" : ""}>
                      <td>{row.time}</td>
                      <td>{row.clientName ?? "—"}</td>
                      <td>
                        {row.status === "void" ? <span className="tag tag-muted">Аннулирован</span> : row.direction === "out" ? <span className="tag tag-warn">Возврат</span> : <span className="tag tag-ok">Приход</span>}
                      </td>
                      <td className="num">{row.direction === "out" ? "−" : ""}{money(row.totalMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === "appointments" && (
              <table className="report-table">
                <thead><tr><th>Время</th><th>Клиент</th><th>Мастер</th><th>Услуги</th><th>Статус</th><th className="num">Цена</th></tr></thead>
                <tbody>
                  {report.appointmentList.length === 0 && <tr><td colSpan={6} className="muted">Записей нет</td></tr>}
                  {report.appointmentList.map((row) => (
                    <tr key={row.id}>
                      <td><Link href={`/journal?date=${report.date}`}>{row.time}</Link></td>
                      <td>{row.clientName ?? "—"}{row.source === "online" && <span className="tag tag-muted" style={{ marginLeft: 6 }}>онлайн</span>}</td>
                      <td>{row.staffName}</td>
                      <td>{row.title}</td>
                      <td>{STATUS_LABEL[row.status as AppointmentStatus] ?? row.status}</td>
                      <td className="num">{money(row.priceMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
