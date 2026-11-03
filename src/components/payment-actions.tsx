"use client";

import { useEffect, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

export type PaymentItem = {
  id: string;
  appointmentId: string | null;
  clientId: string | null;
  clientName: string | null;
  shiftId: string | null;
  direction: "in" | "out";
  status: "posted" | "refunded" | "void" | "pending";
  totalMinor: number;
  changeMinor: number;
  refundOfId: string | null;
  refundReason: string | null;
  voidReason: string | null;
  postedAt: string | null;
  createdByName: string;
  lines: { id: string; type: string; title: string; amountMinor: number; refundOfLineId: string | null }[];
  tenders: { method: string; amountMinor: number }[];
  refundedMinor: number;
  refundableMinor: number;
  canRefund: boolean;
  canVoid: boolean;
  receipts?: { id: string; kind: string; status: string }[];
  receiptNo?: string | null;
  terminalRef?: string | null;
};

/** PAY-EXT-02: receipt number from the salon's own kassa and the terminal code, editable after the fact. */
function ExternalRefs({ payment, onChanged }: { payment: PaymentItem; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [receiptNo, setReceiptNo] = useState(payment.receiptNo ?? "");
  const [terminalRef, setTerminalRef] = useState(payment.terminalRef ?? "");
  if (!editing) {
    return (
      <div className="spread" style={{ fontSize: 13 }}>
        <span className="muted">
          {payment.receiptNo ? `Чек с кассы № ${payment.receiptNo}` : "Номер чека не указан"}
          {payment.terminalRef ? ` · терминал ${payment.terminalRef}` : ""}
        </span>
        <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>{payment.receiptNo || payment.terminalRef ? "Изменить" : "Указать"}</button>
      </div>
    );
  }
  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <input aria-label="Номер чека" placeholder="Номер чека" value={receiptNo} onChange={(event) => setReceiptNo(event.target.value)} style={{ width: 120 }} />
      <input aria-label="Код операции терминала" placeholder="Код терминала" value={terminalRef} onChange={(event) => setTerminalRef(event.target.value)} style={{ width: 160 }} />
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await api(`/api/payments/${payment.id}/refs`, { method: "PATCH", body: JSON.stringify({ receiptNo, terminalRef }) });
            setEditing(false);
            onChanged();
          } catch (error) {
            toast((error as ApiError).message, "error");
          }
        }}
      >
        Сохранить
      </button>
    </div>
  );
}

type ReceiptDetail = {
  id: string;
  kind: "sell" | "sell_refund";
  status: "pending" | "sent" | "done" | "failed" | "canceled";
  totalMinor: number;
  fnNumber: string | null;
  fdNumber: string | null;
  fiscalSign: string | null;
  registeredAt: string | null;
  ofdUrl: string | null;
  error: string | null;
  provider: string;
  items: { name: string; sumMinor: number; paymentMethod: string }[];
  payments: { type: string; sumMinor: number }[];
};

const RECEIPT_STATUS: Record<string, [string, string]> = {
  pending: ["чек в очереди", "tag-muted"],
  sent: ["чек отправлен", "tag-muted"],
  done: ["чек ✓", "tag-ok"],
  failed: ["чек: ошибка", "tag-bad"],
  canceled: ["чек отменён", "tag-muted"],
};
const RECEIPT_PAYMENT: Record<string, string> = { cash: "Наличными", electronic: "Безналичными", prepaid: "Зачёт предоплаты" };

/** The receipt that matters for the row: the reversal if any, otherwise the sale. */
function mainReceipt(payment: PaymentItem) {
  const list = payment.receipts ?? [];
  return list.find((receipt) => receipt.status === "failed") ?? list[list.length - 1] ?? null;
}

