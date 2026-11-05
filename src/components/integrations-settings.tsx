"use client";

import { useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

type Field = { key: string; label: string; secret: boolean; required: boolean; placeholder: string; options: { value: string; label: string }[] | null; hint: string };
type Integration = {
  provider: string;
  kind: "telegram" | "sms" | "fiscal" | "acquiring" | "voice";
  label: string;
  about: string;
  docsUrl: string;
  fields: Field[];
  values: Record<string, string>;
  connected: boolean;
  enabled: boolean;
  status: "new" | "ok" | "error";
  statusText: string;
  checkedAt: string | null;
  account: string | null;
  webhookUrl: string | null;
};

const GROUPS: { kind: Integration["kind"]; title: string; hint: string }[] = [
  { kind: "telegram", title: "Telegram", hint: "Без своего бота сообщения идут от общего бота платформы, если он настроен." },
  { kind: "sms", title: "SMS", hint: "Для клиентов без Telegram. Работает один шлюз; включение другого выключает первый." },
  { kind: "fiscal", title: "Онлайн-касса (54-ФЗ)", hint: "После подключения выберите кассу в разделе «Чеки и онлайн-оплата» ниже." },
  { kind: "acquiring", title: "Эквайринг: карта и СБП", hint: "Нужен для оплаты по ссылке и предоплаты. Провайдера выбирают в «Чеки и онлайн-оплата»." },
  { kind: "voice", title: "Голос CRM", hint: "Без ключа CRM отвечает голосом браузера. С ключом OpenAI или ElevenLabs отвечает живым голосом." },
];

function Status({ item }: { item: Integration }) {
  if (item.enabled && item.status === "ok") return <span className="tag tag-ok">Включено</span>;
  if (item.status === "error") return <span className="tag tag-bad">Ошибка</span>;
  if (item.connected) return <span className="tag tag-muted">Выключено</span>;
  return <span className="tag tag-muted">Не подключено</span>;
}

/** INT-*: the owner connects providers with their own keys. */
export function IntegrationsSettings() {
  const toast = useToast();
  const [items, setItems] = useState<Integration[] | null>(null);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Integration[]>("/api/integrations").then(setItems).catch(() => setItems([]));
  }, []);

  async function call(path: string, method: string, body: unknown, message: string) {
    setBusy(true);
    try {
      const next = await api<Integration[]>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      setItems(next);
      toast(message);
      return next;
    } catch (error) {
      toast((error as ApiError).message, "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function open(item: Integration) {
    setEditing(item);
    setValues(Object.fromEntries(item.fields.map((field) => [field.key, field.secret ? "" : item.values[field.key] ?? (field.options?.[0]?.value ?? "")])));
  }

  if (!items) return <div className="panel"><div className="skeleton" /></div>;
  if (!items.length) return null;
  return (
    <div className="panel list">
      <div>
        <h2 style={{ margin: 0 }}>Интеграции</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Подключите свои аккаунты: ключи вводите вы, хранятся они зашифрованными и не видны даже администраторам. Перед включением CRM проверяет подключение.
        </span>
      </div>
      {GROUPS.map((group) => (
        <div key={group.kind} className="list" style={{ gap: 8 }}>
          <div>
            <b style={{ fontSize: 14 }}>{group.title}</b>
            <div className="muted" style={{ fontSize: 12 }}>{group.hint}</div>
          </div>
          <div className="integration-grid">
            {items.filter((item) => item.kind === group.kind).map((item) => (
              <div key={item.provider} className={`integration-card ${item.enabled ? "on" : ""}`}>
                <div className="spread">
                  <strong>{item.label}</strong>
                  <Status item={item} />
                </div>
                <span className="muted" style={{ fontSize: 12.5 }}>{item.about}</span>
                {item.statusText && <span className={item.status === "error" ? "integration-error" : "integration-ok"}>{item.account && !item.statusText.includes(item.account) ? `${item.account} · ` : ""}{item.statusText}</span>}
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <button className="btn" disabled={busy} onClick={() => open(item)}>{item.connected ? "Настроить" : "Подключить"}</button>
                  {item.connected && (
                    <button className="btn-ghost" disabled={busy} onClick={() => call(`/api/integrations/${item.provider}`, "PUT", { enabled: !item.enabled }, item.enabled ? "Выключено" : "Включено")}>
                      {item.enabled ? "Выключить" : "Включить"}
                    </button>
                  )}
                  {item.connected && <button className="btn-ghost" disabled={busy} onClick={() => call(`/api/integrations/${item.provider}/check`, "POST", {}, "Проверено")}>Проверить</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {editing && (
        <Modal title={editing.label} onClose={() => setEditing(null)}>
          <form
            className="list"
            onSubmit={async (event) => {
              event.preventDefault();
              const next = await call(`/api/integrations/${editing.provider}`, "PUT", { values, enabled: true }, "Подключено и включено");
              if (next) setEditing(null);
            }}
          >
            <span className="muted" style={{ fontSize: 13 }}>
              {editing.about} <a href={editing.docsUrl} target="_blank" rel="noreferrer">Где взять ключи</a>
            </span>
            {editing.fields.map((field) => (
              <div key={field.key} className="field">
                <label>{field.label}{field.required ? " *" : ""}</label>
                {field.options ? (
                  <select value={values[field.key] ?? ""} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}>
                    {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[field.key] ?? ""}
                    placeholder={field.secret && editing.values[field.key] ? `сохранён ${editing.values[field.key]} — оставьте пустым` : field.placeholder}
                    onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                  />
                )}
                {field.hint && <span className="muted" style={{ fontSize: 12 }}>{field.hint}</span>}
              </div>
            ))}
            {editing.webhookUrl && editing.kind === "acquiring" && (
              <div className="field">
                <label>Адрес для уведомлений (вставьте в кабинете провайдера)</label>
                <div className="row" style={{ gap: 8 }}>
                  <input readOnly value={editing.webhookUrl} onFocus={(event) => event.target.select()} />
                  <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(editing.webhookUrl!).then(() => toast("Скопировано"))}>Копировать</button>
                </div>
              </div>
            )}
            {editing.kind === "telegram" && <span className="muted" style={{ fontSize: 12 }}>Вебхук бота CRM настроит сама. Клиенты, подключённые к общему боту, продолжат получать сообщения от него.</span>}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn-gradient" type="submit" disabled={busy}>{busy ? "Проверяем…" : "Проверить и включить"}</button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={async () => { if (await call(`/api/integrations/${editing.provider}`, "PUT", { values, enabled: false }, "Сохранено, пока выключено")) setEditing(null); }}>
                Сохранить без включения
              </button>
              {editing.connected && (
                <button type="button" className="btn-ghost" disabled={busy} onClick={async () => { if (await call(`/api/integrations/${editing.provider}`, "DELETE", undefined, "Ключи удалены")) setEditing(null); }}>
                  Удалить ключи
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
