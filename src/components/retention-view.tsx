"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatPhone } from "@/domain/phone";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

type Me = { actor: { role: string } };
type Due = {
  clientId: string;
  clientName: string;
  phone: string | null;
  marketing: boolean;
  lastVisitAt: string;
  staffName: string;
  services: string;
  rebookDays: number;
  dueDate: string;
  overdueDays: number;
  remindedAt: string | null;
};
type Entry = {
  id: string;
  clientId: string;
  clientName: string;
  phone: string | null;
  serviceTitle: string | null;
  staffName: string | null;
  dateFrom: string;
  dateTo: string;
  timeFromMin: number;
  timeToMin: number;
  note: string;
  status: string;
  offers: number;
  lastOfferedAt: string | null;
};
type Slot = { appointmentId: string; staffName: string; startsAt: string; endsAt: string; date: string; services: string; matches: string[] };
type Review = {
  id: string;
  clientName: string | null;
  staffName: string | null;
  services: string | null;
  rating: number;
  body: string;
  status: "pending" | "published" | "hidden" | "rejected";
  reply: string;
  rejectReason: string | null;
  createdAt: string;
};
type Reviews = { items: Review[]; counts: Record<string, number>; staff: { staffId: string; name: string; rating: number; count: number }[] };
type Settings = { reviewEnabled: boolean; reviewDelayHours: number; reviewModeration: boolean; noshowBlockAfter: number; rebookEnabled: boolean; birthdayEnabled: boolean };

const TZ = "Europe/Moscow";
const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: TZ });
const whenFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const shortDate = (date: string) => dayFmt.format(new Date(`${date}T12:00:00Z`));
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10;
  const t = n % 100;
  return d === 1 && t !== 11 ? one : d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
};
const stars = (n: number) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const toast = useToast();
  const reload = useCallback(() => {
    if (!path) return;
    api<T>(path).then(setData).catch((error: ApiError) => toast(error.message, "error"));
  }, [path, toast]);
  useEffect(reload, [reload]);
  return { data, reload };
}

/** Stage 6: who to bring back, who is waiting for a slot, what clients said. */
export function RetentionView() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"due" | "wait" | "reviews" | "settings">("due");
  useEffect(() => {
    api<Me>("/api/auth/me")
      .then((data) => {
        setMe(data);
        if (data.actor.role === "master") setTab("reviews");
      })
      .catch(() => undefined);
    const wanted = new URLSearchParams(window.location.search).get("tab");
    if (wanted === "wait" || wanted === "reviews" || wanted === "settings") setTab(wanted);
  }, []);
  if (!me) return <div className="reports-page"><div className="skeleton" /></div>;
  const master = me.actor.role === "master";
  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">Удержание клиентов</div>
          <h1 className="date-title">{master ? "Мои отзывы" : "Вернуть клиентов"}</h1>
        </div>
        {!master && (
          <div className="segment">
            <button className={tab === "due" ? "on" : ""} onClick={() => setTab("due")}>Пора вернуть</button>
            <button className={tab === "wait" ? "on" : ""} onClick={() => setTab("wait")}>Лист ожидания</button>
            <button className={tab === "reviews" ? "on" : ""} onClick={() => setTab("reviews")}>Отзывы</button>
            <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>Настройки</button>
          </div>
        )}
      </div>
      {tab === "due" && !master && <DueList />}
      {tab === "wait" && !master && <Waitlist />}
      {tab === "reviews" && <ReviewsPanel canModerate={!master} />}
      {tab === "settings" && !master && <SettingsPanel />}
    </div>
  );
}

