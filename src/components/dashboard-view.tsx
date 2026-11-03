"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/domain/money";
import { api } from "./api";

type Data = {
  branchName: string;
  monthRevenueMinor: number;
  todayPaidMinor: number;
  series: { day: string; totalMinor: number }[];
  topServices: { title: string; totalMinor: number; visits: number }[];
  journal: { expectedRevenueMinor: number; appointmentCount: number; loadPercent: number; newClients: number; staff: { id: string; name: string; loadPercent: number }[] } | null;
};

export function DashboardView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ branches: { id: string }[] }>("/api/auth/me")
      .then((me) => api<Data>(`/api/dashboard?branchId=${me.branches[0]?.id ?? ""}`))
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);
  const max = Math.max(1, ...(data?.series.map((point) => point.totalMinor) ?? [1]));
  const points = (data?.series ?? []).map((point, index, all) => {
    const x = all.length <= 1 ? 0 : (index / (all.length - 1)) * 280;
    const y = 70 - (point.totalMinor / max) * 60;
    return `${x},${y}`;
  }).join(" ");

  return (
    <>
      <div>
        <div className="page-kicker">{data?.branchName}</div>
        <h1>Обзор студии</h1>
      </div>
      {error && <div className="banner">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <>
          <div className="panel">
            <div className="spread">
              <div>
                <div className="page-kicker">Выручка за месяц</div>
                <div className="display" style={{ fontSize: 42 }}>{formatMoney(data.monthRevenueMinor)}</div>
              </div>
              <svg className="spark" viewBox="0 0 280 80">
                <polyline fill="none" stroke="url(#g)" strokeWidth="3" points={points || "0,70 280,70"} />
                <defs>
                  <linearGradient id="g" x1="0" x2="1">
                    <stop offset="0%" stopColor="#7c5cff" />
                    <stop offset="100%" stopColor="#ff4d8d" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
          </div>
          <div className="stats">
            <div className="stat-pill"><span>Сегодня в кассе</span><b>{formatMoney(data.todayPaidMinor)}</b></div>
            <div className="stat-pill"><span>Записей сегодня</span><b>{data.journal?.appointmentCount ?? "—"}</b></div>
            <div className="stat-pill"><span>Ожидаемая выручка</span><b>{formatMoney(data.journal?.expectedRevenueMinor ?? 0)}</b></div>
            <div className="stat-pill"><span>Новые клиенты</span><b>{data.journal?.newClients ?? 0}</b></div>
          </div>
          <div className="split">
            <div className="panel">
              <h2 className="display" style={{ fontSize: 20 }}>Загрузка мастеров</h2>
              {(data.journal?.staff ?? []).map((staff) => (
                <div key={staff.id} style={{ marginTop: 10 }}>
                  <div className="spread"><span>{staff.name}</span><b>{staff.loadPercent}%</b></div>
                  <div className="util"><i style={{ width: `${Math.min(100, staff.loadPercent)}%` }} /></div>
                </div>
              ))}
              {!data.journal && <p className="muted">Журнал для этой роли скрыт.</p>}
            </div>
            <div className="panel">
              <h2 className="display" style={{ fontSize: 20 }}>Топ услуг</h2>
              {data.topServices.length === 0 && <p className="muted">В этом месяце услуг ещё нет.</p>}
              {data.topServices.map((service) => (
                <div key={service.title} className="spread" style={{ marginTop: 10 }}>
                  <div><strong>{service.title}</strong><div className="muted">{service.visits} записей</div></div>
                  <b>{formatMoney(service.totalMinor)}</b>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
