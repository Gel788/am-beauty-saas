"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, Clock, MapPin, Star } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { portraitFor, SALON_PHOTO } from "./portraits";

type Branch = { id: string; name: string; address: string; timezone: string; currency: string; accent: string; logoUrl: string | null };
type Service = { id: string; title: string; categoryId: string | null; durationMin: number; priceMinor: number; staffIds: string[] };
type Staff = { id: string; name: string; color: string; specialties: string };
type Catalog = { branch: Branch; categories: { id: string; title: string }[]; services: Service[]; staff: Staff[] };
type Reviews = { staff: { staffId: string; rating: number; count: number }[]; latest: { rating: number; body: string; staffId: string | null; author: string; createdAt: string }[] };
type Day = { date: string; slots: { startsAt: string; time: string; staffIds: string[] }[] };

function todayIn(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function whenLabel(date: string, time: string, today: string) {
  const diff = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `завтра в ${time}`;
  const label = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  return `${label}, ${time}`;
}

function stars(rating: number) {
  return (
    <span className="sc-stars" aria-label={`Оценка ${rating.toFixed(1)} из 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={13} className={n <= Math.round(rating) ? "on" : ""} />)}
    </span>
  );
}

/**
 * SHOWCASE-01: the salon's public page — masters with their nearest free time, prices by category,
 * published reviews and one button to book. Everything comes from the public online-booking API.
 */
export function Showcase({ tenantSlug, branchSlug }: { tenantSlug: string; branchSlug: string }) {
  const api = `/api/public/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(branchSlug)}`;
  const book = `/b/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(branchSlug)}`;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [reviews, setReviews] = useState<Reviews | null>(null);
  const [error, setError] = useState("");
  const [nearest, setNearest] = useState<Record<string, { date: string; time: string; serviceId: string }>>({});
  const [category, setCategory] = useState<string>("all");

  useEffect(() => {
    fetch(`${api}/catalog`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message || "Страница салона недоступна");
        setCatalog(body);
      })
      .catch((err: Error) => setError(err.message));
    fetch(`${api}/reviews`).then((res) => (res.ok ? res.json() : null)).then(setReviews).catch(() => undefined);
  }, [api]);

  // Nearest free time per master, on their first (cheapest-to-check) service.
  useEffect(() => {
    if (!catalog) return;
    const today = todayIn(catalog.branch.timezone);
    let alive = true;
    for (const member of catalog.staff.slice(0, 12)) {
      const service = catalog.services.find((item) => item.staffIds.includes(member.id));
      if (!service) continue;
      const query = new URLSearchParams({ serviceId: service.id, staffId: member.id, from: today, days: "7" });
      fetch(`${api}/slots?${query}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { days: Day[] } | null) => {
          const day = data?.days.find((item) => item.slots.length);
          if (alive && day) setNearest((current) => ({ ...current, [member.id]: { date: day.date, time: day.slots[0].time, serviceId: service.id } }));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [api, catalog]);

  const ratingOf = useMemo(() => new Map((reviews?.staff ?? []).map((row) => [row.staffId, row])), [reviews]);
  const overall = useMemo(() => {
    const rows = reviews?.staff ?? [];
    const count = rows.reduce((sum, row) => sum + row.count, 0);
    return count ? { rating: rows.reduce((sum, row) => sum + row.rating * row.count, 0) / count, count } : null;
  }, [reviews]);

  if (error) {
    return (
      <div className="sc-page">
        <div className="sc-empty"><h1>Страница недоступна</h1><p>{error}</p></div>
      </div>
    );
  }
  if (!catalog) return <div className="sc-page"><div className="sc-empty">Загружаем…</div></div>;

  const { branch } = catalog;
  const today = todayIn(branch.timezone);
  const minPrice = (serviceIds: string[]) => Math.min(...catalog.services.filter((item) => serviceIds.includes(item.id)).map((item) => item.priceMinor));
  const visible = catalog.services.filter((item) => category === "all" || item.categoryId === category);
  const groups = catalog.categories
    .map((cat) => ({ ...cat, services: visible.filter((item) => item.categoryId === cat.id) }))
    .concat([{ id: "other", title: "Другое", services: visible.filter((item) => !item.categoryId) }])
    .filter((group) => group.services.length);
  const staffName = (id: string | null) => catalog.staff.find((member) => member.id === id)?.name ?? null;
  const soonest = Object.entries(nearest).sort(([, a], [, b]) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0];

  return (
    <div className="sc-page" style={{ ["--sc-accent" as string]: branch.accent || "#7c5cff" }}>
      <header className="sc-hero">
        <img className="sc-hero-photo" src={branch.logoUrl || SALON_PHOTO} alt="" />
        <div className="sc-hero-shade" />
        <div className="sc-hero-body">
          <h1>{branch.name}</h1>
          <div className="sc-hero-facts">
            {branch.address && <span><MapPin size={15} /> {branch.address}</span>}
            {overall && <span><Star size={15} /> {overall.rating.toFixed(1)} · {overall.count} отзывов</span>}
            {soonest && <span><Clock size={15} /> Свободно {whenLabel(soonest[1].date, soonest[1].time, today)}</span>}
          </div>
          <div className="sc-hero-cta">
            <a className="sc-btn main" href={book}>Записаться онлайн</a>
            <a className="sc-btn ghost" href="#prices">Цены</a>
          </div>
        </div>
      </header>

      <main className="sc-main">
        <section>
          <h2>Мастера</h2>
          <div className="sc-staff">
            {catalog.staff.map((member) => {
              const rating = ratingOf.get(member.id);
              const free = nearest[member.id];
              const photo = portraitFor(member.name);
              const services = catalog.services.filter((item) => item.staffIds.includes(member.id));
              return (
                <article key={member.id} className="sc-master">
                  {photo ? <img src={photo} alt="" /> : <div className="sc-initial" style={{ background: member.color }}>{member.name.slice(0, 1)}</div>}
                  <strong>{member.name}</strong>
                  <span className="sc-muted">{member.specialties || services.slice(0, 2).map((item) => item.title).join(", ")}</span>
                  {rating && <span className="sc-rating">{stars(rating.rating)} {rating.rating.toFixed(1)} <small>({rating.count})</small></span>}
                  {services.length > 0 && <span className="sc-muted">от {formatMoney(minPrice(services.map((item) => item.id)), branch.currency)}</span>}
                  <a className="sc-btn small" href={free ? `${book}?service=${free.serviceId}&staff=${member.id}` : book}>
                    <CalendarCheck size={14} /> {free ? whenLabel(free.date, free.time, today) : "Записаться"}
                  </a>
                </article>
              );
            })}
          </div>
        </section>

        <section id="prices">
          <h2>Услуги и цены</h2>
          {catalog.categories.length > 1 && (
            <div className="sc-tabs" role="tablist">
              <button type="button" className={category === "all" ? "on" : ""} onClick={() => setCategory("all")}>Все</button>
              {catalog.categories.map((cat) => (
                <button type="button" key={cat.id} className={category === cat.id ? "on" : ""} onClick={() => setCategory(cat.id)}>{cat.title}</button>
              ))}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.id} className="sc-group">
              {(category === "all" && groups.length > 1) && <h3>{group.title}</h3>}
              {group.services.map((item) => (
                <a key={item.id} className="sc-service" href={`${book}?service=${item.id}`}>
                  <span>
                    <b>{item.title}</b>
                    <small>{item.durationMin} мин · {item.staffIds.length} {item.staffIds.length === 1 ? "мастер" : item.staffIds.length < 5 ? "мастера" : "мастеров"}</small>
                  </span>
                  <span className="sc-price">{formatMoney(item.priceMinor, branch.currency)}</span>
                </a>
              ))}
            </div>
          ))}
        </section>

        {reviews && reviews.latest.length > 0 && (
          <section>
            <h2>Отзывы</h2>
            <div className="sc-reviews">
              {reviews.latest.map((review, index) => (
                <figure key={index} className="sc-review">
                  {stars(review.rating)}
                  <blockquote>{review.body}</blockquote>
                  <figcaption>
                    {review.author}
                    {staffName(review.staffId) && <span className="sc-muted"> · мастер {staffName(review.staffId)}</span>}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        <footer className="sc-foot">
          {branch.address && (
            <a href={`https://yandex.ru/maps/?text=${encodeURIComponent(branch.address)}`} target="_blank" rel="noreferrer"><MapPin size={15} /> {branch.address} · на карте</a>
          )}
          <a href={`${book}/privacy`} target="_blank" rel="noreferrer">Политика обработки данных</a>
        </footer>
      </main>

      <a className="sc-sticky" href={book}>Записаться онлайн</a>
    </div>
  );
}
