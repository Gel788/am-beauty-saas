"use client";

import { useEffect, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Shift = { id: string; openingCashMinor: number; openedAt: string; note: string } | null;
type Payment = { id: string; totalMinor: number; changeMinor: number; clientName: string | null; postedAt: string | null; status: string };

export function CashView() {
  const toast = useToast();
  const [branchId, setBranchId] = useState("");
  const [shift, setShift] = useState<Shift>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [cash, setCash] = useState("5000");
  const [error, setError] = useState("");

  async function load() {
    const me = await api<{ branches: { id: string }[] }>("/api/auth/me");
    const id = me.branches[0]?.id ?? "";
    setBranchId(id);
    setShift(await api<Shift>(`/api/shifts/current?branchId=${id}`));
    setPayments(await api<Payment[]>(`/api/payments?branchId=${id}`));
  }
  useEffect(() => { void load().catch((err: ApiError) => setError(err.message)); }, []);

  return (
    <>
      <div><div className="page-kicker">Деньги дня</div><h1>Касса</h1></div>
      {error && <div className="banner">{error}</div>}
      <div className="panel">
        {shift ? (
          <div>
            <div className="page-kicker">Смена открыта</div>
            <b className="display" style={{ fontSize: 28 }}>{formatMoney(shift.openingCashMinor)}</b>
            <p className="muted">Наличные на старте · {new Date(shift.openedAt).toLocaleString("ru-RU")}</p>
          </div>
        ) : (
          <form className="row" onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api("/api/shifts/open", { method: "POST", body: JSON.stringify({ branchId, openingCashMinor: rublesToMinor(Number(cash)) }) });
              toast("Смена открыта");
              await load();
            } catch (err) {
              toast((err as ApiError).message, "error");
            }
          }}>
            <div className="field"><label>Наличных в кассе, ₽</label><input value={cash} onChange={(event) => setCash(event.target.value)} /></div>
            <button className="btn-gradient" type="submit">Открыть смену</button>
          </form>
        )}
      </div>
      <div className="panel list">
        <h2 className="display" style={{ fontSize: 22 }}>Платежи</h2>
        {payments.length === 0 && <p className="muted">Пока пусто. Оплата принимается из карточки записи.</p>}
        {payments.map((payment) => (
          <div key={payment.id} className="spread person">
            <div><strong>{payment.clientName || "Без клиента"}</strong><span>{payment.postedAt ? new Date(payment.postedAt).toLocaleString("ru-RU") : ""} {payment.changeMinor ? `· сдача ${formatMoney(payment.changeMinor)}` : ""}</span></div>
            <b>{formatMoney(payment.totalMinor)}</b>
          </div>
        ))}
      </div>
    </>
  );
}
