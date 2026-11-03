"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Banknote, CreditCard, History, Landmark, Lock, LockOpen, Printer, QrCode } from "lucide-react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { api, type ApiError } from "./api";
import { METHOD_LABEL, PaymentRow, type PaymentItem } from "./payment-actions";
import { Modal, useToast } from "./ui";

type Method = "cash" | "card" | "sbp" | "transfer";
type Totals = {
  openingCashMinor: number;
  byMethod: Record<Method, { inMinor: number; outMinor: number; netMinor: number }>;
  expected: Record<Method, number>;
  revenue: { servicesMinor: number; productsMinor: number; tipsMinor: number; debtRepaidMinor: number };
  incomeMinor: number;
  refundsMinor: number;
  changeGivenMinor: number;
  paymentCount: number;
  refundCount: number;
  voidCount: number;
  voidMinor: number;
};
export type Shift = {
  id: string;
  status: "open" | "closing" | "closed";
  openingCashMinor: number;
  openedAt: string;
  openedById: string;
  openedByName: string;
  note: string;
  closingStartedAt: string | null;
  closingStartedById: string | null;
  closingStartedByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  expectedCashMinor: number;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  varianceReason: string | null;
  declared: Partial<Record<Method, number>>;
  closeNote: string;
  staleWarning: boolean;
  hoursOpen: number;
  totals: Totals;
};
type Report = { shift: Shift; payments: PaymentItem[] };
type Me = { actor: { userId: string; role: string }; branches: { id: string; name: string; shiftVarianceThresholdMinor?: number }[] };

const METHODS: { id: Method; icon: typeof Banknote }[] = [
  { id: "cash", icon: Banknote },
  { id: "card", icon: CreditCard },
  { id: "sbp", icon: QrCode },
  { id: "transfer", icon: Landmark },
];

const toRub = (minor: number) => String(minor / 100);
const parseRub = (value: string) => rublesToMinor(Number(value.replace(/\s/g, "").replace(",", ".")));
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "—";

function Signed({ minor }: { minor: number }) {
  const tone = minor === 0 ? "ok" : minor > 0 ? "warn" : "bad";
  return <span className={`tag tag-${tone}`}>{minor > 0 ? "+" : minor < 0 ? "−" : ""}{formatMoney(Math.abs(minor))}</span>;
}

