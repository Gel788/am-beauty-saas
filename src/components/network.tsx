"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Network, Plus } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { addCalendarDays, todayInZone } from "@/domain/time";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";
import { SALON_PHOTO } from "./portraits";

type BranchLite = { id: string; name: string; address: string; timezone: string };

async function switchTo(branchId: string, href?: string) {
  await api("/api/preferences", { method: "PUT", body: JSON.stringify({ branchId }) });
  if (href) window.location.href = href;
  else window.location.reload();
}

/** NET-SWITCH-01: the branch picker at the top of the sidebar. */
export function BranchSwitcher({ branches, role }: { branches: BranchLite[]; role: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = branches[0];
  const owner = role === "owner" || role === "super";
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!current) return null;
  const many = branches.length > 1;
  return (
    <div className="branch-switch" ref={box}>
      <button className="salon-switch" type="button" aria-expanded={open} onClick={() => (many || owner) && setOpen(!open)}>
        <img src={SALON_PHOTO} alt="" />
        <div>
          <strong>{current.name}</strong>
          <span>{many ? `Сеть · ${branches.length} филиала` : current.address || "Филиал"}</span>
        </div>
        {(many || owner) && <ChevronDown size={15} className="muted" style={{ marginLeft: "auto" }} />}
      </button>
      {open && (
        <div className="branch-menu panel" role="menu">
          {branches.map((branch, index) => (
            <button key={branch.id} type="button" role="menuitem" className="branch-item" onClick={() => index === 0 ? setOpen(false) : switchTo(branch.id)}>
              <span><b>{branch.name}</b><small className="muted">{branch.address}</small></span>
              {index === 0 && <Check size={15} />}
            </button>
          ))}
          {owner && (
            <div className="branch-menu-foot">
              {many && <Link href="/network" onClick={() => setOpen(false)}><Network size={14} /> Сравнить филиалы</Link>}
              <Link href="/settings#branches" onClick={() => setOpen(false)}><Plus size={14} /> Открыть филиал</Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ NET-DASH-01

type Stats = {
  branchId: string;
  name: string;
  address: string;
  revenueMinor: number;
  revenueBeforeMinor: number;
  revenueChange: number | null;
  averageCheckMinor: number;
  appointments: number;
  completed: number;
  cancelled: number;
  noShow: number;
  noShowRate: number;
  online: number;
  clients: number;
  newClients: number;
  loadPercent: number;
  staff: number;
  sharePercent: number;
};
type Summary = {
  from: string;
  to: string;
  previous: { from: string; to: string };
  branches: Stats[];
  total: {
    revenueMinor: number;
    revenueChange: number | null;
    averageCheckMinor: number;
    appointments: number;
    noShow: number;
    noShowRate: number;
    online: number;
    clients: number;
    clientsInSeveralBranches: number;
    newClients: number;
    loadPercent: number;
  };
};
type Preset = "7" | "30" | "month" | "prev";
type Sort = "revenueMinor" | "loadPercent" | "noShowRate" | "averageCheckMinor";

const short = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

function Delta({ value }: { value: number | null }) {
  if (value === null) return <small className="muted">нет данных за прошлый период</small>;
  return <small className={value === 0 ? "muted" : value > 0 ? "delta up" : "delta down"}>{value > 0 ? "+" : ""}{value}% к прошлому периоду</small>;
}

function loadTone(percent: number) {
  if (percent >= 85) return "hot";
  if (percent >= 55) return "ok";
  return "low";
}

export function NetworkView() {
  const [zone, setZone] = useState("Europe/Moscow");
  const [role, setRole] = useState("");
  const [preset, setPreset] = useState<Preset>("30");
  const [sort, setSort] = useState<Sort>("revenueMinor");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ actor: { role: string }; branches: BranchLite[] }>("/api/auth/me").then((me) => {
      setRole(me.actor.role);
      setZone(me.branches[0]?.timezone ?? "Europe/Moscow");
    }).catch((err: ApiError) => setError(err.message));
  }, []);

  const range = useMemo(() => {
    const today = todayInZone(zone);
    if (preset === "7") return { from: addCalendarDays(today, -6), to: today };
    if (preset === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
    if (preset === "prev") {
      const last = addCalendarDays(`${today.slice(0, 7)}-01`, -1);
      return { from: `${last.slice(0, 7)}-01`, to: last };
    }
    return { from: addCalendarDays(today, -29), to: today };
  }, [zone, preset]);

  useEffect(() => {
    if (!role) return;
    setData(null);
    api<Summary>(`/api/network?from=${range.from}&to=${range.to}`).then((value) => { setData(value); setError(""); }).catch((err: ApiError) => setError(err.message));
  }, [range, role]);

  const rows = useMemo(() => {
    if (!data) return [];
    const list = [...data.branches];
    return list.sort((a, b) => (sort === "noShowRate" ? a[sort] - b[sort] : b[sort] - a[sort]));
  }, [data, sort]);
  const maxRevenue = Math.max(1, ...rows.map((row) => row.revenueMinor));

  return (
    <div className="reports-page">
      <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
        <div><div className="page-kicker">Сеть салонов</div><h1>Филиалы</h1></div>
        <div className="segment">
          {([["7", "7 дней"], ["30", "30 дней"], ["month", "Этот месяц"], ["prev", "Прошлый месяц"]] as [Preset, string][]).map(([value, label]) => (
            <button key={value} type="button" className={preset === value ? "on" : ""} onClick={() => setPreset(value)}>{label}</button>
          ))}
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <>
          <div className="report-tiles period-tiles">
            <div className="panel report-tile"><span className="muted">Выручка сети</span><b className="display">{formatMoney(data.total.revenueMinor)}</b><Delta value={data.total.revenueChange} /></div>
            <div className="panel report-tile"><span className="muted">Загрузка мастеров</span><b className="display">{data.total.loadPercent}%</b><small className="muted">записанное время к рабочему</small></div>
            <div className="panel report-tile"><span className="muted">Неявки</span><b className="display">{data.total.noShowRate}%</b><small className="muted">{data.total.noShow} из {data.total.appointments} записей</small></div>
            <div className="panel report-tile"><span className="muted">Клиентов</span><b className="display">{data.total.clients}</b><small className="muted">в нескольких филиалах: {data.total.clientsInSeveralBranches}</small></div>
          </div>

          <div className="panel list">
            <div className="spread" style={{ flexWrap: "wrap", gap: 8 }}>
              <h3 style={{ margin: 0 }}>Сравнение филиалов · {short(data.from)} — {short(data.to)}</h3>
              <div className="segment small">
                {([["revenueMinor", "Выручка"], ["loadPercent", "Загрузка"], ["noShowRate", "Неявки"], ["averageCheckMinor", "Средний чек"]] as [Sort, string][]).map(([value, label]) => (
                  <button key={value} type="button" className={sort === value ? "on" : ""} onClick={() => setSort(value)}>{label}</button>
                ))}
              </div>
            </div>
            <div className="net-rows">
              {rows.map((row) => (
                <div key={row.branchId} className="net-row">
                  <div className="net-name">
                    <b>{row.name}</b>
                    <small className="muted">{row.address || "адрес не указан"} · мастеров {row.staff}</small>
                  </div>
                  <div className="net-revenue">
                    <div className="spread"><b>{formatMoney(row.revenueMinor)}</b><small className="muted">{row.sharePercent}% сети</small></div>
                    <div className="net-bar"><i style={{ width: `${Math.max(2, (100 * Math.max(0, row.revenueMinor)) / maxRevenue)}%` }} /></div>
                    <Delta value={row.revenueChange} />
                  </div>
                  <div className="net-metric"><span className="muted">Загрузка</span><b className={`load-chip ${loadTone(row.loadPercent)}`}>{row.loadPercent}%</b></div>
                  <div className="net-metric"><span className="muted">Неявки</span><b className={row.noShowRate >= 10 ? "delta down" : ""}>{row.noShowRate}%</b><small className="muted">{row.noShow} из {row.appointments}</small></div>
                  <div className="net-metric"><span className="muted">Средний чек</span><b>{formatMoney(Math.round(row.averageCheckMinor / 100) * 100)}</b><small className="muted">визитов {row.completed}</small></div>
                  <div className="net-metric"><span className="muted">Клиенты</span><b>{row.clients}</b><small className="muted">новых {row.newClients} · онлайн {row.online}</small></div>
                  <div className="net-actions">
                    <button type="button" className="btn" onClick={() => switchTo(row.branchId, "/journal")}>Журнал</button>
                    <button type="button" className="btn" onClick={() => switchTo(row.branchId, "/reports?tab=period")}>Отчёт</button>
                  </div>
                </div>
              ))}
            </div>
            {rows.length < 2 && (role === "owner" || role === "super") && (
              <span className="muted" style={{ fontSize: 13 }}>Пока один филиал. <Link href="/settings#branches">Открыть второй →</Link></span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ NET-BRANCH-01

const ZONES: [string, string][] = [
  ["Europe/Kaliningrad", "Калининград (МСК−1)"],
  ["Europe/Moscow", "Москва (МСК)"],
  ["Europe/Samara", "Самара (МСК+1)"],
  ["Asia/Yekaterinburg", "Екатеринбург (МСК+2)"],
  ["Asia/Omsk", "Омск (МСК+3)"],
  ["Asia/Novosibirsk", "Новосибирск (МСК+4)"],
  ["Asia/Krasnoyarsk", "Красноярск (МСК+4)"],
  ["Asia/Irkutsk", "Иркутск (МСК+5)"],
  ["Asia/Yakutsk", "Якутск (МСК+6)"],
  ["Asia/Vladivostok", "Владивосток (МСК+7)"],
  ["Asia/Magadan", "Магадан (МСК+8)"],
  ["Asia/Kamchatka", "Камчатка (МСК+9)"],
];

export function BranchesSettings({ currentId }: { currentId: string }) {
  const toast = useToast();
  const [branches, setBranches] = useState<BranchLite[]>([]);
  const [staff, setStaff] = useState<{ id: string; displayName: string; active: boolean }[]>([]);
  const [form, setForm] = useState({ name: "", address: "", phone: "", timezone: "Europe/Moscow", copyFrom: currentId, staffIds: [] as string[] });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<BranchLite[]>("/api/branches").then(setBranches).catch(() => undefined);
    api<{ id: string; displayName: string; active: boolean }[]>("/api/staff").then(setStaff).catch(() => undefined);
  }, []);
  const toggle = (id: string) => setForm({ ...form, staffIds: form.staffIds.includes(id) ? form.staffIds.filter((value) => value !== id) : [...form.staffIds, id] });
  return (
    <form
      id="branches"
      className="panel list"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          const created = await api<BranchLite>("/api/branches", { method: "POST", body: JSON.stringify(form) });
          setBranches([...branches, created]);
          setForm({ ...form, name: "", address: "", phone: "", staffIds: [] });
          toast(`Филиал «${created.name}» открыт`);
        } catch (error) {
          toast((error as ApiError).message, "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="spread">
        <h2 style={{ margin: 0 }}>Филиалы сети</h2>
        {branches.length > 1 && <Link className="btn" href="/network" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Network size={15} /> Сравнить</Link>}
      </div>
      <div className="branch-list">
        {branches.map((branch) => (
          <div key={branch.id} className="branch-card">
            <div><b>{branch.name}</b><small className="muted">{branch.address || "адрес не указан"} · {ZONES.find(([zone]) => zone === branch.timezone)?.[1] ?? branch.timezone}</small></div>
            {branch.id === currentId ? <span className="chip">сейчас открыт</span> : <button type="button" className="btn" onClick={() => switchTo(branch.id, "/settings")}>Перейти</button>}
          </div>
        ))}
      </div>
      <h3 style={{ margin: "6px 0 0" }}>Открыть новый филиал</h3>
      <div className="form-grid-2">
        <div className="field"><label>Название</label><input required value={form.name} placeholder="Например, Тверская" onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
        <div className="field"><label>Телефон</label><input value={form.phone} placeholder="+7 …" onChange={(event) => setForm({ ...form, phone: event.target.value })} /></div>
        <div className="field"><label>Адрес</label><input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></div>
        <div className="field">
          <label>Часовой пояс</label>
          <select value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>
            {ZONES.map(([zone, label]) => <option key={zone} value={zone}>{label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Настройки взять из</label>
          <select value={form.copyFrom} onChange={(event) => setForm({ ...form, copyFrom: event.target.value })}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>Правила журнала, онлайн-записи, напоминаний и склада. Онлайн-кассу и ИНН филиал настраивает сам.</span>
        </div>
      </div>
      {staff.some((member) => member.active) && (
        <div className="field">
          <label>Мастера, которые будут работать и здесь</label>
          <div className="chip-row">
            {staff.filter((member) => member.active).map((member) => (
              <button key={member.id} type="button" className={`chip ${form.staffIds.includes(member.id) ? "on" : ""}`} onClick={() => toggle(member.id)}>{member.displayName}</button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>График в новом филиале задаётся в «Мастерах». Записать мастера в два филиала на одно время нельзя.</span>
        </div>
      )}
      <button className="btn-gradient" type="submit" disabled={busy}>{busy ? "Открываю…" : "Открыть филиал"}</button>
    </form>
  );
}
