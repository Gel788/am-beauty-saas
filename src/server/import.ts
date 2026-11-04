/**
 * CL-IMPORT-01: clients from a spreadsheet (YClients / Altegio / Excel export).
 * The browser reads the file into rows; the server checks every row (dry run) and then commits
 * the same rows in one transaction. A committed import can be undone while its cards are untouched.
 */
import { AppError } from "@/domain/errors";
import { normalizePhone } from "@/domain/phone";
import { IMPORT_FIELDS, nameKey, parseCount, parseDate, parseMoney, type ImportField, type Mapping } from "@/domain/sheet";
import { isAdminPlus } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import type { Ctx } from "./types";

export const MAX_IMPORT_ROWS = 20_000;

export type ImportOptions = {
  /** A phone already in the base: skip the row, or fill the card's empty fields and add tags and history. */
  existing?: "skip" | "fill";
  /** The salon collected 152-ФЗ consents in its previous system. */
  consentGiven?: boolean;
  /** Extra tag for every imported card, e.g. "из YClients". */
  tag?: string;
};

type Parsed = {
  line: number;
  name: string;
  phones: string[];
  email: string | null;
  birthDate: string | null;
  notes: string;
  tags: string[];
  visits: number;
  lastVisit: string | null;
  revenueMinor: number;
  bonus: number;
  debtMinor: number;
};

export type RowIssue = { line: number; name: string; phone: string; reason: string };
export type ImportReport = {
  total: number;
  create: number;
  update: number;
  skip: number;
  mergedInFile: number;
  invalid: number;
  withDebt: number;
  withBonus: number;
  issues: RowIssue[];
  samples: { line: number; name: string; phone: string; action: "create" | "update" | "skip" }[];
};

function cell(row: string[], mapping: Mapping, field: ImportField) {
  const index = mapping[field];
  return index === undefined || index < 0 ? "" : String(row[index] ?? "").trim();
}

function cleanMapping(input: unknown): Mapping {
  const mapping: Mapping = {};
  if (!input || typeof input !== "object") return mapping;
  for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(field in IMPORT_FIELDS)) continue;
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0 && index < 200) mapping[field as ImportField] = index;
  }
  return mapping;
}

function splitPhones(value: string) {
  // One cell can hold several numbers: "+7 900 111-22-33, 8 (916) 000-00-00"
  return value.split(/[,;/]|\s{2,}/).map((part) => part.trim()).filter((part) => /\d{6,}/.test(part.replace(/\D/g, "")));
}

function parseRow(row: string[], mapping: Mapping, line: number): Parsed | { line: number; error: string; name: string; phone: string } {
  const first = cell(row, mapping, "name");
  const last = cell(row, mapping, "lastName");
  const name = [first, last && !first.toLowerCase().includes(last.toLowerCase()) ? last : ""].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 120);
  const rawPhones = [...splitPhones(cell(row, mapping, "phone")), ...splitPhones(cell(row, mapping, "phone2"))];
  const phoneText = cell(row, mapping, "phone");
  const phones: string[] = [];
  for (const raw of rawPhones) {
    try {
      const phone = normalizePhone(raw);
      if (!phones.includes(phone)) phones.push(phone);
    } catch {
      // a bad extra number is dropped; a bad only number fails the row below
    }
  }
  if (!phones.length) return { line, name, phone: phoneText, error: phoneText ? "Не удалось разобрать телефон" : "Нет телефона" };
  const email = cell(row, mapping, "email").toLowerCase();
  const birthText = cell(row, mapping, "birthDate");
  const balance = parseMoney(cell(row, mapping, "balance"));
  const debt = parseMoney(cell(row, mapping, "debt"));
  return {
    line,
    name: name || "Без имени",
    phones,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    birthDate: birthText ? parseDate(birthText) : null,
    notes: cell(row, mapping, "notes").slice(0, 2000),
    tags: cell(row, mapping, "tags")
      .split(/[,;]/)
      .map((tag) => tag.trim().slice(0, 40))
      .filter(Boolean),
    visits: parseCount(cell(row, mapping, "visits")) ?? 0,
    lastVisit: parseDate(cell(row, mapping, "lastVisit")),
    revenueMinor: Math.max(0, parseMoney(cell(row, mapping, "revenue")) ?? 0),
    bonus: Math.max(0, Math.floor((parseMoney(cell(row, mapping, "bonus")) ?? 0) / 100)),
    // Debt: a "долг" column is positive; a "баланс" column is negative when the client owes.
    debtMinor: Math.max(0, debt ?? 0, balance !== null && balance < 0 ? -balance : 0),
  };
}

