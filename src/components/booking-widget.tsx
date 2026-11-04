"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney } from "@/domain/money";

type Branch = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  currency: string;
  accent: string;
  logoUrl: string | null;
  cancelHours: number;
  maxAdvanceDays: number;
};
type Service = { id: string; title: string; categoryId: string | null; durationMin: number; priceMinor: number; depositMinor?: number; staffIds: string[] };
type Staff = { id: string; name: string; color: string; specialties: string };
type OnlineField = { key: string; entity: "client" | "appointment"; label: string; type: string; options: string[]; required: boolean };
type GroupEvent = { id: string; title: string; description: string; staffName: string | null; startsAt: string; endsAt: string; date: string; priceMinor: number; freeSeats: number; capacity: number };
type Catalog = { branch: Branch; categories: { id: string; title: string }[]; services: Service[]; staff: Staff[]; fields?: OnlineField[]; groups?: GroupEvent[] };
type GroupResult = { status: "enrolled" | "waitlisted"; title: string; startsAt: string };
type Slot = { startsAt: string; time: string; staffIds: string[] };
type Day = { date: string; slots: Slot[] };
type Hold = { holdId: string; expiresAt: string; staffId: string; staffName: string; serviceTitle: string; priceMinor: number; startsAt: string; endsAt: string };
type Booking = {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  staffName: string;
  serviceTitle: string;
  priceMinor: number;
  promo: { code: string; discountMinor: number } | null;
  cancelToken: string;
  cancelUntil: string;
  telegramUrl: string | null;
  deposit?: { amountMinor: number; payUrl: string; dueAt: string } | null;
};
type Failure = Error & { code?: string; details?: { reason?: string; full?: boolean; field?: string } | null };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(body.error?.message || "Не получилось. Попробуйте ещё раз") as Failure;
    error.code = body.error?.code;
    error.details = body.error?.details;
    throw error;
  }
  return body as T;
}

