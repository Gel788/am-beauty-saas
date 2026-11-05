/**
 * PULSE-01: «Пульт дня» — what the desk should do right now, built from today's and tomorrow's
 * journal, the waiting list, clients due back and the warehouse. Pure: the panel fetches, this decides.
 */

export type PulseDay = {
  date: string;
  staff: { id: string; name: string; dayOff: boolean; intervals: { startMin: number; endMin: number; kind: "work" | "break" }[] }[];
  appointments: {
    id: string;
    staffId: string;
    clientId: string | null;
    clientName: string | null;
    startMin: number;
    endMin: number;
    status: string;
    version: number;
    priceMinor: number;
    paidMinor: number;
    debtMinor: number;
    services: { title: string }[];
  }[];
};

export type PulseSlot = { appointmentId: string; staffName: string; startsAt: string; date: string; services: string; matches: string[] };
export type PulseEntry = { id: string; clientName: string };
export type PulseDue = { clientId: string; clientName: string; marketing: boolean; staffName: string; services: string; overdueDays: number; remindedAt: string | null };

export type PulseAction =
  | { kind: "status"; appointmentId: string; version: number; status: "arrived" | "no_show" | "confirmed"; label: string }
  | { kind: "open"; appointmentId: string; label: string }
  | { kind: "book"; text: string; label: string }
  | { kind: "offer"; entryId: string; appointmentId: string; label: string }
  | { kind: "remind"; clientId: string; label: string }
  | { kind: "link"; href: string; label: string };

export type PulseCard = {
  key: string;
  tone: "urgent" | "money" | "chance" | "info";
  title: string;
  hint: string;
  actions: PulseAction[];
};

export type PulseSummary = { visits: number; done: number; left: number; expectedMinor: number; paidMinor: number; freeMin: number };

const LIVE = new Set(["scheduled", "confirmed", "arrived", "in_progress", "completed"]);
const WAITING = new Set(["scheduled", "confirmed"]);

