"use client";

import { useEffect, useState } from "react";

type Info = { branchName: string; staffName: string; services: string; date: string; review: { rating: number; body: string } | null };

const LABELS = ["", "Плохо", "Так себе", "Нормально", "Хорошо", "Отлично"];

/** REV-CREATE-01: the client's page behind the review link. */
export function ReviewPage({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/api/public/review/${token}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message ?? "Ссылка недействительна");
        setInfo(data);
      })
      .catch((err: Error) => setError(err.message));
  }, [token]);

  async function send() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/public/review/${token}`, { method: "POST", body: JSON.stringify({ rating, body }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? "Не получилось отправить");
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return (
      <main className="pay-page">
        <div className="pay-card">{error ? <><h1 style={{ margin: 0, fontSize: 22 }}>Ссылка не работает</h1><p className="muted">{error}</p></> : <div className="skeleton" />}</div>
      </main>
    );
  }
  const shown = hover || rating;
  const finished = done || info.review;
  return (
    <main className="pay-page">
      <div className="pay-card review-public">
        <span className="muted">{info.branchName}</span>
        <h1 style={{ margin: 0, fontSize: 24 }}>{finished ? "Спасибо за отзыв!" : "Как прошёл визит?"}</h1>
        <span className="muted">{info.services} · мастер {info.staffName}</span>
        {finished ? (
          <>
            <div className="review-stars big" aria-label={`Оценка ${info.review?.rating ?? rating}`}>
              {[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= (info.review?.rating ?? rating) ? "on" : ""}>★</span>)}
            </div>
            <p className="muted">Мы прочитаем каждое слово. Ждём вас снова!</p>
          </>
        ) : (
          <>
            <div className="review-stars big" role="radiogroup" aria-label="Оценка" onMouseLeave={() => setHover(0)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} из 5`} className={n <= shown ? "on" : ""} onMouseEnter={() => setHover(n)} onClick={() => setRating(n)}>★</button>
              ))}
            </div>
            <span className="review-label">{LABELS[shown] || "Нажмите на звезду"}</span>
            <textarea className="review-text" rows={4} maxLength={2000} placeholder={rating && rating <= 3 ? "Что нам исправить? Владелец прочитает лично." : "Что понравилось? (необязательно)"} value={body} onChange={(event) => setBody(event.target.value)} />
            {error && <p className="error-text">{error}</p>}
            <button className="btn-gradient" disabled={!rating || busy} onClick={send}>Отправить</button>
          </>
        )}
      </div>
    </main>
  );
}
