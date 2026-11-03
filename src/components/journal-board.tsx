"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Gauge, Plus, Search, Sparkles, UserPlus, Wallet } from "lucide-react";
import type { AppointmentStatus } from "@/domain/status";
import { addCalendarDays, todayInZone, weekdayLabel, zonedDateTimeToUtc } from "@/domain/time";
import { hitTestColumn, pointerIntent, resolveDrop } from "@/domain/grid";
import { api, type ApiError } from "./api";
import { RecordDrawer, type DrawerSeed } from "./record-drawer";
import { portraitFor } from "./portraits";
import { useToast } from "./ui";

type Appt = {
  id: string;
  staffId: string;
  clientName: string | null;
  guest: boolean;
  startsAt: string;
  endsAt: string;
  startMin: number;
  endMin: number;
  status: AppointmentStatus;
  source: string;
  color: string;
  version: number;
  services: { title: string }[];
  priceMinor: number;
  paidMinor: number;
  forceOverlap: boolean;
};

type Column = {
  id: string;
  name: string;
  color: string;
  dayOff: boolean;
  loadPercent: number;
  intervals: { startMin: number; endMin: number; kind: "work" | "break" }[];
};

type Journal = {
  date: string;
  branch: { id: string; timezone: string; gridLabelMin: number };
  density: "comfortable" | "compact";
  dayStartMin: number;
  dayEndMin: number;
  staff: Column[];
  appointments: Appt[];
  stats: { expectedRevenueMinor: number; loadPercent: number; appointmentCount: number; onlineCount: number; newClients: number };
};

type Drag = {
  id: string;
  mode: "move" | "resize";
  originStart: number;
  originEnd: number;
  originStaff: string;
  previewStart: number;
  previewEnd: number;
  previewStaff: string;
  invalid: boolean;
  outside: boolean;
  active: boolean;
};

