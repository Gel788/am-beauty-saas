"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

type Tier = { title: string; minSpendMinor: number; earnBps: number };
type Settings = { bonusEnabled: boolean; bonusEarnBps: number; bonusBurnMaxBps: number; bonusEarnOnProducts: boolean; certificateValidDays: number; bonusExpireDays: number; tiers: Tier[] };
type TierDraft = { title: string; spend: string; earn: string };
type Certificate = {
  id: string;
  code: string;
  nominalMinor: number;
  balanceMinor: number;
  validTo: string;
  state: "active" | "used" | "expired" | "void";
  clientName: string | null;
  voidedMinor: number;
  voidReason: string | null;
  createdAt: string;
};
type Plan = { id: string; title: string; visits: number; validDays: number; priceMinor: number; serviceIds: string[]; active: boolean };
type Membership = {
  id: string;
  title: string;
  clientName: string;
  visitsTotal: number;
  visitsLeft: number;
  validFrom: string;
  validTo: string;
  frozenFrom: string | null;
  frozenTo: string | null;
  state: "active" | "frozen" | "used" | "expired" | "cancelled";
};
type Promo = {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  validFrom: string | null;
  validTo: string | null;
  serviceIds: string[];
  minCheckMinor: number;
  maxUses: number | null;
  perPhoneLimit: number | null;
  onlineOnly: boolean;
  active: boolean;
  uses: number;
};
type Service = { id: string; title: string };
type Me = { actor: { role: string } };

