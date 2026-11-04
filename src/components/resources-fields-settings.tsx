"use client";

import { useEffect, useState } from "react";
import { api, type ApiError } from "./api";
import { Modal, useToast } from "./ui";

export type Resource = { id: string; branchId: string; kind: "room" | "equipment" | "other"; title: string; color: string; capacity: number; openMin: number | null; closeMin: number | null; active: boolean; serviceIds: string[] };
type Service = { id: string; title: string; active: boolean };
export const RESOURCE_KIND: Record<Resource["kind"], string> = { room: "Кабинет", equipment: "Аппарат", other: "Другое" };
const hhmm = (minutes: number | null) => (minutes === null ? "" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
const toMin = (value: string) => (value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : null);

/** RES-CRUD-01 / RES-LINK-01: rooms and devices of the branch and the services that need them. */
export function ResourcesSettings({ branchId }: { branchId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<Resource[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [editing, setEditing] = useState<(Partial<Resource> & { open?: string; close?: string }) | null>(null);

  async function load() {
    setItems(await api<Resource[]>(`/api/resources?branchId=${branchId}&all=1`));
    setServices((await api<{ services: Service[] }>("/api/catalog")).services.filter((service) => service.active));
  }
  useEffect(() => {
    void load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function save() {
    if (!editing) return;
    try {
      const body = { branchId, kind: editing.kind, title: editing.title, color: editing.color, capacity: editing.capacity, openMin: toMin(editing.open ?? ""), closeMin: toMin(editing.close ?? ""), active: editing.active, serviceIds: editing.serviceIds };
      await api(editing.id ? `/api/resources/${editing.id}` : "/api/resources", { method: editing.id ? "PATCH" : "POST", body: JSON.stringify(body) });
      setEditing(null);
      toast("Сохранено");
      await load();
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }

  return (
    <div className="panel list">
      <div className="spread">
        <div>
          <h2 style={{ margin: 0 }}>Кабинеты и аппараты</h2>
          <span className="muted" style={{ fontSize: 13 }}>Если услуге нужен кабинет или аппарат, CRM сама подберёт свободный и не даст записать двоих в один кабинет.</span>
        </div>
        <button className="btn" onClick={() => setEditing({ kind: "room", capacity: 1, color: "#e9e2ff", active: true, serviceIds: [] })}>+ Добавить</button>
      </div>
      {items.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Пока нет. Добавьте кабинеты, если в салоне несколько мастеров делят комнаты или аппарат.</span>}
      <div className="resource-list">
        {items.map((item) => (
          <button key={item.id} className={`resource-row ${item.active ? "" : "off"}`} onClick={() => setEditing({ ...item, open: hhmm(item.openMin), close: hhmm(item.closeMin) })}>
            <i style={{ background: item.color }} />
            <div>
              <strong>{item.title}</strong>
              <span>
                {RESOURCE_KIND[item.kind]}
                {item.capacity > 1 ? ` · ${item.capacity} места` : ""}
                {item.openMin !== null ? ` · ${hhmm(item.openMin)}–${hhmm(item.closeMin)}` : ""}
                {` · ${item.serviceIds.length ? `${item.serviceIds.length} услуг` : "услуги не выбраны"}`}
                {item.active ? "" : " · выключен"}
              </span>
            </div>
          </button>
        ))}
      </div>
      {editing && (
        <Modal title={editing.id ? editing.title ?? "Ресурс" : "Новый ресурс"} onClose={() => setEditing(null)}>
          <div className="list">
            <div className="form-grid">
              <div className="field"><label>Название</label><input value={editing.title ?? ""} placeholder="Кабинет 1, Лазер Candela…" onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></div>
              <div className="field">
                <label>Тип</label>
                <select value={editing.kind} onChange={(event) => setEditing({ ...editing, kind: event.target.value as Resource["kind"] })}>
                  {Object.entries(RESOURCE_KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div className="field"><label>Одновременно клиентов</label><input type="number" min={1} max={100} value={editing.capacity ?? 1} onChange={(event) => setEditing({ ...editing, capacity: Number(event.target.value) })} /></div>
              <div className="field"><label>Цвет</label><input type="color" value={editing.color ?? "#e9e2ff"} onChange={(event) => setEditing({ ...editing, color: event.target.value })} /></div>
              <div className="field"><label>Доступен с</label><input type="time" value={editing.open ?? ""} onChange={(event) => setEditing({ ...editing, open: event.target.value })} /></div>
              <div className="field"><label>до</label><input type="time" value={editing.close ?? ""} onChange={(event) => setEditing({ ...editing, close: event.target.value })} /></div>
            </div>
            <div className="field">
              <label>Нужен для услуг</label>
              <span className="muted" style={{ fontSize: 12 }}>Если у услуги несколько кабинетов, подойдёт любой свободный. Кабинет и аппарат нужны оба.</span>
              <div className="chip-pick">
                {services.map((service) => {
                  const on = editing.serviceIds?.includes(service.id);
                  return (
                    <button key={service.id} type="button" className={`chip ${on ? "on" : ""}`} onClick={() => setEditing({ ...editing, serviceIds: on ? editing.serviceIds!.filter((id) => id !== service.id) : [...(editing.serviceIds ?? []), service.id] })}>
                      {service.title}
                    </button>
                  );
                })}
              </div>
            </div>
            {editing.id && <label className="row"><input type="checkbox" checked={editing.active ?? true} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} /> Работает (выключенный не назначается новым записям)</label>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn-gradient" onClick={save}>Сохранить</button>
              {editing.id && (
                <button className="btn-ghost" onClick={async () => {
                  try {
                    const result = await api<{ deleted: boolean }>(`/api/resources/${editing.id}`, { method: "DELETE" });
                    toast(result.deleted ? "Удалено" : "По нему были записи, поэтому он выключен");
                    setEditing(null);
                    await load();
                  } catch (error) {
                    toast((error as ApiError).message, "error");
                  }
                }}>Удалить</button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export type Field = { id: string; entity: "client" | "appointment"; key: string; label: string; type: string; options: string[]; required: boolean; showInOnline: boolean; showInJournal: boolean; active: boolean };
const TYPE_LABEL: Record<string, string> = { text: "Строка", textarea: "Текст", number: "Число", select: "Выбор одного", multiselect: "Выбор нескольких", date: "Дата", bool: "Да / нет" };

function slug(label: string) {
  const map: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ы: "y", э: "e", ю: "yu", я: "ya" };
  const text = label.toLowerCase().split("").map((char) => map[char] ?? char).join("").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  return /^[a-z]/.test(text) ? text : `f_${text}`;
}

/** CF-DEF-01: the salon's own fields on the client card and the visit. */
export function FieldsSettings() {
  const toast = useToast();
  const [fields, setFields] = useState<Field[]>([]);
  const [editing, setEditing] = useState<(Partial<Field> & { optionsText?: string }) | null>(null);
  useEffect(() => {
    api<Field[]>("/api/fields?all=1").then(setFields).catch(() => undefined);
  }, []);
  async function save() {
    if (!editing) return;
    try {
      const body = { ...editing, key: editing.id ? undefined : editing.key || slug(editing.label ?? ""), options: (editing.optionsText ?? "").split("\n").map((line) => line.trim()).filter(Boolean) };
      setFields(await api<Field[]>(editing.id ? `/api/fields/${editing.id}` : "/api/fields", { method: editing.id ? "PATCH" : "POST", body: JSON.stringify(body) }));
      setEditing(null);
      toast("Сохранено");
    } catch (error) {
      toast((error as ApiError).message, "error");
    }
  }
  const group = (entity: Field["entity"], title: string) => (
    <div className="list" style={{ gap: 6 }}>
      <div className="spread">
        <b style={{ fontSize: 14 }}>{title}</b>
        <button className="btn-ghost" onClick={() => setEditing({ entity, type: "text", active: true, optionsText: "" })}>+ Поле</button>
      </div>
      {fields.filter((field) => field.entity === entity).map((field) => (
        <button key={field.id} className={`resource-row ${field.active ? "" : "off"}`} onClick={() => setEditing({ ...field, optionsText: field.options.join("\n") })}>
          <div>
            <strong>{field.label}{field.required ? " *" : ""}</strong>
            <span>{[TYPE_LABEL[field.type], field.showInOnline && "в онлайн-записи", field.showInJournal && "на блоке в журнале", !field.active && "выключено"].filter(Boolean).join(" · ")}</span>
          </div>
        </button>
      ))}
    </div>
  );
  const needsOptions = editing?.type === "select" || editing?.type === "multiselect";
  return (
    <div className="panel list">
      <div>
        <h2 style={{ margin: 0 }}>Свои поля</h2>
        <span className="muted" style={{ fontSize: 13 }}>Добавьте то, что нужно именно вам: тип кожи, длину волос, откуда узнали. Поля появятся в карточке клиента и в записи.</span>
      </div>
      {group("client", "Клиент")}
      {group("appointment", "Запись")}
      {editing && (
        <Modal title={editing.id ? editing.label ?? "Поле" : "Новое поле"} onClose={() => setEditing(null)}>
          <div className="list">
            <div className="form-grid">
              <div className="field"><label>Название</label><input value={editing.label ?? ""} placeholder="Тип кожи" onChange={(event) => setEditing({ ...editing, label: event.target.value })} /></div>
              <div className="field">
                <label>Тип</label>
                <select value={editing.type} onChange={(event) => setEditing({ ...editing, type: event.target.value })}>
                  {Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
            </div>
            {needsOptions && (
              <div className="field">
                <label>Варианты, по одному в строке</label>
                <textarea rows={4} value={editing.optionsText ?? ""} onChange={(event) => setEditing({ ...editing, optionsText: event.target.value })} />
              </div>
            )}
            <label className="row"><input type="checkbox" checked={editing.required ?? false} onChange={(event) => setEditing({ ...editing, required: event.target.checked })} /> Обязательное</label>
            <label className="row"><input type="checkbox" checked={editing.showInOnline ?? false} onChange={(event) => setEditing({ ...editing, showInOnline: event.target.checked })} /> Спрашивать в онлайн-записи (не больше 3 полей)</label>
            {editing.entity === "appointment" && <label className="row"><input type="checkbox" checked={editing.showInJournal ?? false} onChange={(event) => setEditing({ ...editing, showInJournal: event.target.checked })} /> Показывать на блоке записи в журнале (одно поле)</label>}
            {editing.id && <label className="row"><input type="checkbox" checked={editing.active ?? true} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} /> Включено (значения выключенного поля сохраняются)</label>}
            <button className="btn-gradient" style={{ alignSelf: "flex-start" }} onClick={save}>Сохранить</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** CF-VAL-01 form part: inputs for the active fields of an entity. */
export function CustomInputs({ fields, values, onChange }: { fields: Field[]; values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void }) {
  if (!fields.length) return null;
  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });
  return (
    <div className="custom-fields">
      {fields.map((field) => {
        const value = values[field.key];
        const label = <label>{field.label}{field.required ? " *" : ""}</label>;
        if (field.type === "bool") {
          return <label key={field.key} className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={value === true} onChange={(event) => set(field.key, event.target.checked)} /> {field.label}</label>;
        }
        if (field.type === "select") {
          return (
            <div key={field.key} className="field">
              {label}
              <select value={String(value ?? "")} onChange={(event) => set(field.key, event.target.value)}>
                <option value="">—</option>
                {[...field.options, ...(value && !field.options.includes(String(value)) ? [String(value)] : [])].map((option) => <option key={option} value={option}>{option}{field.options.includes(option) ? "" : " (устаревшее)"}</option>)}
              </select>
            </div>
          );
        }
        if (field.type === "multiselect") {
          const list = Array.isArray(value) ? (value as string[]) : [];
          return (
            <div key={field.key} className="field">
              {label}
              <div className="chip-pick">
                {field.options.map((option) => (
                  <button key={option} type="button" className={`chip ${list.includes(option) ? "on" : ""}`} onClick={() => set(field.key, list.includes(option) ? list.filter((item) => item !== option) : [...list, option])}>{option}</button>
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={field.key} className="field">
            {label}
            {field.type === "textarea" ? (
              <textarea rows={2} value={String(value ?? "")} onChange={(event) => set(field.key, event.target.value)} />
            ) : (
              <input type={field.type === "date" ? "date" : "text"} inputMode={field.type === "number" ? "decimal" : undefined} value={String(value ?? "")} onChange={(event) => set(field.key, event.target.value)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
