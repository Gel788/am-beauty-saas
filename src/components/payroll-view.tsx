"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { todayInZone } from "@/domain/time";
import { api, type ApiError } from "./api";

type Status = "draft" | "calculated" | "approved" | "paid" | "locked";
type PeriodSummary = { id: string; startsOn: string; endsOn: string; status: Status; totalMinor: number; payoutMinor: number; staffCount: number; warningCount: number };
type Line = {
  id: string;
  type: string;
  manual: boolean;
  appointmentId: string | null;
  title: string;
  occurredOn: string | null;
  baseAmountMinor: number;
  rate: Record<string, unknown>;
  resultMinor: number;
  reason: string | null;
};
type Item = {
  id: string;
  staffId: string;
  staffName: string;
  accrualMinor: number;
  deductionMinor: number;
  tipMinor: number;
  totalMinor: number;
  payoutMinor: number;
  carryDebt: boolean;
  status: string;
  paidOn: string | null;
  paidMethod: string | null;
  paidReference: string | null;
  lines: Line[];
};
type Sheet = { id: string; startsOn: string; endsOn: string; status: Status; warnings: { code: string; message: string }[]; items: Item[] };
type Rule = {
  id: string;
  staffId: string | null;
  serviceId: string | null;
  scheme: "percent" | "fixed_per_service" | "salary" | "hybrid";
  percentBps: number;
  fixedMinor: number;
  salaryMinor: number;
  periodUnit: "month" | "biweekly" | "week";
  base: string;
  includeTips: boolean;
  deductMaterials?: boolean;
  validFrom: string;
  validTo: string | null;
};
type Me = { actor: { role: string; staffId: string | null }; branches: { id: string; name: string; timezone: string; currency: string }[] };

const STATUS: Record<Status, [string, string]> = {
  draft: ["Черновик", "tag-muted"],
  calculated: ["Рассчитан", "tag-warn"],
  approved: ["Утверждён", "tag-ok"],
  paid: ["Выплачен", "tag-ok"],
  locked: ["Закрыт", "tag-muted"],
};
const SCHEMES: Record<Rule["scheme"], string> = {
  percent: "Процент с услуги",
  fixed_per_service: "Фикс за услугу",
  salary: "Оклад",
  hybrid: "Оклад + процент",
};
const UNITS: Record<Rule["periodUnit"], string> = { month: "в месяц", biweekly: "за 2 недели", week: "в неделю" };
const LINE_TYPES: Record<string, string> = {
  service: "Услуга",
  salary: "Оклад",
  tip: "Чаевые",
  bonus: "Премия",
  penalty: "Штраф",
  adjustment: "Корректировка",
  refund_clawback: "Сторно",
};
const SETUP = ["owner", "admin", "accountant", "super"];
const MONEY = ["owner", "accountant", "super"];

function dayLabel(date: string) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function previousMonth(today: string) {
  const [y, m] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1));
  const end = new Date(Date.UTC(y, m - 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function rateLabel(line: Line, money: (n: number) => string) {
  const rate = line.rate as { scheme?: string; percentBps?: number; fixedMinor?: number };
  if (line.type !== "service") return "";
  if (rate.scheme === "fixed_per_service") return `фикс ${money(Number(rate.fixedMinor ?? 0))}`;
  const materials = Number((line.rate as { materialsMinor?: number }).materialsMinor ?? 0);
  return `${Number(rate.percentBps ?? 0) / 100}% от ${money(line.baseAmountMinor)}${materials ? ` (материалы −${money(materials)})` : ""}`;
}

export function PayrollView() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"periods" | "rules">("periods");
  const [error, setError] = useState("");

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch((err: ApiError) => setError(err.message));
  }, []);

  const branch = me?.branches[0];
  const role = me?.actor.role ?? "";
  if (!me || !branch) return <div className="reports-page">{error ? <div className="banner">{error}</div> : <div className="skeleton" />}</div>;
  const money = (minor: number) => formatMoney(minor, branch.currency ?? "RUB");

  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">{branch.name}</div>
          <h1 className="date-title">{role === "master" ? "Моя зарплата" : "Зарплаты"}</h1>
        </div>
        {SETUP.includes(role) && (
          <div className="segment">
            <button className={tab === "periods" ? "on" : ""} onClick={() => setTab("periods")}>Периоды</button>
            <button className={tab === "rules" ? "on" : ""} onClick={() => setTab("rules")}>Правила оплаты</button>
          </div>
        )}
      </div>
      {error && <div className="banner">{error}</div>}
      {tab === "periods" ? (
        <Periods branchId={branch.id} timezone={branch.timezone} role={role} money={money} onError={setError} />
      ) : (
        <Rules money={money} onError={setError} />
      )}
    </div>
  );
}

