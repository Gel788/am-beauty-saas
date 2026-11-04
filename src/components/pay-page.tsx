"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/domain/money";
import { formatWhen } from "./booking-widget";

type Info = {
  salon: string;
  branch: string;
  address: string;
  timezone: string;
  startsAt: string | null;
  description: string;
  amountMinor: number;
  status: "created" | "pending" | "succeeded" | "canceled" | "expired";
  method: string | null;
  sandbox: boolean;
  confirmationUrl: string | null;
  expiresAt: string;
};

/** ACQ-PAGE-01: the client's page behind the pay link. */
export function PayPage({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/public/pay/${token}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message ?? "Ссылка не найдена");
        setInfo(body);
      })
      .catch((err: Error) => setError(err.message));
  }, [token]);

  async function sandbox(action: "card" | "sbp" | "cancel") {
    setBusy(true);
    try {
      const response = await fetch(`/api/public/pay/${token}/sandbox`, { method: "POST", body: JSON.stringify({ action }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "Не получилось");
      setInfo(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !info) {
    return (
      <main className="pay-page">
        <div className="pay-card"><h1 style={{ margin: 0, fontSize: 22 }}>Ссылка не работает</h1><p className="muted">{error}</p></div>
      </main>
    );
  }
  if (!info) return <main className="pay-page"><div className="pay-card"><div className="skeleton" /></div></main>;
  const open = info.status === "pending" || info.status === "created";
  return (
    <main className="pay-page">
      <div className="pay-card">
        <div>
          <div className="page-kicker">{info.salon}</div>
          <div className="muted" style={{ fontSize: 13 }}>{info.branch}{info.address ? ` · ${info.address}` : ""}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 13 }}>{info.description}</div>
          {info.startsAt && <div style={{ fontSize: 14, marginTop: 2 }}>Визит: {formatWhen(info.startsAt, info.timezone)}</div>}
        </div>
        <div className="pay-amount">{formatMoney(info.amountMinor)}</div>
        {info.status === "succeeded" && (
          <div className="banner" style={{ background: "#e7f6ec", color: "#1d6b3a" }}>
            Оплачено{info.method ? (info.method === "sbp" ? " по СБП" : " картой") : ""}. Спасибо! Чек придёт на телефон или почту, которые знает салон.
          </div>
        )}
        {info.status === "canceled" && <div className="banner">Ссылка отменена. Попросите салон прислать новую.</div>}
        {info.status === "expired" && <div className="banner">Срок ссылки истёк. Попросите салон прислать новую.</div>}
        {open && info.sandbox && (
          <>
            <div className="tag tag-warn" style={{ whiteSpace: "normal" }}>Тестовый режим: деньги не списываются.</div>
            <div className="pay-actions">
              <button className="btn-gradient" type="button" disabled={busy} onClick={() => sandbox("card")}>Оплатить картой</button>
              <button className="btn" type="button" disabled={busy} onClick={() => sandbox("sbp")}>Оплатить по СБП</button>
              <button className="btn-ghost" type="button" disabled={busy} onClick={() => sandbox("cancel")}>Отказаться</button>
            </div>
          </>
        )}
        {open && !info.sandbox && info.confirmationUrl && (
          <a className="btn-gradient" style={{ textAlign: "center", padding: "12px 0" }} href={info.confirmationUrl}>Перейти к оплате</a>
        )}
        {open && (
          <span className="muted" style={{ fontSize: 12 }}>
            Ссылка действует до {new Date(info.expiresAt).toLocaleString("ru-RU", { timeZone: info.timezone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {error && <span className="muted" style={{ color: "#b42318" }}>{error}</span>}
      </div>
    </main>
  );
}
