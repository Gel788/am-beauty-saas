"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { STATUS_LABEL, type AppointmentStatus } from "@/domain/status";
import { addCalendarDays, todayInZone, weekdayLabel, zonedDateTimeToUtc } from "@/domain/time";
import { hitTestColumn, pointerIntent, resolveDrop } from "@/domain/grid";
import { api, type ApiError } from "./api";
import { RecordDrawer, type DrawerSeed } from "./record-drawer";
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
  const [hidden, setHidden] = useState<string[]>([]);
  const [seed, setSeed] = useState<DrawerSeed | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [view, setView] = useState<"day" | "week" | "month">("day");
  const [search, setSearch] = useState("");
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
        searchRef.current?.focus();
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

  const visibleStaff = useMemo(() => journal?.staff.filter((staff) => !hidden.includes(staff.id)) ?? [], [journal, hidden]);
  const px = journal?.density === "compact" ? 0.95 : 1.28;
  const dayStart = journal?.dayStartMin ?? 600;
  const dayEnd = journal?.dayEndMin ?? 1200;
  const height = (dayEnd - dayStart) * px;

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
      let previewStart = mode === "resize" ? current.originStart : current.originStart + delta;
      let previewEnd = mode === "resize" ? current.originEnd + delta : previewStart + duration;
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-staff]")].map((node) => {
        const rect = node.getBoundingClientRect();
        return { staffId: node.dataset.staff || "", x: rect.left, width: rect.width, hidden: hidden.includes(node.dataset.staff || "") };
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

  const hours: number[] = [];
  const step = journal?.branch.gridLabelMin ?? 60;
  for (let minute = dayStart; minute <= dayEnd; minute += step) hours.push(minute);

  return (
    <>
      <div className="spread">
        <div>
          <div className="page-kicker">{date === todayInZone(timezone) ? "Сегодня" : "День"} · {journal?.stats.appointmentCount ?? 0} записей</div>
          <h1>{date ? weekdayLabel(date, timezone) : "Журнал"}</h1>
        </div>
        <div className="row">
          <button className="icon-btn" aria-label="Предыдущий день" onClick={() => go(addCalendarDays(date, -1))}><ChevronLeft size={18} /></button>
          <button className="btn-ghost" onClick={() => go(todayInZone(timezone))}>Сегодня</button>
          <button className="icon-btn" aria-label="Следующий день" onClick={() => go(addCalendarDays(date, 1))}><ChevronRight size={18} /></button>
          <input type="date" value={date} onChange={(event) => go(event.target.value)} aria-label="Дата" />
          <div className="segment">
            <button className={view === "day" ? "on" : ""} onClick={() => setView("day")} type="button">День</button>
            <button className={view === "week" ? "on" : ""} onClick={() => setView("week")} type="button">Неделя</button>
            <button className={view === "month" ? "on" : ""} onClick={() => setView("month")} type="button">Месяц</button>
          </div>
          <div className="search">
            <Search size={16} />
            <input ref={searchRef} value={search} placeholder="Клиент или телефон" aria-label="Поиск записей" onChange={(event) => setSearch(event.target.value)} />
            {found.length > 0 && (
              <div className="panel" style={{ position: "absolute", top: 46, left: 0, right: 0, zIndex: 5 }}>
                {found.map((item) => (
                  <button key={item.id} className="person" type="button" onClick={() => { go(item.date); setSeed({ id: item.id, staffId: "", startMin: 0, date: item.date }); setSearch(""); }}>
                    <div><strong>{item.clientName}</strong><span>{item.staffName}</span></div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn-gradient" onClick={() => setSeed({ staffId: visibleStaff[0]?.id ?? "", startMin: dayStart, date })}>+ Запись</button>
        </div>
      </div>
      {journal && (
        <div className="stats">
          <div className="stat-pill"><span>Ожидаемая выручка</span><b>{formatMoney(journal.stats.expectedRevenueMinor)}</b></div>
          <div className="stat-pill"><span>Загрузка дня</span><b>{journal.stats.loadPercent}%</b></div>
          <div className="stat-pill"><span>Онлайн</span><b>{journal.stats.onlineCount}</b></div>
          <div className="stat-pill"><span>Новые клиенты</span><b>{journal.stats.newClients}</b></div>
        </div>
      )}
      <div className="row">
        <button className={`chip ${showOff ? "on" : ""}`} onClick={() => setShowOff((value) => !value)} type="button">Показать без смены</button>
        <button className="chip" onClick={() => setShowCancelled((value) => !value)} type="button">{showCancelled ? "Скрыть отменённые" : "Показать отменённые"}</button>
        {journal?.staff.map((staff) => (
          <button key={staff.id} className="chip" type="button" onClick={() => setHidden((current) => current.includes(staff.id) ? current.filter((id) => id !== staff.id) : [...current, staff.id])}>
            {hidden.includes(staff.id) ? "Показать" : "Скрыть"} {staff.name.split(" ")[0]}
          </button>
        ))}
      </div>
      {view !== "day" ? (
        <div className="panel empty">Неделя и месяц — следующая фаза. Сейчас работает дневной журнал.</div>
      ) : (
        <div className="panel journal" ref={columnsRef}>
          {loading && !journal && <div className="skeleton" />}
          {error && <div className="banner">{error}</div>}
          {journal && visibleStaff.length === 0 && (
            <div className="empty">
              <strong>Нет смен</strong>
              <p>На этот день никто не выходит.</p>
              <a className="btn-gradient" href="/staff" style={{ display: "inline-block" }}>Расписание</a>
            </div>
          )}
          {journal && visibleStaff.length > 0 && (
            <div style={{ ["--cols" as string]: visibleStaff.length }}>
              <div className="journal-head">
                <div />
                {visibleStaff.map((staff) => (
                  <div className="staff-head" key={staff.id}>
                    <strong>{staff.name}</strong>
                    <div className="util" aria-label={`Загрузка ${staff.loadPercent}%`}><i style={{ width: `${Math.min(100, staff.loadPercent)}%` }} /></div>
                  </div>
                ))}
              </div>
              <div className="journal-row" style={{ height }}>
                <div className="time-col" />
                {visibleStaff.map((staff) => (
                  <div
                    key={staff.id}
                    className="col"
                    data-staff={staff.id}
                    style={{ height }}
                    onClick={(event) => {
                      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                      const minute = dayStart + Math.round((event.clientY - rect.top) / px / 5) * 5;
                      setSeed({ staffId: staff.id, startMin: minute, date });
                    }}
                  >
                    {hours.map((minute) => (
                      <div key={minute} className="hour-line" style={{ top: (minute - dayStart) * px }}>
                        {staff.id === visibleStaff[0].id && <span>{`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`}</span>}
                      </div>
                    ))}
                    {staff.intervals.filter((interval) => interval.kind === "break").map((interval) => (
                      <div key={`${interval.startMin}-b`} className="off-zone" style={{ top: (interval.startMin - dayStart) * px, height: (interval.endMin - interval.startMin) * px }} />
                    ))}
                    {staff.dayOff && <div className="off-zone" style={{ top: 0, height }} />}
                    {journal.appointments.filter((appt) => appt.staffId === staff.id).map((appt) => {
                      const preview = drag?.id === appt.id && drag.active ? drag : null;
                      const start = preview && preview.previewStaff === staff.id ? preview.previewStart : appt.startMin;
                      const end = preview && preview.previewStaff === staff.id ? preview.previewEnd : appt.endMin;
                      const movedAway = preview && preview.previewStaff !== staff.id;
                      return (
                        <button
                          key={appt.id}
                          className={`appt ${appt.status === "cancelled" ? "cancelled" : ""} ${preview ? "preview" : ""} ${preview?.invalid ? "bad" : ""}`}
                          style={{
                            top: (start - dayStart) * px,
                            height: Math.max(28, (end - start) * px - 4),
                            background: appt.color,
                            opacity: movedAway ? 0.35 : 1,
                          }}
                          onPointerDown={(event) => onBlockPointerDown(event, appt, "move")}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <b>{appt.clientName || "Без имени"} {appt.guest ? "· Гость" : ""}</b>
                          <small>{appt.services[0]?.title}{appt.services.length > 1 ? ` +${appt.services.length - 1}` : ""}</small>
                          <div className="meta">{STATUS_LABEL[appt.status]}{appt.paidMinor < appt.priceMinor ? " · не оплачено" : " · оплачено"}{appt.source === "online" ? " · онлайн" : ""}</div>
                          <span
                            data-resize="1"
                            style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 8, cursor: "ns-resize" }}
                            onPointerDown={(event) => onBlockPointerDown(event, appt, "resize")}
                          />
                        </button>
                      );
                    })}
                    {drag?.active && drag.previewStaff === staff.id && !journal.appointments.some((appt) => appt.id === drag.id && appt.staffId === staff.id) && (
                      <div className={`appt preview ${drag.invalid ? "bad" : ""}`} style={{ top: (drag.previewStart - dayStart) * px, height: Math.max(28, (drag.previewEnd - drag.previewStart) * px), background: "#efe7ff" }} />
                    )}
                  </div>
                ))}
              </div>
            </div>
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
    </>
  );
}
