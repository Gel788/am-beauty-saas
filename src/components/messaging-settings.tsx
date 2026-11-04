"use client";

import { useEffect, useMemo, useState } from "react";
import { Send } from "lucide-react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type BranchPart = { id: string; reminderEnabled: boolean; reminderHours: number; bookingMessageEnabled: boolean; tenantSlug: string | null; slug: string };
type Template = { key: string; label: string; body: string; custom: boolean; defaultBody: string };
type Settings = {
  channels: { name: string; label: string; available: boolean; hint: string }[];
  order: string[];
  legalName: string;
  legalInn: string;
  privacyEmail: string;
  templates: Template[];
  placeholders: string[];
  telegram: { configured: boolean; bot: string | null; selfLinked: boolean; selfUsername: string | null };
};
type Message = { id: string; channel: string; recipient: string; body: string; status: string; error: string | null; createdAt: string; clientName: string | null };

const SAMPLE: Record<string, string> = {
  имя: "Анна",
  салон: "AM Beauty",
  адрес: ", Садовая 12",
  когда: "четверг, 6 ноября, 14:00",
  услуги: "Маникюр с покрытием",
  мастер: "Алина",
  сумма: "2 500 ₽",
  ссылка: "https://am.beauty/booking/…",
};
const CHANNEL_LABEL: Record<string, string> = { telegram: "Telegram", sms: "SMS", log: "журнал" };