function DueList() {
  const toast = useToast();
  const { data, reload } = useLoad<Due[]>("/api/retention/due");
  const [busy, setBusy] = useState("");
  const overdue = (data ?? []).filter((row) => row.overdueDays >= 0);
  async function remind(row: Due) {
    setBusy(row.clientId);
    try {
      const result = await api<{ sent: boolean; channel: string | null; error: string | null }>(`/api/retention/due/${row.clientId}/remind`, { method: "POST", body: "{}" });
      toast(result.sent ? `Напоминание ушло: ${row.clientName}` : result.error ?? "Не отправлено", result.sent ? undefined : "error");
      reload();
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="report-tiles">
        <div className="panel report-tile"><span className="muted">Пора записаться</span><b>{overdue.length}</b><small className="muted">прошёл срок повторного визита</small></div>
        <div className="panel report-tile"><span className="muted">На этой неделе</span><b>{(data ?? []).length - overdue.length}</b><small className="muted">срок подходит в ближайшие 7 дней</small></div>
        <div className="panel report-tile"><span className="muted">Можно написать</span><b>{(data ?? []).filter((row) => row.marketing && !row.remindedAt).length}</b><small className="muted">есть согласие на рассылки</small></div>
      </div>
      <div className="panel list">
        <span className="muted" style={{ fontSize: 13 }}>
          Клиенты, у которых подходит срок повторного визита (задаётся у услуги: маникюр — 21 день, брови — 28) и нет будущей записи. Без согласия на рассылки — только звонок.
        </span>
        {!data && <div className="skeleton" />}
        {data?.length === 0 && <div className="empty">Сейчас никого: все записаны или срок ещё не подошёл.</div>}
        {data?.map((row) => (
          <div key={row.clientId} className="due-row">
            <div className="due-main">
              <strong>{row.clientName}</strong>
              <span className="muted">{row.services} · {row.staffName} · был(а) {shortDate(row.lastVisitAt.slice(0, 10))}</span>
            </div>
            <span className={`tag ${row.overdueDays > 7 ? "tag-bad" : row.overdueDays >= 0 ? "tag-warn" : "tag-ok"}`}>
              {row.overdueDays > 0 ? `просрочено на ${row.overdueDays} дн.` : row.overdueDays === 0 ? "срок сегодня" : `через ${-row.overdueDays} дн.`}
            </span>
            {row.phone && <a className="btn-ghost" href={`tel:${row.phone}`}>{formatPhone(row.phone)}</a>}
            {row.remindedAt ? (
              <span className="muted due-sent">написали {shortDate(row.remindedAt.slice(0, 10))}</span>
            ) : (
              <button className="btn" disabled={!row.marketing || busy === row.clientId} title={row.marketing ? "" : "Нет согласия на рассылки — позвоните"} onClick={() => remind(row)}>
                Напомнить
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

type Hit = { id: string; name: string; phones: { phone: string }[] };
type Option = { id: string; title?: string; displayName?: string; active?: boolean };

function Waitlist() {
  const toast = useToast();
  const { data, reload } = useLoad<{ entries: Entry[]; slots: Slot[] }>("/api/retention/waitlist");
  const [adding, setAdding] = useState(false);
  const byId = useMemo(() => new Map((data?.entries ?? []).map((entry) => [entry.id, entry])), [data]);

  async function offer(entry: Entry, slot: Slot) {
    try {
      const result = await api<{ sent: boolean; error: string | null }>(`/api/retention/waitlist/${entry.id}/offer`, { method: "POST", body: JSON.stringify({ appointmentId: slot.appointmentId }) });
      toast(result.sent ? `Предложили окно: ${entry.clientName}` : result.error ?? "Не отправлено", result.sent ? undefined : "error");
      reload();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  async function close(entry: Entry, status: "booked" | "cancelled") {
    try {
      await api(`/api/retention/waitlist/${entry.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      reload();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  return (
    <div className="wait-grid">
      <div className="panel list">
        <div className="spread">
          <strong>Освободившиеся окна</strong>
          <span className="muted" style={{ fontSize: 12 }}>отменённые записи на 3 недели вперёд</span>
        </div>
        {!data && <div className="skeleton" />}
        {data?.slots.length === 0 && <div className="empty">Свободных окон после отмен нет.</div>}
        {data?.slots.map((slot) => (
          <div key={slot.appointmentId} className="slot-card">
            <div className="spread">
              <b>{whenFmt.format(new Date(slot.startsAt))}</b>
              <span className={`tag ${slot.matches.length ? "tag-ok" : ""}`}>{slot.matches.length ? `ждут: ${slot.matches.length}` : "никто не ждёт"}</span>
            </div>
            <span className="muted">{slot.staffName} · {slot.services}</span>
            {slot.matches.map((id) => {
              const entry = byId.get(id);
              if (!entry) return null;
              return (
                <div key={id} className="spread slot-match">
                  <span>{entry.clientName}{entry.offers ? <span className="muted"> · предлагали {entry.offers} раз</span> : null}</span>
                  <button className="btn" onClick={() => offer(entry, slot)}>Предложить</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="panel list">
        <div className="spread">
          <strong>Ждут окно · {data?.entries.length ?? 0}</strong>
          <button className="btn-gradient" onClick={() => setAdding(true)}>+ В лист ожидания</button>
        </div>
        {data?.entries.length === 0 && <div className="empty">Лист пуст. Добавьте клиента, которому не нашлось удобного времени.</div>}
        {data?.entries.map((entry) => (
          <div key={entry.id} className="wait-row">
            <div className="due-main">
              <strong>{entry.clientName}</strong>
              <span className="muted">
                {entry.serviceTitle ?? "любая услуга"} · {entry.staffName ?? "любой мастер"}
              </span>
              <span className="muted">
                {entry.dateFrom === entry.dateTo ? shortDate(entry.dateFrom) : `${shortDate(entry.dateFrom)} — ${shortDate(entry.dateTo)}`}
                {entry.timeFromMin > 0 || entry.timeToMin < 1440 ? `, ${hhmm(entry.timeFromMin)}–${hhmm(entry.timeToMin)}` : ", любое время"}
                {entry.note ? ` · ${entry.note}` : ""}
              </span>
            </div>
            {entry.phone && <a className="btn-ghost" href={`tel:${entry.phone}`}>{formatPhone(entry.phone)}</a>}
            <button className="btn-ghost" onClick={() => close(entry, "booked")}>Записан</button>
            <button className="btn-ghost" onClick={() => close(entry, "cancelled")}>Убрать</button>
          </div>
        ))}
      </div>
      {adding && <AddWaitlist onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function AddWaitlist({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [client, setClient] = useState<Hit | null>(null);
  const [services, setServices] = useState<Option[]>([]);
  const [staff, setStaff] = useState<Option[]>([]);
  const [form, setForm] = useState({ serviceId: "", staffId: "", dateFrom: today, dateTo: today, timeFrom: "10:00", timeTo: "21:00", note: "" });
  useEffect(() => {
    api<{ services: Option[] }>("/api/catalog").then((data) => setServices(data.services.filter((item) => item.active))).catch(() => undefined);
    api<Option[]>("/api/staff").then((data) => setStaff(data.filter((item) => item.active !== false))).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (query.trim().length < 2 || client) return setHits([]);
    const timer = window.setTimeout(() => api<Hit[]>(`/api/clients?q=${encodeURIComponent(query)}`).then(setHits).catch(() => undefined), 200);
    return () => window.clearTimeout(timer);
  }, [query, client]);
  const minutes = (value: string) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  async function save() {
    if (!client) return toast("Выберите клиента", "error");
    try {
      await api("/api/retention/waitlist", {
        method: "POST",
        body: JSON.stringify({
          clientId: client.id,
          serviceId: form.serviceId || null,
          staffId: form.staffId || null,
          dateFrom: form.dateFrom,
          dateTo: form.dateTo,
          timeFromMin: minutes(form.timeFrom),
          timeToMin: minutes(form.timeTo),
          note: form.note,
        }),
      });
      toast(`${client.name} в листе ожидания`);
      onSaved();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  return (
    <Modal title="В лист ожидания" onClose={onClose}>
      <div className="list">
        <div className="field">
          <label>Клиент</label>
          <input value={client ? client.name : query} onChange={(event) => { setClient(null); setQuery(event.target.value); }} placeholder="Имя или телефон" autoFocus />
          {hits.length > 0 && (
            <div className="chips">
              {hits.slice(0, 6).map((hit) => (
                <button key={hit.id} type="button" className="chip" onClick={() => { setClient(hit); setHits([]); }}>
                  {hit.name}{hit.phones[0] ? ` · ${formatPhone(hit.phones[0].phone)}` : ""}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label>Услуга</label>
            <select value={form.serviceId} onChange={(event) => setForm({ ...form, serviceId: event.target.value })}>
              <option value="">Любая</option>
              {services.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Мастер</label>
            <select value={form.staffId} onChange={(event) => setForm({ ...form, staffId: event.target.value })}>
              <option value="">Любой</option>
              {staff.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>С</label><input type="date" value={form.dateFrom} onChange={(event) => setForm({ ...form, dateFrom: event.target.value, dateTo: event.target.value > form.dateTo ? event.target.value : form.dateTo })} /></div>
          <div className="field" style={{ flex: 1 }}><label>По</label><input type="date" value={form.dateTo} onChange={(event) => setForm({ ...form, dateTo: event.target.value })} /></div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Удобно с</label><input type="time" step={1800} value={form.timeFrom} onChange={(event) => setForm({ ...form, timeFrom: event.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label>До</label><input type="time" step={1800} value={form.timeTo} onChange={(event) => setForm({ ...form, timeTo: event.target.value })} /></div>
        </div>
        <div className="field"><label>Комментарий</label><input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Например: только после работы" /></div>
        <button className="btn-gradient" onClick={save}>Добавить</button>
      </div>
    </Modal>
  );
}

const REVIEW_STATUS: Record<Review["status"], string> = { pending: "На модерации", published: "Опубликован", hidden: "Скрыт", rejected: "Отклонён" };

function ReviewsPanel({ canModerate }: { canModerate: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState(canModerate ? "pending" : "");
  const { data, reload } = useLoad<Reviews>(`/api/retention/reviews${status ? `?status=${status}` : ""}`);
  const [rejecting, setRejecting] = useState<Review | null>(null);
  const [reason, setReason] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});

  async function act(review: Review, action: string, extra: Record<string, unknown> = {}) {
    try {
      await api(`/api/retention/reviews/${review.id}`, { method: "POST", body: JSON.stringify({ action, ...extra }) });
      toast(action === "publish" ? "Опубликован" : action === "hide" ? "Скрыт" : action === "reject" ? "Отклонён" : "Сохранено");
      setRejecting(null);
      reload();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  const total = data ? Object.values(data.counts).reduce((sum, n) => sum + n, 0) : 0;
  const month = new Date();
  const from = new Date(month.getFullYear(), month.getMonth(), 1).toISOString().slice(0, 10);
  return (
    <>
      <div className="report-tiles">
        {(data?.staff ?? []).slice(0, 3).map((row) => (
          <div key={row.staffId} className="panel report-tile">
            <span className="muted">{row.name}</span>
            <b>{row.rating.toFixed(1)} <span className="stars">{stars(Math.round(row.rating))}</span></b>
            <small className="muted">{row.count} {plural(row.count, "опубликованный отзыв", "опубликованных отзыва", "опубликованных отзывов")}</small>
          </div>
        ))}
        {data && data.staff.length === 0 && <div className="panel report-tile"><span className="muted">Рейтинг</span><b>—</b><small className="muted">появится после первых опубликованных отзывов</small></div>}
      </div>
      <div className="panel list">
        <div className="spread">
          {canModerate ? (
            <div className="segment">
              {(["pending", "published", "hidden", "rejected", ""] as const).map((key) => (
                <button key={key || "all"} className={status === key ? "on" : ""} onClick={() => setStatus(key)}>
                  {key ? REVIEW_STATUS[key] : "Все"}{key && data?.counts[key] ? ` · ${data.counts[key]}` : !key && total ? ` · ${total}` : ""}
                </button>
              ))}
            </div>
          ) : (
            <span className="muted">Отзывы клиентов о ваших визитах</span>
          )}
          {canModerate && <a className="btn-ghost" href={`/api/retention/reviews.csv?from=${from}&to=${new Date().toISOString().slice(0, 10)}`}>CSV за месяц</a>}
        </div>
        {!data && <div className="skeleton" />}
        {data?.items.length === 0 && <div className="empty">{status === "pending" ? "Новых отзывов на модерации нет." : "Пока пусто."}</div>}
        {data?.items.map((review) => (
          <div key={review.id} className={`review-card ${review.rating <= 3 ? "low" : ""}`}>
            <div className="spread">
              <span><span className="stars">{stars(review.rating)}</span> <b>{review.clientName ?? "Клиент"}</b></span>
              <span className={`tag ${review.status === "published" ? "tag-ok" : review.status === "pending" ? "tag-warn" : ""}`}>{REVIEW_STATUS[review.status]}</span>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>{review.staffName} · {review.services} · {whenFmt.format(new Date(review.createdAt))}</span>
            {review.body ? <p className="review-body">{review.body}</p> : <p className="muted review-body">Без текста, только оценка</p>}
            {review.rejectReason && <span className="muted" style={{ fontSize: 12 }}>Причина: {review.rejectReason}</span>}
            {review.reply && <div className="review-reply"><b>Ответ салона:</b> {review.reply}</div>}
            {canModerate && (
              <div className="row" style={{ flexWrap: "wrap" }}>
                {review.status !== "published" && <button className="btn" onClick={() => act(review, "publish", replies[review.id] ? { reply: replies[review.id] } : {})}>Опубликовать</button>}
                {review.status !== "hidden" && <button className="btn-ghost" onClick={() => act(review, "hide")}>Скрыть</button>}
                {review.status === "pending" && <button className="btn-ghost" onClick={() => { setReason(""); setRejecting(review); }}>Отклонить</button>}
                <input
                  className="reply-input"
                  placeholder="Ответить клиенту публично"
                  value={replies[review.id] ?? ""}
                  onChange={(event) => setReplies({ ...replies, [review.id]: event.target.value })}
                  onKeyDown={(event) => { if (event.key === "Enter" && replies[review.id]) act(review, "reply", { reply: replies[review.id] }); }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      {rejecting && (
        <Modal title="Отклонить отзыв" onClose={() => setRejecting(null)}>
          <div className="list">
            <div className="field"><label>Причина (видна только сотрудникам)</label><input value={reason} onChange={(event) => setReason(event.target.value)} autoFocus placeholder="Спам, не наш клиент, оскорбления" /></div>
            <button className="btn-gradient" onClick={() => act(rejecting, "reject", { reason })}>Отклонить</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function SettingsPanel() {
  const toast = useToast();
  const { data, reload } = useLoad<Settings>("/api/retention/settings");
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => setForm(data), [data]);
  if (!form) return <div className="skeleton" />;
  async function save() {
    try {
      await api("/api/retention/settings", { method: "PATCH", body: JSON.stringify(form) });
      toast("Сохранено");
      reload();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  return (
    <div className="panel list" style={{ maxWidth: 720 }}>
      <strong>Отзывы</strong>
      <label className="row"><input type="checkbox" checked={form.reviewEnabled} onChange={(event) => setForm({ ...form, reviewEnabled: event.target.checked })} /> Просить отзыв после визита</label>
      <div className="row">
        <span className="muted">Через</span>
        <input className="num-input" inputMode="numeric" value={form.reviewDelayHours} onChange={(event) => setForm({ ...form, reviewDelayHours: Number(event.target.value) || 0 })} />
        <span className="muted">ч после окончания визита (не в тихие часы)</span>
      </div>
      <label className="row"><input type="checkbox" checked={form.reviewModeration} onChange={(event) => setForm({ ...form, reviewModeration: event.target.checked })} /> Публиковать только после проверки</label>
      <strong style={{ marginTop: 8 }}>Неявки</strong>
      <div className="row">
        <span className="muted">Не пускать в онлайн-запись после</span>
        <input className="num-input" inputMode="numeric" value={form.noshowBlockAfter} onChange={(event) => setForm({ ...form, noshowBlockAfter: Number(event.target.value) || 0 })} />
        <span className="muted">неявок за год (0 — не ограничивать). Клиент увидит просьбу позвонить.</span>
      </div>
      <strong style={{ marginTop: 8 }}>Автоматические сообщения</strong>
      <span className="muted" style={{ fontSize: 13 }}>Уходят только клиентам с согласием на рассылки (38-ФЗ). Тексты — в настройках сообщений.</span>
      <label className="row"><input type="checkbox" checked={form.rebookEnabled} onChange={(event) => setForm({ ...form, rebookEnabled: event.target.checked })} /> «Пора на повторный визит», когда подошёл срок услуги</label>
      <label className="row"><input type="checkbox" checked={form.birthdayEnabled} onChange={(event) => setForm({ ...form, birthdayEnabled: event.target.checked })} /> Поздравление с днём рождения</label>
      <button className="btn-gradient" style={{ alignSelf: "flex-start" }} onClick={save}>Сохранить</button>
    </div>
  );
}
