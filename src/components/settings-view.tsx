"use client";

import { useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Branch = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  requireOpenShift: boolean;
  masterSeesAllColumns: boolean;
  masterCanCreateOwn: boolean;
  masterCanDragOwn: boolean;
  masterCanCancelOwnFuture: boolean;
  arrivalWindowHours: number;
  noShowGraceMin: number;
  gridLabelMin: number;
  requirePaymentOnComplete: boolean;
  shiftVarianceThresholdMinor: number;
};

export function SettingsView() {
  const toast = useToast();
  const [branch, setBranch] = useState<Branch | null>(null);
  useEffect(() => {
    api<{ branches: Branch[] }>("/api/auth/me").then((me) => setBranch(me.branches[0] ?? null)).catch((error: ApiError) => toast(error.message, "error"));
  }, [toast]);
  if (!branch) return <div className="skeleton" />;
  const set = <K extends keyof Branch>(key: K, value: Branch[K]) => setBranch({ ...branch, [key]: value });
  return (
    <>
      <div><div className="page-kicker">Филиал</div><h1>Настройки</h1></div>
      <form className="panel list" onSubmit={async (event) => {
        event.preventDefault();
        try {
          const saved = await api<Branch>(`/api/branches/${branch.id}`, { method: "PATCH", body: JSON.stringify(branch) });
          setBranch(saved);
          toast("Сохранено");
        } catch (error) {
          toast((error as ApiError).message, "error");
        }
      }}>
        <div className="field"><label>Название</label><input value={branch.name} onChange={(event) => set("name", event.target.value)} /></div>
        <div className="field"><label>Адрес</label><input value={branch.address} onChange={(event) => set("address", event.target.value)} /></div>
        <div className="field"><label>Часовой пояс</label><input value={branch.timezone} onChange={(event) => set("timezone", event.target.value)} /></div>
        <label className="row"><input type="checkbox" checked={branch.requireOpenShift} onChange={(event) => set("requireOpenShift", event.target.checked)} /> Требовать открытую смену для оплаты</label>
        <label className="row"><input type="checkbox" checked={branch.masterSeesAllColumns} onChange={(event) => set("masterSeesAllColumns", event.target.checked)} /> Мастер видит все колонки</label>
        <label className="row"><input type="checkbox" checked={branch.masterCanCreateOwn} onChange={(event) => set("masterCanCreateOwn", event.target.checked)} /> Мастер создаёт свои записи</label>
        <label className="row"><input type="checkbox" checked={branch.masterCanDragOwn} onChange={(event) => set("masterCanDragOwn", event.target.checked)} /> Мастер перетаскивает свои записи</label>
        <label className="row"><input type="checkbox" checked={branch.requirePaymentOnComplete} onChange={(event) => set("requirePaymentOnComplete", event.target.checked)} /> Предлагать оплату при завершении</label>
        <div className="field"><label>Окно «пришёл», часы</label><input type="number" value={branch.arrivalWindowHours} onChange={(event) => set("arrivalWindowHours", Number(event.target.value))} /></div>
        <div className="field">
          <label>Допустимое расхождение при закрытии смены, ₽</label>
          <input type="number" min={0} step="0.01" value={branch.shiftVarianceThresholdMinor / 100} onChange={(event) => set("shiftVarianceThresholdMinor", Math.max(0, Math.round(Number(event.target.value) * 100)))} />
          <span className="muted" style={{ fontSize: 12 }}>Если расхождение больше — кассир обязан указать причину. 0 — причина нужна при любом расхождении.</span>
        </div>
        <div className="field"><label>Неявка после, минут</label><input type="number" value={branch.noShowGraceMin} onChange={(event) => set("noShowGraceMin", Number(event.target.value))} /></div>
        <button className="btn-gradient" type="submit">Сохранить</button>
      </form>
    </>
  );
}
