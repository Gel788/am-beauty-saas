"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatMoney } from "@/domain/money";
import { formatPhone } from "@/domain/phone";
import { STATUS_LABEL, type AppointmentStatus } from "@/domain/status";
import { api, type ApiError } from "./api";
import { initials, useToast } from "./ui";
import { ClientComms } from "./client-comms";
import { TechCard } from "./tech-card";
import { CustomInputs, type Field } from "./resources-fields-settings";

type Client = {
  id: string;
  name: string;
  email: string | null;
  notes: string;
  balanceMinor: number;
  version: number;
  phones: { phone: string }[];
  tags: string[];
  visitCount?: number;
  lastVisitAt?: string | null;
  imported?: { visits: number; lastVisit: string | null; revenueMinor: number } | null;
  custom?: Record<string, unknown>;
};

export function ClientsView() {
  const toast = useToast();
  const cardRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);
  const [history, setHistory] = useState<{ visits: { id: string; startsAt: string; status: AppointmentStatus; titles: string[]; branchName: string; priceMinor: number }[]; payments: { id: string; totalMinor: number; status: string }[] } | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", notes: "" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  // CF-*: the salon's client fields, values on the open card, and the list filter.
  const [fields, setFields] = useState<Field[]>([]);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [filter, setFilter] = useState<{ field: string; value: string }>({ field: "", value: "" });
  useEffect(() => {
    api<Field[]>("/api/fields?entity=client").then(setFields).catch(() => undefined);
  }, []);
  const filterField = fields.find((field) => field.key === filter.field);

  async function load(q = query) {
    try {
      const params = new URLSearchParams();
      if (q.trim().length >= 2) params.set("q", q);
      if (filter.field && filter.value) {
        params.set("field", filter.field);
        params.set("value", filter.value);
      }
      setClients(await api<Client[]>(`/api/clients${params.toString() ? `?${params.toString()}` : ""}`));
      setError("");
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), query ? 200 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filter]);

  // MOBILE-01: on a phone the card sits under the list, so bring it into view.
  function reveal() {
    if (window.matchMedia("(max-width: 980px)").matches) window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function open(client: Client) {
    const full = await api<Client>(`/api/clients/${client.id}`);
    setSelected(full);
    reveal();
    setForm({ name: full.name, phone: full.phones[0]?.phone ?? "", email: full.email ?? "", notes: full.notes });
    setCustom(full.custom ?? {});
    setHistory(await api(`/api/clients/${client.id}/history`));
  }

  return (
    <>
      <div className="spread">
        <div>
          <div className="page-kicker">База салона</div>
          <h1>Клиенты</h1>
        </div>
        <div className="row">
          <div className="search"><input value={query} placeholder="Имя, телефон или почта" aria-label="Поиск клиентов" onChange={(event) => setQuery(event.target.value)} /></div>
          {fields.some((field) => field.type === "select" || field.type === "multiselect" || field.type === "bool") && (
            <div className="row" style={{ gap: 6 }}>
              <select aria-label="Фильтр по полю" value={filter.field} onChange={(event) => setFilter({ field: event.target.value, value: "" })}>
                <option value="">Все клиенты</option>
                {fields.filter((field) => field.type === "select" || field.type === "multiselect" || field.type === "bool").map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
              </select>
              {filterField && (
                <select aria-label="Значение" value={filter.value} onChange={(event) => setFilter({ ...filter, value: event.target.value })}>
                  <option value="">—</option>
                  {(filterField.type === "bool" ? ["true"] : filterField.options).map((option) => <option key={option} value={option}>{option === "true" ? "да" : option}</option>)}
                </select>
              )}
            </div>
          )}
          <Link className="btn" href="/clients/import">Импорт</Link>
          <Link className="btn" href="/clients/duplicates">Дубли</Link>
          <button className="btn-gradient" onClick={() => { setCreating(true); setSelected(null); reveal(); setCustom({}); setForm({ name: "", phone: "", email: "", notes: "" }); }}>Новый клиент</button>
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {query.trim().length === 1 && <div className="muted">Введите минимум 2 символа</div>}
      <div className="split">
        <div className="list">
          {clients.length === 0 && <div className="panel empty">Никого не нашли. Создайте карточку или измените запрос.</div>}
          {clients.map((client) => (
            <button key={client.id} className="person" onClick={() => open(client)}>
              <div className="avatar">{initials(client.name)}</div>
              <div style={{ flex: 1 }}>
                <strong>{client.name}</strong>
                <span>{client.phones[0] ? formatPhone(client.phones[0].phone) : "без телефона"} · визитов {(client.visitCount ?? 0) + (client.imported?.visits ?? 0)}</span>
              </div>
              {client.balanceMinor > 0 && <span className="badge">{formatMoney(client.balanceMinor)}</span>}
            </button>
          ))}
        </div>
        <div className="panel" ref={cardRef}>
          {!selected && !creating && <div className="empty">Выберите клиента, чтобы увидеть историю и долг.</div>}
          {(selected || creating) && (
            <form
              className="list"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  if (creating) {
                    const created = await api<Client>("/api/clients", { method: "POST", body: JSON.stringify({ ...form, custom }) });
                    toast("Клиент создан");
                    setCreating(false);
                    await load();
                    await open(created);
                  } else if (selected) {
                    const updated = await api<Client>(`/api/clients/${selected.id}`, { method: "PATCH", body: JSON.stringify({ ...form, custom, version: selected.version }) });
                    toast("Сохранено");
                    setSelected(updated);
                    await load();
                  }
                } catch (err) {
                  const error = err as ApiError;
                  toast(error.details?.existingClientName ? `${error.message}: ${String(error.details.existingClientName)}` : error.message, "error");
                }
              }}
            >
              <h2 className="display" style={{ fontSize: 26 }}>{creating ? "Новый клиент" : selected?.name}</h2>
              {selected && selected.balanceMinor > 0 && <div className="banner">Долг {formatMoney(selected.balanceMinor)}. Погашение — в кассе, оплата типа «долг».</div>}
              <div className="field"><label>Имя</label><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></div>
              <div className="field"><label>Телефон</label><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} required /></div>
              <div className="field"><label>Почта</label><input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></div>
              <div className="field"><label>Заметки</label><textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></div>
              <CustomInputs fields={fields} values={custom} onChange={setCustom} />
              <div className="row">
                <button className="btn-gradient" type="submit">Сохранить</button>
                {selected && (
                  <button
                    className="btn"
                    type="button"
                    onClick={async () => {
                      try {
                        await api(`/api/clients/${selected.id}/delete`, { method: "POST", body: JSON.stringify({}) });
                        toast("Клиент скрыт");
                        setSelected(null);
                        await load();
                      } catch (err) {
                        const error = err as ApiError;
                        if (error.details?.futureCount) {
                          const cancel = window.confirm(`Есть будущие записи: ${error.details.futureCount}. Отменить их? Иначе они останутся.`);
                          await api(`/api/clients/${selected.id}/delete`, { method: "POST", body: JSON.stringify({ decision: cancel ? "cancel_future" : "keep_future" }) });
                          toast("Клиент скрыт");
                          setSelected(null);
                          await load();
                        } else toast(error.message, "error");
                      }
                    }}
                  >
                    Удалить
                  </button>
                )}
              </div>
              {history && (
                <div>
                  <h3>История</h3>
                  {selected?.imported && (
                    <p className="muted" style={{ fontSize: 13 }}>
                      До переезда: {selected.imported.visits} визитов{selected.imported.lastVisit ? `, последний ${new Date(selected.imported.lastVisit).toLocaleDateString("ru-RU")}` : ""}{selected.imported.revenueMinor ? `, на ${formatMoney(selected.imported.revenueMinor)}` : ""}
                    </p>
                  )}
                  {history.visits.length === 0 && <p className="muted">Визитов пока нет</p>}
                  {history.visits.map((visit) => (
                    <div key={visit.id} className="person" style={{ marginBottom: 8 }}>
                      <div>
                        <strong>{visit.titles.join(", ") || "Визит"}</strong>
                        <span>{new Date(visit.startsAt).toLocaleString("ru-RU")} · {visit.branchName} · {STATUS_LABEL[visit.status]} · {formatMoney(visit.priceMinor)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </form>
          )}
          {selected && !creating && <TechCard clientId={selected.id} />}
          {selected && !creating && <ClientComms clientId={selected.id} />}
        </div>
      </div>
    </>
  );
}
