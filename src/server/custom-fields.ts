/**
 * Custom fields (CF-*): the salon adds its own fields to the client card and the visit
 * ("Откуда узнали", "Тип кожи", "Длина волос"). Values live in a jsonb column next to the row.
 */
import { AppError } from "@/domain/errors";
import { isAdminPlus } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import type { Ctx } from "./types";

export type FieldEntity = "client" | "appointment";
export type FieldType = "text" | "textarea" | "number" | "select" | "multiselect" | "date" | "bool";
const TYPES: FieldType[] = ["text", "textarea", "number", "select", "multiselect", "date", "bool"];
const MAX_PER_ENTITY = 30;
const MAX_ONLINE = 3;

type FieldRow = {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  required: boolean;
  show_in_online: boolean;
  show_in_journal: boolean;
  position: number;
  active: boolean;
};

export type CustomField = ReturnType<typeof present>;
function present(row: FieldRow) {
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options ?? [],
    required: row.required,
    showInOnline: row.show_in_online,
    showInJournal: row.show_in_journal,
    position: Number(row.position),
    active: row.active,
  };
}

export async function listFields(ctx: Ctx, entity?: FieldEntity, input: { includeInactive?: boolean } = {}) {
  const rows = await many<FieldRow>(
    ctx.db,
    `SELECT * FROM custom_fields WHERE ($1::text IS NULL OR entity = $1) ${input.includeInactive ? "" : "AND active"} ORDER BY entity, position, created_at`,
    [entity ?? null],
  );
  return rows.map(present);
}

/** CF-DEF-01 / CF-DEF-02: create or change a field. */
export async function saveField(
  ctx: Ctx,
  input: { id?: string; entity?: unknown; key?: unknown; label?: unknown; type?: unknown; options?: unknown; required?: unknown; showInOnline?: unknown; showInJournal?: unknown; active?: unknown; position?: unknown },
) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Поля настраивает администратор");
  const current = input.id ? await one<FieldRow>(ctx.db, "SELECT * FROM custom_fields WHERE id = $1 FOR UPDATE", [input.id]) : null;
  if (input.id && !current) throw new AppError("NOT_FOUND", "Поле не найдено");
  const entity = String(input.entity ?? current?.entity ?? "") as FieldEntity;
  if (entity !== "client" && entity !== "appointment") throw new AppError("VALIDATION", "Поле бывает у клиента или у записи");
  const label = String(input.label ?? current?.label ?? "").trim().slice(0, 60);
  if (!label) throw new AppError("VALIDATION", "Укажите название поля");
  const key = current?.key ?? String(input.key ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new AppError("VALIDATION", "Ключ: латиница, цифры и _, начинается с буквы");
  const type = String(input.type ?? current?.type ?? "text") as FieldType;
  if (!TYPES.includes(type)) throw new AppError("VALIDATION", "Неизвестный тип поля");
  if (current && type !== current.type) {
    // Edge case 2: values of the old type would turn into garbage.
    const used = await one(ctx.db, `SELECT 1 FROM ${entity === "client" ? "clients" : "appointments"} WHERE custom ? $1 LIMIT 1`, [key]);
    if (used) throw new AppError("VALIDATION", "У поля уже есть значения: тип не меняется. Создайте новое поле");
  }
  const options = Array.isArray(input.options)
    ? [...new Set(input.options.map((item) => String(item).trim().slice(0, 60)).filter(Boolean))].slice(0, 50)
    : current?.options ?? [];
  if ((type === "select" || type === "multiselect") && !options.length) throw new AppError("VALIDATION", "Добавьте хотя бы один вариант");
  const bool = (value: unknown, fallback: boolean) => (value === undefined ? fallback : Boolean(value));
  const required = bool(input.required, current?.required ?? false);
  const active = bool(input.active, current?.active ?? true);
  const showInOnline = bool(input.showInOnline, current?.show_in_online ?? false) && active;
  const showInJournal = entity === "appointment" && bool(input.showInJournal, current?.show_in_journal ?? false) && active;
  if (!current) {
    const count = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM custom_fields WHERE entity = $1", [entity]);
    if (Number(count?.n) >= MAX_PER_ENTITY) throw new AppError("VALIDATION", `Не больше ${MAX_PER_ENTITY} полей`);
    const taken = await one(ctx.db, "SELECT 1 FROM custom_fields WHERE entity = $1 AND key = $2", [entity, key]);
    if (taken) throw new AppError("VALIDATION", "Поле с таким ключом уже есть");
  }
  if (showInOnline) {
    const online = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM custom_fields WHERE entity = $1 AND show_in_online AND active AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')", [entity, current?.id ?? null]);
    if (Number(online?.n) >= MAX_ONLINE) throw new AppError("VALIDATION", `В онлайн-записи — не больше ${MAX_ONLINE} полей`);
  }
  const id = current?.id ?? crypto.randomUUID();
  // CF-JOURNAL-01: only one field fits under the service name on the block.
  if (showInJournal) await ctx.db.query("UPDATE custom_fields SET show_in_journal = false WHERE entity = 'appointment' AND id <> $1", [id]);
  const position = input.position !== undefined ? Number(input.position) || 0 : current?.position;
  if (current) {
    await ctx.db.query(
      `UPDATE custom_fields SET label = $2, type = $3, options = $4, required = $5, show_in_online = $6, show_in_journal = $7, active = $8, position = $9 WHERE id = $1`,
      [id, label, type, options, required, showInOnline, showInJournal, active, position],
    );
  } else {
    await ctx.db.query(
      `INSERT INTO custom_fields (id, tenant_id, entity, key, label, type, options, required, show_in_online, show_in_journal, active, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, (SELECT COALESCE(MAX(position), 0) + 1 FROM custom_fields WHERE entity = $3))`,
      [id, ctx.actor.tenantId, entity, key, label, type, options, required, showInOnline, showInJournal, active],
    );
  }
  await audit(ctx, { branchId: null, entity: "custom_field", entityId: id, action: current ? "field.updated" : "field.created", diff: { entity, key, label, type, active } });
  return listFields(ctx, undefined, { includeInactive: true });
}

