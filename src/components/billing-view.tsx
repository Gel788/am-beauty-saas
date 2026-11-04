"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, CreditCard, ShieldAlert } from "lucide-react";
import { formatMoney } from "@/domain/money";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Plan = { id: "start" | "salon" | "network"; title: string; priceMinor: number; staffLimit: number; branchLimit: number; features: string[]; fits: boolean };
type Invoice = { id: string; number: number; planTitle: string; months: number; amountMinor: number; status: "pending" | "paid" | "canceled"; provider: string; confirmationUrl: string | null; periodFrom: string | null; periodTo: string | null; createdAt: string; paidAt: string | null };
type Summary = {
  plan: string;
  planTitle: string;
  state: "trial" | "active" | "grace" | "expired" | "suspended";
  until: string | null;
  daysLeft: number;
  suspendedReason: string;
  limits: { staffLimit: number; branchLimit: number };
  usage: { staff: number; branches: number };
  provider: "test" | "yookassa";
  plans: Plan[];
  periods: { months: 1 | 6 | 12; discountBps: number; label: string }[];
  invoices: Invoice[];
};

const date = (value: string | null) => (value ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "—");
const STATUS: Record<Invoice["status"], string> = { pending: "ждёт оплаты", paid: "оплачен", canceled: "отменён" };
const rub = (minor: number) => formatMoney(Math.round(minor / 100) * 100);

function headline(s: Summary) {
  if (s.state === "trial") return { tone: "ok", title: `Пробный период: осталось ${s.daysLeft} ${s.daysLeft % 10 === 1 && s.daysLeft % 100 !== 11 ? "день" : "дн."}`, text: `Все возможности открыты до ${date(s.until)}, выберите тариф, чтобы не прерываться: оставшиеся дни сохранятся.` };
  if (s.state === "active") return { tone: "ok", title: `Тариф «${s.planTitle}» оплачен до ${date(s.until)}`, text: "Продлить можно в любой момент: новый срок добавится к текущему." };
  if (s.state === "grace") return { tone: "warn", title: "Подписка закончилась", text: "CRM работает ещё несколько дней. Потом станет доступна только для просмотра, пока тариф не продлят." };
  if (s.state === "suspended") return { tone: "bad", title: "Салон приостановлен платформой", text: s.suspendedReason ? `Причина: ${s.suspendedReason}. Напишите в поддержку.` : "Напишите в поддержку." };
  return { tone: "bad", title: "CRM открыта только для просмотра", text: "Подписка закончилась. Записи, клиенты и отчёты сохранены. Оплатите тариф, и всё заработает сразу." };
}

