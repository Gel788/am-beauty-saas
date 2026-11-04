"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Webhook } from "lucide-react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Key = { id: string; name: string; prefix: string; scope: "read" | "write"; branchId: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type Hook = { id: string; url: string; events: string[]; active: boolean; lastStatus: number | null; lastError: string | null; lastDeliveryAt: string | null; failures: number };
type Branch = { id: string; name: string };

const when = (value: string | null) => (value ? new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "ещё не было");

/** API-KEY-01 + API-HOOK-01: keys and webhooks for the salon's own integrations. Owner only. */
export function ApiSettings() {
  const toast = useToast();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [events, setEvents] = useState<{ event: string; label: string }[]>([]);
  const [keyForm, setKeyForm] = useState({ name: "", scope: "read", branchId: "" });
  const [hookForm, setHookForm] = useState({ url: "", events: ["appointment.created", "appointment.cancelled"] as string[] });
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  useEffect(() => {
    api<Branch[]>("/api/branches").then(setBranches).catch(() => undefined);
    api<Key[]>("/api/api-keys").then(setKeys).catch(() => undefined);
    api<{ events: { event: string; label: string }[]; webhooks: Hook[] }>("/api/api-webhooks").then((data) => { setEvents(data.events); setHooks(data.webhooks); }).catch(() => undefined);
  }, []);

  const fail = (error: unknown) => toast((error as ApiError).message, "error");
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast("Скопировано");
    } catch {
      toast("Не получилось скопировать, выделите вручную", "error");
    }
  };

  return (
    <div className="panel list" id="api">
      <div className="spread">
        <h2 style={{ margin: 0 }}>API и вебхуки</h2>
        <a className="btn" href="/developers" target="_blank" rel="noreferrer">Документация</a>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>Для своего сайта, 1С, Zapier и других систем: читать и создавать записи, клиентов, услуги. Ключ даёт права администратора, храните его как пароль.</span>

      {secret && (
        <div className="secret-once">
          <b>{secret.title}</b>
          <span className="muted">Покажем один раз. Сохраните его сейчас.</span>
          <div className="row"><code>{secret.value}</code><button type="button" className="btn" onClick={() => copy(secret.value)}><Copy size={14} /> Копировать</button><button type="button" className="btn" onClick={() => setSecret(null)}>Сохранил</button></div>
        </div>
      )}

      <h3 style={{ margin: "6px 0 0", display: "flex", gap: 6, alignItems: "center" }}><KeyRound size={16} /> Ключи</h3>
      {keys.map((key) => (
        <div key={key.id} className={`branch-card ${key.revokedAt ? "revoked" : ""}`}>
          <div>
            <b>{key.name} <span className="chip">{key.scope === "write" ? "чтение и запись" : "только чтение"}</span>{key.branchId && <span className="chip">{branches.find((b) => b.id === key.branchId)?.name ?? "филиал"}</span>}</b>
            <small className="muted"><code>{key.prefix}…</code> · {key.revokedAt ? `отозван ${when(key.revokedAt)}` : `последний запрос: ${when(key.lastUsedAt)}`}</small>
          </div>
          {!key.revokedAt && (
            <button type="button" className="btn" onClick={async () => {
              try {
                await api(`/api/api-keys/${key.id}`, { method: "DELETE" });
                setKeys(keys.map((item) => (item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item)));
                toast("Ключ отозван");
              } catch (error) { fail(error); }
            }}>Отозвать</button>
          )}
        </div>
      ))}
      <form className="row" style={{ flexWrap: "wrap", gap: 8 }} onSubmit={async (event) => {
        event.preventDefault();
        try {
          const created = await api<Key & { key: string }>("/api/api-keys", { method: "POST", body: JSON.stringify({ ...keyForm, branchId: keyForm.branchId || null }) });
          setKeys([created, ...keys]);
          setSecret({ title: `Ключ «${created.name}»`, value: created.key });
          setKeyForm({ ...keyForm, name: "" });
        } catch (error) { fail(error); }
      }}>
        <input placeholder="Название: Сайт, 1С…" value={keyForm.name} onChange={(event) => setKeyForm({ ...keyForm, name: event.target.value })} required style={{ flex: 1, minWidth: 180 }} />
        <select value={keyForm.scope} onChange={(event) => setKeyForm({ ...keyForm, scope: event.target.value })}>
          <option value="read">Только чтение</option>
          <option value="write">Чтение и запись</option>
        </select>
        {branches.length > 1 && (
          <select value={keyForm.branchId} onChange={(event) => setKeyForm({ ...keyForm, branchId: event.target.value })}>
            <option value="">Все филиалы</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        )}
        <button className="btn-gradient" type="submit">Выдать ключ</button>
      </form>

      <h3 style={{ margin: "10px 0 0", display: "flex", gap: 6, alignItems: "center" }}><Webhook size={16} /> Вебхуки</h3>
      <span className="muted" style={{ fontSize: 12 }}>CRM отправит POST на ваш адрес, когда что-то произойдёт. В теле только идентификаторы, подробности читайте через API. Подпись: заголовок X-AmBeauty-Signature.</span>
      {hooks.map((hook) => (
        <div key={hook.id} className="branch-card">
          <div>
            <b style={{ wordBreak: "break-all" }}>{hook.url}</b>
            <small className="muted">{hook.events.map((item) => events.find((e) => e.event === item)?.label ?? item).join(", ")}</small>
            <small className={hook.lastError ? "delta down" : "muted"}>{hook.lastDeliveryAt ? `${when(hook.lastDeliveryAt)}: ${hook.lastError ?? `ответ ${hook.lastStatus}`}` : "отправок ещё не было"}</small>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn" onClick={async () => {
              try {
                const result = await api<{ ok: boolean; status: number | null; error: string | null }>(`/api/api-webhooks/${hook.id}/ping`, { method: "POST" });
                setHooks(hooks.map((item) => (item.id === hook.id ? { ...item, lastStatus: result.status, lastError: result.ok ? null : result.error, lastDeliveryAt: new Date().toISOString() } : item)));
                toast(result.ok ? `Получатель ответил ${result.status}` : `Не дошло: ${result.error}`, result.ok ? undefined : "error");
              } catch (error) { fail(error); }
            }}>Проверить</button>
            <button type="button" className="btn" onClick={async () => {
              try {
                await api(`/api/api-webhooks/${hook.id}`, { method: "DELETE" });
                setHooks(hooks.filter((item) => item.id !== hook.id));
              } catch (error) { fail(error); }
            }}>Удалить</button>
          </div>
        </div>
      ))}
      <form className="list" style={{ gap: 8 }} onSubmit={async (event) => {
        event.preventDefault();
        try {
          const created = await api<Hook & { secret: string }>("/api/api-webhooks", { method: "POST", body: JSON.stringify(hookForm) });
          setHooks([...hooks, created]);
          setSecret({ title: "Секрет подписи вебхука", value: created.secret });
          setHookForm({ ...hookForm, url: "" });
        } catch (error) { fail(error); }
      }}>
        <input placeholder="https://your-site.ru/ambeauty-hook" value={hookForm.url} onChange={(event) => setHookForm({ ...hookForm, url: event.target.value })} required />
        <div className="chip-row">
          {events.map((item) => (
            <button key={item.event} type="button" className={`chip ${hookForm.events.includes(item.event) ? "on" : ""}`} onClick={() => setHookForm({ ...hookForm, events: hookForm.events.includes(item.event) ? hookForm.events.filter((e) => e !== item.event) : [...hookForm.events, item.event] })}>{item.label}</button>
          ))}
        </div>
        <button className="btn" type="submit" style={{ alignSelf: "flex-start" }}>Добавить вебхук</button>
      </form>
    </div>
  );
}