type Plan = {
  report: ImportReport;
  creates: Parsed[];
  updates: { clientId: string; row: Parsed }[];
};

async function plan(ctx: Ctx, rows: string[][], mapping: Mapping, options: ImportOptions): Promise<Plan> {
  if (mapping.phone === undefined) throw new AppError("VALIDATION", "Укажите, в какой колонке телефон");
  if (mapping.name === undefined) throw new AppError("VALIDATION", "Укажите, в какой колонке имя");
  if (rows.length > MAX_IMPORT_ROWS) throw new AppError("VALIDATION", `За раз можно загрузить до ${MAX_IMPORT_ROWS} строк`);
  const existing = await many<{ phone_e164: string; client_id: string }>(
    ctx.db,
    "SELECT p.phone_e164, p.client_id FROM client_phones p JOIN clients c ON c.id = p.client_id WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL",
  );
  const byPhone = new Map(existing.map((row) => [row.phone_e164, row.client_id]));
  const report: ImportReport = { total: rows.length, create: 0, update: 0, skip: 0, mergedInFile: 0, invalid: 0, withDebt: 0, withBonus: 0, issues: [], samples: [] };
  const creates: Parsed[] = [];
  const updates: { clientId: string; row: Parsed }[] = [];
  const inFile = new Map<string, Parsed>();

  rows.forEach((row, index) => {
    const line = index + 1;
    const parsed = parseRow(row, mapping, line);
    if ("error" in parsed) {
      report.invalid += 1;
      report.issues.push({ line, name: parsed.name, phone: parsed.phone, reason: parsed.error });
      return;
    }
    // The same person twice in the file (same phone): the later row adds to the first.
    const twin = parsed.phones.map((phone) => inFile.get(phone)).find(Boolean);
    if (twin) {
      report.mergedInFile += 1;
      for (const phone of parsed.phones) if (!twin.phones.includes(phone) && !byPhone.has(phone)) twin.phones.push(phone);
      twin.tags = [...new Set([...twin.tags, ...parsed.tags])];
      twin.email ??= parsed.email;
      twin.birthDate ??= parsed.birthDate;
      twin.visits += parsed.visits;
      twin.revenueMinor += parsed.revenueMinor;
      twin.lastVisit = [twin.lastVisit, parsed.lastVisit].filter(Boolean).sort().at(-1) ?? null;
      if (parsed.notes && !twin.notes.includes(parsed.notes)) twin.notes = [twin.notes, parsed.notes].filter(Boolean).join("\n");
      return;
    }
    for (const phone of parsed.phones) inFile.set(phone, parsed);
    if (options.tag?.trim()) parsed.tags = [...new Set([...parsed.tags, options.tag.trim().slice(0, 40)])];
    const clientId = parsed.phones.map((phone) => byPhone.get(phone)).find(Boolean);
    if (clientId) {
      if (options.existing === "fill") {
        report.update += 1;
        updates.push({ clientId, row: parsed });
      } else report.skip += 1;
      if (report.samples.length < 8) report.samples.push({ line, name: parsed.name, phone: parsed.phones[0], action: options.existing === "fill" ? "update" : "skip" });
      return;
    }
    report.create += 1;
    creates.push(parsed);
    if (parsed.debtMinor > 0) report.withDebt += 1;
    if (parsed.bonus > 0) report.withBonus += 1;
    if (report.samples.length < 8) report.samples.push({ line, name: parsed.name, phone: parsed.phones[0], action: "create" });
  });
  // Extra phones of the same person must not belong to another card already.
  for (const row of creates) row.phones = row.phones.filter((phone, index) => index === 0 || !byPhone.has(phone));
  report.issues = report.issues.slice(0, 200);
  return { report, creates, updates };
}

function input(body: { rows?: unknown; mapping?: unknown; options?: unknown; hasHeader?: unknown }) {
  if (!Array.isArray(body.rows)) throw new AppError("VALIDATION", "Нет строк для загрузки");
  const all = body.rows.map((row) => (Array.isArray(row) ? row.map((value) => String(value ?? "")) : []));
  const rows = body.hasHeader === false ? all : all.slice(1);
  const raw = (body.options ?? {}) as Record<string, unknown>;
  const options: ImportOptions = {
    existing: raw.existing === "fill" ? "fill" : "skip",
    consentGiven: raw.consentGiven === true,
    tag: typeof raw.tag === "string" ? raw.tag : undefined,
  };
  return { rows, mapping: cleanMapping(body.mapping), options };
}

