"use client";

import { useEffect, useState } from "react";
import { ReportsView } from "@/components/reports-view";
import { PeriodView } from "@/components/period-view";
import { api } from "@/components/api";

export default function ReportsPage() {
  const [tab, setTab] = useState<"day" | "period">("day");
  const [role, setRole] = useState("");
  useEffect(() => {
    api<{ actor: { role: string } }>("/api/auth/me").then((me) => {
      setRole(me.actor.role);
      if (me.actor.role === "master") setTab("period");
    }).catch(() => undefined);
    if (new URLSearchParams(window.location.search).get("tab") === "period") setTab("period");
  }, []);
  return (
    <div className="reports-page">
      {role !== "master" && (
        <div className="segment" style={{ alignSelf: "flex-start" }}>
          <button type="button" className={tab === "day" ? "on" : ""} onClick={() => setTab("day")}>День</button>
          <button type="button" className={tab === "period" ? "on" : ""} onClick={() => setTab("period")}>Период</button>
        </div>
      )}
      {tab === "day" && role !== "master" ? <ReportsView /> : role ? <PeriodView role={role} /> : null}
    </div>
  );
}
