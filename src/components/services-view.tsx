"use client";

import { useEffect, useState } from "react";
import { formatMoney, rublesToMinor } from "@/domain/money";
import { api, type ApiError } from "./api";
import { useToast } from "./ui";

type Service = { id: string; title: string; durationMin: number; priceMinor: number; color: string; active: boolean; staffIds: string[]; categoryId: string | null; rebookDays: number | null; onlineDepositMinor: number | null };
type Staff = { id: string; displayName: string };
type Category = { id: string; title: string };

export function ServicesView() {
  const toast = useToast();
  const [services, setServices] = useState<Service[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [form, setForm] = useState({ title: "", durationMin: 60, price: 1500, color: "#f8d0e4", categoryId: "", staffIds: [] as string[] });

  async function load() {
    const catalog = await api<{ services: Service[]; categories: Category[] }>("/api/catalog");
    setServices(catalog.services);
    setCategories(catalog.categories);
    setStaff(await api<Staff[]>("/api/staff"));
  }
  useEffect(() => { void load().catch((error: ApiError) => toast(error.message, "error")); }, [toast]);

  return (
    <>
      <div>
        <div className="page-kicker">Прайс</div>
        <h1>Услуги</h1>
      </div>
      <form
        className="panel list"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api("/api/services", {
              method: "POST",
              body: JSON.stringify({
                title: form.title,
                durationMin: Number(form.durationMin),
                priceMinor: rublesToMinor(Number(form.price)),
                color: form.color,
                categoryId: form.categoryId || null,
                staffIds: form.staffIds,
              }),
            });
            toast("Услуга добавлена");
            setForm({ ...form, title: "" });
            await load();
          } catch (error) {
            toast((error as ApiError).message, "error");
          }
        }}
      >
        <div className="row">
          <div className="field" style={{ flex: 2 }}><label>Название</label><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required /></div>
          <div className="field"><label>Минуты</label><input type="number" step={5} min={5} value={form.durationMin} onChange={(event) => setForm({ ...form, durationMin: Number(event.target.value) })} /></div>
          <div className="field"><label>Цена, ₽</label><input type="number" min={0} value={form.price} onChange={(event) => setForm({ ...form, price: Number(event.target.value) })} /></div>
          <div className="field"><label>Цвет</label><input type="color" value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} /></div>
        </div>
        <div className="chips">
          {staff.map((person) => (
            <button
              key={person.id}
              type="button"
              className="chip"
              onClick={() => setForm({ ...form, staffIds: form.staffIds.includes(person.id) ? form.staffIds.filter((id) => id !== person.id) : [...form.staffIds, person.id] })}
              style={{ outline: form.staffIds.includes(person.id) ? "2px solid #7c5cff" : undefined }}
            >
              {person.displayName}
            </button>
          ))}
        </div>
        <button className="btn-gradient" type="submit">Добавить услугу</button>
      </form>
      <div className="list">
        {services.map((service, index) => (
          <div key={service.id} className="person">
            <div className="avatar" style={{ background: service.color, color: "#24182f" }} />
            <div style={{ flex: 1 }}>
              <strong>{service.title}{!service.active ? " · скрыта" : ""}</strong>
              <span>{service.durationMin} мин · {formatMoney(service.priceMinor)} · мастеров {service.staffIds.length}</span>
            </div>
            <select
              className="rebook-select"
              title="Через сколько дней позвать клиента снова"
              value={service.rebookDays ?? ""}
              onChange={async (event) => {
                await api(`/api/services/${service.id}`, { method: "PATCH", body: JSON.stringify({ rebookDays: event.target.value ? Number(event.target.value) : null }) });
                await load();
              }}
            >
              <option value="">Без повтора</option>
              {[14, 21, 28, 35, 42, 60, 90].map((days) => <option key={days} value={days}>Повтор через {days} дн.</option>)}
            </select>
            <input
              className="deposit-input"
              type="number"
              min={0}
              placeholder="Предоплата ₽"
              title="Предоплата при онлайн-записи. Пусто — как в настройках филиала, 0 — без предоплаты"
              defaultValue={service.onlineDepositMinor === null ? "" : service.onlineDepositMinor / 100}
              onBlur={async (event) => {
                const value = event.target.value.trim();
                const next = value === "" ? null : Math.round(Number(value) * 100);
                if (next === service.onlineDepositMinor) return;
                await api(`/api/services/${service.id}`, { method: "PATCH", body: JSON.stringify({ onlineDepositMinor: next }) });
                await load();
              }}
            />
            <button className="btn-ghost" type="button" disabled={index === 0} onClick={async () => {
              const ids = services.map((item) => item.id);
              [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
              await api("/api/services/reorder", { method: "POST", body: JSON.stringify({ ids }) });
              await load();
            }}>Выше</button>
            <button className="btn" type="button" onClick={async () => { await api(`/api/services/${service.id}/deactivate`, { method: "POST", body: "{}" }); await load(); }}>Скрыть</button>
          </div>
        ))}
        {categories.length === 0 && <p className="muted">Категории можно не заводить: услуги живут и общим списком.</p>}
      </div>
    </>
  );
}