export function CashView() {
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"shift" | "history">("shift");
  const [shift, setShift] = useState<Shift | null>(null);
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [history, setHistory] = useState<Shift[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [income, setIncome] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const branch = me?.branches[0];

  const load = useCallback(async () => {
    try {
      const who = me ?? (await api<Me>("/api/auth/me"));
      if (!me) setMe(who);
      const id = who.branches[0]?.id ?? "";
      const current = await api<Shift | null>(`/api/shifts/current?branchId=${id}`);
      setShift(current);
      setPayments(current ? await api<PaymentItem[]>(`/api/payments?branchId=${id}&shiftId=${current.id}`) : []);
      setHistory(await api<Shift[]>(`/api/shifts?branchId=${id}&limit=30`));
      setError("");
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => { void load(); }, [load]);

  async function openReport(id: string) {
    try {
      setReport(await api<Report>(`/api/shifts/${id}/report`));
    } catch (err) {
      toast((err as ApiError).message, "error");
    }
  }

  return (
    <div className="cash-page">
      <div className="journal-top">
        <div className="journal-title">
          <div className="page-kicker">Деньги дня · {branch?.name ?? "филиал"}</div>
          <h1 className="date-title">Касса</h1>
        </div>
        <div className="journal-toolbar">
          <div className="segment">
            <button type="button" className={tab === "shift" ? "on" : ""} onClick={() => setTab("shift")}>Текущая смена</button>
            <button type="button" className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>История смен</button>
          </div>
          {shift?.status === "open" && <button className="btn" type="button" onClick={() => setIncome(true)}>+ Приход</button>}
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {loading && <div className="skeleton" />}

      {!loading && tab === "shift" && !shift && branch && <OpenShift branchId={branch.id} last={history.find((item) => item.status === "closed") ?? null} onOpened={load} />}
      {!loading && tab === "shift" && shift?.status === "open" && (
        <OpenState shift={shift} payments={payments} onChanged={load} />
      )}
      {!loading && tab === "shift" && shift?.status === "closing" && me && (
        <ClosingState
          shift={shift}
          payments={payments}
          me={me}
          threshold={branch?.shiftVarianceThresholdMinor ?? 0}
          onCancelled={load}
          onClosed={(closed) => { setReport(closed); void load(); }}
        />
      )}
      {!loading && tab === "history" && <HistoryList items={history} onOpen={openReport} />}

      {report && <ZReport report={report} onClose={() => setReport(null)} onChanged={() => openReport(report.shift.id)} />}
      {income && branch && <IncomeModal branchId={branch.id} onClose={() => setIncome(false)} onDone={() => { setIncome(false); void load(); }} />}
    </div>
  );
}

function OpenShift({ branchId, last, onOpened }: { branchId: string; last: Shift | null; onOpened: () => void }) {
  const toast = useToast();
  const [cash, setCash] = useState(last?.countedCashMinor != null ? toRub(last.countedCashMinor) : "5000");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const amount = parseRub(cash);
  return (
    <div className="cash-grid">
      <form
        className="panel cash-hero"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api("/api/shifts/open", { method: "POST", body: JSON.stringify({ branchId, openingCashMinor: amount, note }) });
            toast("Смена открыта");
            onOpened();
          } catch (err) {
            toast((err as ApiError).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row"><span className="stat-ico"><LockOpen size={16} /></span><span className="page-kicker">Смена закрыта</span></div>
        <h2 className="display" style={{ fontSize: 24 }}>Открыть смену</h2>
        <p className="muted" style={{ margin: 0 }}>Пересчитайте наличные в ящике. Все оплаты до закрытия попадут в эту смену.</p>
        <div className="field">
          <label htmlFor="opening">Наличных в кассе, ₽</label>
          <input id="opening" className="money-input" inputMode="decimal" value={cash} onChange={(event) => setCash(event.target.value)} />
        </div>
        <div className="field"><label htmlFor="open-note">Комментарий</label><input id="open-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Необязательно" /></div>
        <button className="btn-gradient" type="submit" disabled={busy || !Number.isFinite(amount) || amount < 0}>Открыть смену · {formatMoney(Math.max(0, amount))}</button>
      </form>
      <div className="panel list">
        <strong>Прошлая смена</strong>
        {!last && <p className="muted">Это первая смена филиала.</p>}
        {last && (
          <>
            <div className="spread"><span className="muted">Закрыта</span><span>{when(last.closedAt)} · {last.closedByName}</span></div>
            <div className="spread"><span className="muted">В кассе по пересчёту</span><b>{formatMoney(last.countedCashMinor ?? 0)}</b></div>
            <div className="spread"><span className="muted">Расхождение</span><Signed minor={last.varianceMinor ?? 0} /></div>
            <div className="spread"><span className="muted">Приход за смену</span><span>{formatMoney(last.totals.incomeMinor)}</span></div>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Сумма открытия подставлена из пересчёта прошлой смены.</p>
          </>
        )}
      </div>
    </div>
  );
}

function MethodCards({ totals }: { totals: Totals }) {
  return (
    <div className="dash-cards">
      {METHODS.map(({ id, icon: Icon }) => {
        const bucket = totals.byMethod[id];
        return (
          <div key={id} className="panel">
            <div className="row"><span className="stat-ico"><Icon size={15} /></span><span className="muted">{METHOD_LABEL[id]}</span></div>
            <b className="display" style={{ fontSize: 24, display: "block", marginTop: 8 }}>{formatMoney(id === "cash" ? totals.expected.cash : bucket.netMinor)}</b>
            <div className="muted" style={{ fontSize: 12 }}>
              {id === "cash" ? `старт ${formatMoney(totals.openingCashMinor)} · ` : ""}+{formatMoney(bucket.inMinor)}
              {bucket.outMinor > 0 ? ` · −${formatMoney(bucket.outMinor)}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Breakdown({ totals }: { totals: Totals }) {
  const rows: [string, number][] = [
    ["Услуги и предоплаты", totals.revenue.servicesMinor],
    ["Прочий приход", totals.revenue.productsMinor],
    ["Чаевые", totals.revenue.tipsMinor],
    ["Погашение долгов", totals.revenue.debtRepaidMinor],
  ];
  return (
    <div className="list">
      {rows.map(([label, value]) => (
        <div key={label} className="spread"><span className="muted">{label}</span><span>{formatMoney(value)}</span></div>
      ))}
      <div className="spread"><span className="muted">Возвраты · {totals.refundCount}</span><span className={totals.refundsMinor ? "danger" : ""}>{totals.refundsMinor ? "−" : ""}{formatMoney(totals.refundsMinor)}</span></div>
      {totals.voidCount > 0 && <div className="spread"><span className="muted">Аннулировано · {totals.voidCount}</span><span className="muted">{formatMoney(totals.voidMinor)}</span></div>}
      <div className="spread"><span className="muted">Сдача выдана</span><span>{formatMoney(totals.changeGivenMinor)}</span></div>
      <div className="spread cash-total"><strong>Итого за смену</strong><b>{formatMoney(totals.incomeMinor - totals.refundsMinor)}</b></div>
    </div>
  );
}

function OpenState({ shift, payments, onChanged }: { shift: Shift; payments: PaymentItem[]; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <>
      {shift.staleWarning && <div className="banner">Смена открыта {shift.hoursOpen} ч. Похоже, её забыли закрыть.</div>}
      <div className="cash-grid">
        <div className="panel cash-hero">
          <div className="spread">
            <div className="row"><span className="stat-ico"><Banknote size={16} /></span><span className="page-kicker">Ожидается в ящике</span></div>
            <span className="tag tag-ok">смена открыта</span>
          </div>
          <div className="big-num">{formatMoney(shift.totals.expected.cash)}</div>
          <div className="muted">Открыл {shift.openedByName} · {when(shift.openedAt)}{shift.note ? ` · ${shift.note}` : ""}</div>
          <div className="row" style={{ marginTop: 4 }}>
            <button
              className="btn-gradient"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/api/shifts/${shift.id}/start-closing`, { method: "POST" });
                  onChanged();
                } catch (err) {
                  toast((err as ApiError).message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Lock size={14} style={{ display: "inline", marginRight: 6, verticalAlign: -2 }} />Закрыть смену
            </button>
            <span className="muted" style={{ fontSize: 12 }}>На время пересчёта новые оплаты блокируются</span>
          </div>
        </div>
        <div className="panel"><Breakdown totals={shift.totals} /></div>
      </div>
      <MethodCards totals={shift.totals} />
      <PaymentsPanel payments={payments} onChanged={onChanged} />
    </>
  );
}

function PaymentsPanel({ payments, onChanged, title = "Платежи смены" }: { payments: PaymentItem[]; onChanged: () => void; title?: string }) {
  return (
    <div className="panel list">
      <div className="spread"><strong>{title}</strong><span className="muted">{payments.length}</span></div>
      {payments.length === 0 && <div className="empty">Пока пусто. Оплата принимается из карточки записи.</div>}
      {payments.map((payment) => <PaymentRow key={payment.id} payment={payment} onChanged={onChanged} />)}
    </div>
  );
}

function ClosingState({
  shift,
  payments,
  me,
  threshold,
  onCancelled,
  onClosed,
}: {
  shift: Shift;
  payments: PaymentItem[];
  me: Me;
  threshold: number;
  onCancelled: () => void;
  onClosed: (report: Report) => void;
}) {
  const toast = useToast();
  const [counted, setCounted] = useState("");
  const [declared, setDeclared] = useState<Record<"card" | "sbp" | "transfer", string>>({
    card: toRub(shift.totals.expected.card),
    sbp: toRub(shift.totals.expected.sbp),
    transfer: toRub(shift.totals.expected.transfer),
  });
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const countedMinor = counted.trim() === "" ? null : parseRub(counted);
  const variance = countedMinor === null ? null : countedMinor - shift.totals.expected.cash;
  const nonCashOff = (["card", "sbp", "transfer"] as const).filter((method) => parseRub(declared[method]) !== shift.totals.expected[method]);
  const needsReason = (variance !== null && Math.abs(variance) > threshold) || nonCashOff.length > 0;
  const canCancel = me.actor.role === "owner" || shift.closingStartedById === me.actor.userId;
  const ready = countedMinor !== null && countedMinor >= 0 && (!needsReason || reason.trim().length > 0);

  return (
    <div className="cash-grid">
      <div className="panel list">
        <div className="spread">
          <div className="row"><span className="stat-ico"><Lock size={15} /></span><strong>Закрытие смены</strong></div>
          <span className="tag tag-warn">оплаты заблокированы</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>Начал {shift.closingStartedByName} · {when(shift.closingStartedAt)}. Пересчитайте наличные и сверьте безнал с терминалом.</p>
        <div className="close-table">
          <div className="close-head"><span>Способ</span><span>Ожидается</span><span>Факт</span></div>
          <div className="close-line">
            <span>{METHOD_LABEL.cash}</span>
            <span>{formatMoney(shift.totals.expected.cash)}</span>
            <input className="money-input sm" inputMode="decimal" aria-label="Наличные по пересчёту, ₽" placeholder="пересчёт, ₽" value={counted} onChange={(event) => setCounted(event.target.value)} autoFocus />
          </div>
          {(["card", "sbp", "transfer"] as const).map((method) => (
            <div key={method} className="close-line">
              <span>{METHOD_LABEL[method]}</span>
              <span>{formatMoney(shift.totals.expected[method])}</span>
              <input className="money-input sm" inputMode="decimal" aria-label={`${METHOD_LABEL[method]}, ₽`} value={declared[method]} onChange={(event) => setDeclared({ ...declared, [method]: event.target.value })} />
            </div>
          ))}
        </div>
        <div className="spread">
          <span className="muted">Расхождение по наличным</span>
          {variance === null ? <span className="muted">введите пересчёт</span> : <Signed minor={variance} />}
        </div>
        {nonCashOff.length > 0 && (
          <div className="banner">Безнал не сходится: {nonCashOff.map((method) => METHOD_LABEL[method]).join(", ")}. Укажите причину.</div>
        )}
        <div className="field">
          <label htmlFor="variance-reason">Причина расхождения{needsReason ? " · обязательно" : ""}</label>
          <textarea id="variance-reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} aria-required={needsReason} />
        </div>
        <div className="field"><label htmlFor="close-note">Комментарий к смене</label><input id="close-note" value={note} onChange={(event) => setNote(event.target.value)} /></div>
        <div className="row">
          <button
            className="btn"
            type="button"
            disabled={busy || !canCancel}
            title={canCancel ? "" : "Вернуть может тот, кто начал закрытие, или владелец"}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/shifts/${shift.id}/cancel-closing`, { method: "POST" });
                toast("Смена снова открыта");
                onCancelled();
              } catch (err) {
                toast((err as ApiError).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Вернуть в работу
          </button>
          <button
            className="btn-gradient"
            type="button"
            disabled={busy || !ready}
            onClick={async () => {
              setBusy(true);
              try {
                const closed = await api<Report>(`/api/shifts/${shift.id}/close`, {
                  method: "POST",
                  body: JSON.stringify({
                    countedCashMinor: countedMinor,
                    declared: { card: parseRub(declared.card), sbp: parseRub(declared.sbp), transfer: parseRub(declared.transfer) },
                    varianceReason: reason,
                    note,
                  }),
                });
                toast("Смена закрыта");
                onClosed(closed);
              } catch (err) {
                toast((err as ApiError).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Закрыть и сформировать Z-отчёт
          </button>
        </div>
      </div>
      <div className="list">
        <div className="panel"><Breakdown totals={shift.totals} /></div>
        <PaymentsPanel payments={payments} onChanged={onCancelled} />
      </div>
    </div>
  );
}

function HistoryList({ items, onOpen }: { items: Shift[]; onOpen: (id: string) => void }) {
  if (!items.length) return <div className="panel empty">Смен пока не было.</div>;
  return (
    <div className="panel list">
      <div className="history-head"><span>Смена</span><span>Кто</span><span>Приход</span><span>Наличные</span><span>Расхождение</span></div>
      {items.map((item) => (
        <button key={item.id} type="button" className="history-row" onClick={() => onOpen(item.id)}>
          <span>
            <strong>{new Date(item.openedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</strong>
            <small>{new Date(item.openedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}–{item.closedAt ? new Date(item.closedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "…"}</small>
          </span>
          <span className="muted">{item.closedByName ?? item.openedByName}</span>
          <span>{formatMoney(item.totals.incomeMinor - item.totals.refundsMinor)}</span>
          <span>{formatMoney(item.countedCashMinor ?? item.expectedCashMinor)}</span>
          <span>{item.status === "closed" ? <Signed minor={item.varianceMinor ?? 0} /> : <span className="tag tag-warn">{item.status === "open" ? "открыта" : "закрывается"}</span>}</span>
        </button>
      ))}
    </div>
  );
}

function ZReport({ report, onClose, onChanged }: { report: Report; onClose: () => void; onChanged: () => void }) {
  const { shift, payments } = report;
  const declared = useMemo(() => shift.declared ?? {}, [shift.declared]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal zreport" role="dialog" aria-modal="true" aria-label="Z-отчёт" onMouseDown={(event) => event.stopPropagation()}>
        <div className="spread no-print">
          <div className="row"><History size={16} /><span className="page-kicker">Z-отчёт</span></div>
          <div className="row">
            <button className="icon-btn" type="button" onClick={() => window.print()} aria-label="Печать"><Printer size={16} /></button>
            <button className="icon-btn" type="button" onClick={onClose} aria-label="Закрыть">×</button>
          </div>
        </div>
        <h2 className="display" style={{ fontSize: 22 }}>Смена {new Date(shift.openedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</h2>
        <div className="z-section">
          <div className="spread"><span className="muted">Открыта</span><span>{when(shift.openedAt)} · {shift.openedByName}</span></div>
          <div className="spread"><span className="muted">Закрыта</span><span>{shift.closedAt ? `${when(shift.closedAt)} · ${shift.closedByName}` : shift.status === "closing" ? "закрывается" : "открыта"}</span></div>
          <div className="spread"><span className="muted">Наличные на старте</span><span>{formatMoney(shift.openingCashMinor)}</span></div>
        </div>
        <div className="z-section">
          <strong>По способам оплаты</strong>
          {METHODS.map(({ id }) => (
            <div key={id} className="spread">
              <span className="muted">{METHOD_LABEL[id]}</span>
              <span>
                +{formatMoney(shift.totals.byMethod[id].inMinor)}
                {shift.totals.byMethod[id].outMinor ? ` · −${formatMoney(shift.totals.byMethod[id].outMinor)}` : ""}
                {id !== "cash" && declared[id] !== undefined && declared[id] !== shift.totals.expected[id] ? ` · заявлено ${formatMoney(declared[id] ?? 0)}` : ""}
              </span>
            </div>
          ))}
        </div>
        <div className="z-section"><Breakdown totals={shift.totals} /></div>
        <div className="z-section">
          <div className="spread"><span className="muted">Наличные ожидались</span><span>{formatMoney(shift.expectedCashMinor)}</span></div>
          <div className="spread"><span className="muted">Наличные по пересчёту</span><span>{shift.countedCashMinor === null ? "—" : formatMoney(shift.countedCashMinor)}</span></div>
          <div className="spread"><span className="muted">Расхождение</span>{shift.varianceMinor === null ? <span>—</span> : <Signed minor={shift.varianceMinor} />}</div>
          {shift.varianceReason && <div className="muted">Причина: {shift.varianceReason}</div>}
          {shift.closeNote && <div className="muted">Комментарий: {shift.closeNote}</div>}
        </div>
        <div className="z-section list">
          <strong>Платежи · {payments.length}</strong>
          {payments.map((payment) => <PaymentRow key={payment.id} payment={payment} onChanged={onChanged} compact />)}
        </div>
      </div>
    </div>
  );
}

function IncomeModal({ branchId, onClose, onDone }: { branchId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [rub, setRub] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [busy, setBusy] = useState(false);
  const amount = parseRub(rub || "0");
  return (
    <Modal title="Приход без записи" onClose={onClose}>
      <div className="list">
        <div className="field"><label>Что продали</label><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, шампунь" autoFocus /></div>
        <div className="field"><label>Сумма, ₽</label><input inputMode="decimal" value={rub} onChange={(event) => setRub(event.target.value)} /></div>
        <div className="segment">
          {METHODS.map(({ id }) => (
            <button key={id} type="button" className={method === id ? "on" : ""} onClick={() => setMethod(id)}>{METHOD_LABEL[id]}</button>
          ))}
        </div>
        <div className="row">
          <button className="btn" type="button" onClick={onClose}>Отмена</button>
          <button
            className="btn-gradient"
            type="button"
            disabled={busy || amount <= 0}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/payments", {
                  method: "POST",
                  body: JSON.stringify({ branchId, kind: "misc", title, tenders: [{ method, amountMinor: amount }] }),
                });
                toast("Приход проведён");
                onDone();
              } catch (err) {
                toast((err as ApiError).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Провести {amount > 0 ? formatMoney(amount) : ""}
          </button>
        </div>
      </div>
    </Modal>
  );
}