/** Dry run: what would happen, row by row. Nothing is written. */
export async function previewImport(ctx: Ctx, body: Parameters<typeof input>[0]) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Импорт доступен администратору и владельцу");
  const { rows, mapping, options } = input(body);
  return (await plan(ctx, rows, mapping, options)).report;
}

export async function commitImport(ctx: Ctx, body: Parameters<typeof input>[0] & { fileName?: unknown }) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Импорт доступен администратору и владельцу");
  const { rows, mapping, options } = input(body);
  const { report, creates, updates } = await plan(ctx, rows, mapping, options);
  if (!creates.length && !updates.length) throw new AppError("VALIDATION", "Нечего загружать: все строки уже в базе или с ошибками");
  const jobId = crypto.randomUUID();
  const now = ctx.now.toISOString();
  const tenantId = ctx.actor.tenantId;
  await ctx.db.query(
    "INSERT INTO import_jobs (id, tenant_id, file_name, mapping, options, stats, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [jobId, tenantId, String(body.fileName ?? "").slice(0, 200), JSON.stringify(mapping), JSON.stringify(options), JSON.stringify({ ...report, issues: undefined, samples: undefined }), ctx.actor.userId, now],
  );

  // Phones still held by hidden (deleted) cards are released for the new ones.
  const incoming = creates.flatMap((row) => row.phones);
  if (incoming.length) {
    await ctx.db.query(
      `UPDATE client_phones p SET deleted_at = $2 FROM clients c
       WHERE c.id = p.client_id AND c.deleted_at IS NOT NULL AND p.deleted_at IS NULL AND p.phone_e164 = ANY($1::text[])`,
      [incoming, now],
    );
  }

  // Batches of 500 keep a 20 000-row import to a few dozen statements.
  for (let start = 0; start < creates.length; start += 500) {
    const batch = creates.slice(start, start + 500).map((row) => ({ ...row, id: crypto.randomUUID() }));
    await ctx.db.query(
      `INSERT INTO clients (id, tenant_id, name, email, notes, source, birth_date, import_job_id, imported_visits, imported_last_visit,
         imported_revenue_minor, consent_pd_at, consent_pd_source, created_at)
       SELECT r.id, $1, r.name, r.email, r.notes, 'import', r.birth_date, $2, r.visits, r.last_visit, r.revenue,
              CASE WHEN $3 THEN $4::timestamptz END, CASE WHEN $3 THEN 'import' END, $4::timestamptz
       FROM jsonb_to_recordset($5::jsonb) AS r(id uuid, name text, email text, notes text, birth_date date, visits int, last_visit date, revenue bigint)`,
      [
        tenantId,
        jobId,
        options.consentGiven === true,
        now,
        JSON.stringify(batch.map((row) => ({ id: row.id, name: row.name, email: row.email, notes: row.notes, birth_date: row.birthDate, visits: row.visits, last_visit: row.lastVisit, revenue: row.revenueMinor }))),
      ],
    );
    const phones = batch.flatMap((row) => row.phones.map((phone, index) => ({ id: crypto.randomUUID(), client_id: row.id, phone, primary: index === 0 })));
    await ctx.db.query(
      `INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary)
       SELECT r.id, $1, r.client_id, r.phone, r.primary FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, client_id uuid, phone text, "primary" boolean)
       ON CONFLICT DO NOTHING`,
      [tenantId, JSON.stringify(phones)],
    );
    const tags = batch.flatMap((row) => row.tags.map((tag) => ({ client_id: row.id, tag })));
    if (tags.length) {
      await ctx.db.query(
        `INSERT INTO client_tags (client_id, tenant_id, tag) SELECT r.client_id, $1, r.tag FROM jsonb_to_recordset($2::jsonb) AS r(client_id uuid, tag text) ON CONFLICT DO NOTHING`,
        [tenantId, JSON.stringify(tags)],
      );
    }
    for (const row of batch) {
      if (row.debtMinor > 0) {
        await ctx.db.query("UPDATE clients SET balance_minor = balance_minor + $2 WHERE id = $1", [row.id, row.debtMinor]);
        await ctx.db.query(
          "INSERT INTO balance_adjustments (id, tenant_id, client_id, amount_minor, reason, actor_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [crypto.randomUUID(), tenantId, row.id, row.debtMinor, "Долг из прежней системы (импорт)", ctx.actor.userId, now],
        );
      }
      if (row.bonus > 0) {
        await ctx.db.query("UPDATE clients SET bonus_balance = bonus_balance + $2 WHERE id = $1", [row.id, row.bonus]);
        await ctx.db.query(
          "INSERT INTO bonus_ledger (id, tenant_id, client_id, kind, delta, balance_after, reason, created_by, created_at) VALUES ($1,$2,$3,'manual',$4,$4,$5,$6,$7)",
          [crypto.randomUUID(), tenantId, row.id, row.bonus, "Бонусы из прежней системы (импорт)", ctx.actor.userId, now],
        );
      }
    }
  }

  // Existing cards: only empty fields are filled; tags and history are added. Money is not touched.
  for (const { clientId, row } of updates) {
    await ctx.db.query(
      `UPDATE clients SET
         email = COALESCE(email, $2), birth_date = COALESCE(birth_date, $3::date),
         notes = CASE WHEN $4 = '' OR position($4 in notes) > 0 THEN notes WHEN notes = '' THEN $4 ELSE notes || E'\n' || $4 END,
         imported_visits = GREATEST(imported_visits, $5), imported_revenue_minor = GREATEST(imported_revenue_minor, $6),
         imported_last_visit = GREATEST(imported_last_visit, $7::date),
         consent_pd_at = CASE WHEN $8 THEN COALESCE(consent_pd_at, $9::timestamptz) ELSE consent_pd_at END,
         consent_pd_source = CASE WHEN $8 THEN COALESCE(consent_pd_source, 'import') ELSE consent_pd_source END,
         version = version + 1, updated_at = now()
       WHERE id = $1`,
      [clientId, row.email, row.birthDate, row.notes, row.visits, row.revenueMinor, row.lastVisit, options.consentGiven === true, now],
    );
    for (const tag of row.tags) {
      await ctx.db.query("INSERT INTO client_tags (client_id, tenant_id, tag) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [clientId, tenantId, tag]);
    }
  }
  await audit(ctx, { entity: "import", entityId: jobId, action: "clients.imported", diff: { created: report.create, updated: report.update, skipped: report.skip, invalid: report.invalid } });
  return { jobId, ...report };
}