function coerce(field: FieldRow, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && !raw.length)) return undefined;
  const bad = (message: string) => new AppError("VALIDATION", `${field.label}: ${message}`, { field: field.key });
  switch (field.type) {
    case "text":
    case "textarea": {
      const text = String(raw).trim().slice(0, field.type === "text" ? 200 : 2000);
      return text || undefined;
    }
    case "number": {
      const number = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
      if (!Number.isFinite(number)) throw bad("нужно число");
      return number;
    }
    case "date": {
      const text = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw bad("нужна дата");
      return text;
    }
    case "bool":
      return raw === true || raw === "true" || raw === "1" || raw === 1;
    case "select": {
      const value = String(raw);
      // Edge case 1: an option removed later stays on old rows; new values must be current.
      if (!field.options.includes(value)) throw bad("выберите из списка");
      return value;
    }
    case "multiselect": {
      const values = (Array.isArray(raw) ? raw : [raw]).map(String);
      if (values.some((value) => !field.options.includes(value))) throw bad("выберите из списка");
      return [...new Set(values)];
    }
  }
}

/**
 * CF-VAL-01: merges submitted values into the stored ones, checks types and required fields.
 * Online (CF-ONLINE-01) only the online fields can be set and only they are required.
 */
export async function validateCustom(
  ctx: Ctx,
  entity: FieldEntity,
  submitted: Record<string, unknown> | undefined,
  stored: Record<string, unknown> = {},
  mode: "desk" | "online" = "desk",
) {
  const fields = await many<FieldRow>(ctx.db, "SELECT * FROM custom_fields WHERE entity = $1 AND active", [entity]);
  if (!fields.length) return stored;
  const result: Record<string, unknown> = { ...stored };
  for (const field of fields) {
    if (mode === "online" && !field.show_in_online) continue;
    if (submitted && Object.prototype.hasOwnProperty.call(submitted, field.key)) {
      const value = coerce(field, submitted[field.key]);
      if (value === undefined) delete result[field.key];
      else result[field.key] = value;
    }
    const missing = result[field.key] === undefined || (field.type === "bool" && result[field.key] !== true && field.required);
    // A required field is enforced when the form shows it: new records, and edits that send values.
    if (field.required && missing && (submitted !== undefined || mode === "online")) {
      throw new AppError("VALIDATION", `Заполните поле «${field.label}»`, { field: field.key });
    }
  }
  return result;
}

/** For screens: [{label, value}] in field order, values rendered as text. */
export async function describeCustom(ctx: Ctx, entity: FieldEntity, values: Record<string, unknown> | null | undefined) {
  if (!values || !Object.keys(values).length) return [];
  const fields = await listFields(ctx, entity, { includeInactive: true });
  return fields
    .filter((field) => values[field.key] !== undefined)
    .map((field) => ({ key: field.key, label: field.label, value: renderValue(field, values[field.key]), stale: !field.active || (field.type === "select" && !field.options.includes(String(values[field.key]))) }));
}

export function renderValue(field: { type: FieldType }, value: unknown) {
  if (value === undefined || value === null) return "";
  if (field.type === "bool") return value ? "да" : "нет";
  if (Array.isArray(value)) return value.join(", ");
  if (field.type === "date") {
    const [y, m, d] = String(value).split("-");
    return `${d}.${m}.${y}`;
  }
  return String(value);
}

/** Online booking form: the visit's and the client's online fields (≤3 each). */
export async function onlineFields(ctx: Ctx) {
  const rows = await many<FieldRow>(ctx.db, "SELECT * FROM custom_fields WHERE show_in_online AND active ORDER BY entity, position");
  return rows.map(present);
}