function addDays(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function todayIn(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function formatWhen(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function dayLabel(date: string) {
  const instant = new Date(`${date}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" }).format(instant),
    day: new Intl.DateTimeFormat("ru-RU", { day: "numeric", timeZone: "UTC" }).format(instant),
    month: new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "UTC" }).format(instant),
  };
}

const PAGE_DAYS = 7;

export function BookingWidget({ tenantSlug, branchSlug }: { tenantSlug: string; branchSlug: string }) {
  const base = `/api/public/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(branchSlug)}`;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [service, setService] = useState<Service | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [from, setFrom] = useState<string>("");
  const [date, setDate] = useState<string>("");
  const [days, setDays] = useState<Day[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", comment: "", promo: "", website: "", consent: false, marketing: false });
  const idempotencyKey = useRef<string>("");
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [group, setGroup] = useState<GroupEvent | null>(null);
  const [groupFull, setGroupFull] = useState(false);
  const [groupResult, setGroupResult] = useState<GroupResult | null>(null);

  const [ratings, setRatings] = useState<Record<string, { rating: number; count: number }>>({});
  useEffect(() => {
    // REV-SHOW-01: published reviews only; the widget works the same without them.
    call<{ staff: { staffId: string; rating: number; count: number }[] }>(`${base}/reviews`)
      .then((data) => setRatings(Object.fromEntries(data.staff.map((row) => [row.staffId, row]))))
      .catch(() => undefined);
  }, [base]);

  useEffect(() => {
    call<Catalog>(`${base}/catalog`)
      .then((data) => {
        setCatalog(data);
        const today = todayIn(data.branch.timezone);
        setFrom(today);
        setDate(today);
      })
      .catch((error: Failure) => setLoadError(error.message));
  }, [base]);

  const tz = catalog?.branch.timezone ?? "Europe/Moscow";
  const today = catalog ? todayIn(tz) : "";
  const lastDay = catalog ? addDays(today, catalog.branch.maxAdvanceDays) : "";

  const loadSlots = useCallback(async () => {
    if (!service || !from) return;
    setDays(null);
    try {
      const params = new URLSearchParams({ serviceId: service.id, from, days: String(PAGE_DAYS) });
      if (staffId) params.set("staffId", staffId);
      const result = await call<{ days: Day[] }>(`${base}/slots?${params}`);
      setDays(result.days);
      if (!result.days.some((day) => day.date === date)) setDate(result.days[0]?.date ?? from);
    } catch (error) {
      setNotice((error as Failure).message);
      setDays([]);
    }
  }, [base, service, staffId, from, date]);

  useEffect(() => {
    if (step === 2) void loadSlots();
    // Reload only when the inputs of the query change, not on every date click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, service, staffId, from]);

  const releaseCurrentHold = useCallback(() => {
    if (hold) void call(`${base}/holds/${hold.holdId}`, { method: "DELETE" }).catch(() => undefined);
    setHold(null);
  }, [base, hold]);

  function pickService(next: Service) {
    // Changing the service resets the slot (section 2 of the spec).
    releaseCurrentHold();
    setService(next);
    setStaffId(null);
    setFrom(today);
    setDate(today);
    setNotice(null);
    setStep(2);
  }

  async function pickSlot(slot: Slot) {
    if (!service) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await call<Hold>(`${base}/holds`, {
        method: "POST",
        body: JSON.stringify({ serviceId: service.id, staffId, startsAt: slot.startsAt }),
      });
      setHold(created);
      idempotencyKey.current = crypto.randomUUID();
      setStep(3);
    } catch (error) {
      setNotice((error as Failure).message);
      void loadSlots();
    } finally {
      setBusy(false);
    }
  }

  function backToSlots(message?: string) {
    releaseCurrentHold();
    setNotice(message ?? null);
    setStep(2);
    void loadSlots();
  }

  async function confirm() {
    if (!hold || form.website) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await call<Booking>(`${base}/bookings`, {
        method: "POST",
        body: JSON.stringify({ holdId: hold.holdId, name: form.name, phone: form.phone, comment: form.comment, promoCode: form.promo || undefined, consent: form.consent, marketing: form.marketing, custom, idempotencyKey: idempotencyKey.current }),
      });
      setBooking(result);
      setHold(null);
      setStep(4);
    } catch (error) {
      const failure = error as Failure;
      if (failure.code === "CONFLICT_SLOT") {
        setHold(null);
        setNotice(failure.message);
        setStep(2);
        void loadSlots();
      } else {
        setNotice(failure.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function enrollGroup(waitlist: boolean) {
    if (!group || form.website) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await call<GroupResult>(`${base}/groups/${group.id}/enroll`, {
        method: "POST",
        body: JSON.stringify({ name: form.name, phone: form.phone, consent: form.consent, marketing: form.marketing, waitlist }),
      });
      setGroupResult(result);
      setStep(4);
      setGroupFull(false);
    } catch (error) {
      const failure = error as Failure;
      if (failure.details?.full) setGroupFull(true);
      setNotice(failure.message);
    } finally {
      setBusy(false);
    }
  }

  function resetAll() {
    setBooking(null);
    setService(null);
    setGroup(null);
    setGroupResult(null);
    setGroupFull(false);
    setCustom({});
    setForm({ name: "", phone: "", comment: "", promo: "", website: "", consent: false, marketing: false });
    setStep(1);
  }

  const grouped = useMemo(() => {
    if (!catalog) return [];
    const groups = catalog.categories.map((category) => ({
      id: category.id,
      title: category.title,
      services: catalog.services.filter((item) => item.categoryId === category.id),
    }));
    const rest = catalog.services.filter((item) => !catalog.categories.some((category) => category.id === item.categoryId));
    if (rest.length) groups.push({ id: "other", title: groups.length ? "Другое" : "Услуги", services: rest });
    return groups.filter((group) => group.services.length);
  }, [catalog]);

  if (loadError) {
    return (
      <div className="bk-page">
        <div className="bk-card bk-empty">
          <h1>Онлайн-запись недоступна</h1>
          <p>{loadError}. Позвоните в салон, чтобы записаться.</p>
        </div>
      </div>
    );
  }
  if (!catalog) return <div className="bk-page"><div className="bk-card bk-loading">Загружаем услуги…</div></div>;

  const branch = catalog.branch;
  const staffFor = service ? catalog.staff.filter((member) => service.staffIds.includes(member.id)) : [];
  const day = days?.find((item) => item.date === date);
  const staffName = (id: string) => catalog.staff.find((member) => member.id === id)?.name ?? "";

  return (
    <div className="bk-page" style={{ ["--bk-accent" as string]: branch.accent }}>
      <div className="bk-card">
        <header className="bk-head">
          {branch.logoUrl ? <img src={branch.logoUrl} alt="" className="bk-logo" /> : <div className="bk-logo bk-logo-text">{branch.name.slice(0, 1)}</div>}
          <div>
            <h1>{branch.name}</h1>
            {branch.address && <p>{branch.address}</p>}
          </div>
        </header>

        {step < 4 && !group && (
          <ol className="bk-steps" aria-label="Шаги записи">
            {["Услуга", "Мастер и время", "Контакты"].map((label, index) => (
              <li key={label} className={step === index + 1 ? "on" : step > index + 1 ? "done" : ""}>
                <span>{index + 1}</span>{label}
              </li>
            ))}
          </ol>
        )}

        {notice && <div className="bk-notice" role="alert">{notice}</div>}

        {step === 1 && (
          <section>
            {grouped.length === 0 && <p className="bk-muted">Сейчас нет услуг для онлайн-записи.</p>}
            {grouped.map((group) => (
              <div key={group.id} className="bk-group">
                <h2>{group.title}</h2>
                {group.services.map((item) => (
                  <button key={item.id} className={`bk-service${service?.id === item.id ? " on" : ""}`} onClick={() => pickService(item)}>
                    <span className="bk-service-title">{item.title}</span>
                    <span className="bk-service-meta">{item.durationMin} мин · {formatMoney(item.priceMinor, branch.currency)}{item.depositMinor ? ` · предоплата ${formatMoney(item.depositMinor, branch.currency)}` : ""}</span>
                  </button>
                ))}
              </div>
            ))}
            {!!catalog.groups?.length && (
              <div className="bk-group">
                <h2>Групповые занятия</h2>
                {catalog.groups.map((item) => (
                  <button key={item.id} className="bk-service" onClick={() => { setGroup(item); setGroupFull(item.freeSeats === 0); setNotice(null); setStep(3); }}>
                    <span className="bk-service-title">{item.title}<small className="bk-muted"> · {formatWhen(item.startsAt, tz)}{item.staffName ? ` · ${item.staffName}` : ""}</small></span>
                    <span className="bk-service-meta">{item.freeSeats ? `${item.freeSeats} из ${item.capacity} мест` : "мест нет"} · {formatMoney(item.priceMinor, branch.currency)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {step === 3 && group && !groupResult && (
          <section>
            <div className="bk-picked">
              <span>{group.title} · {formatWhen(group.startsAt, tz)} · {formatMoney(group.priceMinor, branch.currency)}</span>
              <button className="bk-link" onClick={() => { setGroup(null); setNotice(null); setStep(1); }}>Изменить</button>
            </div>
            {group.description && <p className="bk-muted">{group.description}</p>}
            <form className="bk-form" onSubmit={(event) => { event.preventDefault(); void enrollGroup(groupFull); }}>
              <label>Имя<input required autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>Телефон<input required type="tel" autoComplete="tel" placeholder="+7 900 000-00-00" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
              <label className="bk-consent">
                <input type="checkbox" required checked={form.consent} onChange={(event) => setForm({ ...form, consent: event.target.checked })} />
                <span>Согласен(на) на обработку персональных данных по <a href={`/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(branchSlug)}/privacy`} target="_blank" rel="noreferrer">политике</a> салона</span>
              </label>
              <label className="bk-consent">
                <input type="checkbox" checked={form.marketing} onChange={(event) => setForm({ ...form, marketing: event.target.checked })} />
                <span>Хочу получать акции и новости салона</span>
              </label>
              <input className="bk-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} />
              {groupFull && <p className="bk-muted">Свободных мест нет. Встаньте в лист ожидания: если место освободится, мы напишем.</p>}
              <button className="bk-primary" type="submit" disabled={busy}>{busy ? "Записываем…" : groupFull ? "Встать в лист ожидания" : "Записаться на занятие"}</button>
            </form>
          </section>
        )}

        {groupResult && (
          <section className="bk-done">
            <div className="bk-check">✓</div>
            <h2>{groupResult.status === "enrolled" ? "Вы записаны" : "Вы в листе ожидания"}</h2>
            <p className="bk-when">{formatWhen(groupResult.startsAt, tz)}</p>
            <p>{groupResult.title}</p>
            {groupResult.status === "waitlisted" && <p className="bk-muted">Если место освободится, мы пришлём сообщение.</p>}
            <button className="bk-link" onClick={resetAll}>Записаться ещё</button>
          </section>
        )}

        {step === 2 && service && (
          <section>
            <div className="bk-picked">
              <span>{service.title} · {service.durationMin} мин · {formatMoney(service.priceMinor, branch.currency)}</span>
              <button className="bk-link" onClick={() => { setStep(1); setNotice(null); }}>Изменить</button>
            </div>
            <h2>Мастер</h2>
            <div className="bk-chips">
              <button className={!staffId ? "on" : ""} onClick={() => setStaffId(null)}>Любой</button>
              {staffFor.map((member) => (
                <button key={member.id} className={staffId === member.id ? "on" : ""} onClick={() => setStaffId(member.id)}>
                  <i style={{ background: member.color }} />{member.name}
                  {ratings[member.id] && <span className="widget-rating"> ★ {ratings[member.id].rating.toFixed(1)}</span>}
                </button>
              ))}
            </div>
            <h2>Дата</h2>
            <div className="bk-days">
              <button className="bk-arrow" aria-label="Раньше" disabled={from <= today} onClick={() => setFrom(addDays(from, -PAGE_DAYS) < today ? today : addDays(from, -PAGE_DAYS))}>‹</button>
              {Array.from({ length: PAGE_DAYS }, (_, index) => addDays(from, index)).map((value) => {
                const label = dayLabel(value);
                const count = days?.find((item) => item.date === value)?.slots.length ?? 0;
                return (
                  <button key={value} className={`bk-day${value === date ? " on" : ""}${days && !count ? " off" : ""}`} disabled={value > lastDay} onClick={() => setDate(value)}>
                    <small>{label.weekday}</small><b>{label.day}</b><small>{label.month}</small>
                  </button>
                );
              })}
              <button className="bk-arrow" aria-label="Позже" disabled={addDays(from, PAGE_DAYS) > lastDay} onClick={() => setFrom(addDays(from, PAGE_DAYS))}>›</button>
            </div>
            <h2>Время</h2>
            {!days && <p className="bk-muted">Ищем свободное время…</p>}
            {days && !day?.slots.length && <p className="bk-muted">В этот день свободного времени нет. Выберите другой день.</p>}
            <div className="bk-slots">
              {day?.slots.map((slot) => (
                <button key={slot.startsAt} disabled={busy} onClick={() => pickSlot(slot)} title={staffId ? "" : slot.staffIds.map(staffName).join(", ")}>
                  {slot.time}
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 3 && hold && (
          <section>
            <Summary hold={hold} timeZone={tz} currency={branch.currency} />
            <Countdown until={hold.expiresAt} onExpire={() => backToSlots("Время брони истекло. Выберите время заново")} />
            <form
              className="bk-form"
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              <label>Имя<input required autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>Телефон<input required type="tel" autoComplete="tel" placeholder="+7 900 000-00-00" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
              <label>Комментарий<textarea rows={2} value={form.comment} onChange={(event) => setForm({ ...form, comment: event.target.value })} /></label>
              {(catalog.fields ?? []).map((field) => <WidgetField key={field.key} field={field} value={custom[field.key]} onChange={(value) => setCustom({ ...custom, [field.key]: value })} />)}
              <label>Промокод<input autoComplete="off" value={form.promo} onChange={(event) => setForm({ ...form, promo: event.target.value.toUpperCase() })} /></label>
              <label className="bk-consent">
                <input type="checkbox" required checked={form.consent} onChange={(event) => setForm({ ...form, consent: event.target.checked })} />
                <span>Согласен(на) на обработку персональных данных по <a href={`/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(branchSlug)}/privacy`} target="_blank" rel="noreferrer">политике</a> салона</span>
              </label>
              <label className="bk-consent">
                <input type="checkbox" checked={form.marketing} onChange={(event) => setForm({ ...form, marketing: event.target.checked })} />
                <span>Хочу получать акции и новости салона</span>
              </label>
              <input className="bk-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} />
              <button className="bk-primary" type="submit" disabled={busy}>{busy ? "Записываем…" : service?.depositMinor ? `Записаться и внести ${formatMoney(service.depositMinor, branch.currency)}` : "Записаться"}</button>
              <button className="bk-link" type="button" onClick={() => backToSlots()}>Назад к выбору времени</button>
            </form>
          </section>
        )}

        {step === 4 && booking && (
          <section className="bk-done">
            <div className="bk-check">{booking.deposit ? "₽" : "✓"}</div>
            <h2>{booking.deposit ? "Осталось внести предоплату" : "Вы записаны"}</h2>
            <p className="bk-when">{formatWhen(booking.startsAt, tz)}</p>
            <p>{booking.serviceTitle} · {booking.staffName} · {formatMoney(booking.priceMinor, branch.currency)}</p>
            {booking.deposit && (
              <div className="bk-deposit">
                <p>Время закреплено за вами. Внесите предоплату {formatMoney(booking.deposit.amountMinor, branch.currency)} до {new Date(booking.deposit.dueAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz })}, иначе запись отменится.</p>
                <a className="bk-primary" href={booking.deposit.payUrl} target="_top">Оплатить {formatMoney(booking.deposit.amountMinor, branch.currency)}</a>
              </div>
            )}
            {booking.promo && <p className="bk-muted">Промокод {booking.promo.code}: скидка {formatMoney(booking.promo.discountMinor, branch.currency)}</p>}
            <p className="bk-muted">
              Отменить запись можно до {formatWhen(booking.cancelUntil, tz)} по ссылке:{" "}
              <a href={`/booking/${booking.cancelToken}`} target="_top">управление записью</a>. Сохраните её.
            </p>
            {booking.telegramUrl && (
              <a className="bk-telegram" href={booking.telegramUrl} target="_blank" rel="noreferrer">
                Получать напоминания в Telegram
              </a>
            )}
            <button className="bk-link" onClick={resetAll}>
              Записаться ещё
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

/** CF-ONLINE-01: the salon's own questions (at most three), rendered in the widget's style. */
function WidgetField({ field, value, onChange }: { field: OnlineField; value: unknown; onChange: (value: unknown) => void }) {
  const title = `${field.label}${field.required ? "" : " (необязательно)"}`;
  if (field.type === "bool") {
    return (
      <label className="bk-consent">
        <input type="checkbox" required={field.required} checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label>{title}
        <select required={field.required} value={String(value ?? "")} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">Выберите</option>
          {field.options.map((option) => <option key={option}>{option}</option>)}
        </select>
      </label>
    );
  }
  if (field.type === "multiselect") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="bk-field">
        <span>{title}</span>
        <div className="bk-chips">
          {field.options.map((option) => (
            <button key={option} type="button" className={list.includes(option) ? "on" : ""} onClick={() => onChange(list.includes(option) ? list.filter((item) => item !== option) : [...list, option])}>{option}</button>
          ))}
        </div>
      </div>
    );
  }
  const type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
  return (
    <label>{title}
      {field.type === "textarea" ? (
        <textarea rows={2} required={field.required} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input type={type} required={field.required} value={String(value ?? "")} onChange={(event) => onChange(field.type === "number" ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value)} />
      )}
    </label>
  );
}

function Summary({ hold, timeZone, currency }: { hold: Hold; timeZone: string; currency: string }) {
  return (
    <div className="bk-summary">
      <b>{hold.serviceTitle}</b>
      <span>{formatWhen(hold.startsAt, timeZone)}</span>
      <span>Мастер: {hold.staffName} · {formatMoney(hold.priceMinor, currency)}</span>
    </div>
  );
}

function Countdown({ until, onExpire }: { until: string; onExpire: () => void }) {
  const [left, setLeft] = useState(() => new Date(until).getTime() - Date.now());
  const fired = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setLeft(new Date(until).getTime() - Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  useEffect(() => {
    if (left <= 0 && !fired.current) {
      fired.current = true;
      onExpire();
    }
  }, [left, onExpire]);
  const seconds = Math.max(0, Math.floor(left / 1000));
  return (
    <p className="bk-muted bk-timer">
      Время закреплено за вами ещё {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </p>
  );
}
