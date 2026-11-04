"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { formatPhone } from "@/domain/phone";
import { addCalendarDays, todayInZone, zonedDateTimeToUtc } from "@/domain/time";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

type Me = { actor: { role: string; staffId: string | null }; branches: { id: string; name: string; timezone: string }[] };
type Event = {
  id: string;
  branchId: string;
  title: string;
  description: string;
  staffId: string | null;
  staffName: string | null;
  resourceId: string | null;
  resourceTitle: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  priceMinor: number;
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  onlineVisible: boolean;
  enrolled: number;
  waitlisted: number;
  arrived: number;
  paid: number;
  freeSeats: number;
  seriesId: string | null;
  cancelReason: string | null;
};
type Participant = { id: string; clientId: string; clientName: string; phone: string | null; status: "enrolled" | "waitlisted" | "arrived" | "no_show" | "cancelled"; source: string; paid: boolean };
type Detail = Event & { canEdit: boolean; canRun: boolean; participants: Participant[] };
type Stat = { title: string; events: number; seats: number; enrolled: number; arrived: number; fillPercent: number; noShowPercent: number; revenueMinor: number };

const STATUS: Record<Event["status"], string> = { scheduled: "Запланировано", in_progress: "Идёт", completed: "Прошло", cancelled: "Отменено" };
const PART: Record<Participant["status"], string> = { enrolled: "записан", waitlisted: "ожидание", arrived: "пришёл", no_show: "не пришёл", cancelled: "отменил" };
const PART_TAG: Record<Participant["status"], string> = { enrolled: "tag-muted", waitlisted: "tag-warn", arrived: "tag-ok", no_show: "tag-bad", cancelled: "tag-muted" };

function monday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addCalendarDays(date, -((day + 6) % 7));
}

