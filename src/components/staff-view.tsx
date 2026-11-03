"use client";

import { useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { initials, useToast } from "./ui";

type Staff = { id: string; displayName: string; color: string; active: boolean; branchIds: string[] };
type Interval = { weekday: number; startMin: number; endMin: number; kind: "work" | "break" };

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function StaffView() {
  const toast = useToast();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [branchId, setBranchId] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [intervals, setIntervals] = useState<Interval[]>([]);

  async function load() {
    const me = await api<{ branches: { id: string }[] }>("/api/auth/me");
    const branch = me.branches[0]?.id ?? "";
    setBranchId(branch);
    setStaff(await api<Staff[]>("/api/staff"));
  }
  useEffect(() => { void load().catch((error: ApiError) => toast(error.message, "error")); }, [toast]);

  async function openSchedule(id: string) {
    setSelected(id);
    setIntervals(await api<Interval[]>(`/api/staff/${id}/schedule?branchId=${branchId}`));
  }

  return (
    <>
      <div className="spread">
        <div><div className="page-kicker">Команда</div><h1>Мастера</h1></div>
      </div>
      <form className="panel row" onSubmit={async (event) => {
        event.preventDefault();
        try {
          await api("/api/staff", { method: "POST", body: JSON.stringify({ displayName: name, branchIds: [branchId] }) });
          setName("");
          toast("Мастер добавлен");
          await load();
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}>
        <div className="field" style={{ flex: 1 }}><label>Имя</label><input value={name} onChange={(event) => setName(event.target.value)} required /></div>
        <button className="btn-gradient" type="submit">Добавить</button>
      </form>
      <div className="split">
        <div className="list">
          {staff.map((person) => (
            <button key={person.id} className="person" type="button" onClick={() => openSchedule(person.id)}>
              <div className="avatar" style={{ background: person.color }}>{initials(person.displayName)}</div>
              <div><strong>{person.displayName}</strong><span>{person.active ? "активен" : "скрыт"}</span></div>
            </button>
          ))}
        </div>
        <div className="panel">
          {!selected && <div className="empty">Выберите мастера, чтобы задать неделю.</div>}
          {selected && (
            <form className="list" onSubmit={async (event) => {
              event.preventDefault();
              try {
                await api(`/api/staff/${selected}/schedule`, { method: "PUT", body: JSON.stringify({ branchId, intervals }) });
                toast("График сохранён");
              } catch (error) {
                toast((error as ApiError).message, "error");
              }
            }}>
              <h2 className="display" style={{ fontSize: 22 }}>Неделя</h2>
              {DAYS.map((label, index) => {
                const weekday = index + 1;
                const work = intervals.find((item) => item.weekday === weekday && item.kind === "work");
                return (
                  <div className="row" key={label}>
                    <strong style={{ width: 28 }}>{label}</strong>
                    <input type="time" value={work ? minutes(work.startMin) : ""} onChange={(event) => setDay(weekday, event.target.value, work?.endMin)} />
                    <input type="time" value={work ? minutes(work.endMin) : ""} onChange={(event) => setDay(weekday, minutes(work?.startMin ?? 600), toMinutes(event.target.value))} />
                  </div>
                );
              })}
              <button className="btn-gradient" type="submit">Сохранить график</button>
              <button className="btn" type="button" onClick={async () => {
                const decision = window.confirm("Деактивировать и отменить будущие записи? Отмена диалога оставит выбор переноса.");
                try {
                  if (decision) {
                    await api(`/api/staff/${selected}/deactivate`, { method: "POST", body: JSON.stringify({ decision: "cancel" }) });
                  } else {
                    await api(`/api/staff/${selected}/deactivate`, { method: "POST", body: JSON.stringify({}) });
                  }
                  toast("Готово");
                  await load();
                } catch (error) {
                  toast((error as ApiError).message, "error");
                }
              }}>Деактивировать</button>
            </form>
          )}
        </div>
      </div>
    </>
  );

  function setDay(weekday: number, start: string | number, end?: number) {
    const startMin = typeof start === "number" ? start : toMinutes(start);
    const endMin = end ?? (intervals.find((item) => item.weekday === weekday)?.endMin ?? startMin + 60);
    setIntervals((current) => [
      ...current.filter((item) => item.weekday !== weekday || item.kind !== "work"),
      { weekday, startMin, endMin, kind: "work" },
    ]);
  }
}

function minutes(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function toMinutes(value: string) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}
