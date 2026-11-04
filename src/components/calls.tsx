"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PhoneIncoming, PhoneMissed, PhoneOutgoing, X } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { api } from "./api";

type Card = {
  id: string;
  name: string;
  visits: number;
  lastVisit: { at: string; title: string; staff: string } | null;
  nextVisit: { id: string; at: string; title: string; staff: string } | null;
  debtMinor: number;
  alert: string | null;
  note: string;
};
type Live = { id: string; phone: string; phoneE164: string | null; status: string; startedAt: string; client: Card | null };

const when = (iso: string, timeZone?: string) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
const day = (iso: string, timeZone?: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone });

/** TEL-POPUP-01: while the phone rings the desk sees who it is. Polls only when telephony is on. */
export function CallPopup() {
  const router = useRouter();
  const [calls, setCalls] = useState<Live[]>([]);
  const [zone, setZone] = useState<string | undefined>(undefined);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const enabled = useRef(true);

  useEffect(() => {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      try {
        const live = await api<{ enabled: boolean; timezone: string; calls: Live[] }>("/api/calls/live");
        enabled.current = live.enabled;
        setZone(live.timezone);
        setCalls(live.calls);
      } catch {
        // Network blip: try again on the next tick.
      }
      if (!stopped) timer = window.setTimeout(tick, enabled.current && !document.hidden ? 3000 : 60000);
    };
    void tick();
    const wake = () => {
      if (!document.hidden && enabled.current) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  const shown = calls.filter((call) => !hidden.has(call.id));
  if (!shown.length) return null;
  return (
    <div className="call-stack" role="status" aria-live="polite">
      {shown.map((call) => {
        const client = call.client;
        return (
          <div key={call.id} className={`call-card ${call.status}`}>
            <div className="call-head">
              <span className="call-ico"><PhoneIncoming size={16} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <small>{call.status === "ringing" ? "Входящий звонок" : "Идёт разговор"}</small>
                <strong>{client?.name ?? "Новый номер"}</strong>
                <span className="muted">{call.phone}</span>
              </div>
              <button type="button" className="call-close" aria-label="Скрыть" onClick={() => setHidden(new Set([...hidden, call.id]))}><X size={14} /></button>
            </div>
            {client ? (
              <div className="call-facts">
                {client.alert && <div className="call-alert">{client.alert}</div>}
                <div>Визитов: <b>{client.visits}</b>{client.lastVisit ? ` · последний ${day(client.lastVisit.at, zone)}, ${client.lastVisit.title} у ${client.lastVisit.staff}` : ""}</div>
                {client.nextVisit ? <div>Записан: <b>{when(client.nextVisit.at, zone)}</b> · {client.nextVisit.title} · {client.nextVisit.staff}</div> : <div className="muted">Будущих записей нет</div>}
                {client.debtMinor > 0 && <div className="call-debt">Долг {formatMoney(client.debtMinor)}</div>}
                {client.note && <div className="muted">{client.note}</div>}
              </div>
            ) : (
              <div className="call-facts muted">Этого номера нет в базе. Можно сразу завести клиента.</div>
            )}
            <div className="call-actions">
              {client ? (
                <>
                  <button type="button" className="btn" onClick={() => router.push(`/clients?open=${client.id}`)}>Карточка</button>
                  {client.nextVisit && <button type="button" className="btn-ghost" onClick={() => router.push(`/journal?open=${client.nextVisit!.id}`)}>Его запись</button>}
                </>
              ) : (
                <button type="button" className="btn" onClick={() => router.push(`/clients?phone=${encodeURIComponent(call.phoneE164 ?? "")}`)}>Новый клиент</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type Row = { id: string; direction: string; status: string; startedAt: string; durationSec: number | null; recordingUrl: string | null };

/** TEL-LOG-01: calls on the client card. Quiet when there are none. */
export function ClientCalls({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    api<Row[]>(`/api/clients/${clientId}/calls`).then(setRows).catch(() => setRows([]));
  }, [clientId]);
  if (!rows?.length) return null;
  const length = (sec: number | null) => (sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : "");
  return (
    <div className="list">
      <h3 style={{ margin: "6px 0 0" }}>Звонки</h3>
      {rows.map((row) => {
        const Icon = row.status === "missed" ? PhoneMissed : row.direction === "out" ? PhoneOutgoing : PhoneIncoming;
        const label = row.status === "missed" ? "Пропущенный" : row.direction === "out" ? "Исходящий" : "Входящий";
        return (
          <div key={row.id} className={`call-row ${row.status === "missed" ? "missed" : ""}`}>
            <Icon size={14} />
            <span>{label}</span>
            <span className="muted">{when(row.startedAt)}{row.durationSec ? ` · ${length(row.durationSec)}` : ""}</span>
            {row.recordingUrl && <a href={row.recordingUrl} target="_blank" rel="noreferrer">Запись</a>}
          </div>
        );
      })}
    </div>
  );
}