function ReceiptBlock({ paymentId, onChanged }: { paymentId: string; onChanged: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<ReceiptDetail[] | null>(null);
  const load = () => api<ReceiptDetail[]>(`/api/fiscal/receipts?paymentId=${paymentId}`).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentId]);
  if (!rows?.length) return null;
  return (
    <div className="list" style={{ gap: 4, marginTop: 6, paddingTop: 6, borderTop: "1px dashed var(--line)" }}>
      {rows.map((receipt) => (
        <div key={receipt.id} className="list" style={{ gap: 2 }}>
          <div className="spread">
            <b style={{ fontSize: 13 }}>{receipt.kind === "sell" ? "Кассовый чек, приход" : "Кассовый чек, возврат прихода"}</b>
            <span className={`tag ${RECEIPT_STATUS[receipt.status][1]}`}>{RECEIPT_STATUS[receipt.status][0]}</span>
          </div>
          {receipt.items.map((item, index) => (
            <div key={index} className="spread" style={{ fontSize: 12 }}><span className="muted">{item.name}{item.paymentMethod === "advance" ? " (аванс)" : ""}</span><span>{formatMoney(item.sumMinor)}</span></div>
          ))}
          {receipt.payments.map((item, index) => (
            <div key={index} className="spread" style={{ fontSize: 12 }}><span className="muted">{RECEIPT_PAYMENT[item.type] ?? item.type}</span><span>{formatMoney(item.sumMinor)}</span></div>
          ))}
          {receipt.status === "done" && (
            <span className="muted" style={{ fontSize: 12 }}>
              ФН {receipt.fnNumber} · ФД {receipt.fdNumber} · ФП {receipt.fiscalSign}
              {receipt.provider === "test" ? " · тестовая касса" : ""}
            </span>
          )}
          {receipt.error && <span className="muted" style={{ fontSize: 12, color: "var(--bad, #b42318)" }}>{receipt.error}</span>}
          {receipt.status === "failed" && (
            <button
              type="button"
              className="btn"
              style={{ alignSelf: "flex-start" }}
              onClick={async () => {
                try {
                  await api(`/api/fiscal/receipts/${receipt.id}/retry`, { method: "POST" });
                  toast("Чек отправлен повторно");
                  setTimeout(() => { load(); onChanged(); }, 800);
                } catch (error) {
                  toast((error as ApiError).message, "error");
                }
              }}
            >
              Повторить чек
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export const METHOD_LABEL: Record<string, string> = {
  cash: "Наличные",
  card: "Карта",
  sbp: "СБП",
  transfer: "Перевод",
  bonus: "Бонусы",
  certificate: "Сертификат",
  membership: "Абонемент",
};

const LINE_LABEL: Record<string, string> = {
  service: "Услуга",
  deposit: "Предоплата",
  product: "Товар",
  tip: "Чаевые",
  debt: "Погашение долга",
};

function time(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function kind(payment: PaymentItem) {
  if (payment.direction === "out") return "Возврат";
  const types = new Set(payment.lines.map((line) => line.type));
  if (types.has("debt")) return "Погашение долга";
  if (types.has("deposit")) return "Предоплата";
  if (types.has("service")) return "Оплата визита";
  if (types.has("tip") && types.size === 1) return "Чаевые";
  return payment.lines[0]?.title || "Приход";
}

export function PaymentRow({ payment, onChanged, compact = false }: { payment: PaymentItem; onChanged: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"refund" | "void" | null>(null);
  const out = payment.direction === "out";
  const tag =
    payment.status === "void" ? <span className="tag tag-muted">аннулирован</span> :
    payment.status === "refunded" ? <span className="tag tag-warn">возвращён</span> :
    payment.refundedMinor > 0 ? <span className="tag tag-warn">возврат {formatMoney(payment.refundedMinor)}</span> :
    null;
  const receipt = mainReceipt(payment);
  return (
    <div className={`pay-row ${payment.status === "void" ? "is-void" : ""}`}>
      <button type="button" className="pay-main" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`pay-dir ${out ? "out" : "in"}`} aria-hidden>{out ? "↩" : "↓"}</span>
        <span className="pay-who">
          <strong>{payment.clientName || (compact ? kind(payment) : "Без клиента")}</strong>
          <span>
            {compact ? time(payment.postedAt) : `${kind(payment)} · ${time(payment.postedAt)}`}
            {" · "}
            {payment.tenders.map((tender) => METHOD_LABEL[tender.method] ?? tender.method).join(" + ")}
          </span>
        </span>
        {tag}
        {receipt && payment.status !== "void" && <span className={`tag receipt-chip ${RECEIPT_STATUS[receipt.status]?.[1] ?? ""}`}>{RECEIPT_STATUS[receipt.status]?.[0]}</span>}
        {!receipt && payment.receiptNo && payment.status !== "void" && <span className="tag receipt-chip tag-muted">чек № {payment.receiptNo}</span>}
        <b className={`pay-sum ${out ? "out" : ""}`}>{out ? "−" : ""}{formatMoney(payment.totalMinor)}</b>
      </button>
      {open && (
        <div className="pay-detail">
          {payment.lines.map((line) => (
            <div key={line.id} className="spread"><span className="muted">{LINE_LABEL[line.type] ?? line.type} · {line.title}</span><span>{formatMoney(line.amountMinor)}</span></div>
          ))}
          {payment.tenders.map((tender, index) => (
            <div key={index} className="spread"><span className="muted">{METHOD_LABEL[tender.method] ?? tender.method}</span><span>{formatMoney(tender.amountMinor)}</span></div>
          ))}
          {payment.changeMinor > 0 && <div className="spread"><span className="muted">Сдача</span><span>{formatMoney(payment.changeMinor)}</span></div>}
          {payment.refundReason && <div className="muted">Причина возврата: {payment.refundReason}</div>}
          {payment.voidReason && <div className="muted">Аннулирован: {payment.voidReason}</div>}
          <div className="muted">Провёл: {payment.createdByName}{!payment.shiftId && payment.direction === "in" ? " · онлайн-оплата, вне смены" : ""}</div>
          {(payment.receipts?.length ?? 0) > 0 ? (
            <ReceiptBlock paymentId={payment.id} onChanged={onChanged} />
          ) : (
            payment.status !== "void" && <ExternalRefs payment={payment} onChanged={onChanged} />
          )}
          {(payment.canRefund || payment.canVoid) && (
            <div className="row" style={{ marginTop: 6 }}>
              {payment.canRefund && <button type="button" className="btn" onClick={() => setMode("refund")}>Возврат</button>}
              {payment.canVoid && <button type="button" className="btn danger" onClick={() => setMode("void")}>Аннулировать</button>}
            </div>
          )}
          {!payment.canRefund && payment.direction === "in" && payment.status === "posted" && payment.refundableMinor > 0 && (
            <div className="muted">Для возврата откройте смену.</div>
          )}
        </div>
      )}
      {mode === "refund" && <RefundModal payment={payment} onClose={() => setMode(null)} onDone={() => { setMode(null); onChanged(); }} />}
      {mode === "void" && <VoidModal payment={payment} onClose={() => setMode(null)} onDone={() => { setMode(null); onChanged(); }} />}
    </div>
  );
}

export function RefundModal({ payment, onClose, onDone }: { payment: PaymentItem; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [rub, setRub] = useState(String(payment.refundableMinor / 100));
  const [method, setMethod] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const amount = rublesToMinor(Number(rub.replace(",", ".")));
  const methods = [...new Set(payment.tenders.map((tender) => tender.method))];
  const tooMuch = amount > payment.refundableMinor;
  return (
    <Modal title="Возврат" onClose={onClose}>
      <div className="list">
        <div className="muted">{payment.clientName || "Без клиента"} · можно вернуть до {formatMoney(payment.refundableMinor)}</div>
        <div className="field">
          <label>Сумма, ₽</label>
          <input inputMode="decimal" value={rub} onChange={(event) => setRub(event.target.value)} aria-invalid={tooMuch} />
          {tooMuch && <span className="danger" style={{ fontSize: 12 }}>Больше, чем осталось по платежу</span>}
        </div>
        {methods.length > 1 && (
          <div className="field">
            <label>Куда вернуть</label>
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              <option value="">Как платили</option>
              {methods.map((item) => <option key={item} value={item}>{METHOD_LABEL[item] ?? item}</option>)}
            </select>
          </div>
        )}
        <div className="field"><label>Причина</label><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Например, жалоба клиента" /></div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Возврат проводится в текущей смене. Сначала возвращается услуга, чаевые — последними.</p>
        <div className="row">
          <button className="btn" type="button" onClick={onClose}>Отмена</button>
          <button
            className="btn-gradient"
            type="button"
            disabled={busy || amount <= 0 || tooMuch}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/payments/${payment.id}/refund`, {
                  method: "POST",
                  body: JSON.stringify({ amountMinor: amount, method: method || undefined, reason }),
                });
                toast(`Возврат ${formatMoney(amount)} проведён`);
                onDone();
              } catch (error) {
                toast((error as ApiError).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Вернуть {amount > 0 ? formatMoney(amount) : ""}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function VoidModal({ payment, onClose, onDone }: { payment: PaymentItem; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Аннулировать оплату?" onClose={onClose}>
      <div className="list">
        <p style={{ margin: 0 }}>
          Платёж {formatMoney(payment.totalMinor)} наличными исчезнет из кассы смены. Действие необратимо и попадёт в журнал аудита.
        </p>
        <div className="field"><label>Причина</label><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Например, провели дважды" autoFocus /></div>
        <div className="row">
          <button className="btn" type="button" onClick={onClose}>Отмена</button>
          <button
            className="btn-gradient"
            type="button"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/api/payments/${payment.id}/void`, { method: "POST", body: JSON.stringify({ reason }) });
                toast("Оплата аннулирована");
                onDone();
              } catch (error) {
                toast((error as ApiError).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Аннулировать
          </button>
        </div>
      </div>
    </Modal>
  );
}