const SETUP = ["owner", "admin", "super"];
const STATE: Record<string, [string, string]> = {
  active: ["действует", "tag-ok"],
  frozen: ["заморожен", "tag-warn"],
  used: ["израсходован", "tag-muted"],
  expired: ["истёк", "tag-muted"],
  void: ["аннулирован", "tag-bad"],
  cancelled: ["отменён", "tag-bad"],
};
const fmtDate = (iso: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${iso}T12:00:00Z`));
const rub = (value: string) => rublesToMinor(Number(value.replace(",", ".")) || 0);
const pct = (bps: number) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
const StateTag = ({ state }: { state: string }) => <span className={`tag ${STATE[state]?.[1] ?? "tag-muted"}`}>{STATE[state]?.[0] ?? state}</span>;

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api<T>(path).then(setData).catch((err: ApiError) => setError(err.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    async call(path: string, method: string, body: unknown, message: string) {
      setBusy(true);
      try {
        await api(path, { method, body: JSON.stringify(body) });
        toast(message);
        return true;
      } catch (err) {
        toast((err as ApiError).message, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

export function LoyaltyView() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"certs" | "subs" | "promos" | "bonus">("certs");
  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => setMe(null));
  }, []);
  if (!me) return <div className="reports-page"><div className="skeleton" /></div>;
  const canSetup = SETUP.includes(me.actor.role);
  return (
    <div className="reports-page">
      <div className="journal-top">
        <div>
          <div className="page-kicker">Удержание клиентов</div>
          <h1 className="date-title">Лояльность</h1>
        </div>
        <div className="segment">
          <button className={tab === "certs" ? "on" : ""} onClick={() => setTab("certs")}>Сертификаты</button>
          <button className={tab === "subs" ? "on" : ""} onClick={() => setTab("subs")}>Абонементы</button>
          {canSetup && <button className={tab === "promos" ? "on" : ""} onClick={() => setTab("promos")}>Промокоды</button>}
          {canSetup && <button className={tab === "bonus" ? "on" : ""} onClick={() => setTab("bonus")}>Бонусная программа</button>}
        </div>
      </div>
      {tab === "certs" && <Certificates canVoid={me.actor.role === "owner" || me.actor.role === "super"} />}
      {tab === "subs" && <Memberships canSetup={canSetup} />}
      {tab === "promos" && <Promos />}
      {tab === "bonus" && <BonusProgram />}
    </div>
  );
}

function Certificates({ canVoid }: { canVoid: boolean }) {
  const [q, setQ] = useState("");
  const { data, error, reload } = useLoad<Certificate[]>(`/api/loyalty/certificates${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const [voiding, setVoiding] = useState<Certificate | null>(null);
  const live = (data ?? []).filter((cert) => cert.state === "active");
  return (
    <>
      <div className="report-tiles">
        <div className="panel report-tile">
          <span className="muted">Действующих сертификатов</span>
          <b className="display">{live.length}</b>
          <small className="muted">продаются в кассе: «+ Приход» → сертификат</small>
        </div>
        <div className="panel report-tile">
          <span className="muted">Обязательства салона</span>
          <b className="display">{formatMoney(live.reduce((sum, cert) => sum + cert.balanceMinor, 0))}</b>
          <small className="muted">остаток на действующих сертификатах</small>
        </div>
        <div className="panel report-tile">
          <span className="muted">Продано всего</span>
          <b className="display">{formatMoney((data ?? []).reduce((sum, cert) => sum + cert.nominalMinor, 0))}</b>
          <small className="muted">номинал за всё время</small>
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      <div className="panel row">
        <input placeholder="Поиск по коду" value={q} onChange={(event) => setQ(event.target.value)} style={{ maxWidth: 260 }} />
      </div>
      <div className="panel list">
        <table className="report-table">
          <thead>
            <tr><th>Код</th><th>Владелец</th><th className="num">Номинал</th><th className="num">Остаток</th><th>Действует до</th><th>Статус</th>{canVoid && <th />}</tr>
          </thead>
          <tbody>
            {data === null && <tr><td colSpan={7} className="muted">Загрузка…</td></tr>}
            {data?.length === 0 && <tr><td colSpan={7} className="muted">Сертификатов пока нет. Продайте первый через кассу</td></tr>}
            {data?.map((cert) => (
              <tr key={cert.id} className={cert.state === "void" ? "void" : ""}>
                <td><code>{cert.code}</code></td>
                <td>{cert.clientName ?? <span className="muted">на предъявителя</span>}</td>
                <td className="num">{formatMoney(cert.nominalMinor)}</td>
                <td className="num">{formatMoney(cert.balanceMinor)}</td>
                <td>{fmtDate(cert.validTo)}</td>
                <td><StateTag state={cert.state} />{cert.voidReason && <div className="muted" style={{ fontSize: 12 }}>{cert.voidReason}</div>}</td>
                {canVoid && (
                  <td className="num">{cert.state === "active" && <button className="btn danger" onClick={() => setVoiding(cert)}>Аннулировать</button>}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {voiding && <VoidModal cert={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); reload(); }} />}
    </>
  );
}

function VoidModal({ cert, onClose, onDone }: { cert: Certificate; onClose: () => void; onDone: () => void }) {
  const { busy, call } = useAction();
  const [reason, setReason] = useState("");
  return (
    <Modal title={`Аннулировать ${cert.code}`} onClose={onClose}>
      <div className="list">
        <p className="muted">Остаток {formatMoney(cert.balanceMinor)} сгорит. Деньги клиенту этим действием не возвращаются, для возврата оформите возврат платежа в кассе.</p>
        <div className="field"><label>Причина</label><input value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></div>
        <button className="btn danger" disabled={busy} onClick={async () => (await call(`/api/loyalty/certificates/${cert.id}/void`, "POST", { reason }, "Сертификат аннулирован")) && onDone()}>
          Аннулировать
        </button>
      </div>
    </Modal>
  );
}

function useServices() {
  const [services, setServices] = useState<Service[]>([]);
  useEffect(() => {
    api<{ services: Service[] }>("/api/catalog").then((data) => setServices(data.services)).catch(() => setServices([]));
  }, []);
  return services;
}

function ServicePicker({ services, value, onChange }: { services: Service[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="field">
      <label>Услуги (ничего не выбрано — любые)</label>
      <div className="chips">
        {services.map((service) => {
          const on = value.includes(service.id);
          return (
            <button key={service.id} type="button" className={`chip ${on ? "on" : ""}`} onClick={() => onChange(on ? value.filter((id) => id !== service.id) : [...value, service.id])}>
              {service.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Memberships({ canSetup }: { canSetup: boolean }) {
  const plans = useLoad<Plan[]>("/api/loyalty/plans");
  const subs = useLoad<Membership[]>("/api/loyalty/memberships");
  const services = useServices();
  const { call } = useAction();
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState<{ sub: Membership; kind: "freeze" | "extend" } | null>(null);
  const title = (ids: string[]) => (ids.length ? ids.map((id) => services.find((service) => service.id === id)?.title ?? "…").join(", ") : "любые услуги");
  return (
    <>
      <div className="panel list">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Виды абонементов</h2>
          {canSetup && <button className="btn-ghost" onClick={() => setCreating(true)}>+ Новый вид</button>}
        </div>
        <table className="report-table">
          <thead><tr><th>Название</th><th className="num">Визитов</th><th className="num">Срок</th><th className="num">Цена</th><th>Услуги</th>{canSetup && <th />}</tr></thead>
          <tbody>
            {plans.data?.length === 0 && <tr><td colSpan={6} className="muted">Видов абонементов пока нет</td></tr>}
            {plans.data?.map((plan) => (
              <tr key={plan.id} className={plan.active ? "" : "void"}>
                <td>{plan.title}</td>
                <td className="num">{plan.visits}</td>
                <td className="num">{plan.validDays} дн.</td>
                <td className="num">{formatMoney(plan.priceMinor)}</td>
                <td className="muted">{title(plan.serviceIds)}</td>
                {canSetup && (
                  <td className="num">
                    <button className="btn-ghost" onClick={async () => (await call(`/api/loyalty/plans/${plan.id}`, "PATCH", { active: !plan.active }, plan.active ? "Снят с продажи" : "Снова в продаже")) && plans.reload()}>
                      {plan.active ? "Снять с продажи" : "Вернуть"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel list">
        <h2 style={{ margin: 0 }}>Абонементы клиентов</h2>
        <table className="report-table">
          <thead><tr><th>Клиент</th><th>Абонемент</th><th className="num">Осталось</th><th>Срок</th><th>Статус</th>{canSetup && <th />}</tr></thead>
          <tbody>
            {subs.data?.length === 0 && <tr><td colSpan={6} className="muted">Проданных абонементов пока нет. Продаются через кассу</td></tr>}
            {subs.data?.map((sub) => (
              <tr key={sub.id}>
                <td>{sub.clientName}</td>
                <td>{sub.title}</td>
                <td className="num">{sub.visitsLeft} из {sub.visitsTotal}</td>
                <td>
                  {fmtDate(sub.validFrom)} — {fmtDate(sub.validTo)}
                  {sub.frozenFrom && sub.frozenTo && <div className="muted" style={{ fontSize: 12 }}>заморозка {fmtDate(sub.frozenFrom)} — {fmtDate(sub.frozenTo)}</div>}
                </td>
                <td><StateTag state={sub.state} /></td>
                {canSetup && (
                  <td className="num">
                    {(sub.state === "active" || sub.state === "frozen") && (
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        {!sub.frozenFrom && <button className="btn-ghost" onClick={() => setActing({ sub, kind: "freeze" })}>Заморозить</button>}
                        <button className="btn-ghost" onClick={() => setActing({ sub, kind: "extend" })}>Продлить</button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <PlanModal services={services} onClose={() => setCreating(false)} onDone={() => { setCreating(false); plans.reload(); }} />}
      {acting && <MembershipModal {...acting} onClose={() => setActing(null)} onDone={() => { setActing(null); subs.reload(); }} />}
    </>
  );
}

function PlanModal({ services, onClose, onDone }: { services: Service[]; onClose: () => void; onDone: () => void }) {
  const { busy, call } = useAction();
  const [form, setForm] = useState({ title: "", visits: "10", validDays: "90", price: "", serviceIds: [] as string[] });
  return (
    <Modal title="Новый вид абонемента" onClose={onClose}>
      <div className="list">
        <div className="field"><label>Название</label><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} autoFocus /></div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Визитов</label><input inputMode="numeric" value={form.visits} onChange={(event) => setForm({ ...form, visits: event.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label>Срок, дней</label><input inputMode="numeric" value={form.validDays} onChange={(event) => setForm({ ...form, validDays: event.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label>Цена, ₽</label><input inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></div>
        </div>
        <ServicePicker services={services} value={form.serviceIds} onChange={(serviceIds) => setForm({ ...form, serviceIds })} />
        <button
          className="btn-gradient"
          disabled={busy}
          onClick={async () =>
            (await call(
              "/api/loyalty/plans",
              "POST",
              { title: form.title, visits: Number(form.visits), validDays: Number(form.validDays), priceMinor: rub(form.price), serviceIds: form.serviceIds },
              "Абонемент создан",
            )) && onDone()
          }
        >
          Создать
        </button>
      </div>
    </Modal>
  );
}

function MembershipModal({ sub, kind, onClose, onDone }: { sub: Membership; kind: "freeze" | "extend"; onClose: () => void; onDone: () => void }) {
  const { busy, call } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ from: today, to: today, days: "7", reason: "" });
  const body = kind === "freeze" ? { from: form.from, to: form.to, reason: form.reason } : { days: Number(form.days), reason: form.reason };
  return (
    <Modal title={kind === "freeze" ? "Заморозить абонемент" : "Продлить абонемент"} onClose={onClose}>
      <div className="list">
        <p className="muted">{sub.clientName}: {sub.title}, до {fmtDate(sub.validTo)}</p>
        {kind === "freeze" ? (
          <>
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label>С</label><input type="date" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} /></div>
              <div className="field" style={{ flex: 1 }}><label>По</label><input type="date" value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} /></div>
            </div>
            <small className="muted">Срок абонемента сдвинется на дни заморозки. Заморозить можно один раз, не дольше 90 дней.</small>
          </>
        ) : (
          <div className="field"><label>На сколько дней</label><input inputMode="numeric" value={form.days} onChange={(event) => setForm({ ...form, days: event.target.value })} /></div>
        )}
        <div className="field"><label>Причина</label><input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></div>
        <button className="btn-gradient" disabled={busy} onClick={async () => (await call(`/api/loyalty/memberships/${sub.id}/${kind}`, "POST", body, "Готово")) && onDone()}>
          {kind === "freeze" ? "Заморозить" : "Продлить"}
        </button>
      </div>
    </Modal>
  );
}

function Promos() {
  const { data, error, reload } = useLoad<Promo[]>("/api/loyalty/promos");
  const services = useServices();
  const { call } = useAction();
  const [creating, setCreating] = useState(false);
  const rule = (promo: Promo) =>
    [
      promo.validFrom || promo.validTo ? `${promo.validFrom ? fmtDate(promo.validFrom) : "…"} — ${promo.validTo ? fmtDate(promo.validTo) : "…"}` : null,
      promo.minCheckMinor ? `от ${formatMoney(promo.minCheckMinor)}` : null,
      promo.serviceIds.length ? `${promo.serviceIds.length} усл.` : null,
      promo.perPhoneLimit ? `${promo.perPhoneLimit} на телефон` : null,
      promo.onlineOnly ? "только онлайн" : null,
    ]
      .filter(Boolean)
      .join(" · ") || "без ограничений";
  return (
    <>
      {error && <div className="banner">{error}</div>}
      <div className="panel list">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Промокоды</h2>
          <button className="btn-ghost" onClick={() => setCreating(true)}>+ Новый промокод</button>
        </div>
        <small className="muted">Клиент вводит промокод при онлайн-записи, администратор — в карточке визита до оплаты. Скидка ложится на услуги, зарплата мастера считается по правилу «база».</small>
        <table className="report-table">
          <thead><tr><th>Код</th><th className="num">Скидка</th><th>Условия</th><th className="num">Применений</th><th /></tr></thead>
          <tbody>
            {data?.length === 0 && <tr><td colSpan={5} className="muted">Промокодов пока нет</td></tr>}
            {data?.map((promo) => (
              <tr key={promo.id} className={promo.active ? "" : "void"}>
                <td><code>{promo.code}</code></td>
                <td className="num">{promo.kind === "percent" ? pct(promo.value) : formatMoney(promo.value)}</td>
                <td className="muted">{rule(promo)}</td>
                <td className="num">{promo.uses}{promo.maxUses ? ` из ${promo.maxUses}` : ""}</td>
                <td className="num">
                  <button className="btn-ghost" onClick={async () => (await call(`/api/loyalty/promos/${promo.id}`, "PATCH", { active: !promo.active }, promo.active ? "Промокод выключен" : "Промокод включён")) && reload()}>
                    {promo.active ? "Выключить" : "Включить"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <PromoModal services={services} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
    </>
  );
}

function PromoModal({ services, onClose, onDone }: { services: Service[]; onClose: () => void; onDone: () => void }) {
  const { busy, call } = useAction();
  const [form, setForm] = useState({
    code: "",
    kind: "percent" as "percent" | "fixed",
    value: "",
    validFrom: "",
    validTo: "",
    minCheck: "",
    maxUses: "",
    perPhone: "1",
    onlineOnly: false,
    serviceIds: [] as string[],
  });
  const intOrNull = (value: string) => (value.trim() ? Number(value) : null);
  return (
    <Modal title="Новый промокод" onClose={onClose}>
      <div className="list">
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Код</label><input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })} autoFocus /></div>
          <div className="field">
            <label>Скидка</label>
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "percent" | "fixed" })}>
              <option value="percent">процент</option>
              <option value="fixed">сумма</option>
            </select>
          </div>
          <div className="field" style={{ width: 110 }}><label>{form.kind === "percent" ? "%" : "₽"}</label><input inputMode="decimal" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} /></div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Действует с</label><input type="date" value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label>по</label><input type="date" value={form.validTo} onChange={(event) => setForm({ ...form, validTo: event.target.value })} /></div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Мин. чек, ₽</label><input inputMode="decimal" value={form.minCheck} onChange={(event) => setForm({ ...form, minCheck: event.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label>Всего применений</label><input inputMode="numeric" placeholder="без лимита" value={form.maxUses} onChange={(event) => setForm({ ...form, maxUses: event.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label>На один телефон</label><input inputMode="numeric" placeholder="без лимита" value={form.perPhone} onChange={(event) => setForm({ ...form, perPhone: event.target.value })} /></div>
        </div>
        <ServicePicker services={services} value={form.serviceIds} onChange={(serviceIds) => setForm({ ...form, serviceIds })} />
        <label className="row"><input type="checkbox" checked={form.onlineOnly} onChange={(event) => setForm({ ...form, onlineOnly: event.target.checked })} /> только для онлайн-записи</label>
        <button
          className="btn-gradient"
          disabled={busy}
          onClick={async () =>
            (await call(
              "/api/loyalty/promos",
              "POST",
              {
                code: form.code,
                kind: form.kind,
                value: form.kind === "percent" ? Math.round((Number(form.value.replace(",", ".")) || 0) * 100) : rub(form.value),
                validFrom: form.validFrom || null,
                validTo: form.validTo || null,
                minCheckMinor: rub(form.minCheck),
                maxUses: intOrNull(form.maxUses),
                perPhoneLimit: intOrNull(form.perPhone),
                onlineOnly: form.onlineOnly,
                serviceIds: form.serviceIds,
              },
              "Промокод создан",
            )) && onDone()
          }
        >
          Создать
        </button>
      </div>
    </Modal>
  );
}

function BonusProgram() {
  const { data, reload } = useLoad<Settings>("/api/loyalty/settings");
  const { busy, call } = useAction();
  const [form, setForm] = useState<{ enabled: boolean; earn: string; burn: string; products: boolean; certDays: string; expireDays: string; tiers: TierDraft[] } | null>(null);
  useEffect(() => {
    if (data)
      setForm({
        enabled: data.bonusEnabled,
        earn: String(data.bonusEarnBps / 100),
        burn: String(data.bonusBurnMaxBps / 100),
        products: data.bonusEarnOnProducts,
        certDays: String(data.certificateValidDays),
        expireDays: String(data.bonusExpireDays ?? 0),
        tiers: (data.tiers ?? []).map((tier) => ({ title: tier.title, spend: String(tier.minSpendMinor / 100), earn: String(tier.earnBps / 100) })),
      });
  }, [data]);
  if (!form) return <div className="skeleton" />;
  const toBps = (value: string) => Math.round((Number(value.replace(",", ".")) || 0) * 100);
  const earn = toBps(form.earn);
  const burn = toBps(form.burn);
  return (
    <div className="panel list" style={{ maxWidth: 620 }}>
      <h2 style={{ margin: 0 }}>Бонусная программа</h2>
      <label className="row"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> начислять и списывать баллы</label>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>Начисление, % от оплаты</label><input inputMode="decimal" value={form.earn} onChange={(event) => setForm({ ...form, earn: event.target.value })} /></div>
        <div className="field" style={{ flex: 1 }}><label>Списание, не больше % чека</label><input inputMode="decimal" value={form.burn} onChange={(event) => setForm({ ...form, burn: event.target.value })} /></div>
      </div>
      <label className="row"><input type="checkbox" checked={form.products} onChange={(event) => setForm({ ...form, products: event.target.checked })} /> начислять и на покупку товаров</label>
      <div className="field">
        <label>Баллы сгорают через, дней (0 — бессрочно)</label>
        <input inputMode="numeric" value={form.expireDays} onChange={(event) => setForm({ ...form, expireDays: event.target.value })} />
        <span className="muted" style={{ fontSize: 12.5 }}>Сгорают сначала самые старые баллы. В карточке клиента видно, сколько сгорит в ближайшие 2 недели.</span>
      </div>
      <div className="list">
        <b>Уровни клиентов</b>
        <span className="muted" style={{ fontSize: 12.5 }}>Уровень даётся по сумме всех оплат клиента и заменяет базовый процент начисления. Без уровней действует базовый процент.</span>
        {form.tiers.map((tier, index) => (
          <div key={index} className="row tier-row">
            <input placeholder="Название, напр. Золото" value={tier.title} onChange={(event) => setForm({ ...form, tiers: form.tiers.map((item, i) => (i === index ? { ...item, title: event.target.value } : item)) })} />
            <label className="muted">от<input inputMode="decimal" value={tier.spend} onChange={(event) => setForm({ ...form, tiers: form.tiers.map((item, i) => (i === index ? { ...item, spend: event.target.value } : item)) })} />₽</label>
            <label className="muted"><input inputMode="decimal" value={tier.earn} onChange={(event) => setForm({ ...form, tiers: form.tiers.map((item, i) => (i === index ? { ...item, earn: event.target.value } : item)) })} />%</label>
            <button className="icon-btn" type="button" aria-label="Убрать уровень" onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, i) => i !== index) })}>×</button>
          </div>
        ))}
        {form.tiers.length < 6 && (
          <button className="btn-ghost" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setForm({ ...form, tiers: [...form.tiers, { title: "", spend: form.tiers.length ? String(Number(form.tiers[form.tiers.length - 1].spend || 0) + 30000) : "0", earn: form.earn }] })}>+ Уровень</button>
        )}
      </div>
      <div className="field"><label>Срок действия подарочного сертификата, дней</label><input inputMode="numeric" value={form.certDays} onChange={(event) => setForm({ ...form, certDays: event.target.value })} /></div>
      <div className="panel" style={{ background: "rgba(255,255,255,0.5)" }}>
        <b>Пример.</b> Визит на {formatMoney(400000)}: клиент получит {Math.floor((400000 * earn) / 10000 / 100)} баллов, а оплатить баллами сможет до {formatMoney(Math.floor((400000 * burn) / 10000))}.
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>1 балл = 1 ₽. Баллы не начисляются на часть чека, оплаченную баллами, сертификатом или абонементом. При возврате начисленные баллы списываются обратно.</div>
      </div>
      <button
        className="btn-gradient"
        disabled={busy}
        onClick={async () =>
          (await call(
            "/api/loyalty/settings",
            "PATCH",
            {
              bonusEnabled: form.enabled,
              bonusEarnBps: earn,
              bonusBurnMaxBps: burn,
              bonusEarnOnProducts: form.products,
              certificateValidDays: Number(form.certDays),
              bonusExpireDays: Number(form.expireDays) || 0,
              tiers: form.tiers.map((tier) => ({ title: tier.title, minSpendMinor: Math.round((Number(tier.spend.replace(",", ".")) || 0) * 100), earnBps: toBps(tier.earn) })),
            },
            "Настройки сохранены",
          )) && reload()
        }
      >
        Сохранить
      </button>
    </div>
  );
}
