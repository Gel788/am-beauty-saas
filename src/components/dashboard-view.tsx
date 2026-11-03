"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatMoney } from "@/domain/money";
import { api } from "./api";
import { portraitFor } from "./portraits";

type Data = {
  today: string;
  branchName: string;
  monthRevenueMinor: number;
  todayPaidMinor: number;
  repeatPercent: number;
  dormantClients: number;
  averageCheckMinor: number;
  series: { day: string; totalMinor: number }[];
  topServices: { title: string; totalMinor: number; visits: number }[];
  journal: {
    expectedRevenueMinor: number;
    appointmentCount: number;
    loadPercent: number;
    newClients: number;
    staff: { id: string; name: string; loadPercent: number }[];
  } | null;
};

function Spark({ color, down = false }: { color: string; down?: boolean }) {
  const points = down ? "0,8 16,10 32,12 48,16 64,20" : "0,20 16,16 32,14 48,10 64,8";
  return (
    <svg width="64" height="28" viewBox="0 0 64 28" aria-hidden>
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
    </svg>
  );
}

export function DashboardView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<"Сегодня" | "Неделя" | "Месяц" | "Год">("Месяц");

  useEffect(() => {
    api<{ branches: { id: string }[]; actor: { name: string } }>("/api/auth/me")
      .then((me) => api<Data & { actorName?: string }>(`/api/dashboard?branchId=${me.branches[0]?.id ?? ""}`).then((payload) => ({ ...payload, actorName: me.actor.name })))
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  const name = (data as (Data & { actorName?: string }) | null)?.actorName?.split(" ")[0] ?? "";
  const chart = (() => {
    if (!data?.today) return "";
    const year = Number(data.today.slice(0, 4));
    const month = Number(data.today.slice(5, 7));
    const days = new Date(year, month, 0).getDate();
    const byDay = new Map(data.series.map((point) => [point.day, point.totalMinor]));
    const values: number[] = [];
    let sum = 0;
    for (let day = 1; day <= days; day += 1) {
      const key = `${data.today.slice(0, 8)}${String(day).padStart(2, "0")}`;
      sum += byDay.get(key) ?? 0;
      values.push(sum);
    }
    const peak = Math.max(1, ...values);
    return values.map((value, index) => {
      const x = 12 + (index / Math.max(1, values.length - 1)) * 530;
      const y = 118 - (value / peak) * 92;
      return `${x},${y}`;
    }).join(" ");
  })();
  const shownRevenue = period === "Сегодня" ? data?.todayPaidMinor ?? 0 : data?.monthRevenueMinor ?? 0;

  return (
    <>
      <div className="journal-top">
        <div>
          <div className="page-kicker">Добрый день, {name}</div>
          <h1 className="date-title">Обзор студии</h1>
        </div>
        <div className="journal-toolbar">
          <div className="segment">
            {(["Сегодня", "Неделя", "Месяц", "Год"] as const).map((item) => (
              <button key={item} className={period === item ? "on" : ""} type="button" onClick={() => setPeriod(item)}>{item}</button>
            ))}
          </div>
          <button className="btn" type="button" onClick={() => { window.location.href = `/api/export?date=${data?.today ?? ""}`; }}>Экспорт</button>
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <>
          <div className="dash-grid">
            <div className="panel">
              <div className="spread">
                <div>
                  <div className="page-kicker">Выручка за ноябрь</div>
                  <div className="big-num">{formatMoney(shownRevenue)}</div>
                  <div className="muted" style={{ marginTop: 6 }}>к прошлому периоду · прогноз по факту кассы</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="muted">сегодня</div>
                  <b className="display" style={{ fontSize: 22 }}>{formatMoney(data.todayPaidMinor)}</b>
                </div>
              </div>
              <svg viewBox="0 0 560 140" style={{ width: "100%", height: 140 }}>
                <defs>
                  <linearGradient id="rev" x1="0" x2="1">
                    <stop offset="0%" stopColor="#7c5cff" />
                    <stop offset="55%" stopColor="#e879f9" />
                    <stop offset="100%" stopColor="#fb923c" />
                  </linearGradient>
                </defs>
                <polyline fill="none" stroke="url(#rev)" strokeWidth="3.5" points={chart || "12,118 540,118"} />
              </svg>
            </div>
            <div className="panel list">
              <div className="spread"><strong>AI-инсайты</strong><span className="badge">скоро</span></div>
              <div className="sys-card">
                {data.dormantClients} клиентов не были больше 45 дней
                <div className="muted">Отправить персональную скидку 10%</div>
                <div className="spread" style={{ marginTop: 8 }}><b>+ запись</b><button className="btn" type="button" style={{ background: "#1c1428", color: "white" }}>Запустить</button></div>
              </div>
              <div className="sys-card">
                Загрузка дня {data.journal?.loadPercent ?? 0}%
                <div className="muted">Включить «счастливые часы» −15%</div>
                <div className="spread" style={{ marginTop: 8 }}><span className="muted">по журналу</span><button className="btn-ghost" type="button">Включить</button></div>
              </div>
              <div className="sys-card">
                {(data.journal?.staff ?? []).slice().sort((a, b) => b.loadPercent - a.loadPercent)[0]?.name ?? "Мастер"} загружен на {(data.journal?.staff ?? []).slice().sort((a, b) => b.loadPercent - a.loadPercent)[0]?.loadPercent ?? 0}%
                <div className="muted">Поднять цену стрижки на 200 ₽</div>
                <div className="spread" style={{ marginTop: 8 }}><span /><button className="btn-ghost" type="button">Подробнее</button></div>
              </div>
            </div>
          </div>
          <div className="dash-cards">
            <div className="panel"><div className="spread"><div><div className="muted">Сегодня</div><b className="display" style={{ fontSize: 26 }}>{formatMoney(data.journal?.expectedRevenueMinor ?? data.todayPaidMinor)}</b></div><Spark color="#7c5cff" /></div></div>
            <div className="panel"><div className="spread"><div><div className="muted">Записей</div><b className="display" style={{ fontSize: 26 }}>{data.journal?.appointmentCount ?? 0}</b><div className="muted">{data.journal?.newClients ?? 0} новых</div></div><Spark color="#fb7185" /></div></div>
            <div className="panel"><div className="spread"><div><div className="muted">Средний чек</div><b className="display" style={{ fontSize: 26 }}>{formatMoney(data.averageCheckMinor)}</b></div><Spark color="#fb923c" /></div></div>
            <div className="panel"><div className="spread"><div><div className="muted">Неявки</div><b className="display" style={{ fontSize: 26 }}>0%</b><div className="muted">за месяц</div></div><Spark color="#34d399" down /></div></div>
          </div>
          <div className="dash-bottom">
            <div className="panel">
              <strong>Загрузка мастеров</strong>
              {(data.journal?.staff ?? []).slice().sort((a, b) => ["Алина Ковалёва", "Марина Соколова", "Денис Волков", "Елена Лебедева"].indexOf(a.name) - ["Алина Ковалёва", "Марина Соколова", "Денис Волков", "Елена Лебедева"].indexOf(b.name)).map((staff) => (
                <div key={staff.id} className="spread" style={{ marginTop: 10 }}>
                  <div className="row" style={{ minWidth: 0 }}>
                    {portraitFor(staff.name) ? <Image className="face" src={portraitFor(staff.name) ?? "/staff/alina.jpg"} alt="" width={36} height={36} /> : <span className="avatar">{staff.name.slice(0, 1)}</span>}
                    <span style={{ whiteSpace: "nowrap" }}>{staff.name}</span>
                  </div>
                  <div className="load" style={{ width: 120 }}><i><span style={{ width: `${Math.min(100, staff.loadPercent)}%` }} /></i><em>{staff.loadPercent}%</em></div>
                </div>
              ))}
            </div>
            <div className="panel">
              <strong>Топ услуг</strong>
              {data.topServices.length === 0 && <p className="muted">В этом месяце услуг ещё нет.</p>}
              {data.topServices.map((service) => (
                <div key={service.title} className="spread" style={{ marginTop: 10 }}>
                  <div><strong>{service.title}</strong><div className="muted">{service.visits} записей</div></div>
                  <b>{formatMoney(service.totalMinor)}</b>
                </div>
              ))}
            </div>
            <div className="panel" style={{ display: "grid", placeItems: "center", textAlign: "center" }}>
              <svg width="120" height="120" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="46" fill="none" stroke="#f3e8ff" strokeWidth="12" />
                <circle cx="60" cy="60" r="46" fill="none" stroke="url(#ring)" strokeWidth="12" strokeDasharray={`${(data.repeatPercent / 100) * 289} 289`} strokeLinecap="round" transform="rotate(-90 60 60)" />
                <defs>
                  <linearGradient id="ring" x1="0" x2="1"><stop offset="0%" stopColor="#7c5cff" /><stop offset="100%" stopColor="#fb923c" /></linearGradient>
                </defs>
                <text x="60" y="66" textAnchor="middle" fontSize="22" fontFamily="var(--font-unbounded)">{data.repeatPercent}%</text>
              </svg>
              <div>
                <strong>Возвращаемость</strong>
                <div className="muted">Пришли повторно за 60 дней</div>
                <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
                  {["/staff/alina.jpg", "/staff/marina.jpg", "/staff/denis.jpg"].map((src) => (
                    <Image key={src} src={src} alt="" width={22} height={22} className="face" />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
