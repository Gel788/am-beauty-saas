"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { addCalendarDays } from "@/domain/time";
import { api, type ApiError } from "./api";
import { describeRule, KINDS, kindOf, type Kind, type Rule } from "./payroll-view";
import { useToast } from "./ui";

const money = (minor: number) => formatMoney(minor, "RUB");
const today = () => new Date().toISOString().slice(0, 10);
const activeOn = (rule: Rule, day: string) => rule.validFrom <= day && (!rule.validTo || rule.validTo >= day);
const kindKey = (rule: Rule): Kind =>
  rule.periodUnit === "shift" ? (rule.scheme === "salary" ? "shift" : rule.guarantee ? "shift_guarantee" : "shift_percent") : (rule.scheme as Kind);

/** PAYROLL-STAFF-01: how this master is paid, set right in their card. */
export function StaffPay({ staffId }: { staffId: string }) {
  const toast = useToast();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ kind: "percent" as Kind, percent: "40", rate: "", fixed: "", base: "service_price", deductMaterials: false, includeTips: true, from: today() });

  const load = useCallback(async () => {
    try {
      setRules(await api<Rule[]>("/api/payroll/rules"));
    } catch (error) {
      setRules([]);
      toast((error as ApiError).message, "error");
    }
  }, [toast]);
  useEffect(() => void load(), [load]);

  const day = today();
  const own = (rules ?? []).filter((rule) => rule.staffId === staffId && !rule.serviceId);
  const current = own.find((rule) => activeOn(rule, day));
  const fallback = (rules ?? []).find((rule) => !rule.staffId && !rule.serviceId && activeOn(rule, day));
  const perService = (rules ?? []).filter((rule) => rule.staffId === staffId && rule.serviceId && activeOn(rule, day));
  const next = own.find((rule) => rule.validFrom > day);

  function startEdit() {
    const base = current ?? fallback;
    if (base) {
      setForm({
        kind: kindKey(base),
        percent: base.percentBps ? String(base.percentBps / 100) : "40",
        rate: base.salaryMinor ? String(base.salaryMinor / 100) : "",
        fixed: base.fixedMinor ? String(base.fixedMinor / 100) : "",
        base: base.base,
        deductMaterials: Boolean(base.deductMaterials),
        includeTips: base.includeTips,
        from: day,
      });
    }
    setEditing(true);
  }

  const kind = KINDS[form.kind];
  const withPercent = kind.scheme === "percent" || kind.scheme === "hybrid";
  const withRate = kind.scheme === "salary" || kind.scheme === "hybrid";
  const num = (value: string) => Number(value.replace(",", ".").replace(/\s/g, ""));

  async function save() {
    const body = {
      staffId,
      serviceId: null,
      scheme: kind.scheme,
      percentBps: withPercent ? Math.round(num(form.percent) * 100) : 0,
      fixedMinor: kind.scheme === "fixed_per_service" ? rublesToMinor(num(form.fixed)) : 0,
      salaryMinor: withRate ? rublesToMinor(num(form.rate)) : 0,
      periodUnit: kind.shift ? "shift" : "month",
      guarantee: kind.guarantee,
      base: form.base,
      includeTips: form.includeTips,
      deductMaterials: withPercent && form.deductMaterials,
      validFrom: form.from,
      validTo: null,
    };
    try {
      // The old rate stays in history: it is closed the day before the new one starts, or replaced if it starts the same day or later.
      for (const rule of own.filter((item) => !item.validTo || item.validTo >= form.from)) {
        if (rule.validFrom >= form.from) await api(`/api/payroll/rules/${rule.id}`, { method: "DELETE" });
        else await api(`/api/payroll/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ validTo: addCalendarDays(form.from, -1) }) });
      }
      await api("/api/payroll/rules", { method: "POST", body: JSON.stringify(body) });
      toast("Оплата мастера сохранена");
      setEditing(false);
      await load();
    } catch (error) {
      toast((error as ApiError).message, "error");
      await load();
    }
  }

  if (rules === null) return <div className="panel muted">Оплата: загрузка…</div>;
  return (
    <div className="panel list">
      <div className="spread">
        <h2 className="report-h" style={{ margin: 0 }}>Оплата</h2>
        {!editing && <button className="btn" type="button" onClick={startEdit}>{current ? "Изменить" : "Задать оплату"}</button>}
      </div>
      {!editing && (
        <>
          {current ? (
            <div><b>{kindOf(current)}</b> · {describeRule(current, money)} <span className="muted">· с {current.validFrom}</span></div>
          ) : fallback ? (
            <div className="muted">Своей схемы нет, считается по общей: {kindOf(fallback)}, {describeRule(fallback, money)}</div>
          ) : (
            <div className="muted">Оплата не задана: в расчёте зарплаты у мастера будет предупреждение «нет правила».</div>
          )}
          {next && <div className="muted">С {next.validFrom}: {kindOf(next)}, {describeRule(next, money)}</div>}
          {perService.length > 0 && <div className="muted">Отдельно по услугам: {perService.length}. Они настраиваются в «Зарплаты → Правила оплаты».</div>}
        </>
      )}
      {editing && (
        <>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <div className="field" style={{ flex: "1 1 240px" }}>
              <label>Как платим</label>
              <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Kind })}>
                {Object.entries(KINDS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
              </select>
            </div>
            {withRate && (
              <div className="field" style={{ flex: "1 1 140px" }}>
                <label>{kind.shift ? "За выход, ₽" : "Оклад в месяц, ₽"}</label>
                <input inputMode="decimal" value={form.rate} onChange={(event) => setForm({ ...form, rate: event.target.value })} placeholder={kind.shift ? "2000" : "40000"} />
              </div>
            )}
            {withPercent && (
              <div className="field" style={{ flex: "0 1 110px" }}>
                <label>Процент</label>
                <input inputMode="decimal" value={form.percent} onChange={(event) => setForm({ ...form, percent: event.target.value })} />
              </div>
            )}
            {withPercent && (
              <div className="field" style={{ flex: "1 1 160px" }}>
                <label>Процент от</label>
                <select value={form.base} onChange={(event) => setForm({ ...form, base: event.target.value })}>
                  <option value="service_price">цены услуги</option>
                  <option value="paid_amount">оплаченного</option>
                </select>
              </div>
            )}
            {kind.scheme === "fixed_per_service" && (
              <div className="field" style={{ flex: "1 1 140px" }}>
                <label>За каждую услугу, ₽</label>
                <input inputMode="decimal" value={form.fixed} onChange={(event) => setForm({ ...form, fixed: event.target.value })} />
              </div>
            )}
            <div className="field" style={{ flex: "0 1 160px" }}>
              <label>С какого дня</label>
              <input type="date" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} />
            </div>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {withPercent && <label className="row"><input type="checkbox" checked={form.deductMaterials} onChange={(event) => setForm({ ...form, deductMaterials: event.target.checked })} /> минус материалы</label>}
            <label className="row"><input type="checkbox" checked={form.includeTips} onChange={(event) => setForm({ ...form, includeTips: event.target.checked })} /> чаевые мастеру</label>
            <button className="btn" type="button" onClick={() => setEditing(false)} style={{ marginLeft: "auto" }}>Отмена</button>
            <button className="btn-gradient" type="button" onClick={save}>Сохранить</button>
          </div>
          <small className="muted">
            {kind.shift ? "Выход засчитывается за прошедший рабочий день по графику (выходные и отпуск не считаются) и за любой день, когда мастер закрыл визит. " : ""}
            {kind.guarantee ? "Мастер получает процент, а если он меньше ставки за выходы, CRM доплачивает разницу. " : ""}
            Прежняя ставка сохранится в истории и закончится накануне выбранного дня.
          </small>
        </>
      )}
    </div>
  );
}