export function hhmm(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function rub(minor: number) {
  return `${new Intl.NumberFormat("ru-RU").format(Math.round(minor / 100))} ₽`;
}

function firstName(name: string) {
  return name.split(" ")[0] ?? name;
}

/** Free stretches of a master's working day from `notBefore`, at least `minLen` minutes long. */
export function freeGaps(day: PulseDay, staffId: string, notBefore: number, minLen = 60) {
  const column = day.staff.find((row) => row.id === staffId);
  if (!column || column.dayOff) return [];
  const busy = [
    ...column.intervals.filter((row) => row.kind === "break").map((row) => [row.startMin, row.endMin] as const),
    ...day.appointments.filter((row) => row.staffId === staffId && LIVE.has(row.status)).map((row) => [row.startMin, row.endMin] as const),
  ].sort((a, b) => a[0] - b[0]);
  const gaps: { startMin: number; endMin: number }[] = [];
  for (const work of column.intervals.filter((row) => row.kind === "work")) {
    let cursor = Math.max(work.startMin, Math.ceil(notBefore / 15) * 15);
    for (const [a, b] of busy) {
      if (b <= cursor || a >= work.endMin) continue;
      if (a > cursor && a - cursor >= minLen) gaps.push({ startMin: cursor, endMin: Math.min(a, work.endMin) });
      cursor = Math.max(cursor, b);
    }
    if (work.endMin - cursor >= minLen) gaps.push({ startMin: cursor, endMin: work.endMin });
  }
  return gaps;
}

export function buildPulse(input: {
  today: PulseDay;
  tomorrow: PulseDay | null;
  /** Minutes since local midnight now. */
  nowMin: number;
  slots: PulseSlot[];
  entries: PulseEntry[];
  due: PulseDue[];
  lowStock: string[];
}): { summary: PulseSummary; cards: PulseCard[] } {
  const { today, tomorrow, nowMin } = input;
  const staffName = new Map([...today.staff, ...(tomorrow?.staff ?? [])].map((row) => [row.id, row.name]));
  const who = (row: PulseDay["appointments"][number]) => row.clientName ?? "Гость";
  const what = (row: PulseDay["appointments"][number]) => row.services.map((line) => line.title).join(", ");
  const live = today.appointments.filter((row) => LIVE.has(row.status));
  const cards: PulseCard[] = [];

  // 1. Late: should have started 10–45 minutes ago and nobody marked them (the two latest).
  const late = live.filter((item) => WAITING.has(item.status) && item.startMin <= nowMin - 10 && item.startMin > nowMin - 45).sort((x, y) => y.startMin - x.startMin);
  for (const row of late.slice(0, 2)) {
    cards.push({
      key: `late-${row.id}`,
      tone: "urgent",
      title: `${who(row)} опаздывает на ${nowMin - row.startMin} мин`,
      hint: `${hhmm(row.startMin)} · ${staffName.get(row.staffId) ?? ""}${what(row) ? ` · ${what(row)}` : ""}`,
      actions: [
        { kind: "status", appointmentId: row.id, version: row.version, status: "arrived", label: "Пришёл" },
        { kind: "status", appointmentId: row.id, version: row.version, status: "no_show", label: "Неявка" },
        { kind: "open", appointmentId: row.id, label: "Открыть" },
      ],
    });
  }

  // 1b. Older visits nobody marked: one card, not a wall of them.
  const unmarked = live.filter((item) => WAITING.has(item.status) && (item.startMin <= nowMin - 45 || late.indexOf(item) >= 2)).sort((x, y) => x.startMin - y.startMin);
  if (unmarked.length) {
    cards.push({
      key: "unmarked",
      tone: "urgent",
      title: `Не отмечено ${unmarked.length} ${unmarked.length === 1 ? "прошедший визит" : unmarked.length < 5 ? "прошедших визита" : "прошедших визитов"}`,
      hint: unmarked.slice(0, 3).map((row) => `${hhmm(row.startMin)} ${firstName(who(row))}`).join(" · ") + (unmarked.length > 3 ? " …" : "") + ". Пришли или неявка?",
      actions: [
        { kind: "status", appointmentId: unmarked[0].id, version: unmarked[0].version, status: "arrived", label: `${firstName(who(unmarked[0]))} пришёл` },
        { kind: "open", appointmentId: unmarked[0].id, label: "Открыть" },
      ],
    });
  }

  // 2. Coming next within half an hour: so the desk greets by name.
  const next = live.filter((item) => WAITING.has(item.status) && item.startMin > nowMin - 10 && item.startMin <= nowMin + 30).sort((a, b) => a.startMin - b.startMin);
  if (next.length) {
    cards.push({
      key: "next",
      tone: "info",
      title: next.length === 1 ? `Скоро придёт ${who(next[0])}` : `Скоро придут ${next.length} ${next.length < 5 ? "клиента" : "клиентов"}`,
      hint: next.slice(0, 3).map((row) => `${hhmm(row.startMin)} ${firstName(who(row))} → ${firstName(staffName.get(row.staffId) ?? "")}`).join(" · "),
      actions: next.slice(0, 2).map((row) => ({ kind: "status" as const, appointmentId: row.id, version: row.version, status: "arrived" as const, label: `${firstName(who(row))} на месте` })),
    });
  }

  // 3. Money: visits today with a debt on the client.
  const debts = live.filter((row) => row.debtMinor > 0);
  if (debts.length) {
    cards.push({
      key: "debts",
      tone: "money",
      title: `Долги у ${debts.length} ${debts.length === 1 ? "клиента" : "клиентов"} сегодня`,
      hint: debts.slice(0, 3).map((row) => `${firstName(who(row))} ${rub(row.debtMinor)} в ${hhmm(row.startMin)}`).join(" · "),
      actions: debts.slice(0, 2).map((row) => ({ kind: "open" as const, appointmentId: row.id, label: firstName(who(row)) })),
    });
  }

  // 4. Freed windows that someone on the waiting list wants.
  const byEntry = new Map(input.entries.map((entry) => [entry.id, entry]));
  for (const slot of input.slots.filter((item) => item.matches.length).slice(0, 2)) {
    const entry = byEntry.get(slot.matches[0]);
    if (!entry) continue;
    cards.push({
      key: `wait-${slot.appointmentId}`,
      tone: "chance",
      title: `Освободилось окно, ждут ${slot.matches.length}`,
      hint: `${slot.date === today.date ? "Сегодня" : slot.date.split("-").reverse().slice(0, 2).join(".")} · ${slot.staffName} · ${slot.services || "услуга"} · первая в очереди ${entry.clientName}`,
      actions: [{ kind: "offer", entryId: entry.id, appointmentId: slot.appointmentId, label: `Предложить ${firstName(entry.clientName)}` }, { kind: "link", href: "/retention", label: "Весь лист" }],
    });
  }

  // 5. Empty time today: masters with an hour or more free from now.
  const gaps = today.staff
    .flatMap((column) => freeGaps(today, column.id, nowMin).map((gap) => ({ ...gap, staffId: column.id, name: column.name })))
    .sort((a, b) => b.endMin - b.startMin - (a.endMin - a.startMin));
  if (gaps.length) {
    const top = gaps[0];
    cards.push({
      key: "gaps",
      tone: "chance",
      title: gaps.length === 1 ? `Свободно: ${firstName(top.name)} ${hhmm(top.startMin)}–${hhmm(top.endMin)}` : `Свободные окна у ${new Set(gaps.map((gap) => gap.staffId)).size} мастеров`,
      hint: gaps.slice(0, 3).map((gap) => `${firstName(gap.name)} ${hhmm(gap.startMin)}–${hhmm(gap.endMin)}`).join(" · "),
      actions: gaps.slice(0, 2).map((gap) => ({ kind: "book" as const, text: `запиши к ${gap.name.split(" ")[0]} сегодня в ${hhmm(gap.startMin)} `, label: `Записать к ${firstName(gap.name)}` })),
    });
  }

  // 6. Tomorrow: who has not confirmed yet.
  const unconfirmed = (tomorrow?.appointments ?? []).filter((row) => row.status === "scheduled").sort((a, b) => a.startMin - b.startMin);
  if (unconfirmed.length) {
    cards.push({
      key: "confirm",
      tone: "info",
      title: `Завтра не подтвердили ${unconfirmed.length}`,
      hint: unconfirmed.slice(0, 3).map((row) => `${hhmm(row.startMin)} ${firstName(who(row))}`).join(" · ") + (unconfirmed.length > 3 ? " …" : ""),
      actions: unconfirmed.slice(0, 2).map((row) => ({ kind: "status" as const, appointmentId: row.id, version: row.version, status: "confirmed" as const, label: `${firstName(who(row))} ✓` })),
    });
  }

  // 7. Clients due back with nothing booked.
  const due = input.due.filter((row) => !row.remindedAt).sort((a, b) => b.overdueDays - a.overdueDays);
  if (due.length) {
    cards.push({
      key: "due",
      tone: "chance",
      title: `Пора вернуть ${due.length} ${due.length === 1 ? "клиента" : "клиентов"}`,
      hint: due.slice(0, 3).map((row) => `${firstName(row.clientName)} · ${row.services || row.staffName}`).join(" · "),
      actions: [
        ...due.filter((row) => row.marketing).slice(0, 1).map((row) => ({ kind: "remind" as const, clientId: row.clientId, label: `Напомнить ${firstName(row.clientName)}` })),
        { kind: "link", href: "/retention", label: "Все" },
      ],
    });
  }

  // 8. Warehouse.
  if (input.lowStock.length) {
    cards.push({
      key: "stock",
      tone: "info",
      title: `Заканчивается ${input.lowStock.length} ${input.lowStock.length === 1 ? "позиция" : input.lowStock.length < 5 ? "позиции" : "позиций"}`,
      hint: input.lowStock.slice(0, 3).join(", ") + (input.lowStock.length > 3 ? "…" : ""),
      actions: [{ kind: "link", href: "/inventory", label: "На склад" }],
    });
  }

  const freeMin = gaps.reduce((sum, gap) => sum + gap.endMin - gap.startMin, 0);
  const summary: PulseSummary = {
    visits: live.length,
    done: live.filter((row) => row.status === "completed").length,
    left: live.filter((row) => WAITING.has(row.status) && row.startMin >= nowMin).length,
    expectedMinor: live.reduce((sum, row) => sum + row.priceMinor, 0),
    paidMinor: live.reduce((sum, row) => sum + row.paidMinor, 0),
    freeMin,
  };
  return { summary, cards };
}
