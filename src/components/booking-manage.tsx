"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/domain/money";
import { formatWhen } from "./booking-widget";

type Booking = {
  appointmentId: string;
  status: string;
  startsAt: string;
  staffName: string;
  clientName: string | null;
  serviceTitle: string;
  priceMinor: number;
  cancelUntil: string;
  canCancel: boolean;
  outcome?: "cancelled" | "requested" | "already_cancelled";
  branch: { name: string; address: string; timezone: string; currency: string; accent: string };
};

const STATUS: Record<string, string> = {
  scheduled: "Запись подтверждена",
  confirmed: "Запись подтверждена",
  arrived: "Вы в салоне",
  in_progress: "Визит идёт",
  completed: "Визит завершён",
  cancelled: "Запись отменена",
  no_show: "Визит пропущен",
};

export function BookingManage({ token }: { token: string }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/public/booking/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message ?? "Запись не найдена");
        setBooking(body);
      })
      .catch((failure: Error) => setError(failure.message));
  }, [token]);

  async function cancel() {
    setBusy(true);
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(token)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Не получилось отменить");
      setBooking(body);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !booking) {
    return <div className="bk-page"><div className="bk-card bk-empty"><h1>Запись не найдена</h1><p>{error}</p></div></div>;
  }
  if (!booking) return <div className="bk-page"><div className="bk-card bk-loading">Загружаем запись…</div></div>;
  const tz = booking.branch.timezone;
  const active = booking.status === "scheduled" || booking.status === "confirmed";
  return (
    <div className="bk-page" style={{ ["--bk-accent" as string]: booking.branch.accent }}>
      <div className="bk-card">
        <header className="bk-head">
          <div className="bk-logo bk-logo-text">{booking.branch.name.slice(0, 1)}</div>
          <div><h1>{booking.branch.name}</h1>{booking.branch.address && <p>{booking.branch.address}</p>}</div>
        </header>
        <section className="bk-done">
          <h2>{STATUS[booking.status] ?? booking.status}</h2>
          <p className="bk-when">{formatWhen(booking.startsAt, tz)}</p>
          <p>{booking.serviceTitle} · {booking.staffName} · {formatMoney(booking.priceMinor, booking.branch.currency)}</p>
          {error && <div className="bk-notice" role="alert">{error}</div>}
          {booking.outcome === "requested" && (
            <div className="bk-notice">Отменить онлайн уже поздно, поэтому мы передали вашу просьбу администратору. С вами свяжутся.</div>
          )}
          {active && booking.canCancel && (
            <div className="bk-form">
              <p className="bk-muted">Отменить можно до {formatWhen(booking.cancelUntil, tz)}.</p>
              <label>Причина (необязательно)<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
              <button className="bk-primary" disabled={busy} onClick={cancel}>{busy ? "Отменяем…" : "Отменить запись"}</button>
            </div>
          )}
          {active && !booking.canCancel && booking.outcome !== "requested" && (
            <div className="bk-form">
              <p className="bk-muted">Онлайн отменить уже нельзя: до визита меньше, чем разрешает салон. Можно отправить просьбу администратору.</p>
              <button className="bk-primary" disabled={busy} onClick={cancel}>{busy ? "Отправляем…" : "Попросить отменить"}</button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
