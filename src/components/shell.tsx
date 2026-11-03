"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CalendarDays, LayoutDashboard, LogOut, Scissors, Settings, Users, Wallet, UserRound } from "lucide-react";
import { api } from "./api";
import { initials } from "./ui";

type Me = {
  actor: { name: string; role: string; email: string };
  branches: { id: string; name: string; address: string }[];
};

const LINKS = [
  { href: "/journal", label: "Журнал", icon: CalendarDays },
  { href: "/dashboard", label: "Обзор", icon: LayoutDashboard },
  { href: "/clients", label: "Клиенты", icon: Users },
  { href: "/services", label: "Услуги", icon: Scissors },
  { href: "/staff", label: "Мастера", icon: UserRound },
  { href: "/cash", label: "Касса", icon: Wallet },
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

  return (
    <div className="app-frame">
      <div className="glass-shell">
        <aside className="sidebar">
          <div className="logo">
            <span className="logo-am">Am</span>
            <span className="logo-beauty">BEAUTY</span>
          </div>
          {me?.branches[0] && (
            <div className="branch-pill">
              <div className="avatar">Am</div>
              <div>
                <strong>{me.branches[0].name}</strong>
                <span>{me.branches[0].address || "Филиал"}</span>
              </div>
            </div>
          )}
          <nav className="nav">
            {LINKS.map((link) => {
              const Icon = link.icon;
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link key={link.href} href={link.href} className={`nav-item ${active ? "active" : ""}`}>
                  <Icon />
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <div className="sidebar-spacer" />
          {me && (
            <div className="user-card">
              <div className="avatar">{initials(me.actor.name)}</div>
              <div style={{ flex: 1 }}>
                <strong>{me.actor.name}</strong>
                <span>{ROLES[me.actor.role] ?? me.actor.role}</span>
              </div>
              <button
                className="icon-btn"
                aria-label="Выйти"
                onClick={async () => {
                  await api("/api/auth/logout", { method: "POST" });
                  router.push("/login");
                }}
              >
                <LogOut size={16} />
              </button>
            </div>
          )}
        </aside>
        <div className="main">
          {offline && <div className="banner">Нет сети. Сохранение заблокировано, пока связь не вернётся.</div>}
          {children}
        </div>
      </div>
    </div>
  );
}
