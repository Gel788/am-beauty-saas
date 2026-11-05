"use client";

/**
 * CMD-BAR-*: one line for everything. ⌘K / Ctrl+K (or «/») on any screen: find a client, a master,
 * a service or a day, open any page, or book in one phrase — «запиши Анну к Алине завтра в 15 маникюр».
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarDays, CalendarPlus, CornerDownLeft, Scissors, Search, Sparkles, UserRound, Users } from "lucide-react";
import { api, type ApiError } from "./api";
import { createPortal } from "react-dom";
import { useToast } from "./ui";

/** Renders over everything, outside the sidebar and page scroll. */
function Overlay({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  return host ? createPortal(children, host) : null;
}
import { matchPages, normalize, parseCommand, type Named, type ServiceRef } from "@/domain/command";
import { addCalendarDays, todayInZone, weekdayLabel, zonedDateTimeToUtc } from "@/domain/time";

type Branch = { id: string; name: string; timezone: string };
type StaffDto = { id: string; displayName: string; active: boolean; branchIds: string[]; specialties: string };
type ServiceDto = { id: string; title: string; durationMin: number; priceMinor: number; active: boolean; staffIds: string[] };
type ClientDto = { id: string; name: string; phones: { phone: string }[]; visitCount?: number; lastVisitAt?: string | null };

type DayView = {
  date: string;
  staff: { id: string; dayOff: boolean; intervals: { startMin: number; endMin: number; kind: "work" | "break" }[] }[];
  appointments: { staffId: string; startMin: number; endMin: number; status: string }[];
};

/** Free start times of a master on a day for a visit of this length, on a 15-minute grid. */
export function freeStarts(day: DayView | null, staffId: string, duration: number, notBefore: number) {
  const column = day?.staff.find((row) => row.id === staffId);
  if (!column || column.dayOff) return [];
  const busy = [
    ...column.intervals.filter((row) => row.kind === "break").map((row) => [row.startMin, row.endMin]),
    ...(day?.appointments ?? []).filter((row) => row.staffId === staffId && row.status !== "cancelled" && row.status !== "no_show").map((row) => [row.startMin, row.endMin]),
  ];
  const out: number[] = [];
  for (const work of column.intervals.filter((row) => row.kind === "work")) {
    for (let start = Math.ceil(Math.max(work.startMin, notBefore) / 15) * 15; start + duration <= work.endMin; start += 15) {
      if (!busy.some(([a, b]) => a < start + duration && b > start)) out.push(start);
    }
  }
  return out;
}

type Item = {
  key: string;
  icon: typeof Search;
  title: string;
  hint?: string;
  tone?: "action";
  run: () => void | Promise<void>;
};

const EXAMPLES = ["запиши Анну к Алине завтра в 15 маникюр", "склад", "журнал на пятницу", "Марина", "зарплаты"];
const WARNINGS: Record<string, string> = {
  OUTSIDE_HOURS: "это время вне графика мастера",
  RESOURCE_HOURS: "кабинет в это время не работает",
};
const rub = (minor: number) => `${Math.round(minor / 100).toLocaleString("ru-RU")} ₽`;
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function dayTitle(date: string, today: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const name = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("ru-RU", { month: "long", day: "numeric", timeZone: "UTC" });
  if (date === today) return `сегодня, ${name}`;
  if (date === addCalendarDays(today, 1)) return `завтра, ${name}`;
  return weekdayLabel(date, timezone).toLowerCase();
}

export function CommandBar({ branches, role }: { branches: Branch[]; role: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const preset = useRef("");
  const [active, setActive] = useState(0);
  const [staff, setStaff] = useState<StaffDto[]>([]);
  const [services, setServices] = useState<ServiceDto[]>([]);
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const branch = branches[0];
  const timezone = branch?.timezone ?? "Europe/Moscow";
  const today = todayInZone(timezone);
  const desk = ["owner", "admin", "super"].includes(role);

  // Hotkeys on every screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        setOpen(true);
      }
    };
    // PULSE-01: «Записать к …» from the day panel opens the bar with the phrase started.
    const onOpen = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string } | undefined>).detail?.text;
      preset.current = text ?? "";
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-bar", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-bar", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setText(preset.current);
    preset.current = "";
    setActive(0);
    setWarnings(null);
    setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  useEffect(() => {
    if (!open || staff.length) return;
    api<StaffDto[]>("/api/staff").then(setStaff).catch(() => undefined);
    api<{ services: ServiceDto[] }>("/api/catalog").then((data) => setServices(data.services.filter((service) => service.active))).catch(() => undefined);
  }, [open, staff.length]);

  const branchStaff = useMemo(() => staff.filter((person) => person.active && (!branch || person.branchIds.includes(branch.id))), [staff, branch]);
  const staffNamed: Named[] = useMemo(() => branchStaff.map((person) => ({ id: person.id, name: person.displayName })), [branchStaff]);
  const serviceRefs: ServiceRef[] = useMemo(() => services.map(({ id, title, staffIds, durationMin, priceMinor }) => ({ id, title, staffIds, durationMin, priceMinor })), [services]);

  // First pass without clients: what is left is probably the client's name — search the base for it.
  const draft = useMemo(() => parseCommand(text, { staff: staffNamed, clients: [], services: serviceRefs, today }), [text, staffNamed, serviceRefs, today]);
  const clientQuery = useMemo(() => {
    // A phone number, not a date or a time: «+7 916 …», «89161234567».
    const phone = /(?:^|\s)(\+?[78][\d\s()-]{9,}\d|\d{6,})(?=\s|$)/.exec(text);
    if (phone) return phone[1].replace(/\D/g, "");
    const booking = draft.intent === "book" || Boolean(draft.staff && (draft.date || draft.time !== null));
    const word = (booking ? draft.rest : normalize(text)).split(" ").find((part) => part.length >= 3) ?? "";
    // «Анну» → «Анн»: the base keeps names in the nominative.
    return word.length > 4 ? word.slice(0, word.length - 2) : word.length === 4 ? word.slice(0, 3) : word;
  }, [draft, text]);

  useEffect(() => {
    if (!open || clientQuery.length < 2 || role === "accountant") {
      setClients([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<ClientDto[]>(`/api/clients?q=${encodeURIComponent(clientQuery)}`, { signal: controller.signal })
        .then((rows) => setClients(rows.slice(0, 8)))
        .catch(() => undefined);
    }, 140);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [clientQuery, open, role]);

  const parsed = useMemo(
    () => parseCommand(text, { staff: staffNamed, clients: clients.map((client) => ({ id: client.id, name: client.name })), services: serviceRefs, today }),
    [text, staffNamed, clients, serviceRefs, today],
  );

  // CMD-BAR-05: the master's day, to show free times and catch a busy slot before saving.
  const [day, setDay] = useState<DayView | null>(null);
  useEffect(() => {
    setDay(null);
    if (!open || !branch || !parsed.staff || !parsed.date) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<DayView>(`/api/journal?date=${parsed.date}&branchId=${branch.id}&showOff=1&showCancelled=0`, { signal: controller.signal })
        .then(setDay)
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, branch, parsed.staff, parsed.date]);
  const duration = parsed.services.reduce((sum, service) => sum + service.durationMin, 0) || 60;
  const nowMin = (() => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":").map(Number);
    return parts[0] * 60 + parts[1];
  })();
  const free = useMemo(
    () => (parsed.staff && day && day.date === parsed.date ? freeStarts(day, parsed.staff.id, duration, parsed.date === today ? nowMin + 15 : 0) : null),
    [day, parsed.staff, parsed.date, duration, today, nowMin],
  );
  const slotTaken = free !== null && parsed.time !== null && !free.includes(parsed.time);

  // No window that day: look ahead up to a week for this master's nearest one.
  const [ahead, setAhead] = useState<{ date: string; start: number } | null>(null);
  useEffect(() => {
    setAhead(null);
    if (!branch || !parsed.staff || !parsed.date || !free || free.length) return;
    let cancelled = false;
    const staffId = parsed.staff.id;
    const wanted = parsed.time ?? 12 * 60;
    (async () => {
      for (let n = 1; n <= 7 && !cancelled; n += 1) {
        const date = addCalendarDays(parsed.date!, n);
        const next = await api<DayView>(`/api/journal?date=${date}&branchId=${branch.id}&showOff=1&showCancelled=0`).catch(() => null);
        const starts = freeStarts(next, staffId, duration, 0);
        if (starts.length) {
          const best = [...starts].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0];
          if (!cancelled) setAhead({ date, start: best });
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branch, parsed.staff, parsed.date, parsed.time, free, duration]);

  const close = useCallback(() => setOpen(false), []);
  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const book = useCallback(
    async (acknowledge: boolean) => {
      if (!branch || !parsed.staff || parsed.date === null || parsed.time === null || !parsed.services.length) return;
      setBusy(true);
      try {
        const startsAt = zonedDateTimeToUtc(parsed.date, parsed.time, timezone).toISOString();
        const created = await api<{ id: string }>("/api/appointments", {
          method: "POST",
          body: JSON.stringify({
            branchId: branch.id,
            staffId: parsed.staff.id,
            clientId: parsed.client?.id ?? null,
            startsAt,
            services: parsed.services.map((service) => ({ serviceId: service.id })),
            source: "admin",
            acknowledgeSoft: acknowledge,
          }),
        });
        toast(`Записано: ${parsed.client?.name ?? "клиент"} к ${parsed.staff.name}, ${dayTitle(parsed.date, today, timezone)} в ${hhmm(parsed.time)}`);
        go(`/journal?date=${parsed.date}&branch=${branch.id}&open=${created.id}`);
      } catch (error) {
        const err = error as ApiError;
        if (err.code === "SOFT_CONFIRM") {
          const list = ((err.details?.warnings as string[] | undefined) ?? []).map((code) => WARNINGS[code] ?? code);
          setWarnings(list);
          setActive(0);
        } else toast(err.message, "error");
      } finally {
        setBusy(false);
      }
    },
    [branch, parsed, timezone, toast, go, today],
  );

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const query = text.trim();
    // 1. The action the phrase asks for.
    if (desk && (parsed.intent === "book" || (parsed.staff && (parsed.date || parsed.time !== null)))) {
      const missing: string[] = [];
      if (!parsed.staff) missing.push("мастера («к Алине»)");
      if (!parsed.services.length) missing.push("услугу");
      if (!parsed.date) missing.push("день («завтра», «в пятницу»)");
      if (parsed.time === null) missing.push("время («в 15»)");
      if (!missing.length && slotTaken) missing.push(free?.length ? "другое время: это занято" : "другой день: у мастера нет свободного времени");
      const total = parsed.services.reduce((sum, service) => sum + service.priceMinor, 0);
      const minutes = parsed.services.reduce((sum, service) => sum + service.durationMin, 0);
      const parts = [
        parsed.client?.name ?? "без клиента",
        parsed.staff ? `→ ${parsed.staff.name}` : null,
        parsed.date ? dayTitle(parsed.date, today, timezone) : null,
        parsed.time !== null ? hhmm(parsed.time) : null,
      ].filter(Boolean);
      out.push({
        key: "book",
        icon: CalendarPlus,
        tone: "action",
        title: missing.length ? `Записать: ${parts.join(" · ")}` : warnings ? "Всё равно записать" : `Записать ${parts.join(" · ")}`,
        hint: missing.length
          ? `Добавьте ${missing.join(", ")}`
          : warnings
            ? warnings.join(" · ")
            : `${parsed.services.map((service) => service.title).join(" + ")} · ${minutes} мин · ${rub(total)}`,
        run: () => (missing.length ? inputRef.current?.focus() : book(Boolean(warnings))),
      });
      // Free times nearest to what was asked (or the first ones of the day).
      if (free && free.length && (parsed.time === null || slotTaken)) {
        const wanted = parsed.time ?? free[0];
        const nearest = [...free].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted)).slice(0, 4).sort((a, b) => a - b);
        for (const start of nearest) {
          out.push({
            key: `slot-${start}`,
            icon: CalendarPlus,
            title: `Свободно в ${hhmm(start)}`,
            hint: `${parsed.staff?.name} · ${hhmm(start)}–${hhmm(start + duration)} — подставить`,
            run: () => setText((value) => `${value.replace(/\s(в|на)\s\d{1,2}([:.]\d{2})?(\s(утра|вечера|дня|часов|час|часа))?/i, "").trim()} в ${hhmm(start)}`),
          });
        }
      } else if (free && !free.length && parsed.staff) {
        out.push({ key: "no-slot", icon: CalendarDays, title: `В этот день нет окна на ${duration} мин: ${parsed.staff.name}`, hint: "ниже свободные мастера на эту услугу, или напишите другой день", run: () => inputRef.current?.focus() });
      }
      if (ahead && parsed.staff) {
        const [, m, d] = ahead.date.split("-");
        out.push({
          key: "ahead",
          icon: CalendarPlus,
          title: `Ближайшее окно: ${dayTitle(ahead.date, today, timezone)} в ${hhmm(ahead.start)}`,
          hint: `${parsed.staff.name} · ${hhmm(ahead.start)}–${hhmm(ahead.start + duration)} — подставить`,
          run: () =>
            setText((value) => {
              let next = value.replace(/\s(в|на)\s\d{1,2}([:.]\d{2})?(\s(утра|вечера|дня|часов|час|часа))?/i, "");
              next = next.replace(/\s(на\s)?(сегодня|завтра|послезавтра|в\s\S+|\d{1,2}\.\d{1,2}(\.\d{2,4})?|\d{1,2}\s[а-яё]+(ря|ля|та|ня|ая|мая))(?=\s|$)/i, "");
              return `${next.trim()} ${d}.${m} в ${hhmm(ahead.start)}`;
            }),
        });
      }
      // Busy or full: who else does it that day, as close to the wanted time as possible.
      if (free && (slotTaken || !free.length) && parsed.services.length && day) {
        const wanted = parsed.time ?? 12 * 60;
        const others = branchStaff
          .filter((row) => row.id !== parsed.staff?.id && parsed.services.every((service) => service.staffIds.includes(row.id)))
          .map((row) => {
            const starts = freeStarts(day, row.id, duration, parsed.date === today ? nowMin + 15 : 0);
            const best = [...starts].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0];
            return { row, best };
          })
          .filter((row) => row.best !== undefined)
          .slice(0, 3);
        for (const { row, best } of others) {
          const first = row.displayName.split(" ")[0];
          out.push({
            key: `other-${row.id}`,
            icon: UserRound,
            title: `Свободно у ${first} в ${hhmm(best)}`,
            hint: `${row.displayName} · ${hhmm(best)}–${hhmm(best + duration)} — подставить`,
            run: () =>
              setText((value) => {
                const withoutTime = value.replace(/\s(в|на)\s\d{1,2}([:.]\d{2})?(\s(утра|вечера|дня|часов|час|часа))?/i, "");
                const swapped = /\sко?\s\S+/i.test(withoutTime) ? withoutTime.replace(/\sко?\s\S+/i, ` к ${first}`) : `${withoutTime} к ${first}`;
                return `${swapped.trim()} в ${hhmm(best)}`;
              }),
          });
        }
      }
      // Missing service: offer the master's own.
      if (parsed.staff && !parsed.services.length) {
        for (const service of services.filter((row) => row.staffIds.includes(parsed.staff!.id)).slice(0, 5)) {
          out.push({ key: `svc-${service.id}`, icon: Scissors, title: service.title, hint: `${service.durationMin} мин · ${rub(service.priceMinor)} — добавить в запись`, run: () => setText((value) => `${value.trim()} ${service.title.split(" ")[0].toLowerCase()}`) });
        }
      }
      if (!parsed.staff && parsed.services.length) {
        for (const person of branchStaff.filter((row) => parsed.services.every((service) => service.staffIds.includes(row.id))).slice(0, 5)) {
          out.push({ key: `who-${person.id}`, icon: UserRound, title: person.displayName, hint: "выбрать мастера", run: () => setText((value) => `${value.trim()} к ${person.displayName.split(" ")[0]}`) });
        }
      }
    }
    // 2. A day.
    if (parsed.date && branch) {
      out.push({ key: "day", icon: CalendarDays, title: `Открыть журнал: ${dayTitle(parsed.date, today, timezone)}`, run: () => go(`/journal?date=${parsed.date}&branch=${branch.id}`) });
    }
    // 3. Pages.
    for (const page of parsed.intent === "book" ? [] : matchPages(query).slice(0, 4)) {
      out.push({ key: `page-${page.href}`, icon: ArrowRight, title: page.title, hint: "открыть", run: () => go(page.href) });
    }
    // 4. Clients.
    if (query.length >= 2 && parsed.intent !== "book") {
      for (const client of clients.slice(0, 6)) {
        const lastAt = client.lastVisitAt ? new Date(client.lastVisitAt) : null;
        const last = lastAt ? `${lastAt.getTime() > Date.now() ? "записан(а) на" : "был(а)"} ${lastAt.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}` : null;
        out.push({
          key: `client-${client.id}`,
          icon: Users,
          title: client.name,
          hint: [client.phones[0]?.phone, client.visitCount ? `визитов: ${client.visitCount}` : null, last].filter(Boolean).join(" · "),
          run: () => go(`/clients?open=${client.id}`),
        });
      }
    }
    // 5. Masters and services by name.
    if (query.length >= 2 && parsed.intent !== "book") {
      const words = normalize(query).split(" ");
      for (const person of branchStaff.filter((row) => words.some((word) => word.length >= 2 && normalize(row.displayName).split(" ").some((part) => part.startsWith(word.slice(0, Math.max(2, word.length - 1)))))).slice(0, 3)) {
        out.push({ key: `staff-${person.id}`, icon: UserRound, title: person.displayName, hint: person.specialties || "мастер · график и оплата", run: () => go(`/staff?open=${person.id}`) });
      }
      for (const service of services.filter((row) => words.some((word) => word.length >= 3 && normalize(row.title).includes(word.slice(0, Math.max(3, word.length - 1))))).slice(0, 3)) {
        out.push({ key: `service-${service.id}`, icon: Scissors, title: service.title, hint: `${service.durationMin} мин · ${rub(service.priceMinor)}`, run: () => go("/services") });
      }
    }
    return out;
  }, [text, parsed, desk, branch, today, timezone, warnings, services, branchStaff, clients, go, book, free, slotTaken, duration, day, nowMin, ahead]);

  useEffect(() => setActive(0), [text]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;
  // The list changes under the mouse: never point past its end.
  const current = Math.min(active, Math.max(items.length - 1, 0));

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(current + 1, Math.max(items.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === "Enter" && items[current] && !busy) {
      event.preventDefault();
      void items[current].run();
    }
  };

  return (
    <Overlay>
      <div className="cmd-backdrop" onMouseDown={close}>
        <div className="cmd" role="dialog" aria-label="Командная строка" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKey}>
          <div className="cmd-input">
            <Sparkles size={20} />
            <input
              ref={inputRef}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setWarnings(null);
              }}
              placeholder="Найти или сделать… «запиши Анну к Алине завтра в 15»"
              aria-label="Что сделать"
            />
            <kbd>esc</kbd>
          </div>
          <div className="cmd-list" ref={listRef}>
            {!text.trim() && (
              <div className="cmd-empty">
                <p>Пишите как говорите. Например:</p>
                <div className="cmd-examples">
                  {EXAMPLES.map((example) => (
                    <button key={example} type="button" onClick={() => setText(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {text.trim() && !items.length && <div className="cmd-empty"><p>Ничего не нашлось. Попробуйте имя клиента, мастера, услугу, день или раздел.</p></div>}
            {items.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-index={index}
                  className={`cmd-item ${index === current ? "on" : ""} ${item.tone === "action" ? "action" : ""}`}
                  onMouseMove={() => index !== current && setActive(index)}
                  onClick={() => void item.run()}
                  disabled={busy && item.tone === "action"}
                >
                  <span className="cmd-icon"><Icon size={18} /></span>
                  <span className="cmd-text">
                    <b>{item.title}</b>
                    {item.hint && <small>{item.hint}</small>}
                  </span>
                  {index === current && <CornerDownLeft className="cmd-enter" size={16} />}
                </button>
              );
            })}
          </div>
          <div className="cmd-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span>
            <span><kbd>↵</kbd> выполнить</span>
            <span><kbd>⌘</kbd><kbd>K</kbd> открыть с любого экрана</span>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

/** The pill in the menu that opens the bar. */
export function CommandButton() {
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return (
    <button type="button" className="cmd-pill" onClick={() => window.dispatchEvent(new Event("open-command-bar"))}>
      <Search size={16} />
      <span>Найти или сделать…</span>
      <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}
