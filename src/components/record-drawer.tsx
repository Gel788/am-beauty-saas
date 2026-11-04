"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { formatPhone } from "@/domain/phone";
import { STATUS_LABEL, type AppointmentStatus } from "@/domain/status";
import { zonedDateTimeToUtc } from "@/domain/time";
import { api, type ApiError } from "./api";
import { PaymentRow, type PaymentItem } from "./payment-actions";
import { PayLinkBlock } from "./pay-link";
import { CustomInputs, type Field } from "./resources-fields-settings";
import { channelLabel } from "@/domain/channels";
import { Modal, useToast } from "./ui";

type Line = { serviceId: string; title: string; durationMin: number; priceMinor: number };
type CatalogService = { id: string; title: string; durationMin: number; priceMinor: number; color: string; active: boolean; staffIds: string[] };
type Staff = { id: string; displayName: string };
type ClientHit = { id: string; name: string; phones: { phone: string }[] };
type Loyalty = {
  program: { bonusEnabled: boolean; bonusBurnMaxBps: number };
  bonusBalance: number;
  tier?: { title: string; earnBps: number } | null;
  expiringSoon?: number;
  memberships: { id: string; title: string; visitsLeft: number; visitsTotal: number; validTo: string; serviceIds: string[]; usableNow: boolean }[];
};
const LOYALTY_METHODS = ["bonus", "certificate", "membership"];

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
  onRefresh,
}: {
  seed: DrawerSeed;
  branchId: string;
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
  /** Refresh the journal behind the drawer without closing it. */
  onRefresh?: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(Boolean(seed.id));
  const [version, setVersion] = useState(1);
  const [status, setStatus] = useState<AppointmentStatus>("scheduled");
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [noShows, setNoShows] = useState(0);
  const [alert, setAlert] = useState<string | null>(null);
  const [rebooked, setRebooked] = useState<string | null>(null);
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
  const [channel, setChannel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ledger, setLedger] = useState<PaymentItem[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [refundHint, setRefundHint] = useState(false);
  const [promo, setPromo] = useState<{ code: string; discountMinor: number } | null>(null);
  const [promoCode, setPromoCode] = useState("");
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [certCode, setCertCode] = useState("");
  const [membershipId, setMembershipId] = useState("");
  const [goods, setGoods] = useState<{ id: string; title: string; sellPriceMinor: number; qty: number; trackStock: boolean }[]>([]);
  const [cart, setCart] = useState<{ itemId: string; title: string; priceMinor: number; qty: number }[]>([]);
  const [pickItem, setPickItem] = useState("");
  const [pickQty, setPickQty] = useState("1");
  const [externalReceipts, setExternalReceipts] = useState(false);
  const [receiptNo, setReceiptNo] = useState("");
  const [terminalRef, setTerminalRef] = useState("");
  // RES-LINK-01: rooms/devices held by the visit, options for the chosen services, and the desk's override.
  const [heldResources, setHeldResources] = useState<{ id: string; title: string; kind: string }[]>([]);
  const [resourceOptions, setResourceOptions] = useState<{ id: string; title: string; kind: string; free: boolean }[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  // CF-VAL-01: the salon's own visit fields.
  const [fields, setFields] = useState<Field[]>([]);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const goodsMinor = cart.reduce((sum, line) => sum + Math.round(line.priceMinor * line.qty), 0);

  const mark = () => setDirty(true);
  const duration = lines.reduce((sum, line) => sum + line.durationMin, 0) || 30;
  const price = lines.reduce((sum, line) => sum + line.priceMinor, 0);

  useEffect(() => {
    // PAY-UPSELL-01 / PAY-EXT-01: goods for sale and how this branch prints receipts.
    api<{ id: string; title: string; sellPriceMinor: number; forSale: boolean; active: boolean; qty: number; trackStock: boolean }[]>(`/api/inventory/items?branchId=${branchId}`)
      .then((items) => setGoods(items.filter((item) => item.forSale && item.active)))
      .catch(() => setGoods([]));
    api<{ id: string; externalReceipts?: boolean }[]>("/api/branches")
      .then((rows) => setExternalReceipts(Boolean(rows.find((row) => row.id === branchId)?.externalReceipts)))
      .catch(() => undefined);
  }, [branchId]);

  useEffect(() => {
    api<{ services: CatalogService[] }>("/api/catalog").then((data) => setServices(data.services)).catch(() => undefined);
    api<Staff[]>("/api/staff").then(setStaff).catch(() => undefined);
    api<Field[]>("/api/fields?entity=appointment").then(setFields).catch(() => undefined);
  }, []);

  const serviceKey = lines.map((line) => line.serviceId).join(",");
  useEffect(() => {
    if (!serviceKey) {
      setResourceOptions([]);
      return;
    }
    const startsAt = zonedDateTimeToUtc(seed.date, startMin, timezone).toISOString();
    const query = new URLSearchParams({ branchId, serviceIds: serviceKey, startsAt, durationMin: String(duration), ...(seed.id ? { appointmentId: seed.id } : {}) });
    const timer = window.setTimeout(() => {
      api<{ id: string; title: string; kind: string; free: boolean }[]>(`/api/resources/options?${query.toString()}`).then(setResourceOptions).catch(() => setResourceOptions([]));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [serviceKey, startMin, duration, seed.date, seed.id, branchId, timezone]);

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
      clientNoShows: number;
      clientAlert: string | null;
      staffId: string;
      startsAt: string;
      comment: string;
      services: Line[];
      paidMinor: number;
      resources: { id: string; title: string; kind: string }[];
      custom: Record<string, unknown>;
      promo: { code: string; discountMinor: number } | null;
      source: string;
      channel: string | null;
      actions: { id: string; label: string; enabled: boolean; reason: string | null }[];
      history: { action: string; createdAt: string }[];
    }>(`/api/appointments/${seed.id}`).then((row) => {
      api<PaymentItem[]>(`/api/appointments/${seed.id}/payments`).then(setLedger).catch(() => setLedger([]));
      setVersion(row.version);
      setStatus(row.status);
      setClientId(row.clientId);
      setClientName(row.clientName ?? "");
      setNoShows(row.clientNoShows ?? 0);
      setAlert(row.clientAlert ?? null);
      setStaffId(row.staffId);
      const start = new Date(row.startsAt);
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start);
      const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
      const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
      setStartMin(hour * 60 + minute);
      setLines(row.services.map((line) => ({ serviceId: line.serviceId, title: line.title, durationMin: line.durationMin, priceMinor: line.priceMinor })));
      setComment(row.comment);
      setHeldResources(row.resources ?? []);
      setPicked({});
      setCustom(row.custom ?? {});
      setPaidMinor(row.paidMinor);
      setPromo(row.promo);
      setLoyalty(null);
      if (row.clientId) {
        api<Loyalty>(`/api/clients/${row.clientId}/loyalty?appointmentId=${seed.id}`).then(setLoyalty).catch(() => setLoyalty(null));
      }
      setActions(row.actions);
      setHistory(row.history);
      setSource(row.source);
      setChannel(row.channel ?? null);
      setPayRub(String(Math.max(0, row.services.reduce((sum, line) => sum + line.priceMinor, 0) - row.paidMinor) / 100));
      setLoading(false);
      setDirty(false);
    }).catch((error: ApiError) => toast(error.message, "error"));
  }, [seed.id, seed.staffId, seed.date, branchId, timezone, toast, reloadKey]);

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

  const paidOnline = useCallback(() => {
    setReloadKey((key) => key + 1);
    onRefresh?.();
  }, [onRefresh]);

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
        resourceIds: Object.values(picked).filter(Boolean),
        custom,
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
      } else if (err.code === "CONFLICT_RESOURCE") {
        toast(`${err.message}. Выберите другое время или кабинет`, "error");
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
      const updated = await api<{ version: number; status: AppointmentStatus; paymentSuggested?: boolean; stockWarnings?: { title: string; neededQty: number; availableQty: number }[] }>(`/api/appointments/${seed.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: next, version, acknowledgeSoft: true }),
      });
      setVersion(updated.version);
      setStatus(updated.status);
      if (updated.paymentSuggested) {
        setTab("pay");
        toast("Визит завершён. Можно принять оплату");
      } else toast(STATUS_LABEL[updated.status]);
      if (updated.stockWarnings?.length) {
        toast(`Материалы ушли в минус: ${updated.stockWarnings.map((w) => `${w.title} (нужно ${w.neededQty}, было ${w.availableQty})`).join(", ")}`, "error");
      }
      onSaved();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  /** REBOOK-01: same master, same services, same time N weeks later (or the nearest free time). */
  async function rebook(weeks: number) {
    if (!seed.id) return;
    setBusy(true);
    try {
      const result = await api<{ appointment: { startsAt: string }; exact: boolean }>(`/api/appointments/${seed.id}/rebook`, { method: "POST", body: JSON.stringify({ weeks }) });
      const when = new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(result.appointment.startsAt));
      setRebooked(when);
      toast(result.exact ? `Записали: ${when}` : `То же время занято — записали на ${when}`);
      onRefresh?.();
    } catch (error) {
      toast((error as ApiError).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancelVisit() {
    if (!seed.id) return;
    const reason = window.prompt("Причина отмены");
    if (!reason) return;
    try {
      const result = await api<{ version: number; refundSuggested?: boolean; waitlistMatches?: number }>(`/api/appointments/${seed.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ version, reason, confirm: true }),
      });
      toast(result.waitlistMatches ? `Запись отменена. Это время ждут ${result.waitlistMatches} из листа ожидания — см. «Удержание»` : "Запись отменена");
      if (result.refundSuggested) {
        // CASH §9: cancelling a prepaid visit offers PAY-REFUND right here.
        setStatus("cancelled");
        setVersion(result.version);
        setRefundHint(true);
        setTab("pay");
        setReloadKey((key) => key + 1);
        onRefresh?.();
      } else onSaved();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  const loyaltyPay = LOYALTY_METHODS.includes(payMethod);
  const usableMemberships = (loyalty?.memberships ?? []).filter((item) => item.usableNow && item.visitsLeft > 0);

  function pickMethod(next: string) {
    setPayMethod(next);
    const due = Math.max(0, price - paidMinor);
    if (next === "bonus" && loyalty) {
      const cap = Math.floor((price * loyalty.program.bonusBurnMaxBps) / 10000);
      setPayRub(String(Math.min(due, cap, loyalty.bonusBalance) / 100));
    } else if (next === "membership") {
      const first = usableMemberships[0];
      setMembershipId(first?.id ?? "");
      if (first) membershipAmount(first.id);
    } else setPayRub(String(due / 100));
    if (LOYALTY_METHODS.includes(next)) setTipRub("");
  }

  function membershipAmount(id: string) {
    // A membership visit pays for exactly one eligible service of this visit.
    const plan = loyalty?.memberships.find((item) => item.id === id);
    const line = lines.find((item) => !plan?.serviceIds.length || plan.serviceIds.includes(item.serviceId));
    if (line) setPayRub(String(line.priceMinor / 100));
  }

  async function promoAction(apply: boolean) {
    if (!seed.id) return;
    try {
      if (apply) {
        const result = await api<{ code: string; discountMinor: number }>(`/api/appointments/${seed.id}/promo`, { method: "POST", body: JSON.stringify({ code: promoCode }) });
        toast(`Скидка ${formatMoney(result.discountMinor)} по промокоду ${result.code}`);
        setPromoCode("");
      } else {
        await api(`/api/appointments/${seed.id}/promo`, { method: "DELETE" });
        toast("Промокод снят, цены вернулись");
      }
      setReloadKey((key) => key + 1);
      onRefresh?.();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  async function takePayment() {
    if (!seed.id) return;
    const tip = loyaltyPay ? 0 : rublesToMinor(Number(tipRub || 0));
    const serviceMinor = rublesToMinor(Number(payRub || 0));
    const extra = loyaltyPay ? 0 : goodsMinor;
    const tender: Record<string, unknown> = { method: payMethod, amountMinor: serviceMinor + tip + extra };
    if (payMethod === "certificate") tender.certificateCode = certCode;
    if (payMethod === "membership") tender.membershipId = membershipId;
    try {
      await api("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          appointmentId: seed.id,
          version,
          tipMinor: tip,
          tenders: [tender],
          ...(extra > 0 ? { amountMinor: serviceMinor, items: cart.map((line) => ({ itemId: line.itemId, qty: line.qty })) } : {}),
          ...(externalReceipts ? { receiptNo, terminalRef } : {}),
        }),
      });
      setCart([]);
      setReceiptNo("");
      setTerminalRef("");
      toast(extra > 0 ? "Оплата проведена, товары списаны со склада" : "Оплата проведена");
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
            <div className="page-kicker">{seed.id ? STATUS_LABEL[status] : "Новая запись"} {source === "online" ? `· онлайн${channel ? `, ${channelLabel(channel)}` : ""}` : ""}</div>
            <h2 className="display" style={{ fontSize: 26 }}>{clientName || "Запись"}</h2>
            {seed.id && noShows > 0 && <span className="tag noshow-flag" title="За последний год">неявок: {noShows}</span>}
            {seed.id && alert && <div className="health-alert">⚠ {alert}</div>}
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
              <input
                inputMode="numeric"
                aria-label="Начало"
                value={`${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`}
                onChange={(event) => {
                  const match = event.target.value.match(/^(\d{1,2}):(\d{2})$/);
                  if (!match) return;
                  const hours = Number(match[1]);
                  const minutes = Number(match[2]);
                  if (hours > 23 || minutes > 59) return;
                  setStartMin(hours * 60 + minutes);
                  mark();
                }}
              />
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
            {resourceOptions.length > 0 && (
              <div className="field">
                <label>Кабинет и оборудование</label>
                <div className="form-grid">
                  {[...new Set(resourceOptions.map((option) => option.kind))].map((kind) => {
                    const held = heldResources.find((row) => row.kind === kind);
                    return (
                      <select key={kind} aria-label="Кабинет" value={picked[kind] ?? ""} onChange={(event) => { setPicked({ ...picked, [kind]: event.target.value }); mark(); }}>
                        <option value="">{held ? `${held.title} (сейчас)` : "Подобрать свободный"}</option>
                        {resourceOptions.filter((option) => option.kind === kind).map((option) => (
                          <option key={option.id} value={option.id} disabled={!option.free && option.id !== held?.id}>{option.title}{option.free ? "" : " — занят"}</option>
                        ))}
                      </select>
                    );
                  })}
                </div>
              </div>
            )}
            <CustomInputs fields={fields} values={custom} onChange={(next) => { setCustom(next); mark(); }} />
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
            {seed.id && clientId && ["arrived", "in_progress", "completed"].includes(status) && (
              <div className="rebook-box">
                <b>{rebooked ? `Записали на ${rebooked}` : "Записать снова к этому мастеру"}</b>
                {!rebooked && [2, 3, 4, 6].map((weeks) => (
                  <button key={weeks} type="button" className="chip" disabled={busy} onClick={() => rebook(weeks)}>через {weeks} нед.</button>
                ))}
              </div>
            )}
            <button className="btn-gradient" type="button" disabled={busy || (typeof navigator !== "undefined" && !navigator.onLine)} onClick={() => save()}>Сохранить</button>
          </div>
        ) : tab === "pay" ? (
          <div className="list">
            {refundHint && ledger.some((item) => item.canRefund) && (
              <div className="banner">Запись отменена, но по ней есть оплата. Оформите возврат ниже.</div>
            )}
            {paidMinor > price && status !== "cancelled" && (
              <div className="banner">Оплачено больше стоимости на {formatMoney(paidMinor - price)}. Верните разницу.</div>
            )}
            {status !== "cancelled" && (
              <>
                <div className="stat-pill"><span>К оплате</span><b>{formatMoney(Math.max(0, price - paidMinor))}</b></div>
                <div className="muted">Оплачено {formatMoney(paidMinor)} из {formatMoney(price)}</div>
                {promo ? (
                  <div className="spread chip">
                    <span>Промокод <b>{promo.code}</b>: скидка {formatMoney(promo.discountMinor)}</span>
                    {paidMinor === 0 && <button className="btn-ghost" type="button" onClick={() => promoAction(false)}>Снять</button>}
                  </div>
                ) : (
                  paidMinor === 0 && (
                    <div className="row">
                      <input placeholder="Промокод" value={promoCode} onChange={(event) => setPromoCode(event.target.value.toUpperCase())} style={{ flex: 1 }} />
                      <button className="btn" type="button" disabled={!promoCode.trim()} onClick={() => promoAction(true)}>Применить</button>
                    </div>
                  )
                )}
                {loyalty && (loyalty.program.bonusEnabled || loyalty.memberships.length > 0) && (
                  <div className="chips">
                    {loyalty.program.bonusEnabled && <span className="chip">Баллы: {formatMoney(loyalty.bonusBalance)}</span>}
                    {loyalty.tier && <span className="chip">{loyalty.tier.title} · {loyalty.tier.earnBps / 100}%</span>}
                    {!!loyalty.expiringSoon && <span className="chip chip-warn">Сгорит за 2 недели: {formatMoney(loyalty.expiringSoon)}</span>}
                    {usableMemberships.map((item) => (
                      <span key={item.id} className="chip">{item.title}: {item.visitsLeft} из {item.visitsTotal}</span>
                    ))}
                  </div>
                )}
                <div className="field">
                  <label>Способ</label>
                  <select value={payMethod} onChange={(event) => pickMethod(event.target.value)}>
                    <option value="card">Карта</option>
                    <option value="cash">Наличные</option>
                    <option value="sbp">СБП</option>
                    <option value="transfer">Перевод</option>
                    {loyalty?.program.bonusEnabled && loyalty.bonusBalance > 0 && <option value="bonus">Бонусы</option>}
                    <option value="certificate">Сертификат</option>
                    {usableMemberships.length > 0 && <option value="membership">Абонемент</option>}
                  </select>
                </div>
                {payMethod === "certificate" && (
                  <div className="field"><label>Код сертификата</label><input placeholder="XXXX-XXXX" value={certCode} onChange={(event) => setCertCode(event.target.value.toUpperCase())} /></div>
                )}
                {payMethod === "membership" && (
                  <div className="field">
                    <label>Абонемент</label>
                    <select value={membershipId} onChange={(event) => { setMembershipId(event.target.value); membershipAmount(event.target.value); }}>
                      {usableMemberships.map((item) => <option key={item.id} value={item.id}>{item.title} · осталось {item.visitsLeft}</option>)}
                    </select>
                  </div>
                )}
                <div className="field"><label>{cart.length ? "Сумма за услуги, ₽" : "Сумма, ₽"}</label><input value={payRub} readOnly={payMethod === "membership"} onChange={(event) => setPayRub(event.target.value)} /></div>
                {payMethod === "bonus" && loyalty && (
                  <small className="muted">Баллами можно оплатить до {formatMoney(Math.floor((price * loyalty.program.bonusBurnMaxBps) / 10000))} этого визита. Остаток доплатите вторым платежом.</small>
                )}
                {!loyaltyPay && goods.length > 0 && (
                  <div className="list upsell" style={{ gap: 6 }}>
                    <label className="muted" style={{ fontSize: 12 }}>Допродажа: товары клиенту</label>
                    <div className="row" style={{ gap: 6 }}>
                      <select value={pickItem} onChange={(event) => setPickItem(event.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Товар">
                        <option value="">Выберите товар</option>
                        {goods.map((item) => (
                          <option key={item.id} value={item.id}>{item.title} · {formatMoney(item.sellPriceMinor)}{item.trackStock ? ` · ост. ${item.qty}` : ""}</option>
                        ))}
                      </select>
                      <input aria-label="Количество" value={pickQty} onChange={(event) => setPickQty(event.target.value)} style={{ width: 56 }} />
                      <button
                        className="btn"
                        type="button"
                        disabled={!pickItem}
                        onClick={() => {
                          const item = goods.find((entry) => entry.id === pickItem);
                          const qty = Number(pickQty.replace(",", "."));
                          if (!item || !(qty > 0)) return;
                          setCart((rows) => {
                            const existing = rows.find((row) => row.itemId === item.id);
                            if (existing) return rows.map((row) => (row.itemId === item.id ? { ...row, qty: row.qty + qty } : row));
                            return [...rows, { itemId: item.id, title: item.title, priceMinor: item.sellPriceMinor, qty }];
                          });
                          setPickItem("");
                          setPickQty("1");
                        }}
                      >
                        Добавить
                      </button>
                    </div>
                    {cart.map((line) => (
                      <div key={line.itemId} className="spread chip">
                        <span>{line.title}{line.qty !== 1 ? ` × ${line.qty}` : ""}</span>
                        <span className="row" style={{ gap: 6 }}>
                          <b>{formatMoney(Math.round(line.priceMinor * line.qty))}</b>
                          <button className="btn-ghost" type="button" aria-label={`Убрать ${line.title}`} onClick={() => setCart((rows) => rows.filter((row) => row.itemId !== line.itemId))}>×</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {!loyaltyPay && <div className="field"><label>Чаевые, ₽</label><input value={tipRub} onChange={(event) => setTipRub(event.target.value)} /></div>}
                {externalReceipts && (
                  <div className="form-grid">
                    <div className="field"><label>Номер чека с кассы</label><input placeholder="необязательно" value={receiptNo} onChange={(event) => setReceiptNo(event.target.value)} /></div>
                    {(payMethod === "card" || payMethod === "sbp") && (
                      <div className="field"><label>Код операции терминала</label><input placeholder="RRN или код авторизации" value={terminalRef} onChange={(event) => setTerminalRef(event.target.value)} /></div>
                    )}
                  </div>
                )}
                {!loyaltyPay && (goodsMinor > 0 || rublesToMinor(Number(tipRub || 0)) > 0) && (
                  <div className="spread"><span className="muted">Итого с клиента</span><b>{formatMoney(rublesToMinor(Number(payRub || 0)) + goodsMinor + rublesToMinor(Number(tipRub || 0)))}</b></div>
                )}
                <button className="btn-gradient" type="button" disabled={!seed.id} onClick={takePayment}>
                  {externalReceipts && (payMethod === "card" || payMethod === "sbp") ? "Оплачено на терминале" : "Провести"}
                </button>
                {seed.id && <PayLinkBlock appointmentId={seed.id} dueMinor={Math.max(0, price - paidMinor)} onPaid={paidOnline} />}
              </>
            )}
            {ledger.length > 0 && (
              <div className="drawer-pay-list">
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Платежи по записи</div>
                {ledger.map((payment) => (
                  <PaymentRow
                    key={payment.id}
                    payment={payment}
                    compact
                    onChanged={() => {
                      setReloadKey((key) => key + 1);
                      onRefresh?.();
                    }}
                  />
                ))}
              </div>
            )}
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
