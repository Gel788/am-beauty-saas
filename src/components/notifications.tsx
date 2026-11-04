"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { api } from "./api";

type Item = { id: string; kind: string; title: string; body: string; entity: string | null; entityId: string | null; read: boolean; createdAt: string };
type Feed = { unread: number; items: Item[] };

function ago(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

const TONE: Record<string, string> = {
  "booking.online": "new",
  "booking.confirmed": "ok",
  "payment.online": "ok",
  "booking.cancelled": "warn",
  "booking.cancel_requested": "warn",
  "payment.online_problem": "bad",
  "fiscal.failed": "bad",
};

/** MSG-DESK-01: the desk's feed, polled every 30 s. */
export function Notifications() {
  const router = useRouter();
  const [feed, setFeed] = useState<Feed>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<Feed>("/api/notifications").then(setFeed).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function readAll() {
    setFeed(await api<Feed>("/api/notifications/read", { method: "POST", body: "{}" }));
  }

  async function follow(item: Item) {
    if (!item.read) api<Feed>("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [item.id] }) }).then(setFeed).catch(() => undefined);
    setOpen(false);
    if (item.entity === "appointment" && item.entityId) router.push(`/journal?open=${item.entityId}`);
    else if (item.kind === "fiscal.failed") router.push("/cash?tab=receipts");
    else if (item.entity === "schedule_request") router.push("/staff");
  }

  return (
    <div className="notify" ref={ref}>
      <button type="button" className={`nav-item ${open ? "active" : ""}`} onClick={() => setOpen(!open)}>
        <Bell />
        Уведомления
        {feed.unread > 0 && <span className="nav-badge">{feed.unread > 99 ? "99+" : feed.unread}</span>}
      </button>
      {open && (
        <div className="notify-panel" role="dialog" aria-label="Уведомления">
          <div className="notify-head">
            <strong>Уведомления</strong>
            {feed.unread > 0 && <button type="button" className="btn-ghost" onClick={readAll}>Прочитать все</button>}
          </div>
          {feed.items.length === 0 && <p className="muted" style={{ padding: "18px 4px" }}>Пока тихо. Здесь появятся онлайн-записи, подтверждения, отмены и оплаты.</p>}
          <div className="notify-list">
            {feed.items.map((item) => (
              <button key={item.id} type="button" className={`notify-item ${item.read ? "" : "unread"} tone-${TONE[item.kind] ?? "new"}`} onClick={() => follow(item)}>
                <span className="notify-dot" />
                <span className="notify-text">
                  <b>{item.title}</b>
                  {item.body && <span>{item.body}</span>}
                  <small>{ago(item.createdAt)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