/** GRP-*: the week's classes, seats, waitlists and payment per seat. */
export function GroupsView() {
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [week, setWeek] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [stats, setStats] = useState<Stat[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const branch = me?.branches[0];
  const admin = me ? ["owner", "admin", "super"].includes(me.actor.role) : false;

  useEffect(() => {
    api<Me>("/api/auth/me")
      .then((data) => {
        setMe(data);
        const tz = data.branches[0]?.timezone ?? "Europe/Moscow";
        setWeek(monday(todayInZone(tz)));
      })
      .catch(() => undefined);
    const open = new URLSearchParams(window.location.search).get("open");
    if (open) setOpenId(open);
  }, []);

  const load = useCallback(() => {
    if (!branch || !week) return;
    const to = addCalendarDays(week, 6);
    api<Event[]>(`/api/groups?branchId=${branch.id}&from=${week}&to=${to}`).then(setEvents).catch((error: ApiError) => toast(error.message, "error"));
    if (me && me.actor.role !== "master") api<Stat[]>(`/api/groups/stats?branchId=${branch.id}&from=${addCalendarDays(week, -28)}&to=${to}`).then(setStats).catch(() => setStats([]));
  }, [branch, week, me, toast]);
  useEffect(load, [load]);

  if (!me || !branch) return <div className="reports-page"><div className="skeleton" /></div>;
  const tz = branch.timezone;
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(week, index));
  const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const time = (iso: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const label = (date: string) => new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">Групповые занятия</div>
          <div className="row" style={{ gap: 8 }}>
            <h1 className="date-title">{new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${week}T12:00:00Z`))} — {new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${addCalendarDays(week, 6)}T12:00:00Z`))}</h1>
            <button className="chev" type="button" aria-label="Предыдущая неделя" onClick={() => setWeek(addCalendarDays(week, -7))}><ChevronLeft size={16} /></button>
            <button className="chev" type="button" aria-label="Следующая неделя" onClick={() => setWeek(addCalendarDays(week, 7))}><ChevronRight size={16} /></button>
          </div>
        </div>
        {admin && <button className="btn-gradient" onClick={() => setCreating(true)}>+ Занятие</button>}
      </div>

      <div className="group-week">
        {days.map((date) => {
          const list = events.filter((event) => dayOf(event.startsAt) === date);
          return (
            <div key={date} className="group-day">
              <div className="group-day-head">{label(date)}</div>
              {list.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Нет занятий</span>}
              {list.map((event) => (
                <button key={event.id} className={`group-card ${event.status}`} onClick={() => setOpenId(event.id)}>
                  <div className="spread">
                    <span className="when">{time(event.startsAt)}–{time(event.endsAt)}</span>
                    {event.status !== "scheduled" && <span className={`tag ${event.status === "cancelled" ? "tag-bad" : event.status === "completed" ? "tag-muted" : "tag-ok"}`}>{STATUS[event.status]}</span>}
                  </div>
                  <strong>{event.title}</strong>
                  <span className="group-meta">{[event.staffName, event.resourceTitle].filter(Boolean).join(" · ")}</span>
                  <div className="seat-bar" aria-label={`Мест занято ${event.enrolled} из ${event.capacity}`}>
                    <i style={{ width: `${Math.min(100, (event.enrolled / event.capacity) * 100)}%` }} />
                  </div>
                  <div className="spread" style={{ fontSize: 12.5 }}>
                    <span><b>{event.enrolled}/{event.capacity}</b>{event.waitlisted ? ` · ждут ${event.waitlisted}` : ""}</span>
                    <span>{event.priceMinor ? formatMoney(event.priceMinor) : "бесплатно"}</span>
                  </div>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {stats.length > 0 && (
        <div className="panel list">
          <h2 style={{ margin: 0 }}>Заполняемость за 5 недель</h2>
          <table className="report-table">
            <thead><tr><th>Занятие</th><th>Раз</th><th>Мест</th><th>Записано</th><th>Заполнено</th><th>Неявки</th><th>Выручка</th></tr></thead>
            <tbody>
              {stats.map((row) => (
                <tr key={row.title}><td>{row.title}</td><td>{row.events}</td><td>{row.seats}</td><td>{row.enrolled}</td><td>{row.fillPercent}%</td><td>{row.noShowPercent}%</td><td>{formatMoney(row.revenueMinor)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <EventForm branchId={branch.id} timezone={tz} date={days[0]} onClose={() => setCreating(false)} onSaved={(event) => { setCreating(false); setWeek(monday(dayOf(event.startsAt))); setOpenId(event.id); load(); }} />}
      {openId && <EventModal id={openId} timezone={tz} onClose={() => { setOpenId(null); load(); }} />}
    </div>
  );
}

function EventForm({ branchId, timezone, date, event, onClose, onSaved }: { branchId: string; timezone: string; date: string; event?: Detail; onClose: () => void; onSaved: (event: Detail) => void }) {
  const toast = useToast();
  const [staff, setStaff] = useState<{ id: string; displayName: string }[]>([]);
  const [rooms, setRooms] = useState<{ id: string; title: string; kind: string }[]>([]);
  const localDay = event ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(event.startsAt)) : date;
  const localTime = event ? new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(event.startsAt)) : "18:00";
  const [form, setForm] = useState({
    title: event?.title ?? "",
    description: event?.description ?? "",
    day: localDay,
    time: localTime,
    durationMin: event ? Math.round((new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60000) : 90,
    capacity: event?.capacity ?? 8,
    price: event ? String(event.priceMinor / 100) : "2500",
    staffId: event?.staffId ?? "",
    resourceId: event?.resourceId ?? "",
    repeatWeeks: 0,
    onlineVisible: event?.onlineVisible ?? true,
  });
  useEffect(() => {
    api<{ id: string; displayName: string }[]>("/api/staff").then(setStaff).catch(() => undefined);
    api<{ id: string; title: string; kind: string }[]>(`/api/resources?branchId=${branchId}`).then(setRooms).catch(() => undefined);
  }, [branchId]);
  async function save(acknowledgeSoft = false) {
    const [hours, minutes] = form.time.split(":").map(Number);
    const body = {
      branchId,
      title: form.title,
      description: form.description,
      startsAt: zonedDateTimeToUtc(form.day, hours * 60 + minutes, timezone).toISOString(),
      durationMin: Number(form.durationMin),
      capacity: Number(form.capacity),
      priceMinor: rublesToMinor(Number(String(form.price).replace(",", ".")) || 0),
      staffId: form.staffId || null,
      resourceId: form.resourceId || null,
      repeatWeeks: event ? undefined : Number(form.repeatWeeks),
      onlineVisible: form.onlineVisible,
      acknowledgeSoft,
    };
    try {
      onSaved(await api<Detail>(event ? `/api/groups/${event.id}` : "/api/groups", { method: event ? "PATCH" : "POST", body: JSON.stringify(body) }));
      toast(event ? "Сохранено" : form.repeatWeeks ? `Создано ${Number(form.repeatWeeks) + 1} занятий` : "Занятие создано");
    } catch (error) {
      const err = error as ApiError;
      if (err.code === "SOFT_CONFIRM" && window.confirm(`${err.message}. Создать всё равно?`)) return save(true);
      toast(err.message, "error");
    }
  }
  return (
    <Modal title={event ? "Изменить занятие" : "Новое групповое занятие"} onClose={onClose}>
      <div className="list">
        <div className="field"><label>Название</label><input value={form.title} placeholder="Мастер-класс по макияжу" onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        <div className="form-grid">
          <div className="field"><label>Дата</label><input type="date" value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} /></div>
          <div className="field"><label>Начало</label><input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></div>
          <div className="field"><label>Длительность, мин</label><input type="number" min={15} step={15} value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) })} /></div>
          <div className="field"><label>Мест</label><input type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} /></div>
          <div className="field"><label>Цена места, ₽</label><input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></div>
          <div className="field">
            <label>Ведущий</label>
            <select value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
              <option value="">—</option>
              {staff.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Зал</label>
            <select value={form.resourceId} onChange={(e) => setForm({ ...form, resourceId: e.target.value })}>
              <option value="">—</option>
              {rooms.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
            </select>
          </div>
          {!event && (
            <div className="field">
              <label>Повторять</label>
              <select value={form.repeatWeeks} onChange={(e) => setForm({ ...form, repeatWeeks: Number(e.target.value) })}>
                <option value={0}>Один раз</option>
                {[3, 7, 11].map((weeks) => <option key={weeks} value={weeks}>Каждую неделю, {weeks + 1} раз</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="field"><label>Описание для клиентов</label><textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        <label className="row"><input type="checkbox" checked={form.onlineVisible} onChange={(e) => setForm({ ...form, onlineVisible: e.target.checked })} /> Показывать в онлайн-записи</label>
        <button className="btn-gradient" style={{ alignSelf: "flex-start" }} onClick={() => save()}>Сохранить</button>
      </div>
    </Modal>
  );
}

function EventModal({ id, timezone, onClose }: { id: string; timezone: string; onClose: () => void }) {
  const toast = useToast();
  const [event, setEvent] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; phones: { phone: string }[] }[]>([]);
  const [ticked, setTicked] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState("card");

  const load = useCallback(() => {
    api<Detail>(`/api/groups/${id}`).then(setEvent).catch((error: ApiError) => toast(error.message, "error"));
  }, [id, toast]);
  useEffect(load, [load]);
  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(() => api<typeof hits>(`/api/clients?q=${encodeURIComponent(query)}`).then(setHits).catch(() => undefined), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function act<T>(path: string, body: unknown, message: string, after?: (value: T) => void) {
    try {
      const result = await api<T>(path, { method: "POST", body: JSON.stringify(body) });
      toast(message);
      after?.(result);
      load();
      return result;
    } catch (error) {
      const err = error as ApiError;
      if (err.details?.full && window.confirm("Мест нет. Записать в лист ожидания?")) return act(path, { ...(body as object), waitlist: true }, "Добавлен в лист ожидания", after);
      toast(err.message, "error");
      return null;
    }
  }

  if (!event) return <Modal title="Занятие" onClose={onClose}><div className="skeleton" /></Modal>;
  if (editing) return <EventForm branchId={event.branchId} timezone={timezone} date="" event={event} onClose={() => setEditing(false)} onSaved={(saved) => { setEvent({ ...event, ...saved }); setEditing(false); load(); }} />;
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, ...opts }).format(new Date(iso));
  const open = event.status === "scheduled" || event.status === "in_progress";
  const seated = event.participants.filter((row) => row.status !== "cancelled" && row.status !== "waitlisted");
  const waiting = event.participants.filter((row) => row.status === "waitlisted");
  return (
    <Modal title={event.title} onClose={onClose} wide>
      <div className="list">
        <div className="group-meta">
          <span>{fmt(event.startsAt, { weekday: "long", day: "numeric", month: "long" })}, {fmt(event.startsAt, { hour: "2-digit", minute: "2-digit" })}–{fmt(event.endsAt, { hour: "2-digit", minute: "2-digit" })}</span>
          {event.staffName && <span>Ведущий: {event.staffName}</span>}
          {event.resourceTitle && <span>Зал: {event.resourceTitle}</span>}
          <span>{event.priceMinor ? `${formatMoney(event.priceMinor)} за место` : "Бесплатно"}</span>
          <span className={`tag ${event.status === "cancelled" ? "tag-bad" : "tag-muted"}`}>{STATUS[event.status]}{event.cancelReason ? `: ${event.cancelReason}` : ""}</span>
        </div>
        <div className="seat-bar big"><i style={{ width: `${Math.min(100, (event.enrolled / event.capacity) * 100)}%` }} /></div>
        <div className="muted" style={{ fontSize: 13 }}>Занято {event.enrolled} из {event.capacity}{event.waitlisted ? `, в листе ожидания ${event.waitlisted}` : ""}{event.paid ? `, оплачено ${event.paid}` : ""}</div>

        {open && event.canRun && (
          <div className="field" style={{ position: "relative" }}>
            <label>Записать клиента</label>
            <input value={query} placeholder="Имя или телефон" onChange={(e) => setQuery(e.target.value)} />
            {hits.length > 0 && (
              <div className="search-pop panel" style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 5 }}>
                {hits.slice(0, 6).map((hit) => (
                  <button key={hit.id} className="person" onClick={() => { setQuery(""); setHits([]); void act(`/api/groups/${event.id}/enroll`, { clientId: hit.id }, `${hit.name} записан(а)`); }}>
                    <div><strong>{hit.name}</strong><span>{hit.phones[0] ? formatPhone(hit.phones[0].phone) : ""}</span></div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <table className="report-table">
          <thead><tr>{open && event.canRun && <th />}<th>Участник</th><th>Статус</th><th>Оплата</th><th /></tr></thead>
          <tbody>
            {[...seated, ...waiting].map((row) => (
              <tr key={row.id}>
                {open && event.canRun && (
                  <td>{(row.status === "enrolled" || row.status === "no_show") && <input type="checkbox" aria-label={`Пришёл: ${row.clientName}`} checked={ticked.includes(row.id)} onChange={(e) => setTicked(e.target.checked ? [...ticked, row.id] : ticked.filter((item) => item !== row.id))} />}</td>
                )}
                <td><strong>{row.clientName}</strong>{row.phone && <div className="muted" style={{ fontSize: 12 }}>{formatPhone(row.phone)}{row.source === "online" ? " · онлайн" : ""}</div>}</td>
                <td><span className={`tag ${PART_TAG[row.status]}`}>{PART[row.status]}</span></td>
                <td>{row.paid ? <span className="tag tag-ok">оплачено</span> : event.priceMinor && row.status !== "waitlisted" && open && event.canEdit ? (
                  <button className="btn-ghost" onClick={() => act(`/api/groups/participants/${row.id}/pay`, { tenders: [{ method, amountMinor: event.priceMinor }] }, "Место оплачено")}>Принять {formatMoney(event.priceMinor)}</button>
                ) : <span className="muted">—</span>}</td>
                <td>{open && event.canRun && <button className="icon-btn" aria-label="Отменить участие" onClick={() => act<{ promoted: string[]; refundSuggested: boolean }>(`/api/groups/participants/${row.id}/status`, { status: "cancelled" }, "Участие отменено", (result) => { if (result.promoted.length) toast("Место отдали первому из листа ожидания"); if (result.refundSuggested) toast("Место было оплачено: сделайте возврат в «Финансах»"); })}>×</button>}</td>
              </tr>
            ))}
            {seated.length + waiting.length === 0 && <tr><td colSpan={5} className="muted">Пока никто не записан</td></tr>}
          </tbody>
        </table>

        {open && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {event.canRun && ticked.length > 0 && <button className="btn" onClick={() => act(`/api/groups/${event.id}/arrived`, { participantIds: ticked }, `Отмечено: ${ticked.length}`, () => setTicked([]))}>Пришли ({ticked.length})</button>}
            {event.canEdit && event.priceMinor > 0 && (
              <select aria-label="Способ оплаты" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="card">Карта</option>
                <option value="cash">Наличные</option>
                <option value="sbp">СБП</option>
              </select>
            )}
            {event.canRun && <button className="btn" onClick={() => act(`/api/groups/${event.id}/complete`, {}, "Занятие завершено")}>Завершить</button>}
            {event.canEdit && <button className="btn-ghost" onClick={() => setEditing(true)}>Изменить</button>}
            {event.canEdit && (
              <button className="btn-ghost" onClick={() => {
                const reason = window.prompt("Причина отмены — её получат участники");
                if (reason) void act<{ notified: number; refunds: unknown[] }>(`/api/groups/${event.id}/cancel`, { reason }, "Занятие отменено", (result) => { if (result.refunds.length) toast(`Оплачено мест: ${result.refunds.length}. Сделайте возвраты`); });
              }}>Отменить занятие</button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