function Periods({ branchId, timezone, role, money, onError }: { branchId: string; timezone: string; role: string; money: (n: number) => string; onError: (m: string) => void }) {
  const [periods, setPeriods] = useState<PeriodSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const defaults = useMemo(() => previousMonth(todayInZone(timezone)), [timezone]);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);

  const load = useCallback(async () => {
    try {
      setPeriods(await api<PeriodSummary[]>(`/api/payroll/periods?branchId=${branchId}`));
    } catch (err) {
      onError((err as ApiError).message);
    }
  }, [branchId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    onError("");
    try {
      const sheet = await api<Sheet>("/api/payroll/periods", { method: "POST", body: JSON.stringify({ branchId, startsOn: from, endsOn: to }) });
      await load();
      setOpenId(sheet.id);
    } catch (err) {
      onError((err as ApiError).message);
    }
  }

  if (openId) {
    return <PeriodSheet id={openId} role={role} money={money} onError={onError} onBack={() => { setOpenId(null); void load(); }} />;
  }

  return (
    <>
      {SETUP.includes(role) && (
        <div className="panel row" style={{ flexWrap: "wrap", gap: 12 }}>
          <b>Новый период</b>
          <input className="report-date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="Начало" />
          <span className="muted">—</span>
          <input className="report-date" type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="Конец" />
          <button className="btn-gradient" onClick={create}>Создать</button>
        </div>
      )}
      <div className="panel list">
        <table className="report-table">
          <thead>
            <tr><th>Период</th><th>Статус</th><th className="num">Мастеров</th><th className="num">Начислено</th><th className="num">К выплате</th></tr>
          </thead>
          <tbody>
            {periods === null && <tr><td colSpan={5} className="muted">Загрузка…</td></tr>}
            {periods?.length === 0 && (
              <tr><td colSpan={5} className="muted">{role === "master" ? "Утверждённых расчётов пока нет" : "Периодов пока нет — создайте первый"}</td></tr>
            )}
            {periods?.map((period) => (
              <tr key={period.id}>
                <td>
                  <a href="#" onClick={(event) => { event.preventDefault(); setOpenId(period.id); }}>
                    {dayLabel(period.startsOn)} — {dayLabel(period.endsOn)}
                  </a>
                  {period.warningCount > 0 && <span className="tag tag-warn" style={{ marginLeft: 6 }}>{period.warningCount} предупр.</span>}
                </td>
                <td><span className={`tag ${STATUS[period.status][1]}`}>{STATUS[period.status][0]}</span></td>
                <td className="num">{period.staffCount}</td>
                <td className="num">{money(period.totalMinor)}</td>
                <td className="num">{money(period.payoutMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PeriodSheet({ id, role, money, onError, onBack }: { id: string; role: string; money: (n: number) => string; onError: (m: string) => void; onBack: () => void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<"cash" | "transfer">("transfer");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api<Sheet>(`/api/payroll/periods/${id}`).then(setSheet).catch((err: ApiError) => onError(err.message));
  }, [id, onError]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    onError("");
    try {
      setSheet(await api<Sheet>(`/api/payroll/periods/${id}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }));
    } catch (err) {
      onError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(lineId: string) {
    onError("");
    try {
      setSheet(await api<Sheet>(`/api/payroll/periods/${id}/lines/${lineId}`, { method: "DELETE" }));
    } catch (err) {
      onError((err as ApiError).message);
    }
  }

  if (!sheet) return <div className="skeleton" />;
  const editable = sheet.status === "draft" || sheet.status === "calculated";
  const canMoney = MONEY.includes(role);
  const total = sheet.items.reduce((sum, item) => sum + item.payoutMinor, 0);

  return (
    <>
      <div className="panel spread" style={{ flexWrap: "wrap" }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn-ghost" onClick={onBack}>‹ Все периоды</button>
          <b>{dayLabel(sheet.startsOn)} — {dayLabel(sheet.endsOn)}</b>
          <span className={`tag ${STATUS[sheet.status][1]}`}>{STATUS[sheet.status][0]}</span>
          {role !== "master" && <span className="muted">к выплате {money(total)}</span>}
        </div>
        {role !== "master" && (
          <div className="row" style={{ flexWrap: "wrap" }}>
            {editable && <button className="btn" disabled={busy} onClick={() => act("calculate")}>{sheet.status === "draft" ? "Рассчитать" : "Пересчитать"}</button>}
            {sheet.status === "calculated" && canMoney && <button className="btn-gradient" disabled={busy} onClick={() => act("approve")}>Утвердить</button>}
            {sheet.status === "approved" && canMoney && (
              <>
                <button className="btn-ghost" disabled={busy} onClick={() => act("unapprove")}>Снять утверждение</button>
                <input className="report-date" type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} aria-label="Дата выплаты" />
                <select className="report-date" value={method} onChange={(event) => setMethod(event.target.value as "cash" | "transfer")} aria-label="Способ">
                  <option value="transfer">Перевод</option>
                  <option value="cash">Наличные</option>
                </select>
                <button className="btn-gradient" disabled={busy} onClick={() => act("pay", { paidOn, method })}>Выплатить всем</button>
              </>
            )}
            {sheet.status === "paid" && (role === "owner" || role === "super") && (
              <button className="btn-gradient" disabled={busy} onClick={() => act("lock")}>Закрыть период</button>
            )}
          </div>
        )}
      </div>

      {sheet.warnings.length > 0 && (
        <div className="banner list" style={{ gap: 4 }}>
          <b>Проверьте перед утверждением</b>
          {sheet.warnings.map((warning, index) => <span key={index}>• {warning.message}</span>)}
        </div>
      )}

      {sheet.status === "draft" && <div className="panel muted">Период создан. Нажмите «Рассчитать», чтобы собрать начисления по завершённым визитам.</div>}
      {sheet.status !== "draft" && sheet.items.length === 0 && <div className="panel muted">За период нет начислений.</div>}

      {sheet.items.map((item) => (
        <div key={item.id} className="panel list">
          <div className="spread" style={{ flexWrap: "wrap" }}>
            <div className="row">
              <b>{item.staffName}</b>
              {item.status === "paid" && (
                <span className="tag tag-ok">выплачено {item.paidOn ? dayLabel(item.paidOn) : ""}{item.paidMethod === "cash" ? ", наличными" : item.paidMethod === "transfer" ? ", переводом" : ""}</span>
              )}
              {item.carryDebt && <span className="tag tag-warn">долг мастера {money(-item.totalMinor)}</span>}
            </div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className="muted">начислено {money(item.accrualMinor)}</span>
              {item.tipMinor > 0 && <span className="muted">чаевые {money(item.tipMinor)}</span>}
              {item.deductionMinor > 0 && <span className="muted">удержано {money(item.deductionMinor)}</span>}
              <b>к выплате {money(item.payoutMinor)}</b>
              {sheet.status === "approved" && canMoney && item.status !== "paid" && (
                <button className="btn" disabled={busy} onClick={() => act("pay", { staffId: item.staffId, paidOn, method })}>Выплатить</button>
              )}
            </div>
          </div>
          <table className="report-table payroll-lines">
            <colgroup><col style={{ width: 90 }} /><col /><col style={{ width: "26%" }} /><col style={{ width: 120 }} />{editable && canMoney && <col style={{ width: 110 }} />}</colgroup>
            <thead><tr><th>Дата</th><th>Строка</th><th>Расчёт</th><th className="num">Сумма</th>{editable && canMoney && <th />}</tr></thead>
            <tbody>
              {item.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.occurredOn ? dayLabel(line.occurredOn) : "—"}</td>
                  <td>
                    <span className="tag tag-muted" style={{ marginRight: 6 }}>{LINE_TYPES[line.type] ?? line.type}</span>
                    {line.title}
                    {line.reason && <span className="muted"> · {line.reason}</span>}
                  </td>
                  <td className="muted">{rateLabel(line, money)}</td>
                  <td className="num">{money(line.resultMinor)}</td>
                  {editable && canMoney && (
                    <td className="num">{line.manual && <button className="btn danger" onClick={() => removeLine(line.id)}>Убрать</button>}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {editable && canMoney && (
            open === item.id ? (
              <ManualLine staffId={item.staffId} onCancel={() => setOpen(null)} onSave={async (body) => { await act("lines", body); setOpen(null); }} />
            ) : (
              <button className="btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(item.id)}>+ Премия, штраф или корректировка</button>
            )
          )}
        </div>
      ))}

      {editable && canMoney && sheet.status === "calculated" && <AddForStaff onSave={(body) => act("lines", body)} present={sheet.items.map((item) => item.staffId)} />}
    </>
  );
}

function ManualLine({ staffId, onSave, onCancel }: { staffId: string; onSave: (body: unknown) => Promise<void>; onCancel?: () => void }) {
  const [type, setType] = useState<"bonus" | "penalty" | "adjustment">("bonus");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <select className="report-date" value={type} onChange={(event) => setType(event.target.value as typeof type)} aria-label="Тип">
        <option value="bonus">Премия</option>
        <option value="penalty">Штраф</option>
        <option value="adjustment">Корректировка (±)</option>
      </select>
      <input className="report-date" style={{ width: 120 }} inputMode="decimal" placeholder="Сумма, ₽" value={amount} onChange={(event) => setAmount(event.target.value)} />
      <input className="report-date" style={{ flex: 1, minWidth: 180 }} placeholder="Причина (обязательно)" value={reason} onChange={(event) => setReason(event.target.value)} />
      <button className="btn-gradient" onClick={() => onSave({ staffId, type, amountMinor: rublesToMinor(Number(amount.replace(",", "."))), reason })}>Добавить</button>
      {onCancel && <button className="btn-ghost" onClick={onCancel}>Отмена</button>}
    </div>
  );
}

/** A bonus for a master who has no lines in the period yet. */
function AddForStaff({ onSave, present }: { onSave: (body: unknown) => Promise<void>; present: string[] }) {
  const [staff, setStaff] = useState<{ id: string; displayName: string; active: boolean }[]>([]);
  const [staffId, setStaffId] = useState("");
  useEffect(() => {
    api<{ id: string; displayName: string; active: boolean }[]>("/api/staff").then(setStaff).catch(() => undefined);
  }, []);
  const others = staff.filter((member) => member.active !== false && !present.includes(member.id));
  if (!others.length) return null;
  return (
    <div className="panel list">
      <div className="row">
        <span className="muted">Начисление мастеру без визитов:</span>
        <select className="report-date" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
          <option value="">Выберите мастера</option>
          {others.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
        </select>
      </div>
      {staffId && <ManualLine staffId={staffId} onSave={async (body) => { await onSave(body); setStaffId(""); }} />}
    </div>
  );
}

function Rules({ money, onError }: { money: (n: number) => string; onError: (m: string) => void }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [staff, setStaff] = useState<{ id: string; displayName: string }[]>([]);
  const [services, setServices] = useState<{ id: string; title: string }[]>([]);
  const [form, setForm] = useState({
    staffId: "",
    serviceId: "",
    scheme: "percent" as Rule["scheme"],
    percent: "40",
    fixed: "",
    salary: "",
    periodUnit: "month" as Rule["periodUnit"],
    base: "service_price",
    includeTips: true,
    deductMaterials: false,
    validFrom: new Date().toISOString().slice(0, 10),
  });

  const load = useCallback(async () => {
    try {
      setRules(await api<Rule[]>("/api/payroll/rules"));
    } catch (err) {
      onError((err as ApiError).message);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    api<{ id: string; displayName: string }[]>("/api/staff").then(setStaff).catch(() => undefined);
    api<{ services: { id: string; title: string }[] }>("/api/catalog").then((catalog) => setServices(catalog.services)).catch(() => undefined);
  }, [load]);

  const staffName = (id: string | null) => (id ? staff.find((member) => member.id === id)?.displayName ?? "Мастер" : "Все мастера");
  const serviceName = (id: string | null) => (id ? services.find((service) => service.id === id)?.title ?? "Услуга" : "все услуги");
  const withPercent = form.scheme === "percent" || form.scheme === "hybrid";
  const withSalary = form.scheme === "salary" || form.scheme === "hybrid";

  async function save() {
    onError("");
    try {
      await api("/api/payroll/rules", {
        method: "POST",
        body: JSON.stringify({
          staffId: form.staffId || null,
          serviceId: form.serviceId || null,
          scheme: form.scheme,
          percentBps: withPercent ? Math.round(Number(form.percent.replace(",", ".")) * 100) : 0,
          fixedMinor: form.scheme === "fixed_per_service" ? rublesToMinor(Number(form.fixed.replace(",", "."))) : 0,
          salaryMinor: withSalary ? rublesToMinor(Number(form.salary.replace(",", "."))) : 0,
          periodUnit: form.periodUnit,
          base: form.base,
          includeTips: form.includeTips,
          deductMaterials: withPercent && form.deductMaterials,
          validFrom: form.validFrom,
        }),
      });
      await load();
    } catch (err) {
      onError((err as ApiError).message);
    }
  }

  async function remove(id: string) {
    onError("");
    try {
      const result = await api<{ outcome: string; validTo?: string }>(`/api/payroll/rules/${id}`, { method: "DELETE" });
      if (result.outcome === "closed") onError(`Правило уже использовано в утверждённых расчётах — оно закрыто датой ${result.validTo}, история сохранена`);
      await load();
    } catch (err) {
      onError((err as ApiError).message);
    }
  }

  function describe(rule: Rule) {
    const parts: string[] = [];
    if (rule.scheme === "percent" || rule.scheme === "hybrid") parts.push(`${rule.percentBps / 100}% ${rule.base === "paid_amount" ? "от оплаченного" : "от цены"}`);
    if (rule.scheme === "fixed_per_service") parts.push(`${money(rule.fixedMinor)} за услугу`);
    if (rule.scheme === "salary" || rule.scheme === "hybrid") parts.push(`оклад ${money(rule.salaryMinor)} ${UNITS[rule.periodUnit]}`);
    if (rule.deductMaterials) parts.push("за вычетом материалов");
    if (!rule.includeTips) parts.push("без чаевых");
    return parts.join(", ");
  }

  return (
    <>
      <div className="panel list">
        <h2 className="report-h">Новое правило</h2>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <select className="report-date" value={form.staffId} onChange={(event) => setForm({ ...form, staffId: event.target.value, serviceId: event.target.value ? form.serviceId : "" })}>
            <option value="">Все мастера (по умолчанию)</option>
            {staff.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
          </select>
          <select className="report-date" value={form.serviceId} disabled={!form.staffId || withSalary} onChange={(event) => setForm({ ...form, serviceId: event.target.value })}>
            <option value="">На все услуги</option>
            {services.map((service) => <option key={service.id} value={service.id}>{service.title}</option>)}
          </select>
          <select className="report-date" value={form.scheme} onChange={(event) => setForm({ ...form, scheme: event.target.value as Rule["scheme"] })}>
            {Object.entries(SCHEMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {withPercent && (
            <>
              <input className="report-date" style={{ width: 90 }} inputMode="decimal" value={form.percent} onChange={(event) => setForm({ ...form, percent: event.target.value })} aria-label="Процент" />
              <span className="muted">%</span>
              <select className="report-date" value={form.base} onChange={(event) => setForm({ ...form, base: event.target.value })}>
                <option value="service_price">от цены услуги</option>
                <option value="paid_amount">от оплаченного</option>
              </select>
            </>
          )}
          {form.scheme === "fixed_per_service" && (
            <input className="report-date" style={{ width: 140 }} inputMode="decimal" placeholder="Фикс, ₽" value={form.fixed} onChange={(event) => setForm({ ...form, fixed: event.target.value })} />
          )}
          {withSalary && (
            <>
              <input className="report-date" style={{ width: 140 }} inputMode="decimal" placeholder="Оклад, ₽" value={form.salary} onChange={(event) => setForm({ ...form, salary: event.target.value })} />
              <select className="report-date" value={form.periodUnit} onChange={(event) => setForm({ ...form, periodUnit: event.target.value as Rule["periodUnit"] })}>
                {Object.entries(UNITS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </>
          )}
          {withPercent && (
            <label className="row"><input type="checkbox" checked={form.deductMaterials} onChange={(event) => setForm({ ...form, deductMaterials: event.target.checked })} /> минус материалы</label>
          )}
          <label className="row"><input type="checkbox" checked={form.includeTips} onChange={(event) => setForm({ ...form, includeTips: event.target.checked })} /> чаевые мастеру</label>
          <span className="muted">с</span>
          <input className="report-date" type="date" value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} />
          <button className="btn-gradient" onClick={save}>Добавить</button>
        </div>
        <small className="muted">Порядок: правило мастера на услугу → правило мастера → правило для всех. Чтобы сменить ставку, закройте старое правило и добавьте новое с нужной даты.</small>
      </div>
      <div className="panel list">
        <table className="report-table">
          <thead><tr><th>Кому</th><th>Схема</th><th>Ставка</th><th>Действует</th><th /></tr></thead>
          <tbody>
            {rules === null && <tr><td colSpan={5} className="muted">Загрузка…</td></tr>}
            {rules?.length === 0 && <tr><td colSpan={5} className="muted">Правил нет — без них расчёт покажет «нет правила оплаты»</td></tr>}
            {rules?.map((rule) => (
              <tr key={rule.id}>
                <td>{staffName(rule.staffId)}{rule.serviceId && <span className="muted"> · {serviceName(rule.serviceId)}</span>}</td>
                <td>{SCHEMES[rule.scheme]}</td>
                <td>{describe(rule)}</td>
                <td className="muted">с {dayLabel(rule.validFrom)}{rule.validTo ? ` по ${dayLabel(rule.validTo)}` : ""}</td>
                <td className="num"><button className="btn danger" onClick={() => remove(rule.id)}>Удалить</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
