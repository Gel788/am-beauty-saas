/** PLAT-BILLING-01: platform plans. Limits mirror plan_limits() in migration 022. */
export type PlanId = "start" | "salon" | "network";
export type TenantPlan = PlanId | "trial";

export type Plan = { id: PlanId; title: string; priceMinor: number; staffLimit: number; branchLimit: number; features: string[] };

export const PLANS: Plan[] = [
  { id: "start", title: "Старт", priceMinor: 149000, staffLimit: 3, branchLimit: 1, features: ["Журнал, клиенты, касса", "Онлайн-запись и напоминания", "До 3 мастеров"] },
  { id: "salon", title: "Салон", priceMinor: 349000, staffLimit: 10, branchLimit: 2, features: ["Всё из «Старта»", "Зарплаты, склад, лояльность", "До 10 мастеров, 2 филиала"] },
  { id: "network", title: "Сеть", priceMinor: 799000, staffLimit: 50, branchLimit: 10, features: ["Всё из «Салона»", "Сравнение филиалов", "До 50 мастеров, 10 филиалов"] },
];

/** During the trial the salon tries everything. */
export const TRIAL_LIMITS = { staffLimit: 50, branchLimit: 10 };
export const GRACE_DAYS = 3;
export const PERIODS: { months: 1 | 6 | 12; discountBps: number; label: string }[] = [
  { months: 1, discountBps: 0, label: "1 месяц" },
  { months: 6, discountBps: 1000, label: "6 месяцев · −10%" },
  { months: 12, discountBps: 2000, label: "12 месяцев · −20%" },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

export function limitsOf(plan: TenantPlan) {
  const found = planById(plan);
  return found ? { staffLimit: found.staffLimit, branchLimit: found.branchLimit } : TRIAL_LIMITS;
}

export function invoiceAmount(planId: PlanId, months: 1 | 6 | 12): number {
  const plan = planById(planId);
  const period = PERIODS.find((item) => item.months === months);
  if (!plan || !period) throw new Error("unknown plan or period");
  return Math.round((plan.priceMinor * months * (10000 - period.discountBps)) / 10000);
}

export type AccessState = "trial" | "active" | "grace" | "expired" | "suspended";

/** Where the salon stands: works normally, works with a warning, or is read-only. */
export function accessState(t: { plan: TenantPlan; trialEndsAt: Date; paidUntil: Date | null; suspendedAt: Date | null }, now: Date) {
  if (t.suspendedAt) return { state: "suspended" as AccessState, until: null, daysLeft: 0 };
  const end = t.paidUntil && (t.plan !== "trial" || t.paidUntil > t.trialEndsAt) ? t.paidUntil : t.trialEndsAt;
  const paid = Boolean(t.paidUntil) && end === t.paidUntil;
  const left = Math.ceil((end.getTime() - now.getTime()) / 86400000);
  if (end > now) return { state: (paid ? "active" : "trial") as AccessState, until: end, daysLeft: left };
  if (now.getTime() - end.getTime() < GRACE_DAYS * 86400000) return { state: "grace" as AccessState, until: end, daysLeft: left };
  return { state: "expired" as AccessState, until: end, daysLeft: left };
}

export const isReadOnly = (state: AccessState) => state === "expired" || state === "suspended";
