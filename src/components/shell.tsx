"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CalendarDays,
  ChevronsUpDown,
  Contact,
  LayoutDashboard,
  LogOut,
  Scissors,
  Settings,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react";
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
  { href: "/staff", label: "Мастера", icon: Contact },
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
  const mainClass = pathname.startsWith("/dashboard") ? "main-dash" : showAi ? "main-journal" : "main-page";

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
    <div className="app-root">
      <div className="blob" style={{ width: 520, height: 520, background: "#DDD0FF", top: -180, left: -120, opacity: 0.9 }} />
      <div className="blob" style={{ width: 480, height: 480, background: "#FFD3E6", top: -140, right: -80, opacity: 0.9 }} />
      <div className="blob" style={{ width: 520, height: 420, background: "#FFE1C7", bottom: -200, right: 220, opacity: 0.85 }} />
      <div className="blob" style={{ width: 360, height: 360, background: "#E9DDFF", bottom: -140, left: 200, opacity: 0.7 }} />
      <aside className="sidebar w-[236px] shrink-0 p-4 flex flex-col relative z-10">
        <div className="flex items-center gap-3 px-2 h-11">
          <div className="mono grid place-items-center shrink-0" style={{ width: 38, height: 38, borderRadius: 12 }}>
            <span className="font-serif italic font-semibold leading-none" style={{ fontSize: 18, marginTop: -2 }}>Am</span>
          </div>
          <div className="flex items-baseline gap-1.5 text-ink leading-none">
            <span className="font-serif italic font-semibold" style={{ fontSize: 21 }}>Am</span>
            <span className="font-display font-medium uppercase" style={{ fontSize: 11, letterSpacing: "0.32em" }}>Beauty</span>
          </div>
        </div>
        {branch && (
          <button className="mt-5 glass rounded-2xl p-2.5 flex items-center gap-2.5 text-left w-full" type="button">
            <img src={SALON_PHOTO} alt="" className="w-9 h-9 rounded-xl object-cover" />
            <div className="leading-tight min-w-0">
              <div className="text-[13px] font-semibold whitespace-nowrap">{branch.name}</div>
              <div className="text-[11px] text-muted">Филиал 1 из {Math.max(me?.branches.length ?? 1, 1)}</div>
            </div>
            <span className="ml-auto text-muted"><ChevronsUpDown className="w-4 h-4" strokeWidth={1.8} /></span>
          </button>
        )}
        <nav className="mt-5 space-y-1">
          {LINKS.map((link) => {
            const Icon = link.icon;
            const active = link.label === "AI-ассистент"
              ? false
              : link.href === "/journal"
                ? pathname.startsWith("/journal")
                : pathname === link.href || pathname.startsWith(link.href);
            return (
              <Link
                key={link.label}
                href={link.href}
                className={`flex items-center gap-3 px-3 h-10 rounded-xl text-[14px] ${active ? "bg-white solid font-semibold text-ink" : "text-ink/60"}`}
              >
                <Icon className={`ic ${active ? "text-acc" : ""}`} strokeWidth={1.8} />
                {link.label}
                {link.badge && (
                  <span className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold text-acc">
                    <span className="orb" style={{ width: 8, height: 8 }} />
                    {link.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto rounded-2xl p-4 relative overflow-hidden glass">
          <div className="blob" style={{ width: 160, height: 160, background: "#F9C9E3", top: -60, right: -60, filter: "blur(40px)" }} />
          <div className="relative flex items-center gap-2 text-[13px] font-semibold">
            <span className="orb inline-block shrink-0" style={{ width: 16, height: 16 }} />
            AI на этой неделе
          </div>
          <div className="relative font-display text-[22px] font-semibold mt-1.5">
            142 <span className="text-[12px] font-sans font-medium text-muted">ответа</span>
          </div>
          <div className="relative text-[12px] text-muted">≈ 11 часов администратора</div>
        </div>
        {me && (
          <div className="flex items-center gap-2.5 mt-4 px-1">
            <img className="w-9 h-9 rounded-full object-cover border-2 border-white" src={ownerPhoto} alt="" />
            <div className="leading-tight min-w-0">
              <div className="text-[13px] font-semibold whitespace-nowrap">{me.actor.name}</div>
              <div className="text-[11px] text-muted">{ROLES[me.actor.role] ?? me.actor.role}</div>
            </div>
            <button
              className="ml-auto text-muted"
              type="button"
              aria-label="Выйти"
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST" });
                router.push("/login");
              }}
            >
              <LogOut className="w-4 h-4" strokeWidth={1.8} />
            </button>
          </div>
        )}
      </aside>
      <div className={mainClass}>
        {offline && <div className="banner">Нет сети. Сохранение заблокировано, пока связь не вернётся.</div>}
        {children}
      </div>
      {showAi && <AiPanel />}
      <div className="grain" />
    </div>
  );
}