export function JournalBoard() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const [journal, setJournal] = useState<Journal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [branchId, setBranchId] = useState(params.get("branch") ?? "");
  const [timezone, setTimezone] = useState("Europe/Moscow");
  const [date, setDate] = useState(params.get("date") ?? "");
  const [showOff, setShowOff] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [seed, setSeed] = useState<DrawerSeed | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [view, setView] = useState<"day" | "week" | "month">("day");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [found, setFound] = useState<{ id: string; clientName: string; staffName: string; startsAt: string; date: string }[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ branches: { id: string; timezone: string }[] }>("/api/auth/me").then((me) => {
      const branch = me.branches.find((item) => item.id === params.get("branch")) ?? me.branches[0];
      if (!branch) return;
      setBranchId(branch.id);
      setTimezone(branch.timezone);
      setDate(params.get("date") || todayInZone(branch.timezone));
    }).catch((err: ApiError) => setError(err.message));
  }, [params]);

  function go(nextDate: string, nextBranch = branchId) {
    const query = new URLSearchParams({ date: nextDate, branch: nextBranch });
    router.replace(`/journal?${query.toString()}`);
    setDate(nextDate);
  }

  useEffect(() => {
    if (!branchId || !date) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    fetch(`/api/journal?date=${date}&branchId=${branchId}&showOff=${showOff ? "1" : "0"}&showCancelled=${showCancelled ? "1" : "0"}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message || "Не удалось открыть журнал");
        setJournal(body);
        setError("");
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [branchId, date, showOff, showCancelled]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName;
      if (event.key === "Escape") {
        if (drag?.active) {
          setDrag(null);
          return;
        }
        setSeed(null);
        return;
      }
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "n" || event.key === "N" || event.key === "т" || event.key === "Т") {
        const staffId = journal?.staff[0]?.id;
        if (staffId) setSeed({ staffId, startMin: journal?.dayStartMin ?? 600, date });
      }
      if (event.key === "/") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [journal, date, drag]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api<typeof found>(`/api/search?q=${encodeURIComponent(search)}&branchId=${branchId}`).then(setFound).catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, branchId]);

  const visibleStaff = useMemo(() => {
    const order = ["Алина Ковалёва", "Марина Соколова", "Денис Волков", "Елена Лебедева"];
    return (journal?.staff ?? []).slice().sort((a, b) => {
      const left = order.indexOf(a.name);
      const right = order.indexOf(b.name);
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    });
  }, [journal]);
  const [trackH, setTrackH] = useState(0);
  const [viewportH, setViewportH] = useState(900);
  useEffect(() => {
    const sync = () => setViewportH(window.innerHeight);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  const dayStart = journal?.dayStartMin ?? 600;
  const dayEnd = journal?.dayEndMin ?? 1200;
  const span = Math.max(30, dayEnd - dayStart);
  const hourPx = viewportH >= 880 || trackH <= 0 ? 70 : Math.min(70, trackH / (span / 60));
  const px = hourPx / 60;

  async function commitDrag(current: Drag) {
    const decision = resolveDrop({ outside: current.outside, staffId: current.previewStaff, hardInvalid: current.invalid });
    if (decision === "cancel") {
      setDrag(null);
      return;
    }
    if (decision === "reject") {
      toast("Это время занято или выходит за день", "error");
      setDrag(null);
      return;
    }
    const appt = journal?.appointments.find((item) => item.id === current.id);
    if (!appt) return;
    try {
      if (current.mode === "resize") {
        const endsAt = zonedDateTimeToUtc(date, current.previewEnd, timezone).toISOString();
        await api(`/api/appointments/${appt.id}/resize`, { method: "POST", body: JSON.stringify({ version: appt.version, endsAt, acknowledgeSoft: true }) });
      } else {
        const startsAt = zonedDateTimeToUtc(date, current.previewStart, timezone).toISOString();
        await api(`/api/appointments/${appt.id}/move`, {
          method: "POST",
          body: JSON.stringify({ version: appt.version, startsAt, staffId: current.previewStaff, acknowledgeSoft: true }),
        });
      }
      toast("Запись перенесена");
      setDrag(null);
      setJournal(null);
      setLoading(true);
      const fresh = await api<Journal>(`/api/journal?date=${date}&branchId=${branchId}&showOff=${showOff ? "1" : "0"}&showCancelled=${showCancelled ? "1" : "0"}`);
      setJournal(fresh);
      setLoading(false);
    } catch (error) {
      const err = error as ApiError;
      if (err.code === "CONFLICT_SLOT") {
        const reason = window.prompt("Пересекается с другой записью. Причина, чтобы оставить так");
        if (reason && current.mode === "move") {
          const startsAt = zonedDateTimeToUtc(date, current.previewStart, timezone).toISOString();
          await api(`/api/appointments/${appt.id}/move`, {
            method: "POST",
            body: JSON.stringify({ version: appt.version, startsAt, staffId: current.previewStaff, acknowledgeSoft: true, forceOverlap: true, overlapReason: reason }),
          });
          toast("Запись перенесена поверх");
        } else toast(err.message, "error");
      } else toast(err.message, "error");
      setDrag(null);
      const fresh = await api<Journal>(`/api/journal?date=${date}&branchId=${branchId}`);
      setJournal(fresh);
    }
  }

  function onBlockPointerDown(event: React.PointerEvent, appt: Appt, mode: "move" | "resize") {
    if (appt.status === "cancelled" || appt.status === "completed") return;
    event.stopPropagation();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const started = Date.now();
    let current: Drag = {
      id: appt.id,
      mode,
      originStart: appt.startMin,
      originEnd: appt.endMin,
      originStaff: appt.staffId,
      previewStart: appt.startMin,
      previewEnd: appt.endMin,
      previewStaff: appt.staffId,
      invalid: false,
      outside: false,
      active: mode === "resize",
    };
    const move = (ev: PointerEvent) => {
      const elapsed = Date.now() - started;
      if (mode === "move" && pointerIntent(elapsed) === "click") return;
      const delta = Math.round((ev.clientY - startY) / px / 5) * 5;
      const duration = current.originEnd - current.originStart;
      const previewStart = mode === "resize" ? current.originStart : current.originStart + delta;
      const previewEnd = mode === "resize" ? current.originEnd + delta : previewStart + duration;
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-staff]")].map((node) => {
        const rect = node.getBoundingClientRect();
        return { staffId: node.dataset.staff || "", x: rect.left, width: rect.width, hidden: false };
      });
      const staffId = mode === "move" ? hitTestColumn(nodes, ev.clientX) : appt.staffId;
      const outside = mode === "move" && (staffId == null || Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 0 && staffId == null);
      const boundsInvalid = previewStart < 0 || previewEnd > 24 * 60;
      const clash = (journal?.appointments ?? []).some((item) => item.id !== appt.id && item.status !== "cancelled" && item.staffId === (staffId ?? appt.staffId) && previewStart < item.endMin && item.startMin < previewEnd);
      current = {
        ...current,
        active: true,
        previewStart,
        previewEnd,
        previewStaff: staffId ?? appt.staffId,
        outside: Boolean(outside && staffId == null),
        invalid: boundsInvalid || clash,
      };
      setDrag(current);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!current.active) {
        setSeed({ id: appt.id, staffId: appt.staffId, startMin: appt.startMin, date });
        return;
      }
      void commitDrag(current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

const TONE: Record<string, { card: string; title: string; sub: string; ring: boolean }> = {
  "Алина Ковалёва": { card: "border-rose-400 bg-gradient-to-br from-rose-100 to-pink-50", title: "text-rose-950", sub: "text-rose-700/70", ring: true },
  "Марина Соколова": { card: "border-amber-400 bg-gradient-to-br from-amber-100 to-orange-50", title: "text-amber-950", sub: "text-amber-800/70", ring: false },
  "Денис Волков": { card: "border-sky-400 bg-gradient-to-br from-sky-100 to-indigo-50", title: "text-sky-950", sub: "text-sky-800/70", ring: false },
  "Елена Лебедева": { card: "border-emerald-400 bg-gradient-to-br from-emerald-100 to-teal-50", title: "text-emerald-950", sub: "text-emerald-800/70", ring: false },
};

function rub(minor: number): string {
  const value = minor / 100;
  const digits = Number.isInteger(value) ? 0 : 2;
  const formatted = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return `${formatted.replace(/\u00A0/g, " ")} ₽`;
}

function ruRecords(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "запись" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "записи" : "записей";
  return `${count} ${word}`;
}

function toneFor(name: string) {
  return TONE[name] ?? TONE["Алина Ковалёва"];
}

  const marks: number[] = [];
  for (let minute = Math.ceil(dayStart / 60) * 60; minute <= dayEnd; minute += 60) marks.push(minute);

  useEffect(() => {
    const root = columnsRef.current;
    if (!root) return;
    const measure = () => setTrackH(root.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [journal, view, visibleStaff.length]);

  const nowMin = (() => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  })();
  const showNow = date === todayInZone(timezone) && nowMin >= dayStart && nowMin <= dayEnd;
  const hh = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

  return (
    <div className="glass rounded-[28px] flex-1 flex flex-col overflow-hidden min-h-0">
      <header className="flex items-center px-6 pt-5 gap-3 shrink-0">
        <div className="min-w-0">
          <div className="text-[12px] text-muted font-medium whitespace-nowrap">{date === todayInZone(timezone) ? "Сегодня" : "День"} · {journal?.stats.appointmentCount ?? 0} записей</div>
          <div className="flex items-end gap-1">
            <h1 className="journal-date font-display text-[24px] font-semibold leading-tight mt-0.5 whitespace-nowrap">{date ? weekdayLabel(date, timezone) : "Журнал"}</h1>
            <label className="sr">
              Дата
              <input type="date" value={date} onChange={(event) => go(event.target.value)} />
            </label>
          </div>
        </div>
        <div className="flex gap-1 ml-2 self-end mb-1 shrink-0">
          <button className="w-8 h-8 rounded-lg solid grid place-items-center text-muted" type="button" aria-label="Предыдущий день" onClick={() => go(addCalendarDays(date, -1))}><ChevronLeft className="w-4 h-4" strokeWidth={1.8} /></button>
          <button className="w-8 h-8 rounded-lg solid grid place-items-center text-muted" type="button" aria-label="Следующий день" onClick={() => go(addCalendarDays(date, 1))}><ChevronRight className="w-4 h-4" strokeWidth={1.8} /></button>
        </div>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <div className="flex p-1 rounded-xl bg-ink/[.05] text-[13px]">
            <button className={view === "day" ? "px-3 py-1.5 rounded-lg bg-white shadow-sm font-semibold" : "px-3 py-1.5 text-muted"} onClick={() => setView("day")} type="button">День</button>
            <button className={view === "week" ? "px-3 py-1.5 rounded-lg bg-white shadow-sm font-semibold" : "px-3 py-1.5 text-muted"} onClick={() => setView("week")} type="button">Неделя</button>
            <button className={view === "month" ? "px-3 py-1.5 rounded-lg bg-white shadow-sm font-semibold" : "px-3 py-1.5 text-muted"} onClick={() => setView("month")} type="button">Месяц</button>
          </div>
          <div className="relative">
            <button className="w-10 h-10 rounded-xl solid grid place-items-center text-ink/70" type="button" aria-label="Поиск записей" onClick={() => { setSearchOpen((value) => !value); window.setTimeout(() => searchRef.current?.focus(), 0); }}>
              <Search className="ic" strokeWidth={1.8} />
            </button>
            {searchOpen && (
              <div className="search-pop panel">
                <div className="search">
                  <input ref={searchRef} value={search} placeholder="Клиент или телефон" aria-label="Поиск записей" onChange={(event) => setSearch(event.target.value)} />
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="chip" type="button" onClick={() => setShowOff((value) => !value)}>{showOff ? "Скрыть выходных" : "Без смены"}</button>
                  <button className="chip" type="button" onClick={() => setShowCancelled((value) => !value)}>{showCancelled ? "Скрыть отменённые" : "Отменённые"}</button>
                </div>
                {found.map((item) => (
                  <button key={item.id} className="person" type="button" onClick={() => { go(item.date); setSeed({ id: item.id, staffId: "", startMin: 0, date: item.date }); setSearch(""); setSearchOpen(false); }}>
                    <div><strong>{item.clientName}</strong><span>{item.staffName}</span></div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="h-10 px-4 rounded-xl grad cta text-white text-[13px] font-semibold flex items-center gap-1.5 whitespace-nowrap" type="button" onClick={() => setSeed({ staffId: visibleStaff[0]?.id ?? "", startMin: dayStart, date })}>
            <Plus className="w-4 h-4" strokeWidth={1.8} />
            Запись
          </button>
        </div>
      </header>
      {journal && (
        <div className="flex items-center gap-8 px-6 mt-4 shrink-0">
          <div className="flex items-center gap-2.5"><span className="w-8 h-8 rounded-xl bg-white solid grid place-items-center text-acc"><Wallet className="w-4 h-4" strokeWidth={1.8} /></span><div className="leading-tight"><div className="text-[14px] font-semibold whitespace-nowrap">{rub(journal.stats.expectedRevenueMinor)}</div><div className="text-[11px] text-muted whitespace-nowrap">ожидаемая выручка</div></div></div>
          <div className="flex items-center gap-2.5"><span className="w-8 h-8 rounded-xl bg-white solid grid place-items-center text-acc"><Gauge className="w-4 h-4" strokeWidth={1.8} /></span><div className="leading-tight"><div className="text-[14px] font-semibold whitespace-nowrap">{journal.stats.loadPercent}%</div><div className="text-[11px] text-muted whitespace-nowrap">загрузка дня</div></div></div>
          <div className="flex items-center gap-2.5"><span className="w-8 h-8 rounded-xl bg-white solid grid place-items-center text-acc"><Sparkles className="w-4 h-4" strokeWidth={1.8} /></span><div className="leading-tight"><div className="text-[14px] font-semibold whitespace-nowrap">{ruRecords(journal.stats.onlineCount)}</div><div className="text-[11px] text-muted whitespace-nowrap">сделал AI</div></div></div>
          <div className="flex items-center gap-2.5"><span className="w-8 h-8 rounded-xl bg-white solid grid place-items-center text-acc"><UserPlus className="w-4 h-4" strokeWidth={1.8} /></span><div className="leading-tight"><div className="text-[14px] font-semibold whitespace-nowrap">{journal.stats.newClients}</div><div className="text-[11px] text-muted whitespace-nowrap">новых клиента</div></div></div>
        </div>
      )}
      {view !== "day" ? (
        <div className="m-6 panel empty">Неделя и месяц — следующая фаза. Сейчас работает дневной журнал.</div>
      ) : (
        <div className="flex flex-1 flex-col min-h-0 mt-4">
          {loading && !journal && <div className="skeleton mx-6" />}
          {error && <div className="banner mx-6">{error}</div>}
          {journal && visibleStaff.length === 0 && (
            <div className="empty">
              <strong>Нет смен</strong>
              <p>На этот день никто не выходит.</p>
              <a className="btn-gradient" href="/staff" style={{ display: "inline-block" }}>Расписание</a>
            </div>
          )}
          {journal && visibleStaff.length > 0 && (
            <>
              <div className="flex h-14 border-y border-ink/[.06] bg-white/40 shrink-0">
                <div className="w-14 shrink-0" />
                {visibleStaff.map((staff) => {
                  const photo = portraitFor(staff.name);
                  return (
                    <div className="flex-1 flex items-center gap-2.5 px-3 min-w-0" key={staff.id}>
                      <div className="relative shrink-0">
                        {photo ? <img src={photo} alt="" className="w-9 h-9 rounded-full object-cover border-2 border-white avatar-shadow" /> : <span className="avatar">{staff.name.slice(0, 1)}</span>}
                        <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white" />
                      </div>
                      <div className="leading-tight min-w-0 flex-1">
                        <div className="text-[13px] font-semibold truncate">{staff.name}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <div className="h-1 w-12 rounded-full bg-ink/10"><div className="h-full rounded-full grad" style={{ width: `${Math.min(100, staff.loadPercent)}%` }} /></div>
                          <span className="text-[11px] text-muted">{staff.loadPercent}%</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-1 relative overflow-hidden min-h-0" ref={columnsRef}>
                <div className="w-14 shrink-0 relative">
                  {marks.filter((minute) => minute > dayStart && minute < dayEnd).map((minute) => (
                    <div key={minute} className="absolute right-3 text-[11px] text-muted font-medium -translate-y-1/2" style={{ top: ((minute - dayStart) / 60) * hourPx }}>
                      {hh(minute)}
                    </div>
                  ))}
                </div>
                <div className="flex flex-1 relative">
                  {marks.map((minute) => (
                    <div key={minute} className="absolute inset-x-0 border-t border-ink/[.06]" style={{ top: ((minute - dayStart) / 60) * hourPx }} />
                  ))}
                  {visibleStaff.map((staff) => (
                    <div
                      key={staff.id}
                      className="day-col flex-1 border-l border-ink/[.06] relative"
                      data-staff={staff.id}
                      onClick={(event) => {
                        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                        const minute = dayStart + Math.round((event.clientY - rect.top) / px / 5) * 5;
                        setSeed({ staffId: staff.id, startMin: minute, date });
                      }}
                    >
                      {journal.appointments.filter((appt) => appt.staffId === staff.id).map((appt) => {
                        const preview = drag?.id === appt.id && drag.active ? drag : null;
                        const start = preview && preview.previewStaff === staff.id ? preview.previewStart : appt.startMin;
                        const end = preview && preview.previewStaff === staff.id ? preview.previewEnd : appt.endMin;
                        const movedAway = preview && preview.previewStaff !== staff.id;
                        const tone = toneFor(staff.name);
                        const serviceTitle = appt.services[0]?.title ?? "";
                        const longEnough = end - start >= 60;
                        const ai = appt.source === "online";
                        return (
                          <button
                            key={appt.id}
                            className={`appt absolute left-1.5 right-1.5 rounded-2xl border-l-[3px] px-3 py-2 overflow-hidden ${tone.card} ${ai && tone.ring ? "ring-2 ring-fuchsia-400/60" : ""} ${appt.status === "cancelled" ? "cancelled" : ""} ${preview ? "preview" : ""} ${preview?.invalid ? "bad" : ""}`}
                            style={{
                              top: ((start - dayStart) / 60) * hourPx + 3,
                              height: Math.max(32, ((end - start) / 60) * hourPx - 6),
                              boxShadow: "0 6px 16px -10px rgba(90,40,140,.25)",
                              opacity: movedAway ? 0.35 : undefined,
                            }}
                            onPointerDown={(event) => onBlockPointerDown(event, appt, "move")}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <div className={`flex items-center text-[11px] font-medium ${tone.sub}`}>
                              <span className="whitespace-nowrap">{hh(start)}–{hh(end)}</span>
                              {ai && (
                                <span className="ml-auto flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md grad text-white">
                                  <Sparkles className="w-2.5 h-2.5" strokeWidth={1.8} />
                                  AI
                                </span>
                              )}
                            </div>
                            <div className={`text-[13px] font-semibold truncate ${tone.title}`}>{appt.clientName || "Без имени"}</div>
                            {longEnough && serviceTitle && <div className={`text-[11px] mt-0.5 truncate ${tone.sub}`}>{serviceTitle}</div>}
                            <span data-resize="1" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 8, cursor: "ns-resize" }} onPointerDown={(event) => onBlockPointerDown(event, appt, "resize")} />
                          </button>
                        );
                      })}
                      {drag?.active && drag.previewStaff === staff.id && !journal.appointments.some((appt) => appt.id === drag.id && appt.staffId === staff.id) && (
                        <div className={`appt preview ${drag.invalid ? "bad" : ""} absolute left-1.5 right-1.5 rounded-2xl bg-violet-100`} style={{ top: ((drag.previewStart - dayStart) / 60) * hourPx + 3, height: Math.max(32, ((drag.previewEnd - drag.previewStart) / 60) * hourPx - 6) }} />
                      )}
                    </div>
                  ))}
                  {showNow && (
                    <div className="absolute inset-x-0 z-10 pointer-events-none" style={{ top: ((nowMin - dayStart) / 60) * hourPx }}>
                      <div className="h-[2px] grad" />
                      <div className="absolute -left-1.5 -top-[5px] w-3 h-3 rounded-full grad border-2 border-white" />
                    </div>
                  )}
                </div>
                {showNow && (
                  <div className="absolute left-1 z-10 text-[10px] font-bold text-white grad rounded-md px-1 py-0.5 -translate-y-1/2 pointer-events-none" style={{ top: ((nowMin - dayStart) / 60) * hourPx }}>
                    {hh(nowMin)}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {seed && branchId && (
        <RecordDrawer
          seed={seed}
          branchId={branchId}
          timezone={timezone}
          onClose={() => setSeed(null)}
          onSaved={() => {
            setSeed(null);
            setLoading(true);
            api<Journal>(`/api/journal?date=${date}&branchId=${branchId}&showOff=${showOff ? "1" : "0"}&showCancelled=${showCancelled ? "1" : "0"}`).then(setJournal).finally(() => setLoading(false));
          }}
        />
      )}
    </div>
  );
}