export function preview(body: string) {
  return body
    .replace(/\{([а-яё]+)\}/gi, (match, key: string) => SAMPLE[key.toLowerCase()] ?? match)
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** MSG-SET-01: channels, the branch's automatic messages, templates, staff Telegram, 152-ФЗ operator. */
export function MessagingSettings<B extends BranchPart>({ branch, role, onSaved }: { branch: B; role: string; onSaved: (branch: B) => void }) {
  const toast = useToast();
  const owner = role === "owner" || role === "super";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [legal, setLegal] = useState({ legalName: "", legalInn: "", privacyEmail: "" });
  const [auto, setAuto] = useState({ reminderEnabled: branch.reminderEnabled, reminderHours: branch.reminderHours, bookingMessageEnabled: branch.bookingMessageEnabled });
  const [messages, setMessages] = useState<Message[] | null>(null);

  useEffect(() => {
    api<Settings>("/api/messaging")
      .then((data) => {
        setSettings(data);
        setOrder(data.order);
        setLegal({ legalName: data.legalName, legalInn: data.legalInn, privacyEmail: data.privacyEmail });
      })
      .catch((error: ApiError) => toast(error.message, "error"));
  }, [toast]);
  useEffect(() => {
    setAuto({ reminderEnabled: branch.reminderEnabled, reminderHours: branch.reminderHours, bookingMessageEnabled: branch.bookingMessageEnabled });
  }, [branch]);
  useEffect(() => {
    api<Message[]>(`/api/messages?branchId=${branch.id}`).then(setMessages).catch(() => setMessages([]));
  }, [branch.id]);

  if (!settings) return <div className="panel"><div className="skeleton" /></div>;

  const route = order.map((name) => CHANNEL_LABEL[name] ?? name).join(" → ");
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function saveChannels() {
    try {
      const saved = await api<Settings>("/api/messaging", { method: "PATCH", body: JSON.stringify({ order, ...legal }) });
      setSettings(saved);
      setOrder(saved.order);
      toast("Каналы сохранены");
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  async function saveAuto() {
    try {
      onSaved(await api<B>(`/api/branches/${branch.id}`, { method: "PATCH", body: JSON.stringify(auto) }));
      toast("Сохранено");
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  async function linkSelf() {
    try {
      const { url } = await api<{ url: string }>("/api/me/telegram-link", { method: "POST", body: "{}" });
      window.open(url, "_blank", "noopener");
      toast("Откройте бота и нажмите «Старт»");
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  async function unlinkSelf() {
    setSettings(await api<Settings>("/api/me/telegram-link", { method: "DELETE" }));
  }

  function toggle(name: string, on: boolean) {
    if (on) setOrder([...order.filter((item) => item !== name), name].sort((a, b) => settings!.channels.findIndex((c) => c.name === a) - settings!.channels.findIndex((c) => c.name === b)));
    else setOrder(order.filter((item) => item !== name));
  }

  return (
    <>
      <section className="panel list">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Сообщения клиентам</h2>
          <span className="muted" style={{ fontSize: 13 }}>Порядок: {route || "не выбран"}</span>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          Каждое сообщение пробуем по порядку: если у клиента нет Telegram, уходит SMS. Всё, что отправлено или не дошло, видно в журнале ниже и в карточке клиента.
        </span>
        <div className="channel-grid">
          {settings.channels.map((item) => (
            <label key={item.name} className={`channel-card ${order.includes(item.name) ? "on" : ""} ${item.available ? "" : "off"}`}>
              <input type="checkbox" disabled={!owner || !item.available} checked={order.includes(item.name)} onChange={(event) => toggle(item.name, event.target.checked)} />
              <span>
                <b>{item.label}</b>
                <small>{item.available ? item.hint : `Не подключён: ${item.hint}`}</small>
              </span>
            </label>
          ))}
        </div>
        {owner && <button className="btn" type="button" onClick={saveChannels}>Сохранить каналы</button>}

        <h3 className="sub-h">Что отправлять автоматически</h3>
        <label className="row"><input type="checkbox" checked={auto.bookingMessageEnabled} onChange={(event) => setAuto({ ...auto, bookingMessageEnabled: event.target.checked })} /> Подтверждение онлайн-записи и отмены</label>
        <label className="row"><input type="checkbox" checked={auto.reminderEnabled} onChange={(event) => setAuto({ ...auto, reminderEnabled: event.target.checked })} /> Напоминание о визите с кнопками «Подтверждаю» / «Отменить»</label>
        <div className="field" style={{ maxWidth: 260 }}>
          <label>За сколько часов до визита</label>
          <input type="number" min={1} max={168} value={auto.reminderHours} onChange={(event) => setAuto({ ...auto, reminderHours: Number(event.target.value) })} />
        </div>
        <span className="muted" style={{ fontSize: 12 }}>С 22:00 до 09:00 по времени филиала напоминания не уходят и ждут утра.</span>
        <button className="btn-gradient" type="button" onClick={saveAuto}>Сохранить</button>
      </section>

      <section className="panel list">
        <h2 style={{ margin: 0 }}>Тексты сообщений</h2>
        <span className="muted" style={{ fontSize: 13 }}>Подстановки заменяются данными записи. Справа видно, как сообщение увидит клиент.</span>
        {settings.templates.map((template) => (
          <TemplateEditor
            key={template.key}
            template={template}
            placeholders={settings.placeholders}
            onSaved={(saved) => setSettings({ ...settings, templates: settings.templates.map((item) => (item.key === saved.key ? saved : item)) })}
          />
        ))}
      </section>

      <section className="panel list">
        <h2 style={{ margin: 0 }}>Мои уведомления в Telegram</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Онлайн-записи, подтверждения, отмены, оплаты по ссылке и непробитые чеки приходят в колокольчик слева. Подключите Telegram, чтобы получать их и на телефон.
        </span>
        {!settings.telegram.configured && <span className="tag tag-warn" style={{ alignSelf: "flex-start" }}>Бот не настроен на сервере: задайте TELEGRAM_BOT_TOKEN</span>}
        {settings.telegram.configured && settings.telegram.selfLinked && (
          <div className="row" style={{ gap: 10 }}>
            <span className="tag tag-ok">Подключено{settings.telegram.selfUsername ? `: @${settings.telegram.selfUsername}` : ""}</span>
            <button className="btn-ghost" type="button" onClick={unlinkSelf}>Отключить</button>
          </div>
        )}
        {settings.telegram.configured && !settings.telegram.selfLinked && (
          <button className="btn" type="button" style={{ alignSelf: "flex-start" }} onClick={linkSelf}><Send size={15} /> Подключить @{settings.telegram.bot}</button>
        )}
      </section>

      <section className="panel list">
        <h2 style={{ margin: 0 }}>Персональные данные (152-ФЗ)</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Онлайн-запись просит согласие на обработку данных и отдельно согласие на акции. Реквизиты ниже попадут в политику:{" "}
          {branch.tenantSlug && <a href={`${origin}/b/${branch.tenantSlug}/${branch.slug}/privacy`} target="_blank" rel="noreferrer">открыть политику</a>}
        </span>
        <div className="form-grid">
          <div className="field"><label>Оператор (ИП или ООО)</label><input disabled={!owner} value={legal.legalName} placeholder="ИП Иванова Ольга Андреевна" onChange={(event) => setLegal({ ...legal, legalName: event.target.value })} /></div>
          <div className="field"><label>ИНН</label><input disabled={!owner} value={legal.legalInn} inputMode="numeric" onChange={(event) => setLegal({ ...legal, legalInn: event.target.value })} /></div>
          <div className="field"><label>Email для запросов по данным</label><input disabled={!owner} value={legal.privacyEmail} type="email" onChange={(event) => setLegal({ ...legal, privacyEmail: event.target.value })} /></div>
        </div>
        {owner && <button className="btn" type="button" style={{ alignSelf: "flex-start" }} onClick={saveChannels}>Сохранить реквизиты</button>}
      </section>

      <section className="panel list">
        <h2 style={{ margin: 0 }}>Журнал сообщений</h2>
        {!messages && <div className="skeleton" />}
        {messages?.length === 0 && <span className="muted">Сообщений пока не было</span>}
        {messages?.map((message) => (
          <div key={message.id} className="list" style={{ gap: 2, paddingBottom: 8, borderBottom: "1px solid var(--line)" }}>
            <div className="spread">
              <b>{message.clientName ?? message.recipient}</b>
              <span className={`tag ${message.status === "delivered" ? "tag-ok" : "tag-bad"}`}>
                {message.status === "delivered" ? (message.channel === "log" ? "в журнале" : CHANNEL_LABEL[message.channel] ?? message.channel) : "не отправлено"}
              </span>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              {new Date(message.createdAt).toLocaleString("ru-RU")} · {message.recipient}{message.error ? ` · ${message.error}` : ""}
            </span>
            <span style={{ fontSize: 13 }}>{message.body}</span>
          </div>
        ))}
      </section>
    </>
  );
}

function TemplateEditor({ template, placeholders, onSaved }: { template: Template; placeholders: string[]; onSaved: (template: Template) => void }) {
  const toast = useToast();
  const [body, setBody] = useState(template.body);
  useEffect(() => setBody(template.body), [template.body]);
  const shown = useMemo(() => preview(body), [body]);
  async function save(next: string | null) {
    try {
      const saved = await api<Template>(`/api/messaging/templates/${template.key}`, { method: "PUT", body: JSON.stringify({ body: next }) });
      onSaved(saved);
      toast("Шаблон сохранён");
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  return (
    <div className="template-row">
      <div className="list" style={{ gap: 6 }}>
        <div className="spread">
          <b style={{ fontSize: 14 }}>{template.label}</b>
          {template.custom && <span className="tag">свой текст</span>}
        </div>
        <textarea rows={3} value={body} maxLength={1000} onChange={(event) => setBody(event.target.value)} />
        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
          {placeholders.map((token) => (
            <button key={token} type="button" className="chip" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => setBody(`${body}${body.endsWith(" ") || !body ? "" : " "}${token}`)}>{token}</button>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" type="button" disabled={body === template.body} onClick={() => save(body)}>Сохранить</button>
          {template.custom && <button className="btn-ghost" type="button" onClick={() => save(null)}>Вернуть стандартный</button>}
        </div>
      </div>
      <div className="sms-preview">
        <small>Так увидит клиент · {shown.length} симв.</small>
        <p>{shown}</p>
      </div>
    </div>
  );
}
