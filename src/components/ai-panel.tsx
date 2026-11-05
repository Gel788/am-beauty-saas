"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, CalendarClock, CheckCheck, Coins, Hourglass, Package, RefreshCw, Sparkles, UserRoundCheck } from "lucide-react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";
import { addCalendarDays, localMinutes, todayInZone } from "@/domain/time";
import { buildPulse, hhmm, type PulseAction, type PulseCard, type PulseDay, type PulseDue, type PulseEntry, type PulseSlot } from "@/domain/pulse";

type Me = { branches: { id: string; timezone: string }[] };
type Item = { title: string; trackStock: boolean; active: boolean; minQty: number; qty: number };

const ICONS: Record<string, typeof Sparkles> = { late: AlertCircle, unmarked: AlertCircle, next: UserRoundCheck, debts: Coins, wait: Hourglass, gaps: CalendarClock, confirm: CheckCheck, due: RefreshCw, stock: Package };

function rub(minor: number) {
  return `${new Intl.NumberFormat("ru-RU").format(Math.round(minor / 100))} ₽`;
}

/** Tell the journal (and this panel) that something changed. */
export function journalChanged() {
  window.dispatchEvent(new Event("journal-changed"));
}

/**
 * PULSE-01: «Пульт дня» next to the journal. Today's and tomorrow's visits, the waiting list,
 * clients due back and the warehouse turn into a short list of things to do, each one click away.
 */
export function AiPanel() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [branch, setBranch] = useState<{ id: string; timezone: string } | null>(null);
  const [data, setData] = useState<{ today: PulseDay; tomorrow: PulseDay | null; slots: PulseSlot[]; entries: PulseEntry[]; due: PulseDue[]; lowStock: string[] } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api<Me>("/api/auth/me")
      .then((me) => setBranch(me.branches.find((item) => item.id === params.get("branch")) ?? me.branches[0] ?? null))
      .catch(() => undefined);
  }, [params]);

  const load = useCallback(async () => {
    if (!branch) return;
    const today = todayInZone(branch.timezone);
    const q = `branchId=${branch.id}&showOff=0&showCancelled=0`;
    const [day, next, wait, due, items] = await Promise.all([
      api<PulseDay>(`/api/journal?date=${today}&${q}`),
      api<PulseDay>(`/api/journal?date=${addCalendarDays(today, 1)}&${q}`).catch(() => null),
      api<{ entries: PulseEntry[]; slots: PulseSlot[] }>(`/api/retention/waitlist?branchId=${branch.id}`).catch(() => ({ entries: [], slots: [] })),
      api<PulseDue[]>(`/api/retention/due?branchId=${branch.id}`).catch(() => []),
      api<Item[]>(`/api/inventory/items?branchId=${branch.id}`).catch(() => []),
    ]);
    const lowStock = items.filter((item) => item.trackStock && item.active && item.minQty > 0 && item.qty <= item.minQty).map((item) => item.title);
    setData({ today: day, tomorrow: next, slots: wait.slots, entries: wait.entries, due, lowStock });
    setNow(new Date());
  }, [branch]);

  useEffect(() => {
    void load().catch(() => undefined);
    const tick = window.setInterval(() => void load().catch(() => undefined), 60_000);
    const onChange = () => void load().catch(() => undefined);
    window.addEventListener("journal-changed", onChange);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("journal-changed", onChange);
    };
  }, [load]);

  const pulse = useMemo(() => {
    if (!data || !branch) return null;
    return buildPulse({ ...data, nowMin: localMinutes(now, branch.timezone) });
  }, [data, branch, now]);

  async function run(card: PulseCard, action: PulseAction) {
    if (!branch) return;
    const key = `${card.key}:${action.label}`;
    setBusy(key);
    try {
      if (action.kind === "status") {
        await api(`/api/appointments/${action.appointmentId}/status`, { method: "POST", body: JSON.stringify({ status: action.status, version: action.version, acknowledgeSoft: true }) });
        toast(action.status === "confirmed" ? "Запись подтверждена" : action.status === "arrived" ? "Отметили: клиент пришёл" : "Отметили неявку");
        journalChanged();
      } else if (action.kind === "open") {
        router.push(`/journal?branch=${branch.id}&open=${action.appointmentId}`);
      } else if (action.kind === "book") {
        window.dispatchEvent(new CustomEvent("open-command-bar", { detail: { text: action.text } }));
      } else if (action.kind === "offer") {
        const result = await api<{ sent: boolean; error: string | null }>(`/api/retention/waitlist/${action.entryId}/offer`, { method: "POST", body: JSON.stringify({ appointmentId: action.appointmentId }) });
        toast(result.sent ? "Предложили окно клиенту" : `Не отправилось: ${result.error ?? "нет канала связи"}`, result.sent ? "ok" : "error");
        await load();
      } else if (action.kind === "remind") {
        const result = await api<{ sent: boolean; error: string | null }>(`/api/retention/due/${action.clientId}/remind?branchId=${branch.id}`, { method: "POST", body: "{}" });
        toast(result.sent ? "Напоминание отправлено" : `Не отправилось: ${result.error ?? "нет канала связи"}`, result.sent ? "ok" : "error");
        await load();
      } else {
        router.push(action.href);
      }
    } catch (err) {
      toast((err as ApiError).message ?? "Не получилось", "error");
      await load().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  const summary = pulse?.summary;
  const progress = summary && summary.expectedMinor > 0 ? Math.min(100, Math.round((summary.paidMinor / summary.expectedMinor) * 100)) : 0;

  return (
    <aside className="ai-panel pulse" id="ai-panel" aria-label="Пульт дня">
      <div className="ai-head">
        <div className="ai-orb" />
        <div>
          <strong>Пульт дня</strong>
          <span>{branch ? `Обновлено в ${hhmm(localMinutes(now, branch.timezone))}` : "Загружаем…"}</span>
        </div>
      </div>

      {summary && (
        <div className="pulse-sum">
          <div>
            <b>{rub(summary.paidMinor)}</b>
            <span>из {rub(summary.expectedMinor)} за сегодня</span>
          </div>
          <div className="pulse-bar"><i style={{ width: `${progress}%` }} /></div>
          <div className="pulse-facts">
            <span><b>{summary.visits}</b> визитов</span>
            <span><b>{summary.done}</b> готово</span>
            <span><b>{summary.left}</b> впереди</span>
            <span><b>{Math.round(summary.freeMin / 60)} ч</b> окон</span>
          </div>
        </div>
      )}

      {pulse && pulse.cards.length === 0 && (
        <div className="pulse-calm">
          <Sparkles size={18} />
          Всё под контролем: опозданий, долгов и пустых окон нет.
        </div>
      )}

      {pulse?.cards.map((card) => {
        const Icon = ICONS[card.key.split("-")[0]] ?? Sparkles;
        return (
          <div key={card.key} className={`pulse-card ${card.tone}`}>
            <div className="pulse-title">
              <span className="pulse-ico"><Icon size={15} /></span>
              <strong>{card.title}</strong>
            </div>
            {card.hint && <p>{card.hint}</p>}
            {card.actions.length > 0 && (
              <div className="pulse-actions">
                {card.actions.map((action, index) => (
                  <button
                    key={action.label}
                    type="button"
                    className={index === 0 ? "pulse-btn main" : "pulse-btn"}
                    disabled={busy === `${card.key}:${action.label}`}
                    onClick={() => void run(card, action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