export async function listImports(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const rows = await many<{ id: string; file_name: string; status: string; stats: ImportReport; created_at: Date; undone_at: Date | null; live: number }>(
    ctx.db,
    `SELECT j.id, j.file_name, j.status, j.stats, j.created_at, j.undone_at,
            (SELECT count(*)::int FROM clients c WHERE c.import_job_id = j.id AND c.deleted_at IS NULL) AS live
     FROM import_jobs j ORDER BY j.created_at DESC LIMIT 20`,
  );
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    status: row.status,
    created: Number(row.stats.create ?? 0),
    updated: Number(row.stats.update ?? 0),
    skipped: Number(row.stats.skip ?? 0),
    invalid: Number(row.stats.invalid ?? 0),
    live: Number(row.live),
    createdAt: new Date(row.created_at).toISOString(),
    undoneAt: row.undone_at ? new Date(row.undone_at).toISOString() : null,
  }));
}

/**
 * Undo: hides the cards this import created, unless the salon has already worked with them
 * (a visit, a payment, a merge). Those stay and are counted as kept.
 */
export async function undoImport(ctx: Ctx, jobId: string) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const job = await one<{ status: string }>(ctx.db, "SELECT status FROM import_jobs WHERE id = $1 FOR UPDATE", [jobId]);
  if (!job) throw new AppError("NOT_FOUND", "Импорт не найден");
  if (job.status === "undone") throw new AppError("VALIDATION", "Импорт уже отменён");
  const removed = await ctx.db.query(
    `UPDATE clients c SET deleted_at = $2, version = version + 1
     WHERE c.import_job_id = $1 AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.client_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM clients m WHERE m.merged_into_id = c.id)
     RETURNING c.id`,
    [jobId, ctx.now.toISOString()],
  );
  // Phones are freed so the same file can be loaded again with a better mapping.
  const ids = removed.rows.map((row) => row.id as string);
  if (ids.length) await ctx.db.query("UPDATE client_phones SET deleted_at = $2 WHERE client_id = ANY($1::uuid[]) AND deleted_at IS NULL", [ids, ctx.now.toISOString()]);
  const kept = await one<{ n: number }>(ctx.db, "SELECT count(*)::int AS n FROM clients WHERE import_job_id = $1 AND deleted_at IS NULL", [jobId]);
  await ctx.db.query("UPDATE import_jobs SET status = 'undone', undone_at = $2 WHERE id = $1", [jobId, ctx.now.toISOString()]);
  await audit(ctx, { entity: "import", entityId: jobId, action: "clients.import_undone", diff: { removed: ids.length, kept: Number(kept?.n ?? 0) } });
  return { removed: ids.length, kept: Number(kept?.n ?? 0) };
}

export { nameKey };
