"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Banknote, BarChart3, Boxes, Gift, UsersRound, CalendarDays, HeartHandshake, LayoutDashboard, Scissors, Settings, Sparkles, Sun, UserRound, Users, Wallet } from "lucide-react";
import { api } from "./api";
import { portraitFor, SALON_PHOTO } from "./portraits";
import { AiPanel } from "./ai-panel";
import { Notifications } from "./notifications";
import { MiniCalendar } from "./mini-calendar";
import { AppDevice } from "./pwa";

type Me = {
  actor: { name: string; role: string };
  branches: { id: string; name: string; address: string; timezone: string }[];
};

const DESK = ["owner", "admin", "super"];
const LINKS: { href: string; label: string; icon: typeof CalendarDays; badge?: string; roles: string[]; masterLabel?: string }[] = [
  { href: "/me", label: "Мой день", icon: Sun, roles: ["master"] },
  { href: "/journal", label: "Календарь", icon: CalendarDays, roles: [...DESK, "master"] },
  { href: "/dashboard", label: "Дашборд", icon: LayoutDashboard, roles: DESK },
  { href: "/clients", label: "Клиенты", icon: Users, roles: [...DESK, "master"] },
  { href: "/groups", label: "Группы", icon: UsersRound, roles: [...DESK, "master"] },
  { href: "/journal#ai-panel", label: "AI-ассистент", icon: Sparkles, badge: "3", roles: DESK },
  { href: "/services", label: "Услуги", icon: Scissors, roles: DESK },
  { href: "/staff", label: "Мастера", icon: UserRound, roles: [...DESK, "master"], masterLabel: "Мой график" },
  { href: "/cash", label: "Финансы", icon: Wallet, roles: [...DESK, "accountant"] },
  { href: "/inventory", label: "Склад", icon: Boxes, roles: [...DESK, "accountant"] },
  { href: "/loyalty", label: "Лояльность", icon: Gift, roles: DESK },
  { href: "/retention", label: "Удержание", icon: HeartHandshake, roles: [...DESK, "master"], masterLabel: "Мои отзывы" },
  { href: "/reports", label: "Отчёты", icon: BarChart3, roles: [...DESK, "accountant", "master"], masterLabel: "Мои показатели" },
  { href: "/payroll", label: "Зарплаты", icon: Banknote, roles: [...DESK, "accountant", "master"], masterLabel: "Моя зарплата" },
  { href: "/settings", label: "Настройки", icon: Settings, roles: DESK },
];

const ROLES: Record<string, string> = {
  owner: "Владелец",
  admin: "Администратор",
  master: "Мастер",
  accountant: "Бухгалтер",
};

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);
  const showAi = pathname.startsWith("/journal") && DESK.includes(me?.actor.role ?? "owner");

  useEffect(() => {
    api<Me>("/api/auth/me")
      .then((data) => {
        setMe(data);
        // PWA-INSTALL-01: the installed app opens the journal; a master goes to «Мой день».
        if (data.actor.role === "master" && new URLSearchParams(window.location.search).get("app") === "1") router.replace("/me");
      })
      .catch(() => undefined);
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    setOffline(!navigator.onLine);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [router]);

  const branch = me?.branches[0];
  const ownerPhoto = portraitFor(me?.actor.name) ?? "/staff/olga.jpg";

  return (
    <div className="aurora">
      <div className="stage">
        <aside className="sidebar">
          <div className="wordmark">
            <span className="am">Am</span>
            <span className="beauty">BEAUTY</span>
          </div>
          {branch && (
            <button className="salon-switch" type="button">
              <img src={SALON_PHOTO} alt="" />
              <div>
                <strong>{branch.name}</strong>
                <span>Филиал 1 из {Math.max(me?.branches.length ?? 1, 1)}</span>
              </div>
            </button>
          )}
          <nav className="nav">
            {LINKS.filter((link) => !me || link.roles.includes(me.actor.role)).map((link) => {
              const Icon = link.icon;
              const label = me?.actor.role === "master" && link.masterLabel ? link.masterLabel : link.label;
              const active = link.label === "AI-ассистент" ? false : pathname === link.href || (link.href !== "/journal" && pathname.startsWith(link.href));
              const calendarActive = link.href === "/journal" && pathname.startsWith("/journal") && link.label === "Календарь";
              return (
                <Link key={link.label} href={link.href} className={`nav-item ${active || calendarActive ? "active" : ""}`}>
                  <Icon />
                  {label}
                  {link.badge && <span className="nav-badge">{link.badge}</span>}
                </Link>
              );
            })}
          </nav>
          {me && (DESK.includes(me.actor.role) || me.actor.role === "accountant") && <Notifications />}
          <div className="side-grow" />
          {me && me.actor.role !== "accountant" ? (
            <Suspense fallback={null}>
              <MiniCalendar timezone={branch?.timezone ?? "Europe/Moscow"} />
            </Suspense>
          ) : (
            <div className="ai-week">
              <p>AI на этой неделе</p>
              <b>142</b>
              <small>ответа · ≈ 11 часов администратора</small>
            </div>
          )}
          {me && <AppDevice />}
          {me && (
            <div className="user-row">
              <img className="face" src={ownerPhoto} alt="" />
              <div>
                <strong>{me.actor.name}</strong>
                <span>{ROLES[me.actor.role] ?? me.actor.role}</span>
              </div>
              <button type="button" aria-label="Выйти" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); router.push("/login"); }}>→</button>
            </div>
          )}
        </aside>
        <div className="stage-main">
          {offline && <div className="banner">Нет сети. Сохранение заблокировано, пока связь не вернётся.</div>}
          {children}
        </div>
      </div>
      {showAi && <AiPanel />}
    </div>
  );
}
