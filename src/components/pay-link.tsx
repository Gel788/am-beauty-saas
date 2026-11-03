"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Link = {
  id: string;
  purpose: "deposit" | "visit";
  amountMinor: number;
  status: "created" | "pending" | "succeeded" | "canceled" | "expired";
  method: string | null;
  error: string | null;
  expiresAt: string;
  paidAt: string | null;
  url?: string;
};

const STATUS: Record<Link["status"], [string, string]> = {
  created: ["ждёт оплаты", "tag-muted"],
  pending: ["ждёт оплаты", "tag-muted"],
  succeeded: ["оплачено", "tag-ok"],
  canceled: ["отменена", "tag-muted"],
  expired: ["истекла", "tag-muted"],
};

/** ACQ-LINK-01 in the record drawer: send the client a link to pay by card or SBP. */
export function PayLinkBlock({ appointmentId, dueMinor, onPaid }: { appointmentId: string; dueMinor: number; onPaid: () => void }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [links, setLinks] = useState<Link[]>([]);
  const [fresh, setFresh] = useState<Record<string, string>>({});
  const [rub, setRub] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ enabled: boolean; links: Link[] }>(`/api/appointments/${appointmentId}/pay-links`);
      setEnabled(data.enabled);
      setLinks((before) => {
        const justPaid = data.links.some((link) => link.status === "succeeded" && before.find((old) => old.id === link.id)?.status === "pending");
        if (justPaid) {
          toast("Клиент оплатил по ссылке");
          onPaid();
        }
        return data.links;
      });
    } catch {
      setEnabled(false);
    }
  }, [appointmentId, onPaid, toast]);

  useEffect(() => {
    load();
  }, [load]);
  const waiting = links.some((link) => link.status === "pending" || link.status === "created");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [waiting, load]);
  useEffect(() => setRub(dueMinor > 0 ? String(dueMinor / 100) : ""), [dueMinor]);

  if (!enabled) return null;
  const active = links.find((link) => link.status === "pending" || link.status === "created");
  const shown = links.slice(0, 3);
  return (
    <div className="list" style={{ gap: 6, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
      <div className="muted" style={{ fontSize: 12 }}>Оплата по ссылке: карта или СБП</div>
      {dueMinor > 0 && !active && (
        <div className="row">
          <input aria-label="Сумма по ссылке, ₽" value={rub} onChange={(event) => setRub(event.target.value)} style={{ width: 110 }} />
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const link = await api<Link>(`/api/appointments/${appointmentId}/pay-links`, {
                  method: "POST",
                  body: JSON.stringify({ amountMinor: rublesToMinor(Number(rub.replace(",", "."))) }),
                });
                if (link.url) {
                  setFresh((map) => ({ ...map, [link.id]: link.url! }));
                  navigator.clipboard?.writeText(link.url).catch(() => undefined);
                }
                toast("Ссылка создана и скопирована");
                await load();
              } catch (error) {
                toast((error as ApiError).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Создать ссылку
          </button>
        </div>
      )}
      {shown.map((link) => (
        <div key={link.id} className="list" style={{ gap: 4 }}>
          <div className="spread">
            <span>{link.purpose === "deposit" ? "Предоплата" : "Оплата"} {formatMoney(link.amountMinor)}{link.method ? ` · ${link.method === "sbp" ? "СБП" : "карта"}` : ""}</span>
            <span className={`tag ${STATUS[link.status][1]}`}>{STATUS[link.status][0]}</span>
          </div>
          {fresh[link.id] && (link.status === "pending" || link.status === "created") && (
            <div className="row" style={{ gap: 6 }}>
              <input readOnly value={fresh[link.id]} onFocus={(event) => event.target.select()} style={{ flex: 1, fontSize: 12 }} />
              <button className="btn-ghost" type="button" onClick={() => navigator.clipboard?.writeText(fresh[link.id]).then(() => toast("Скопировано"))}>Копировать</button>
            </div>
          )}
          {(link.status === "pending" || link.status === "created") && (
            <div className="row" style={{ gap: 6 }}>
              <span className="muted" style={{ fontSize: 12, flex: 1 }}>до {new Date(link.expiresAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              <button
                className="btn-ghost"
                type="button"
                onClick={async () => {
                  try {
                    await api(`/api/pay-links/${link.id}/cancel`, { method: "POST" });
                    await load();
                  } catch (error) {
                    toast((error as ApiError).message, "error");
                  }
                }}
              >
                Отменить ссылку
              </button>
            </div>
          )}
          {link.error && <span className="muted" style={{ fontSize: 12, color: "var(--bad, #b42318)" }}>{link.error}</span>}
        </div>
      ))}
    </div>
  );
}
