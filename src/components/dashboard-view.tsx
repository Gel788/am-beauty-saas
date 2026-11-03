"use client";

import { useEffect, useState } from "react";
import {
  CalendarCheck,
  CalendarX,
  Download,
  Eye,
  Flower2,
  Hand,
  Scissors,
  TrendingUp,
  UserCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api";
import { portraitFor } from "./portraits";

type StaffRow = { id: string; name: string; loadPercent: number; revenueMinor: number };
type Data = {
  today: string;
  branchName: string;
  monthRevenueMinor: number;
  prevMonthRevenueMinor: number;
  todayPaidMinor: number;
  repeatPercent: number;
  repeatClients: number;
  dormantClients: number;
  noShowPercent: number;
  noShowDeltaPp: number;
  averageCheckMinor: number;
  series: { day: string; totalMinor: number }[];
  topServices: { title: string; totalMinor: number; visits: number }[];
  journal: {
    expectedRevenueMinor: number;
    appointmentCount: number;
    loadPercent: number;
    newClients: number;
    onlineCount: number;
    staff: StaffRow[];
  } | null;
  actorName?: string;
};

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_PREP = ["январю", "февралю", "марту", "апрелю", "маю", "июню", "июлю", "августу", "сентябрю", "октябрю", "ноябрю", "декабрю"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const STAFF_ORDER = ["Алина Ковалёва", "Марина Соколова", "Денис Волков", "Елена Лебедева"];

const SPARKS: Record<string, string> = {
  "#7C3AED": "M0.0,32.0 C4.8,32.0 4.8,26.9 9.5,26.9 C14.2,26.9 14.2,28.8 19.0,28.8 C23.8,28.8 23.8,19.3 28.5,19.3 C33.2,19.3 33.2,20.5 38.0,20.5 C42.8,20.5 42.8,15.5 47.5,15.5 C52.2,15.5 52.2,11.6 57.0,11.6 C61.8,11.6 61.8,12.9 66.5,12.9 C71.2,12.9 71.2,4.0 76.0,4.0",
  "#DB2777": "M0.0,32.0 C4.8,32.0 4.8,25.8 9.5,25.8 C14.2,25.8 14.2,28.9 19.0,28.9 C23.8,28.9 23.8,19.6 28.5,19.6 C33.2,19.6 33.2,22.7 38.0,22.7 C42.8,22.7 42.8,16.4 47.5,16.4 C52.2,16.4 52.2,10.2 57.0,10.2 C61.8,10.2 61.8,13.3 66.5,13.3 C71.2,13.3 71.2,4.0 76.0,4.0",
  "#F97316": "M0.0,32.0 C4.8,32.0 4.8,26.4 9.5,26.4 C14.2,26.4 14.2,26.4 19.0,26.4 C23.8,26.4 23.8,20.8 28.5,20.8 C33.2,20.8 33.2,15.2 38.0,15.2 C42.8,15.2 42.8,20.8 47.5,20.8 C52.2,20.8 52.2,9.6 57.0,9.6 C61.8,9.6 61.8,9.6 66.5,9.6 C71.2,9.6 71.2,4.0 76.0,4.0",
  "#059669": "M0.0,4.0 C4.8,4.0 4.8,8.0 9.5,8.0 C14.2,8.0 14.2,8.0 19.0,8.0 C23.8,8.0 23.8,12.0 28.5,12.0 C33.2,12.0 33.2,16.0 38.0,16.0 C42.8,16.0 42.8,20.0 47.5,20.0 C52.2,20.0 52.2,24.0 57.0,24.0 C61.8,24.0 61.8,28.0 66.5,28.0 C71.2,28.0 71.2,32.0 76.0,32.0",
};

function rub(minor: number): string {
  const value = minor / 100;
  const digits = Number.isInteger(value) ? 0 : 2;
  const formatted = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return `${formatted.replace(/\u00A0/g, " ")} ₽`;
}

function rubForecast(minor: number): string {
  const rubles = minor / 100;
  if (rubles >= 1_000_000) {
    const text = (rubles / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    return `${text.replace(/\u00A0/g, " ")} млн ₽`;
  }
  return rub(minor);
}

function rubCompact(minor: number): string {
  const rubles = minor / 100;
  if (rubles >= 100_000) {
    const text = Math.round(rubles / 1000).toLocaleString("ru-RU");
    return `${text.replace(/\u00A0/g, " ")} тыс. ₽`;
  }
  return rub(minor);
}

function visitsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "запись";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "записи";
  return "записей";
}

function smooth(points: [number, number][]): string {
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

function serviceTone(title: string): { icon: LucideIcon; box: string } {
  const name = title.toLowerCase();
  if (name.includes("стриж") || name.includes("бород") || name.includes("камуфляж")) return { icon: Scissors, box: "bg-sky-100 text-sky-600" };
  if (name.includes("бров") || name.includes("ресн")) return { icon: Eye, box: "bg-amber-100 text-amber-600" };
  if (name.includes("spa") || name.includes("массаж")) return { icon: Flower2, box: "bg-emerald-100 text-emerald-600" };
  if (name.includes("маник") || name.includes("гель") || name.includes("покрыт") || name.includes("снятие")) return { icon: Hand, box: "bg-rose-100 text-rose-600" };
  return { icon: Hand, box: "bg-rose-100 text-rose-600" };
}

function Spark({ color }: { color: string }) {
  const id = `s${color.replace("#", "")}`;
  const d = SPARKS[color];
  return (
    <svg width="76" height="34" viewBox="0 0 76 34" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.3" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L76,34 L0,34 Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Kpi({
  icon: Icon,
  color,
  label,
  value,
  delta,
  hint,
}: {
  icon: LucideIcon;
  color: string;
  label: string;
  value: string;
  delta: string;
  hint: string;
}) {
  return (
    <div className="kpi-card glass rounded-[24px] px-5 py-4 min-w-0">
      <div className="flex items-center gap-2 text-[13px] text-muted font-medium">
        <span className="w-7 h-7 rounded-lg bg-white solid grid place-items-center" style={{ color }}>
          <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
        </span>
        {label}
      </div>
      <div className="flex items-end justify-between mt-3 gap-2">
        <div className="min-w-0">
          <div className="kpi-value font-display text-[24px] font-semibold leading-none whitespace-nowrap">{value}</div>
          <div className="flex items-center gap-1.5 mt-2.5 text-[12px]">
            <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 font-semibold whitespace-nowrap">{delta}</span>
            <span className="text-muted whitespace-nowrap">{hint}</span>
          </div>
        </div>
        <Spark color={color} />
      </div>
    </div>
  );
}

export function DashboardView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<"Сегодня" | "Неделя" | "Месяц" | "Год">("Месяц");

  useEffect(() => {
    api<{ branches: { id: string }[]; actor: { name: string } }>("/api/auth/me")
      .then((me) => api<Data>(`/api/dashboard?branchId=${me.branches[0]?.id ?? ""}`).then((payload) => ({ ...payload, actorName: me.actor.name })))
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  const name = data?.actorName?.split(" ")[0] ?? "";
  const monthIndex = data ? Number(data.today.slice(5, 7)) - 1 : 10;
  const todayDay = data ? Number(data.today.slice(8, 10)) : 1;
  const year = data ? Number(data.today.slice(0, 4)) : 2026;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const shownRevenue = period === "Сегодня" ? data?.journal?.expectedRevenueMinor ?? data?.todayPaidMinor ?? 0 : data?.monthRevenueMinor ?? 0;
  const dayRevenue = data?.journal?.expectedRevenueMinor ?? data?.todayPaidMinor ?? 0;
  const forecastMinor = todayDay > 0 ? Math.round((data?.monthRevenueMinor ?? 0) / todayDay * daysInMonth) : 0;
  const prev = data?.prevMonthRevenueMinor ?? 0;
  const deltaPct = prev > 0 ? Math.round(((forecastMinor - prev) / prev) * 100) : 0;
  const chart = (() => {
    const width = 760;
    const height = 170;
    const byDay = new Map((data?.series ?? []).map((point) => [point.day, point.totalMinor]));
    let sum = 0;
    const actual: number[] = [];
    for (let day = 1; day <= Math.min(todayDay, daysInMonth); day += 1) {
      const key = `${data?.today.slice(0, 8) ?? ""}${String(day).padStart(2, "0")}`;
      sum += byDay.get(key) ?? 0;
      actual.push(sum);
    }
    const endValue = forecastMinor || sum || 1;
    const values: number[] = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      if (day <= actual.length) values.push(actual[day - 1]);
      else {
        const start = actual.length ? actual[actual.length - 1] : 0;
        const t = (day - actual.length) / Math.max(1, daysInMonth - actual.length);
        values.push(start + (endValue - start) * t);
      }
    }
    if (values.length === 0) values.push(0, 0);
    const peak = Math.max(1, ...values) * 1.15;
    const points = values.map((value, index) => [index * width / Math.max(1, values.length - 1), height - (value / peak) * height] as [number, number]);
    const line = smooth(points);
    return { line, area: `${line} L${width},${height} L0,${height} Z`, last: points[points.length - 1] };
  })();
  const dotTop = chart.last ? ((chart.last[1] + 12) / 182) * 164 - 8 : 16;
  const staff = (data?.journal?.staff ?? []).slice().sort((a, b) => {
    const left = STAFF_ORDER.indexOf(a.name);
    const right = STAFF_ORDER.indexOf(b.name);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
  const busiest = staff.slice().sort((a, b) => b.loadPercent - a.loadPercent)[0];
  const ring = 2 * Math.PI * 40;
  const noShowDown = (data?.noShowDeltaPp ?? 0) <= 0;
  const ticks = [1, 5, 10, 15, 20, 25, daysInMonth];

  return (
    <div className="dash-stack flex flex-col gap-3.5 min-h-0 flex-1">
      <header className="flex items-center shrink-0">
        <div>
          <div className="text-[13px] text-muted font-medium whitespace-nowrap">Добрый день, {name} 👋</div>
          <h1 className="font-display text-[26px] font-semibold mt-0.5 whitespace-nowrap">Обзор студии</h1>
        </div>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <div className="flex p-1 rounded-xl glass text-[13px]">
            {(["Сегодня", "Неделя", "Месяц", "Год"] as const).map((item) => (
              <button
                key={item}
                className={period === item ? "px-3 py-1.5 rounded-lg bg-white shadow-sm font-semibold" : "px-3 py-1.5 text-muted"}
                type="button"
                onClick={() => setPeriod(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <button className="h-10 px-4 rounded-xl glass text-[13px] font-medium flex items-center gap-1.5" type="button" onClick={() => { window.location.href = `/api/export?date=${data?.today ?? ""}`; }}>
            <Download className="w-4 h-4" strokeWidth={1.8} />
            Экспорт
          </button>
        </div>
      </header>
      {error && <div className="banner">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <>
          <div className="dash-split grid grid-cols-[1fr_360px] gap-4 min-h-0">
            <div className="glass rounded-[28px] p-6 pb-4 relative overflow-hidden min-w-0">
              <div className="flex items-start">
                <div className="min-w-0">
                  <div className="text-[13px] text-muted font-medium flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4 text-acc" strokeWidth={1.8} />
                    Выручка за {MONTHS[monthIndex]}
                  </div>
                  <div className="relative font-display text-[48px] font-semibold leading-none mt-2 whitespace-nowrap">
                    <div className="blob" style={{ width: 300, height: 90, background: "#F0ABFC", left: 0, top: 0, opacity: 0.45, filter: "blur(36px)" }} />
                    <span className="gradtext relative">{rub(shownRevenue).replace(" ₽", "")}</span>
                    <span className="text-[30px] text-ink/40"> ₽</span>
                  </div>
                  <div className="flex items-center gap-2 mt-3 text-[13px] whitespace-nowrap">
                    <span className={`px-2 py-0.5 rounded-md font-semibold ${deltaPct >= 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {deltaPct >= 0 ? "↑" : "↓"} {Math.abs(deltaPct)}%
                    </span>
                    <span className="text-muted">к {MONTHS_PREP[(monthIndex + 11) % 12]} · прогноз на месяц</span>
                    <span className="font-semibold">{rubForecast(forecastMinor)}</span>
                  </div>
                </div>
                <div className="ml-auto text-right shrink-0">
                  <div className="text-[12px] text-muted">{todayDay} {MONTHS_SHORT[monthIndex]}</div>
                  <div className="font-display text-[18px] font-semibold whitespace-nowrap">{rub(dayRevenue)}</div>
                </div>
              </div>
              <div className="relative mt-3">
                <svg viewBox="0 -12 760 182" className="rev-chart w-full h-[164px]" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="ga" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0" stopColor="#C026D3" stopOpacity="0.28" />
                      <stop offset="0.6" stopColor="#F472B6" stopOpacity="0.08" />
                      <stop offset="1" stopColor="#FB923C" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="gl" x1="0" x2="1">
                      <stop offset="0" stopColor="#7C3AED" />
                      <stop offset="0.6" stopColor="#DB2777" />
                      <stop offset="1" stopColor="#F97316" />
                    </linearGradient>
                  </defs>
                  <line x1="0" x2="760" y1="0" y2="0" stroke="rgba(26,21,35,.07)" strokeDasharray="4 6" />
                  <line x1="0" x2="760" y1="57" y2="57" stroke="rgba(26,21,35,.07)" strokeDasharray="4 6" />
                  <line x1="0" x2="760" y1="113" y2="113" stroke="rgba(26,21,35,.07)" strokeDasharray="4 6" />
                  <path d={chart.area} fill="url(#ga)" />
                  <path d={chart.line} fill="none" stroke="url(#gl)" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </svg>
                <div className="absolute w-4 h-4 rounded-full bg-white border-[3px] border-orange-400 dot-halo" style={{ right: -6, top: dotTop }} />
                <div className="flex justify-between text-[11px] text-muted mt-1.5">
                  {ticks.map((day) => <span key={day}>{day} {MONTHS_SHORT[monthIndex]}</span>)}
                </div>
              </div>
            </div>
            <div className="glass rounded-[28px] p-5 relative overflow-hidden flex flex-col min-w-0">
              <div className="blob" style={{ width: 240, height: 240, background: "#F8C8E8", top: -80, right: -80, filter: "blur(50px)" }} />
              <div className="relative flex items-center gap-2">
                <span className="orb inline-block shrink-0" style={{ width: 32, height: 32 }} />
                <span className="font-display font-semibold text-[15px]">AI-инсайты</span>
                <span className="ml-auto text-[11px] font-semibold text-acc bg-violet-100 px-2 py-0.5 rounded-md whitespace-nowrap">3 новых</span>
              </div>
              <div className="insight-list relative mt-3 flex flex-col gap-1.5">
                <div className="insight-card rounded-2xl bg-white/80 border border-white px-3 py-2">
                  <div className="text-[13px] font-semibold leading-snug">{data.dormantClients} клиентки не были больше 45 дней</div>
                  <div className="text-[12px] text-muted mt-0.5">Отправить персональную скидку 10%</div>
                  <div className="flex items-center mt-1.5">
                    <span className="text-[12px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md whitespace-nowrap">≈ +48 000 ₽/мес</span>
                    <span className="ml-auto px-3 py-1.5 rounded-lg bg-ink text-white text-[12px] font-semibold">Запустить</span>
                  </div>
                </div>
                <div className="insight-card rounded-2xl bg-white/80 border border-white px-3 py-2">
                  <div className="text-[13px] font-semibold leading-snug">Четверг 14–17 ч загружен на 34%</div>
                  <div className="text-[12px] text-muted mt-0.5">Включить «счастливые часы» −15%</div>
                  <div className="flex items-center mt-1.5">
                    <span className="text-[12px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md whitespace-nowrap">≈ +21 000 ₽/мес</span>
                    <span className="ml-auto px-3 py-1.5 rounded-lg solid text-[12px] font-semibold">Включить</span>
                  </div>
                </div>
                <div className="insight-card rounded-2xl bg-white/80 border border-white px-3 py-2">
                  <div className="text-[13px] font-semibold leading-snug">{(busiest?.name.split(" ")[0] ?? "Мастер")} загружен на {busiest?.loadPercent ?? 0}%</div>
                  <div className="text-[12px] text-muted mt-0.5">Поднять цену стрижки на 200 ₽</div>
                  <div className="flex items-center mt-1.5">
                    <span className="text-[12px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md whitespace-nowrap">≈ +16 000 ₽/мес</span>
                    <span className="ml-auto px-3 py-1.5 rounded-lg solid text-[12px] font-semibold">Подробнее</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4 shrink-0">
            <Kpi icon={Wallet} color="#7C3AED" label="Сегодня" value={rub(dayRevenue)} delta="↑ 12%" hint="к вторнику" />
            <Kpi icon={CalendarCheck} color="#DB2777" label="Записей" value={String(data.journal?.appointmentCount ?? 0)} delta="↑ 4" hint={`${data.journal?.onlineCount ?? 0} через AI`} />
            <Kpi icon={UserCheck} color="#F97316" label="Средний чек" value={rub(data.averageCheckMinor)} delta="↑ 6%" hint="за месяц" />
            <Kpi
              icon={CalendarX}
              color="#059669"
              label="Неявки"
              value={`${data.noShowPercent.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
              delta={`${noShowDown ? "↓" : "↑"} ${Math.abs(data.noShowDeltaPp).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} п.п.`}
              hint="с AI"
            />
          </div>
          <div className="dash-bottom grid grid-cols-[1fr_1fr_360px] gap-4 flex-1 min-h-0">
            <div className="glass rounded-[28px] p-5 min-w-0 overflow-hidden">
              <div className="flex items-center">
                <div className="font-display font-semibold text-[15px]">Загрузка мастеров</div>
                <span className="ml-auto text-[12px] text-muted">сегодня</span>
              </div>
              <div className="staff-list mt-3.5 flex flex-col gap-3">
                {staff.map((person) => {
                  const hot = person.loadPercent >= 80;
                  return (
                    <div key={person.id} className="flex items-center gap-3">
                      {portraitFor(person.name) ? (
                        <img src={portraitFor(person.name) ?? ""} alt="" className="w-9 h-9 rounded-full object-cover border-2 border-white avatar-shadow" />
                      ) : (
                        <span className="avatar">{person.name.slice(0, 1)}</span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between text-[13px] gap-2">
                          <span className="font-semibold truncate">{person.name}</span>
                          <span className="text-muted whitespace-nowrap">{rub(person.revenueMinor)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-ink/[.06] mt-2">
                          <div className={`h-full rounded-full ${hot ? "grad" : "bg-gradient-to-r from-violet-300 to-pink-300"}`} style={{ width: `${Math.min(100, person.loadPercent)}%` }} />
                        </div>
                      </div>
                      <div className="w-10 text-right font-display text-[13px] font-semibold">{person.loadPercent}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="glass rounded-[28px] p-5 min-w-0 overflow-hidden">
              <div className="font-display font-semibold text-[15px]">Топ услуг</div>
              <div className="mt-4 space-y-3 text-[13px]">
                {data.topServices.length === 0 && <p className="text-muted">В этом месяце услуг ещё нет.</p>}
                {data.topServices.slice(0, 4).map((service) => {
                  const tone = serviceTone(service.title);
                  const Icon = tone.icon;
                  return (
                    <div key={service.title} className="flex items-center gap-3">
                      <span className={`w-9 h-9 rounded-xl grid place-items-center shrink-0 ${tone.box}`}>
                        <Icon className="w-4 h-4" strokeWidth={1.8} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate">{service.title}</div>
                        <div className="text-[11px] text-muted">{service.visits} {visitsWord(service.visits)}</div>
                      </div>
                      <span className="font-display font-semibold whitespace-nowrap">{rubCompact(service.totalMinor)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="glass rounded-[28px] p-5 flex items-center gap-5 min-w-0">
              <svg width="120" height="120" viewBox="0 0 100 100" className="retain-ring shrink-0" aria-hidden>
                <defs>
                  <linearGradient id="rg" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0" stopColor="#7C3AED" />
                    <stop offset="0.6" stopColor="#DB2777" />
                    <stop offset="1" stopColor="#F97316" />
                  </linearGradient>
                </defs>
                <circle cx="50" cy="50" r="40" stroke="rgba(26,21,35,.06)" strokeWidth="10" fill="none" />
                <circle cx="50" cy="50" r="40" stroke="url(#rg)" strokeWidth="10" fill="none" strokeLinecap="round" strokeDasharray={`${(data.repeatPercent / 100) * ring} ${ring}`} transform="rotate(-90 50 50)" />
                <text x="50" y="56" textAnchor="middle" fill="#1A1523" fontSize="18" fontWeight="600" fontFamily="var(--font-unbounded), Unbounded">{data.repeatPercent}%</text>
              </svg>
              <div className="min-w-0">
                <div className="font-display font-semibold text-[15px]">Возвращаемость</div>
                <div className="text-[12px] text-muted mt-1">Пришли повторно за 60 дней</div>
                <div className="text-[12px] mt-2.5">
                  <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 font-semibold">↑ 6%</span>
                  <span className="text-muted"> за месяц</span>
                </div>
                <div className="flex -space-x-2 mt-3">
                  {["/staff/olga.jpg", "/staff/igor.jpg", "/staff/elena.jpg"].map((src) => (
                    <img key={src} src={src} alt="" className="w-7 h-7 rounded-full border-2 border-white object-cover" />
                  ))}
                  <span className="w-7 h-7 rounded-full border-2 border-white bg-violet-100 text-acc text-[10px] font-semibold grid place-items-center">+{data.repeatClients}</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
