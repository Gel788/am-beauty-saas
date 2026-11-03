"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { formatPhone } from "@/domain/phone";
import { STATUS_LABEL, type AppointmentStatus } from "@/domain/status";
import { zonedDateTimeToUtc } from "@/domain/time";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

type Line = { serviceId: string; title: string; durationMin: number; priceMinor: number };
type CatalogService = { id: string; title: string; durationMin: number; priceMinor: number; color: string; active: boolean; staffIds: string[] };
type Staff = { id: string; displayName: string };
type ClientHit = { id: string; name: string; phones: { phone: string }[] };

export type DrawerSeed = {
  id?: string;
  staffId: string;
  startMin: number;
  date: string;
};

export function RecordDrawer({
  seed,
  branchId,
  timezone,
  onClose,
  onSaved,
}: {
  seed: DrawerSeed;
  branchId: string;
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(Boolean(seed.id));
  const [version, setVersion] = useState(1);
  const [status, setStatus] = useState<AppointmentStatus>("scheduled");
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ClientHit[]>([]);
  const [creatingClient, setCreatingClient] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [staffId, setStaffId] = useState(seed.staffId);
  const [startMin, setStartMin] = useState(seed.startMin);
  const [lines, setLines] = useState<Line[]>([]);
  const [comment, setComment] = useState("");
  const [services, setServices] = useState<CatalogService[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [prev, setPrev] = useState<{ id: string; name: string } | null>(null);
  const [history, setHistory] = useState<{ action: string; createdAt: string }[]>([]);
  const [tab, setTab] = useState<"card" | "history" | "pay">("card");
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [paidMinor, setPaidMinor] = useState(0);
  const [actions, setActions] = useState<{ id: string; label: string; enabled: boolean; reason: string | null }[]>([]);
  const [payRub, setPayRub] = useState("");
  const [payMethod, setPayMethod] = useState("card");
  const [tipRub, setTipRub] = useState("");
  const [source, setSource] = useState("admin");
  const [busy, setBusy] = useState(false);

  const mark = () => setDirty(true);
  const duration = lines.reduce((sum, line) => sum + line.durationMin, 0) || 30;
  const price = lines.reduce((sum, line) => sum + line.priceMinor, 0);

  useEffect(() => {
    api<{ services: CatalogService[] }>("/api/catalog").then((data) => setServices(data.services)).catch(() => undefined);
    api<Staff[]>("/api/staff").then(setStaff).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!seed.id) {
      api<{ id: string; name: string } | null>(`/api/prev-client?branchId=${branchId}&staffId=${seed.staffId}&date=${seed.date}`)
        .then(setPrev)
        .catch(() => undefined);
      return;
    }
    api<{
      version: number;
      status: AppointmentStatus;
      clientId: string | null;
      clientName: string | null;
      staffId: string;
      startsAt: string;
      comment: string;
      services: Line[];
      paidMinor: number;
      source: string;
      actions: { id: string; label: string; enabled: boolean; reason: string | null }[];
      history: { action: string; createdAt: string }[];
    }>(`/api/appointments/${seed.id}`).then((row) => {
      setVersion(row.version);
      setStatus(row.status);
      setClientId(row.clientId);
      setClientName(row.clientName ?? "");
      setStaffId(row.staffId);
      const start = new Date(row.startsAt);
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start);
      const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
      const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
      setStartMin(hour * 60 + minute);
      setLines(row.services.map((line) => ({ serviceId: line.serviceId, title: line.title, durationMin: line.durationMin, priceMinor: line.priceMinor })));
      setComment(row.comment);
      setPaidMinor(row.paidMinor);
      setActions(row.actions);
      setHistory(row.history);
      setSource(row.source);
      setPayRub(String(Math.max(0, row.services.reduce((sum, line) => sum + line.priceMinor, 0) - row.paidMinor) / 100));
      setLoading(false);
      setDirty(false);
    }).catch((error: ApiError) => toast(error.message, "error"));
  }, [seed.id, seed.staffId, seed.date, branchId, timezone, toast]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api<ClientHit[]>(`/api/clients?q=${encodeURIComponent(query)}`).then(setHits).catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const available = useMemo(
    () => services.filter((service) => service.active && service.staffIds.includes(staffId)),
    [services, staffId],
  );

  function askClose() {
    if (dirty) setConfirmClose(true);
    else onClose();
  }

  async function save(extra: Record<string, unknown> = {}) {
    if (!navigator.onLine) {
      toast("Нет сети, сохранение заблокировано", "error");
      return;
    }
    setBusy(true);
    try {
      const startsAt = zonedDateTimeToUtc(seed.date, startMin, timezone).toISOString();
      const payload = {
        branchId,
        staffId,
        startsAt,
        services: lines.map((line) => ({ serviceId: line.serviceId, durationMin: line.durationMin })),
        comment,
        acknowledgeSoft: false,
        ...extra,
      };
      if (seed.id) {
        await api(`/api/appointments/${seed.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...payload, version, clientId }),
        });
      } else if (creatingClient) {
        await api("/api/appointments", {
          method: "POST",
          body: JSON.stringify({ ...payload, clientId: null, newClient: { name: newName, phone: newPhone } }),
        });
      } else {
        await api("/api/appointments", { method: "POST", body: JSON.stringify({ ...payload, clientId }) });
      }
      toast("Запись сохранена");
      onSaved();
    } catch (error) {
      const err = error as ApiError;
      if (err.code === "SOFT_CONFIRM") {
        setConfirmClose(false);
        const ok = window.confirm(`${err.message}. Записать всё равно?`);
        if (ok) return save({ ...extra, acknowledgeSoft: true });
      } else if (err.code === "CONFLICT_SLOT") {
        const reason = window.prompt("Время пересекается. Причина, чтобы записать поверх (пусто — отмена)");
        if (reason) return save({ ...extra, forceOverlap: true, overlapReason: reason, acknowledgeSoft: true });
      } else if (err.code === "STALE") {
        toast("Запись изменена. Обновите карточку", "error");
      } else if (err.details?.existingClientId) {
        toast(`${err.message}: откройте существующего клиента`, "error");
        setClientId(String(err.details.existingClientId));
        setCreatingClient(false);
      } else toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function setVisitStatus(next: string) {
    if (!seed.id) return;
    try {
      const updated = await api<{ version: number; status: AppointmentStatus; paymentSuggested?: boolean }>(`/api/appointments/${seed.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: next, version, acknowledgeSoft: true }),
      });
      setVersion(updated.version);
      setStatus(updated.status);
      if (updated.paymentSuggested) {
        setTab("pay");
        toast("Визит завершён. Можно принять оплату");
      } else toast(STATUS_LABEL[updated.status]);
      onSaved();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  async function cancelVisit() {
    if (!seed.id) return;
    const reason = window.prompt("Причина отмены");
    if (!reason) return;
    try {
      await api(`/api/appointments/${seed.id}/cancel`, { method: "POST", body: JSON.stringify({ version, reason, confirm: true }) });
      toast("Запись отменена");
      onSaved();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  async function takePayment() {
    if (!seed.id) return;
    try {
      await api("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          appointmentId: seed.id,
          version,
          tipMinor: rublesToMinor(Number(tipRub || 0)),
          tenders: [{ method: payMethod, amountMinor: rublesToMinor(Number(payRub || 0)) + rublesToMinor(Number(tipRub || 0)) }],
        }),
      });
      toast("Оплата проведена");
      onSaved();
    } catch (error) {
      const err = error as ApiError;
      if (err.code === "SHIFT_REQUIRED") {
        const cash = window.prompt("Смена не открыта. Сумма наличных в кассе, ₽", "0");
        if (cash == null) return;
        await api("/api/shifts/open", { method: "POST", body: JSON.stringify({ branchId, openingCashMinor: rublesToMinor(Number(cash)) }) });
        return takePayment();
      }
      toast(err.message, "error");
    }
  }

  return (
    <div className="drawer-backdrop" onMouseDown={askClose}>
      <aside className="drawer" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-label="Запись">
        <div className="spread">
          <div>
            <div className="page-kicker">{seed.id ? STATUS_LABEL[status] : "Новая запись"} {source === "online" ? "· онлайн" : ""}</div>
            <h2 className="display" style={{ fontSize: 26 }}>{clientName || "Запись"}</h2>
          </div>
          <button className="icon-btn" onClick={askClose} aria-label="Закрыть">×</button>
        </div>
        <div className="segment" style={{ margin: "12px 0" }}>
          <button className={tab === "card" ? "on" : ""} onClick={() => setTab("card")} type="button">Карточка</button>
          <button className={tab === "pay" ? "on" : ""} onClick={() => setTab("pay")} type="button">Оплата</button>
          <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")} type="button">История</button>
        </div>
        {loading ? <div className="skeleton" /> : tab === "card" ? (
          <div className="list">
            {!seed.id && prev && (
              <button className="chip" type="button" onClick={() => { setClientId(prev.id); setClientName(prev.name); mark(); }}>
                Как в прошлый раз: {prev.name}
              </button>
            )}
            <div className="field">
              <label>Клиент</label>
              <input value={query} placeholder={clientName || "Имя или телефон"} onChange={(event) => { setQuery(event.target.value); mark(); }} />
            </div>
            {hits.length > 0 && (
              <div className="list">
                {hits.map((hit) => (
                  <button key={hit.id} className="person" type="button" onClick={() => { setClientId(hit.id); setClientName(hit.name); setQuery(""); setHits([]); setCreatingClient(false); mark(); }}>
                    <div><strong>{hit.name}</strong><span>{hit.phones[0] ? formatPhone(hit.phones[0].phone) : ""}</span></div>
                  </button>
                ))}
              </div>
            )}
            <button className="btn-ghost" type="button" onClick={() => { setCreatingClient((value) => !value); mark(); }}>Новый клиент</button>
            {creatingClient && (
              <>
                <div className="field"><label>Имя</label><input value={newName} onChange={(event) => { setNewName(event.target.value); mark(); }} /></div>
                <div className="field"><label>Телефон</label><input value={newPhone} onChange={(event) => { setNewPhone(event.target.value); mark(); }} placeholder="+7 900 000-00-00" /></div>
              </>
            )}
            <div className="field">
              <label>Мастер</label>
              <select value={staffId} onChange={(event) => { setStaffId(event.target.value); mark(); }}>
                {staff.filter((person) => person.id).map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Начало</label>
              <input type="time" value={`${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`} onChange={(event) => {
                const [h, m] = event.target.value.split(":").map(Number);
                setStartMin(h * 60 + m);
                mark();
              }} />
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Услуги · {duration} мин · {formatMoney(price)}</div>
              <div className="chips">
                {available.map((service) => (
                  <button key={service.id} className="chip" type="button" onClick={() => { setLines((current) => [...current, { serviceId: service.id, title: service.title, durationMin: service.durationMin, priceMinor: service.priceMinor }]); mark(); }}>
                    + {service.title}
                  </button>
                ))}
              </div>
              <div className="list" style={{ marginTop: 8 }}>
                {lines.map((line, index) => (
                  <div key={`${line.serviceId}-${index}`} className="spread person">
                    <div><strong>{line.title}</strong><span>{line.durationMin} мин · {formatMoney(line.priceMinor)}</span></div>
                    <button type="button" className="icon-btn" onClick={() => { setLines(lines.filter((_, i) => i !== index)); mark(); }} aria-label="Убрать услугу">×</button>
                  </div>
                ))}
              </div>
            </div>
            <div className="field"><label>Комментарий</label><textarea rows={3} value={comment} onChange={(event) => { setComment(event.target.value); mark(); }} /></div>
            {seed.id && (
              <div className="chips">
                {actions.filter((action) => action.id !== "cancelled").map((action) => (
                  <button key={action.id} className="chip" type="button" disabled={!action.enabled} title={action.reason ?? ""} onClick={() => setVisitStatus(action.id)}>
                    {action.label}
                  </button>
                ))}
                <button className="chip danger" type="button" onClick={cancelVisit}>Отменить</button>
              </div>
            )}
            <button className="btn-gradient" type="button" disabled={busy || (typeof navigator !== "undefined" && !navigator.onLine)} onClick={() => save()}>Сохранить</button>
          </div>
        ) : tab === "pay" ? (
          <div className="list">
            <div className="stat-pill"><span>К оплате</span><b>{formatMoney(Math.max(0, price - paidMinor))}</b></div>
            <div className="muted">Оплачено {formatMoney(paidMinor)} из {formatMoney(price)}</div>
            <div className="field"><label>Сумма, ₽</label><input value={payRub} onChange={(event) => setPayRub(event.target.value)} /></div>
            <div className="field"><label>Чаевые, ₽</label><input value={tipRub} onChange={(event) => setTipRub(event.target.value)} /></div>
            <div className="field">
              <label>Способ</label>
              <select value={payMethod} onChange={(event) => setPayMethod(event.target.value)}>
                <option value="card">Карта</option>
                <option value="cash">Наличные</option>
                <option value="sbp">СБП</option>
                <option value="transfer">Перевод</option>
              </select>
            </div>
            <button className="btn-gradient" type="button" disabled={!seed.id} onClick={takePayment}>Провести</button>
          </div>
        ) : (
          <div className="list">
            {history.length === 0 && <div className="empty">История появится после сохранения</div>}
            {history.map((item, index) => (
              <div key={index} className="person"><div><strong>{item.action}</strong><span>{new Date(item.createdAt).toLocaleString("ru-RU")}</span></div></div>
            ))}
          </div>
        )}
        {confirmClose && (
          <Modal title="Выйти без сохранения?" onClose={() => setConfirmClose(false)}>
            <p>Черновик не запишется.</p>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => setConfirmClose(false)}>Остаться</button>
              <button className="btn-gradient" type="button" onClick={onClose}>Выйти</button>
            </div>
          </Modal>
        )}
      </aside>
    </div>
  );
}
