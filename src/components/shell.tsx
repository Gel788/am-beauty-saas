"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CalendarDays, LayoutDashboard, Scissors, Settings, Sparkles, UserRound, Users, Wallet } from "lucide-react";
import { api } from "./api";
import { portraitFor, SALON_PHOTO } from "./portraits";
import { AiPanel } from "./ai-panel";

type Me = {
  actor: { name: string; role: string };
  branches: { id: string; name: string; address: string }[];
};

const LINKS = [
  { href: "/journal", label: "Календарь", icon: CalendarDays },
  { href: "/dashboard", label: "Дашборд", icon: LayoutDashboard },
  { href: "/clients", label: "Клиенты", icon: Users },
  { href: "/journal#ai-panel", label: "AI-ассистент", icon: Sparkles, badge: "3" },
  { href: "/services", label: "Услуги", icon: Scissors },
  { href: "/staff", label: "Мастера", icon: UserRound },
  { href: "/cash", label: "Финансы", icon: Wallet },
  { href: "/settings", label: "Настройки", icon: Settings },
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
  const showAi = pathname.startsWith("/journal");

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => undefined);
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    setOffline(!navigator.onLine);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

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
              <Image src={SALON_PHOTO} alt="" width={36} height={36} />
              <div>
                <strong>{branch.name}</strong>
                <span>Филиал 1 из {Math.max(me?.branches.length ?? 1, 1)}</span>
              </div>
            </button>
          )}
          <nav className="nav">
            {LINKS.map((link) => {
              const Icon = link.icon;
              const active = link.label === "AI-ассистент" ? false : pathname === link.href || (link.href !== "/journal" && pathname.startsWith(link.href));
              const calendarActive = link.href === "/journal" && pathname.startsWith("/journal") && link.label === "Календарь";
              return (
                <Link key={link.label} href={link.href} className={`nav-item ${active || calendarActive ? "active" : ""}`}>
                  <Icon />
                  {link.label}
                  {link.badge && <span className="nav-badge">{link.badge}</span>}
                </Link>
              );
            })}
          </nav>
          <div className="side-grow" />
          <div className="ai-week">
            <p>AI на этой неделе</p>
            <b>142</b>
            <small>ответа · ≈ 11 часов администратора</small>
          </div>
          {me && (
            <div className="user-row">
              <Image className="face" src={ownerPhoto} alt="" width={36} height={36} />
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
