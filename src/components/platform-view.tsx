"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/domain/money";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type State = "trial" | "active" | "grace" | "expired" | "suspended";
type Row = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  planTitle: string;
  state: State;
  until: string | null;
  daysLeft: number;
  suspendedReason: string;
  createdAt: string;
  ownerEmail: string;
  staff: number;
  branches: number;
  appointments30d: number;
  lastActivity: string | null;
  paidTotalMinor: number;
};
type Invoice = { id: string; tenantId: string; tenantName: string; number: number; planTitle: string; months: number; amountMinor: number; status: string; provider: string; createdAt: string; paidAt: string | null; periodTo: string | null };
type Task = { id: string; tenantId: string | null; tenantName: string; title: string; note: string; dueOn: string | null; doneAt: string | null; createdBy: string; createdAt: string };
type Event = { at: string; kind: string; tenantId: string | null; tenantName: string; text: string; amountMinor: number | null };
type Overview = {
  totals: Record<"tenants" | "trial" | "active" | "grace" | "expired" | "suspended" | "mrrMinor" | "arrMinor" | "paidTotalMinor" | "paid30dMinor" | "pendingInvoices" | "signups30d" | "openTasks" | "overdueTasks", number> & { conversion: number | null };
  months: { month: string; paidMinor: number; invoices: number; signups: number }[];
  plans: { plan: string; title: string; count: number }[];
  risk: { id: string; name: string; ownerEmail: string; state: State; planTitle: string; daysLeft: number; reasons: string[] }[];
};
type Detail = {
  tenant: Row;
  usage: { clients: number; appointmentsTotal: number; appointments7d: number; online30d: number; revenue30dMinor: number; users: number; branchNames: string[]; months: { month: string; appointments: number }[] };
  invoices: Invoice[];
  tasks: Task[];
  events: Event[];
};

const STATE: Record<State, string> = { trial: "пробный", active: "оплачен", grace: "льготные дни", expired: "только просмотр", suspended: "приостановлен" };
const INVOICE: Record<string, string> = { pending: "ждёт оплаты", paid: "оплачен", canceled: "отменён" };
const EVENT_ICON: Record<string, string> = { signup: "✦", invoice: "₽", paid: "✓", suspended: "■", action: "•" };
const date = (value: string | null) => (value ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "2-digit" }) : "—");
const dateTime = (value: string) => new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const monthLabel = (key: string) => MONTHS[Number(key.slice(5, 7)) - 1] ?? key;
const today = () => new Date().toISOString().slice(0, 10);
const TABS = [["overview", "Сводка"], ["tenants", "Салоны"], ["invoices", "Оплаты"], ["tasks", "Дела"], ["events", "События"]] as const;
type Tab = (typeof TABS)[number][0];

/** PLAT-CABINET-05: the platform owner's own frame — no salon menu, no salon data. */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<{ name: string; email: string } | null>(null);
  useEffect(() => {
    api<{ name: string; email: string }>("/api/platform/me").then(setMe).catch(() => router.replace("/login"));
  }, [router]);
  return (
    <div className="plat-app">
      <header className="plat-top">
        <div className="wordmark"><span className="am">Am</span><span className="beauty">BEAUTY</span></div>
        <span className="plat-badge">Платформа</span>
        <div className="plat-top-user">
          {me && <span className="muted">{me.name} · {me.email}</span>}
          <button type="button" className="btn-ghost" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); router.push("/login"); }}>Выйти</button>
        </div>
      </header>
      <main className="plat-main">{me ? children : <div className="skeleton" />}</main>
    </div>
  );
}

