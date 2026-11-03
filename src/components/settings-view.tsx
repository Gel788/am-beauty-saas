"use client";

import { useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Branch = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  requireOpenShift: boolean;
  masterSeesAllColumns: boolean;
  masterCanCreateOwn: boolean;
  masterCanDragOwn: boolean;
  masterCanCancelOwnFuture: boolean;
  arrivalWindowHours: number;
  noShowGraceMin: number;
  gridLabelMin: number;
  requirePaymentOnComplete: boolean;
  shiftVarianceThresholdMinor: number;
  tenantSlug: string | null;
  slug: string;
  onlineEnabled: boolean;
  onlineStepMin: number;
  onlineMinNoticeMin: number;
  onlineMaxAdvanceDays: number;
  onlineHoldMin: number;
  onlineCancelHours: number;
  onlineMaxActivePerPhone: number;
  onlineAccent: string;
  reminderEnabled: boolean;
  reminderHours: number;
  consumePolicy: "warn" | "block";
  allowNegativeStock: boolean;
};

export function SettingsView() {
  const toast = useToast();
  const [branch, setBranch] = useState<Branch | null>(null);
  useEffect(() => {
    api<{ branches: Branch[] }>("/api/auth/me").then((me) => setBranch(me.branches[0] ?? null)).catch((error: ApiError) => toast(error.message, "error"));
  }, [toast]);
  if (!branch) return <div className="skeleton" />;
  const set = <K extends keyof Branch>(key: K, value: Branch[K]) => setBranch({ ...branch, [key]: value });
  return (
    <>
      <div><div className="page-kicker">Филиал</div><h1>Настройки</h1></div>
      <form className="panel list" onSubmit={async (event) => {
        event.preventDefault();
        try {
          const saved = await api<Branch>(`/api/branches/${branch.id}`, { method: "PATCH", body: JSON.stringify(branch) });
          setBranch(saved);
          toast("Сохранено");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}>
        <div className="field"><label>Название</label><input value={branch.name} onChange={(event) => set("name", event.target.value)} /></div>
        <div className="field"><label>Адрес</label><input value={branch.address} onChange={(event) => set("address", event.target.value)} /></div>
        <div className="field"><label>Часовой пояс</label><input value={branch.timezone} onChange={(event) => set("timezone", event.target.value)} /></div>
        <label className="row"><input type="checkbox" checked={branch.requireOpenShift} onChange={(event) => set("requireOpenShift", event.target.checked)} /> Требовать открытую смену для оплаты</label>
        <label className="row"><input type="checkbox" checked={branch.masterSeesAllColumns} onChange={(event) => set("masterSeesAllColumns", event.target.checked)} /> Мастер видит все колонки</label>
        <label className="row"><input type="checkbox" checked={branch.masterCanCreateOwn} onChange={(event) => set("masterCanCreateOwn", event.target.checked)} /> Мастер создаёт свои записи</label>
        <label className="row"><input type="checkbox" checked={branch.masterCanDragOwn} onChange={(event) => set("masterCanDragOwn", event.target.checked)} /> Мастер перетаскивает свои записи</label>
        <label className="row"><input type="checkbox" checked={branch.requirePaymentOnComplete} onChange={(event) => set("requirePaymentOnComplete", event.target.checked)} /> Предлагать оплату при завершении</label>
        <div className="field"><label>Окно «пришёл», часы</label><input type="number" value={branch.arrivalWindowHours} onChange={(event) => set("arrivalWindowHours", Number(event.target.value))} /></div>
        <div className="field">
          <label>Допустимое расхождение при закрытии смены, ₽</label>
          <input type="number" min={0} step="0.01" value={branch.shiftVarianceThresholdMinor / 100} onChange={(event) => set("shiftVarianceThresholdMinor", Math.max(0, Math.round(Number(event.target.value) * 100)))} />
          <span className="muted" style={{ fontSize: 12 }}>Если расхождение больше — кассир обязан указать причину. 0 — причина нужна при любом расхождении.</span>
        </div>
        <div className="field"><label>Неявка после, минут</label><input type="number" value={branch.noShowGraceMin} onChange={(event) => set("noShowGraceMin", Number(event.target.value))} /></div>
        <button className="btn-gradient" type="submit">Сохранить</button>
      </form>
      <OnlineBookingSettings branch={branch} onSaved={setBranch} />
      <ReminderSettings branch={branch} onSaved={setBranch} />
      <StockSettings branch={branch} onSaved={setBranch} />
    </>
  );
}

function OnlineBookingSettings({ branch, onSaved }: { branch: Branch; onSaved: (branch: Branch) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(branch);
  const [tenantSlug, setTenantSlug] = useState(branch.tenantSlug ?? "");
  useEffect(() => {
    setDraft(branch);
    setTenantSlug(branch.tenantSlug ?? "");
  }, [branch]);
  const set = <K extends keyof Branch>(key: K, value: Branch[K]) => setDraft({ ...draft, [key]: value });
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const link = `${origin}/b/${branch.tenantSlug ?? ""}/${branch.slug}`;
  return (
    <form
      className="panel list"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          if (tenantSlug !== branch.tenantSlug) {
            await api<{ tenantSlug: string }>("/api/tenant", { method: "PATCH", body: JSON.stringify({ slug: tenantSlug }) });
          }
          const saved = await api<Branch>(`/api/branches/${branch.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              slug: draft.slug,
              onlineEnabled: draft.onlineEnabled,
              onlineStepMin: draft.onlineStepMin,
              onlineMinNoticeMin: draft.onlineMinNoticeMin,
              onlineMaxAdvanceDays: draft.onlineMaxAdvanceDays,
              onlineHoldMin: draft.onlineHoldMin,
              onlineCancelHours: draft.onlineCancelHours,
              onlineMaxActivePerPhone: draft.onlineMaxActivePerPhone,
              onlineAccent: draft.onlineAccent,
            }),
          });
          onSaved(saved);
          toast("Онлайн-запись сохранена");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}
    >
      <h2 style={{ margin: 0 }}>Онлайн-запись</h2>
      <label className="row"><input type="checkbox" checked={draft.onlineEnabled} onChange={(event) => set("onlineEnabled", event.target.checked)} /> Принимать онлайн-записи</label>
      <div className="field">
        <label>Ссылка для клиентов</label>
        <div className="row" style={{ gap: 8 }}>
          <input readOnly value={link} onFocus={(event) => event.target.select()} />
          <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Ссылка скопирована"))}>Копировать</button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Для сайта: {`<iframe src="${link}" width="100%" height="720" style="border:0"></iframe>`}
        </span>
      </div>
      <div className="field"><label>Адрес салона в ссылке</label><input value={tenantSlug} onChange={(event) => setTenantSlug(event.target.value)} /></div>
      <div className="field"><label>Адрес филиала в ссылке</label><input value={draft.slug} onChange={(event) => set("slug", event.target.value)} /></div>
      <div className="field">
        <label>Шаг слотов</label>
        <select value={draft.onlineStepMin} onChange={(event) => set("onlineStepMin", Number(event.target.value))}>
          {[5, 10, 15, 30].map((value) => <option key={value} value={value}>{value} минут</option>)}
        </select>
      </div>
      <div className="field"><label>Не раньше чем через, минут</label><input type="number" min={0} value={draft.onlineMinNoticeMin} onChange={(event) => set("onlineMinNoticeMin", Number(event.target.value))} /></div>
      <div className="field"><label>Запись вперёд, дней</label><input type="number" min={1} max={365} value={draft.onlineMaxAdvanceDays} onChange={(event) => set("onlineMaxAdvanceDays", Number(event.target.value))} /></div>
      <div className="field"><label>Бронь слота пока клиент заполняет контакты, минут</label><input type="number" min={5} max={10} value={draft.onlineHoldMin} onChange={(event) => set("onlineHoldMin", Number(event.target.value))} /></div>
      <div className="field"><label>Клиент может отменить не позже чем за, часов</label><input type="number" min={0} value={draft.onlineCancelHours} onChange={(event) => set("onlineCancelHours", Number(event.target.value))} /></div>
      <div className="field"><label>Будущих онлайн-записей на один телефон</label><input type="number" min={1} value={draft.onlineMaxActivePerPhone} onChange={(event) => set("onlineMaxActivePerPhone", Number(event.target.value))} /></div>
      <div className="field"><label>Цвет страницы записи</label><input type="color" style={{ width: 64, height: 36, padding: 2 }} value={draft.onlineAccent} onChange={(event) => set("onlineAccent", event.target.value)} /></div>
      <button className="btn-gradient" type="submit">Сохранить онлайн-запись</button>
    </form>
  );
}

type Message = { id: string; channel: string; recipient: string; body: string; status: string; error: string | null; createdAt: string; clientName: string | null };

function StockSettings({ branch, onSaved }: { branch: Branch; onSaved: (branch: Branch) => void }) {
  const toast = useToast();
  const [policy, setPolicy] = useState(branch.consumePolicy);
  const [negative, setNegative] = useState(branch.allowNegativeStock);
  useEffect(() => {
    setPolicy(branch.consumePolicy);
    setNegative(branch.allowNegativeStock);
  }, [branch]);
  return (
    <form
      className="panel list"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          onSaved(await api<Branch>(`/api/branches/${branch.id}`, { method: "PATCH", body: JSON.stringify({ consumePolicy: policy, allowNegativeStock: negative }) }));
          toast("Настройки склада сохранены");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}
    >
      <h2 style={{ margin: 0 }}>Склад</h2>
      <div className="field">
        <label>Если на завершение визита не хватает материалов</label>
        <select value={policy} onChange={(event) => setPolicy(event.target.value as Branch["consumePolicy"])}>
          <option value="warn">Завершить и предупредить (остаток уйдёт в минус)</option>
          <option value="block">Не давать завершить визит</option>
        </select>
      </div>
      <label className="row"><input type="checkbox" checked={negative} onChange={(event) => setNegative(event.target.checked)} /> Разрешить списание, продажу и перемещение в минус</label>
      <button className="btn-gradient" type="submit">Сохранить склад</button>
    </form>
  );
}

function ReminderSettings({ branch, onSaved }: { branch: Branch; onSaved: (branch: Branch) => void }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(branch.reminderEnabled);
  const [hours, setHours] = useState(branch.reminderHours);
  const [messages, setMessages] = useState<Message[] | null>(null);
  useEffect(() => {
    setEnabled(branch.reminderEnabled);
    setHours(branch.reminderHours);
  }, [branch]);
  useEffect(() => {
    api<Message[]>(`/api/messages?branchId=${branch.id}`).then(setMessages).catch(() => setMessages([]));
  }, [branch.id]);
  return (
    <form
      className="panel list"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          onSaved(await api<Branch>(`/api/branches/${branch.id}`, { method: "PATCH", body: JSON.stringify({ reminderEnabled: enabled, reminderHours: hours }) }));
          toast("Напоминания сохранены");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}
    >
      <h2 style={{ margin: 0 }}>Напоминания клиентам</h2>
      <span className="muted" style={{ fontSize: 13 }}>
        Канал отправки пока не подключён: напоминания формируются по расписанию и записываются в журнал ниже. С 22:00 до 09:00 по времени филиала они не уходят и ждут утра.
      </span>
      <label className="row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Напоминать о визите</label>
      <div className="field"><label>За сколько часов до визита</label><input type="number" min={1} max={168} value={hours} onChange={(event) => setHours(Number(event.target.value))} /></div>
      <button className="btn-gradient" type="submit">Сохранить напоминания</button>
      <h3 style={{ margin: "8px 0 0", fontSize: 14 }}>Журнал сообщений</h3>
      {!messages && <div className="skeleton" />}
      {messages?.length === 0 && <span className="muted">Сообщений пока не было</span>}
      {messages?.map((message) => (
        <div key={message.id} className="list" style={{ gap: 2, paddingBottom: 8, borderBottom: "1px solid var(--line)" }}>
          <div className="spread">
            <b>{message.clientName ?? message.recipient}</b>
            <span className={`tag ${message.status === "delivered" ? "tag-ok" : "tag-bad"}`}>
              {message.status === "delivered" ? (message.channel === "log" ? "в журнале" : message.channel) : "не отправлено"}
            </span>
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {new Date(message.createdAt).toLocaleString("ru-RU")} · {message.recipient}{message.error ? ` · ${message.error}` : ""}
          </span>
          <span style={{ fontSize: 13 }}>{message.body}</span>
        </div>
      ))}
    </form>
  );
}
