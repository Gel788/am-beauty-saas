"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Send } from "lucide-react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Comms = {
  telegramConfigured: boolean;
  consents: { pdAt: string | null; pdSource: string | null; marketing: boolean; marketingAt: string | null };
  telegram: { username: string | null; linkedAt: string } | null;
  messages: { id: string; kind: string; channel: string; body: string; status: string; error: string | null; createdAt: string }[];
};

const KIND: Record<string, string> = {
  reminder: "Напоминание",
  manual: "Сообщение",
  booking_created: "Запись создана",
  booking_cancelled: "Отмена",
  pay_link: "Ссылка на оплату",
};
const SOURCE: Record<string, string> = { online: "в онлайн-записи", desk: "в салоне" };
const CHANNEL: Record<string, string> = { telegram: "Telegram", sms: "SMS", log: "журнал" };

const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** MSG-MANUAL-01 + MSG-CONSENT-01 in the client card. Hidden for roles that cannot see messages. */
export function ClientComms({ clientId }: { clientId: string }) {
  const toast = useToast();
  const [data, setData] = useState<Comms | null>(null);
  const [hidden, setHidden] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");

  const load = useCallback(() => {
    api<Comms>(`/api/clients/${clientId}/messages`)
      .then((value) => { setData(value); setHidden(false); })
      .catch((error: ApiError) => { if (error.code === "FORBIDDEN") setHidden(true); });
  }, [clientId]);
  useEffect(() => { setLink(""); setText(""); load(); }, [load]);

  if (hidden) return null;
  if (!data) return <div className="skeleton" />;

  async function consent(input: { pd?: boolean; marketing?: boolean }) {
    try {
      const consents = await api<Comms["consents"]>(`/api/clients/${clientId}/consents`, { method: "PATCH", body: JSON.stringify(input) });
      setData((current) => (current ? { ...current, consents } : current));
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  async function send() {
    setBusy(true);
    try {
      const result = await api<{ status: string; channel: string; error: string | null }>(`/api/clients/${clientId}/messages`, { method: "POST", body: JSON.stringify({ body: text }) });
      if (result.status === "delivered") toast(result.channel === "log" ? "Записано в журнал: канал отправки не подключён" : `Отправлено в ${CHANNEL[result.channel] ?? result.channel}`);
      else toast(`Не отправлено: ${result.error}`, "error");
      setText("");
      load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function telegramInvite() {
    try {
      const { url } = await api<{ url: string }>(`/api/clients/${clientId}/telegram-link`, { method: "POST", body: "{}" });
      setLink(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      toast("Ссылка скопирована: отправьте её клиенту");
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  const { consents } = data;
  return (
    <div className="list comms">
      <h3 style={{ margin: "6px 0 0" }}>Связь и согласия</h3>
      <div className="consent-box">
        <label className="row">
          <input type="checkbox" checked={Boolean(consents.pdAt)} onChange={(event) => consent({ pd: event.target.checked })} />
          <span>
            Согласие на обработку персональных данных
            <small>{consents.pdAt ? `дано ${day(consents.pdAt)} ${SOURCE[consents.pdSource ?? ""] ?? ""}` : "нет: отметьте, когда клиент подпишет согласие в салоне"}</small>
          </span>
        </label>
        <label className="row">
          <input type="checkbox" disabled={!consents.pdAt} checked={consents.marketing} onChange={(event) => consent({ marketing: event.target.checked })} />
          <span>
            Согласен получать акции и новости
            <small>{consents.marketing && consents.marketingAt ? `с ${day(consents.marketingAt)}` : "рассылки этому клиенту не отправляются"}</small>
          </span>
        </label>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {data.telegram ? (
          <span className="tag tag-ok">Telegram подключён{data.telegram.username ? `: @${data.telegram.username}` : ""}</span>
        ) : (
          <>
            <span className="tag">Telegram не подключён</span>
            {data.telegramConfigured && <button type="button" className="btn-ghost" onClick={telegramInvite}><Copy size={14} /> Ссылка для клиента</button>}
          </>
        )}
      </div>
      {link && <input readOnly value={link} onFocus={(event) => event.target.select()} style={{ fontSize: 12 }} />}
      <div className="composer">
        <textarea rows={2} value={text} maxLength={1000} placeholder="Написать клиенту: уйдёт в Telegram или SMS" onChange={(event) => setText(event.target.value)} />
        <button type="button" className="btn-gradient" disabled={busy || !text.trim()} onClick={send}><Send size={15} /> Отправить</button>
      </div>
      <div className="list" style={{ gap: 6 }}>
        {data.messages.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Сообщений клиенту ещё не было</span>}
        {data.messages.map((message) => (
          <div key={message.id} className={`bubble ${message.status === "failed" ? "failed" : ""}`}>
            <div className="spread">
              <small>{KIND[message.kind] ?? message.kind} · {new Date(message.createdAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
              <small>{message.status === "failed" ? `не дошло${message.error ? `: ${message.error}` : ""}` : CHANNEL[message.channel] ?? message.channel}</small>
            </div>
            <p>{message.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