/** PLAT-CABINET-*: the platform owner's cabinet — subscriptions, money, risk, to-dos, events. */
export function PlatformView() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("overview");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const [list, summary, bills, todo, feed] = await Promise.all([
        api<Row[]>("/api/platform/tenants"),
        api<Overview>("/api/platform/overview"),
        api<Invoice[]>("/api/platform/invoices"),
        api<Task[]>("/api/platform/tasks"),
        api<Event[]>("/api/platform/events?limit=150"),
      ]);
      setRows(list); setOverview(summary); setInvoices(bills); setTasks(todo); setEvents(feed);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const update = async (row: Row, body: Record<string, unknown>, done: string) => {
    try {
      const saved = await api<Row>(`/api/platform/tenants/${row.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setRows((list) => list?.map((item) => (item.id === row.id ? saved : item)) ?? null);
      toast(done);
      void reload();
      return saved;
    } catch (err) {
      toast((err as ApiError).message, "error");
      return null;
    }
  };

  if (error) return <div className="reports-page"><div className="banner">{error}</div></div>;
  if (!rows || !overview || !invoices || !tasks || !events) return <div className="skeleton" />;
  const openTasks = tasks.filter((item) => !item.doneAt).length;
  return (
    <div className="reports-page platform">
      <div className="journal-top">
        <div><div className="page-kicker">Кабинет владельца платформы</div><h1 className="date-title">Подписки и салоны</h1></div>
        <div className="segment">
          {TABS.map(([value, label]) => (
            <button key={value} type="button" className={tab === value ? "on" : ""} onClick={() => setTab(value)}>
              {label}{value === "tasks" && openTasks ? ` · ${openTasks}` : ""}
            </button>
          ))}
        </div>
      </div>
      {tab === "overview" && <OverviewTab data={overview} onOpen={setOpenId} onTab={setTab} />}
      {tab === "tenants" && <TenantsTab rows={rows} onOpen={setOpenId} />}
      {tab === "invoices" && <InvoicesTab invoices={invoices} onOpen={setOpenId} />}
      {tab === "tasks" && <TasksTab tasks={tasks} tenants={rows} onChanged={reload} onOpen={setOpenId} />}
      {tab === "events" && <EventsTab events={events} onOpen={setOpenId} />}
      {openId && <TenantDrawer id={openId} onClose={() => setOpenId(null)} onUpdate={update} onChanged={reload} />}
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className={`panel report-tile ${tone ?? ""}`}>
      <span className="muted">{label}</span>
      <b className="display">{value}</b>
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

function OverviewTab({ data, onOpen, onTab }: { data: Overview; onOpen: (id: string) => void; onTab: (tab: Tab) => void }) {
  const { totals } = data;
  const max = Math.max(...data.months.map((item) => item.paidMinor), 1);
  const planMax = Math.max(...data.plans.map((item) => item.count), 1);
  return (
    <>
      <div className="report-tiles plat-tiles">
        <Tile label="MRR, в месяц" value={formatMoney(totals.mrrMinor)} hint={`ARR ≈ ${formatMoney(totals.arrMinor)}`} />
        <Tile label="Платят" value={String(totals.active)} hint={`из ${totals.tenants} салонов · пробный ${totals.trial}`} />
        <Tile label="Поступило за 30 дней" value={formatMoney(totals.paid30dMinor)} hint={`всего ${formatMoney(totals.paidTotalMinor)}`} />
        <Tile label="Пробный → оплата" value={totals.conversion === null ? "—" : `${totals.conversion}%`} hint={`новых за 30 дней: ${totals.signups30d}`} />
        <Tile label="Под угрозой" value={String(totals.grace + totals.expired)} hint={`льготные ${totals.grace} · просмотр ${totals.expired} · стоп ${totals.suspended}`} tone={totals.grace + totals.expired ? "warn" : ""} />
        <Tile label="Дела" value={String(totals.openTasks)} hint={totals.overdueTasks ? `просрочено ${totals.overdueTasks}` : `счетов ждут оплаты: ${totals.pendingInvoices}`} tone={totals.overdueTasks ? "warn" : ""} />
      </div>
      <div className="report-grid">
        <div className="panel list">
          <div className="spread"><h2 className="report-h">Выручка платформы по месяцам</h2><small className="muted">оплаченные счета</small></div>
          <div className="plat-bars">
            {data.months.map((item) => (
              <div key={item.month} className="plat-bar" title={`${item.month}: ${formatMoney(item.paidMinor)}, счетов ${item.invoices}, новых салонов ${item.signups}`}>
                <small>{item.paidMinor ? formatMoney(item.paidMinor).replace(/\s?₽/, "") : ""}</small>
                <i style={{ height: `${Math.max(2, Math.round((item.paidMinor / max) * 100))}%` }} />
                <span>{monthLabel(item.month)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel list">
          <h2 className="report-h">Салоны по тарифам</h2>
          {data.plans.map((item) => (
            <div key={item.plan} className="plat-plan">
              <span>{item.title}</span>
              <div className="report-bar"><span style={{ width: `${Math.round((item.count / planMax) * 100)}%`, background: "linear-gradient(90deg,#7b5cff,#ff4d8d)" }} /></div>
              <b>{item.count}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="panel list">
        <div className="spread"><h2 className="report-h">Кому нужно внимание</h2><button type="button" className="btn-ghost" onClick={() => onTab("tenants")}>Все салоны</button></div>
        {data.risk.length === 0 && <span className="muted">Всё спокойно: никто не уходит и все активны.</span>}
        {data.risk.map((item) => (
          <button key={item.id} type="button" className="person plat-risk" onClick={() => onOpen(item.id)}>
            <div style={{ flex: 1 }}>
              <strong>{item.name}</strong>
              <span>{item.planTitle} · {item.ownerEmail || "без владельца"}</span>
            </div>
            <div className="plat-reasons">{item.reasons.map((reason) => <span key={reason} className={`tag ${/кончи|льгот|закончил/.test(reason) ? "tag-warn" : "tag-muted"}`}>{reason}</span>)}</div>
          </button>
        ))}
      </div>
    </>
  );
}

function TenantsTab({ rows, onOpen }: { rows: Row[]; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"created" | "until" | "paid" | "activity">("created");
  const shown = useMemo(() => {
    const list = rows.filter((row) => (filter === "all" || row.state === filter || (filter === "expired" && row.state === "grace")) && (!query || `${row.name} ${row.slug} ${row.ownerEmail}`.toLowerCase().includes(query.toLowerCase())));
    const time = (value: string | null) => (value ? new Date(value).getTime() : 0);
    return [...list].sort((a, b) => sort === "until" ? a.daysLeft - b.daysLeft : sort === "paid" ? b.paidTotalMinor - a.paidTotalMinor : sort === "activity" ? time(b.lastActivity) - time(a.lastActivity) : time(b.createdAt) - time(a.createdAt));
  }, [rows, filter, query, sort]);
  return (
    <div className="panel list">
      <div className="period-bar">
        <div className="segment">
          {[["all", "Все"], ["trial", "Пробный"], ["active", "Платят"], ["expired", "Закончилась"], ["suspended", "Стоп"]].map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? "on" : ""} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <input className="report-date" placeholder="Салон, адрес или почта" value={query} onChange={(event) => setQuery(event.target.value)} style={{ minWidth: 220 }} />
        <select className="report-date" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Сортировка">
          <option value="created">Сначала новые</option>
          <option value="until">Скоро кончится</option>
          <option value="paid">Больше заплатили</option>
          <option value="activity">Недавно активны</option>
        </select>
      </div>
      <div className="plat-scroll">
        <table className="plain-table platform-table">
          <thead><tr><th>Салон</th><th>Тариф</th><th>До</th><th>Мастера / филиалы</th><th>Записей за 30 дн.</th><th>Оплачено</th></tr></thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id} className="plat-row" onClick={() => onOpen(row.id)}>
                <td><b>{row.name}</b><small className="muted">{row.slug} · {row.ownerEmail || "без владельца"} · с {date(row.createdAt)}</small></td>
                <td>{row.planTitle}<small className={`state-${row.state}`}>{STATE[row.state]}{row.suspendedReason ? `: ${row.suspendedReason}` : ""}</small></td>
                <td className="nowrap">{date(row.until)}{row.state !== "suspended" && <small className="muted">{row.daysLeft >= 0 ? `осталось ${row.daysLeft} дн.` : `${-row.daysLeft} дн. назад`}</small>}</td>
                <td>{row.staff} / {row.branches}</td>
                <td>{row.appointments30d}<small className="muted">активность {date(row.lastActivity)}</small></td>
                <td className="nowrap">{formatMoney(row.paidTotalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <span className="muted">Ничего не найдено</span>}
    </div>
  );
}

function InvoicesTab({ invoices, onOpen }: { invoices: Invoice[]; onOpen: (id: string) => void }) {
  const [status, setStatus] = useState("all");
  const shown = invoices.filter((item) => status === "all" || item.status === status);
  const sum = shown.filter((item) => item.status === "paid").reduce((total, item) => total + item.amountMinor, 0);
  return (
    <div className="panel list">
      <div className="period-bar">
        <div className="segment">
          {[["all", "Все"], ["paid", "Оплачены"], ["pending", "Ждут оплаты"], ["canceled", "Отменены"]].map(([value, label]) => (
            <button key={value} type="button" className={status === value ? "on" : ""} onClick={() => setStatus(value)}>{label}</button>
          ))}
        </div>
        <span className="muted">оплачено в списке: <b>{formatMoney(sum)}</b></span>
      </div>
      <div className="plat-scroll">
        <table className="plain-table platform-table">
          <thead><tr><th>Счёт</th><th>Салон</th><th>Тариф</th><th>Сумма</th><th>Статус</th><th>Период до</th></tr></thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id} className="plat-row" onClick={() => onOpen(item.tenantId)}>
                <td className="nowrap">№{item.number}<small className="muted">{date(item.createdAt)} · {item.provider === "test" ? "песочница" : "ЮKassa"}</small></td>
                <td>{item.tenantName}</td>
                <td>{item.planTitle}<small className="muted">{item.months} мес.</small></td>
                <td className="nowrap">{formatMoney(item.amountMinor)}</td>
                <td><span className={`tag ${item.status === "paid" ? "tag-ok" : item.status === "pending" ? "tag-warn" : "tag-muted"}`}>{INVOICE[item.status] ?? item.status}</span>{item.paidAt && <small className="muted">{date(item.paidAt)}</small>}</td>
                <td className="nowrap">{date(item.periodTo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <span className="muted">Счетов пока нет</span>}
    </div>
  );
}

function TaskForm({ tenants, tenantId, onCreated }: { tenants?: Row[]; tenantId?: string; onCreated: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [tenant, setTenant] = useState(tenantId ?? "");
  return (
    <form
      className="panel plat-task-form"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await api("/api/platform/tasks", { method: "POST", body: JSON.stringify({ title, dueOn: dueOn || null, tenantId: tenant || null }) });
          setTitle(""); setDueOn("");
          toast("Дело добавлено");
          onCreated();
        } catch (err) {
          toast((err as ApiError).message, "error");
        }
      }}
    >
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Что сделать: позвонить, выставить счёт, помочь с настройкой…" required />
      {tenants && (
        <select value={tenant} onChange={(event) => setTenant(event.target.value)} aria-label="Салон">
          <option value="">Без салона</option>
          {tenants.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      )}
      <input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} aria-label="Срок" />
      <button className="btn-gradient" type="submit">Добавить</button>
    </form>
  );
}

function TaskList({ tasks, onChanged, onOpen }: { tasks: Task[]; onChanged: () => void; onOpen?: (id: string) => void }) {
  const toast = useToast();
  const now = today();
  const act = async (path: string, init: RequestInit) => {
    try { await api(path, init); onChanged(); } catch (err) { toast((err as ApiError).message, "error"); }
  };
  if (tasks.length === 0) return <span className="muted">Дел нет.</span>;
  return (
    <div className="list">
      {tasks.map((item) => {
        const overdue = !item.doneAt && item.dueOn && item.dueOn < now;
        return (
          <div key={item.id} className={`plat-task ${item.doneAt ? "done" : ""}`}>
            <input type="checkbox" checked={!!item.doneAt} aria-label="Сделано" onChange={(event) => act(`/api/platform/tasks/${item.id}`, { method: "PATCH", body: JSON.stringify({ done: event.target.checked }) })} />
            <div className="plat-task-main">
              <strong>{item.title}</strong>
              <small className="muted">
                {item.tenantId && onOpen ? <button type="button" className="link-btn" onClick={() => onOpen(item.tenantId!)}>{item.tenantName}</button> : item.tenantName}
                {item.tenantName ? " · " : ""}{item.createdBy}
              </small>
            </div>
            {item.dueOn && <span className={`tag ${overdue ? "tag-bad" : item.dueOn === now ? "tag-warn" : "tag-muted"}`}>{overdue ? "просрочено " : ""}{date(item.dueOn)}</span>}
            <button type="button" className="btn-ghost" aria-label="Удалить" onClick={() => act(`/api/platform/tasks/${item.id}`, { method: "DELETE" })}>×</button>
          </div>
        );
      })}
    </div>
  );
}

function TasksTab({ tasks, tenants, onChanged, onOpen }: { tasks: Task[]; tenants: Row[]; onChanged: () => void; onOpen: (id: string) => void }) {
  const open = tasks.filter((item) => !item.doneAt);
  const done = tasks.filter((item) => item.doneAt);
  return (
    <>
      <TaskForm tenants={tenants} onCreated={onChanged} />
      <div className="panel list">
        <h2 className="report-h">Открытые · {open.length}</h2>
        <TaskList tasks={open} onChanged={onChanged} onOpen={onOpen} />
      </div>
      {done.length > 0 && (
        <div className="panel list">
          <h2 className="report-h">Сделано за 30 дней · {done.length}</h2>
          <TaskList tasks={done} onChanged={onChanged} onOpen={onOpen} />
        </div>
      )}
    </>
  );
}

function EventList({ events, onOpen }: { events: Event[]; onOpen?: (id: string) => void }) {
  if (events.length === 0) return <span className="muted">Событий пока нет.</span>;
  return (
    <div className="plat-feed">
      {events.map((item, index) => (
        <div key={`${item.at}-${index}`} className={`plat-event ev-${item.kind}`}>
          <i>{EVENT_ICON[item.kind] ?? "•"}</i>
          <div>
            <strong>{item.text}</strong>
            <small className="muted">
              {item.tenantId && onOpen ? <button type="button" className="link-btn" onClick={() => onOpen(item.tenantId!)}>{item.tenantName}</button> : item.tenantName}
              {item.tenantName ? " · " : ""}{dateTime(item.at)}
            </small>
          </div>
          {item.amountMinor !== null && <b>{formatMoney(item.amountMinor)}</b>}
        </div>
      ))}
    </div>
  );
}

function EventsTab({ events, onOpen }: { events: Event[]; onOpen: (id: string) => void }) {
  const [kind, setKind] = useState("all");
  const shown = events.filter((item) => kind === "all" || item.kind === kind);
  return (
    <div className="panel list">
      <div className="segment" style={{ alignSelf: "flex-start" }}>
        {[["all", "Все"], ["signup", "Регистрации"], ["paid", "Оплаты"], ["invoice", "Счета"], ["suspended", "Остановки"], ["action", "Действия команды"]].map(([value, label]) => (
          <button key={value} type="button" className={kind === value ? "on" : ""} onClick={() => setKind(value)}>{label}</button>
        ))}
      </div>
      <EventList events={shown} onOpen={onOpen} />
    </div>
  );
}

function TenantDrawer({ id, onClose, onUpdate, onChanged }: { id: string; onClose: () => void; onUpdate: (row: Row, body: Record<string, unknown>, done: string) => Promise<Row | null>; onChanged: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [days, setDays] = useState(30);
  const load = useCallback(() => api<Detail>(`/api/platform/tenants/${id}`).then(setData).catch((err: ApiError) => setError(err.message)), [id]);
  useEffect(() => { void load(); }, [load]);
  const apply = async (body: Record<string, unknown>, done: string) => {
    if (!data) return;
    if (await onUpdate(data.tenant, body, done)) void load();
  };
  const t = data?.tenant;
  const max = Math.max(...(data?.usage.months.map((item) => item.appointments) ?? [1]), 1);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer plat-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="spread">
          <div><div className="page-kicker">Салон</div><h2 className="display" style={{ margin: 0 }}>{t?.name ?? "…"}</h2></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>×</button>
        </div>
        {error && <div className="banner">{error}</div>}
        {!data || !t ? <div className="skeleton" /> : (
          <>
            <div className="plat-kv">
              <span>Владелец</span><b>{t.ownerEmail ? <a href={`mailto:${t.ownerEmail}`}>{t.ownerEmail}</a> : "—"}</b>
              <span>Адрес в системе</span><b>{t.slug}</b>
              <span>Тариф</span><b>{t.planTitle} · <span className={`state-${t.state}`}>{STATE[t.state]}</span></b>
              <span>Действует до</span><b>{date(t.until)}{t.state !== "suspended" ? ` · ${t.daysLeft >= 0 ? `осталось ${t.daysLeft} дн.` : `${-t.daysLeft} дн. назад`}` : ""}</b>
              <span>С нами с</span><b>{date(t.createdAt)}</b>
              <span>Филиалы</span><b>{data.usage.branchNames.join(", ") || "—"}</b>
            </div>
            <div className="plat-mini">
              <div><b>{t.staff}</b><span>мастеров</span></div>
              <div><b>{data.usage.users}</b><span>сотрудников с входом</span></div>
              <div><b>{data.usage.clients}</b><span>клиентов</span></div>
              <div><b>{data.usage.appointments7d}</b><span>записей за 7 дн.</span></div>
              <div><b>{data.usage.online30d}</b><span>онлайн за 30 дн.</span></div>
              <div><b>{formatMoney(data.usage.revenue30dMinor)}</b><span>касса салона, 30 дн.</span></div>
            </div>
            <div className="panel list">
              <h3 className="report-h">Записи по месяцам</h3>
              <div className="plat-bars small">
                {data.usage.months.map((item) => (
                  <div key={item.month} className="plat-bar" title={`${item.month}: ${item.appointments}`}>
                    <small>{item.appointments || ""}</small>
                    <i style={{ height: `${Math.max(2, Math.round((item.appointments / max) * 100))}%` }} />
                    <span>{monthLabel(item.month)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel list">
              <h3 className="report-h">Управление подпиской</h3>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <select className="report-date" value={t.plan} aria-label="Тариф" onChange={(event) => apply({ plan: event.target.value }, "Тариф изменён")}>
                  <option value="trial">Пробный</option>
                  <option value="start">Старт</option>
                  <option value="salon">Салон</option>
                  <option value="network">Сеть</option>
                </select>
                <input className="report-date" type="number" min={1} max={366} value={days} onChange={(event) => setDays(Number(event.target.value))} style={{ width: 80 }} aria-label="Дней" />
                <button type="button" className="btn" onClick={() => apply({ extendDays: days }, `Продлено на ${days} дн.`)}>Продлить</button>
                {t.state === "suspended" ? (
                  <button type="button" className="btn" onClick={() => apply({ suspend: false }, "Салон снова работает")}>Включить</button>
                ) : (
                  <button type="button" className="btn danger-text" onClick={() => {
                    const reason = window.prompt("Причина приостановки (её увидит салон)", "");
                    if (reason !== null) void apply({ suspend: true, reason }, "Салон приостановлен");
                  }}>Приостановить</button>
                )}
              </div>
            </div>
            <div className="panel list">
              <h3 className="report-h">Дела по салону</h3>
              <TaskForm tenantId={t.id} onCreated={() => { void load(); onChanged(); }} />
              <TaskList tasks={data.tasks} onChanged={() => { void load(); onChanged(); }} />
            </div>
            <div className="panel list">
              <h3 className="report-h">Счета</h3>
              {data.invoices.length === 0 && <span className="muted">Счетов не было.</span>}
              {data.invoices.map((item) => (
                <div key={item.id} className="spread plat-inv">
                  <span>№{item.number} · {item.planTitle}, {item.months} мес.<small className="muted"> {date(item.createdAt)}</small></span>
                  <span className="row"><b>{formatMoney(item.amountMinor)}</b><span className={`tag ${item.status === "paid" ? "tag-ok" : item.status === "pending" ? "tag-warn" : "tag-muted"}`}>{INVOICE[item.status] ?? item.status}</span></span>
                </div>
              ))}
            </div>
            <div className="panel list">
              <h3 className="report-h">История</h3>
              <EventList events={data.events} />
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