/** PLAT-BILLING-01: the owner's subscription screen. */
export function BillingView() {
  const toast = useToast();
  const [data, setData] = useState<Summary | null>(null);
  const [months, setMonths] = useState<1 | 6 | 12>(1);
  const [busy, setBusy] = useState("");
  const [role, setRole] = useState("");
  const load = () => api<Summary>("/api/billing").then(setData).catch((error: ApiError) => toast(error.message, "error"));
  useEffect(() => {
    load();
    api<{ actor: { role: string } }>("/api/auth/me").then((me) => setRole(me.actor.role)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return <div className="skeleton" />;
  const owner = role === "owner" || role === "super";
  const head = headline(data);
  const period = data.periods.find((item) => item.months === months)!;
  const buy = async (plan: Plan) => {
    setBusy(plan.id);
    try {
      const invoice = await api<Invoice>("/api/billing/invoices", { method: "POST", body: JSON.stringify({ plan: plan.id, months }) });
      if (invoice.confirmationUrl) window.location.href = invoice.confirmationUrl;
      else await load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy("");
    }
  };
  const sandbox = async (invoice: Invoice) => {
    setBusy(invoice.id);
    try {
      setData(await api<Summary>(`/api/billing/invoices/${invoice.id}/sandbox-pay`, { method: "POST" }));
      toast("Оплачено (тестовый режим)");
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy("");
    }
  };
  const pending = data.invoices.find((item) => item.status === "pending");
  return (
    <div className="reports-page">
      <div><div className="page-kicker"><Link href="/settings">Настройки</Link> · Подписка</div><h1>Тариф и оплата</h1></div>
      <div className={`panel billing-head ${head.tone}`}>
        {head.tone === "bad" ? <ShieldAlert /> : <CreditCard />}
        <div>
          <b>{head.title}</b>
          <span>{head.text}</span>
        </div>
        <div className="billing-usage">
          <span>Мастеров <b>{data.usage.staff}</b> из {data.limits.staffLimit}</span>
          <span>Филиалов <b>{data.usage.branches}</b> из {data.limits.branchLimit}</span>
        </div>
      </div>

      {pending && (
        <div className="panel list">
          <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
            <div><b>Счёт №{pending.number}</b> · тариф «{pending.planTitle}», {pending.months} мес. · <b>{rub(pending.amountMinor)}</b></div>
            {pending.confirmationUrl ? (
              <a className="btn-gradient" href={pending.confirmationUrl}>Оплатить картой или СБП</a>
            ) : owner ? (
              <button type="button" className="btn-gradient" disabled={busy === pending.id} onClick={() => sandbox(pending)}>Оплатить (тестовый режим)</button>
            ) : null}
          </div>
          {pending.provider === "test" && <span className="muted" style={{ fontSize: 12 }}>Ключи магазина платформы ещё не заданы, поэтому оплата тестовая и деньги не списываются.</span>}
        </div>
      )}

      <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ margin: 0 }}>Тарифы</h2>
        <div className="segment">
          {data.periods.map((item) => (
            <button key={item.months} type="button" className={months === item.months ? "on" : ""} onClick={() => setMonths(item.months)}>{item.label}</button>
          ))}
        </div>
      </div>
      <div className="plan-grid">
        {data.plans.map((plan) => {
          const current = data.plan === plan.id && data.state !== "trial";
          const total = Math.round((plan.priceMinor * months * (10000 - period.discountBps)) / 10000);
          return (
            <div key={plan.id} className={`panel plan-card ${current ? "current" : ""} ${plan.id === "salon" ? "featured" : ""}`}>
              <div className="spread"><h3 style={{ margin: 0 }}>{plan.title}</h3>{current && <span className="chip on">ваш тариф</span>}{!current && plan.id === "salon" && <span className="chip">популярный</span>}</div>
              <div><b className="display plan-price">{rub(plan.priceMinor)}</b><span className="muted"> / месяц</span></div>
              <ul>
                {plan.features.map((item) => <li key={item}><Check size={14} /> {item}</li>)}
              </ul>
              <div className="muted" style={{ fontSize: 12 }}>{months === 1 ? "Оплата за месяц" : `За ${months} мес.: ${rub(total)}`}</div>
              {owner && (
                <button type="button" className={plan.id === "salon" ? "btn-gradient" : "btn"} disabled={!plan.fits || busy === plan.id} onClick={() => buy(plan)}>
                  {!plan.fits ? `Нужно не больше ${plan.staffLimit} мастеров и ${plan.branchLimit} фил.` : current ? "Продлить" : "Выбрать"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!owner && <span className="muted">Тариф выбирает и оплачивает владелец салона.</span>}

      {data.invoices.length > 0 && (
        <div className="panel list">
          <h3 style={{ margin: 0 }}>Счета</h3>
          <table className="plain-table">
            <thead><tr><th>№</th><th>Тариф</th><th>Сумма</th><th>Статус</th><th>Период</th></tr></thead>
            <tbody>
              {data.invoices.map((item) => (
                <tr key={item.id}>
                  <td>{item.number}</td>
                  <td>{item.planTitle}, {item.months} мес.</td>
                  <td>{rub(item.amountMinor)}</td>
                  <td>{STATUS[item.status]}</td>
                  <td>{item.periodFrom ? `${date(item.periodFrom)} — ${date(item.periodTo)}` : date(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Banner in the shell: soon over, over, or suspended. */
export function BillingBanner({ billing, role }: { billing?: { state: string; daysLeft: number | null; readOnly: boolean }; role: string }) {
  if (!billing) return null;
  const owner = role === "owner" || role === "super";
  const link = owner ? <Link href="/settings/billing">{billing.readOnly || billing.state === "grace" ? "Продлить тариф →" : "Выбрать тариф →"}</Link> : <span>Обратитесь к владельцу салона.</span>;
  if (billing.state === "suspended") return <div className="banner billing-banner bad">Салон приостановлен платформой, CRM открыта только для просмотра. {owner ? <Link href="/settings/billing">Подробнее →</Link> : null}</div>;
  if (billing.state === "expired") return <div className="banner billing-banner bad">Подписка закончилась: можно смотреть, но не изменять. {link}</div>;
  if (billing.state === "grace") return <div className="banner billing-banner">Подписка закончилась, через несколько дней CRM станет только для просмотра. {link}</div>;
  if (billing.state === "trial" && billing.daysLeft !== null && billing.daysLeft <= 7) return <div className="banner billing-banner">Пробный период: осталось {billing.daysLeft} дн. {link}</div>;
  return null;
}
