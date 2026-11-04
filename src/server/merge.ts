/**
 * CL-MERGE-01: one person, two cards. Everything moves to the card that stays
 * (visits, payments, debt, bonuses, certificates, memberships, messages, Telegram, tags, phones),
 * the other card is hidden with merged_into_id, and the whole move is in the audit.
 */
import { AppError } from "@/domain/errors";
import { nameKey } from "@/domain/sheet";
import { isAdminPlus } from "./access";
import { audit } from "./audit";
import { many, one } from "./db";
import type { Ctx } from "./types";

type Card = {
  id: string;
  name: string;
  email: string | null;
  notes: string;
  birth_date: string | null;
  balance_minor: number;
  bonus_balance: number;
  version: number;
  created_at: Date;
  consent_pd_at: Date | null;
  consent_pd_source: string | null;
  consent_marketing: boolean;
  consent_marketing_at: Date | null;
  imported_visits: number;
  imported_last_visit: string | null;
  imported_revenue_minor: number;
};

export type DuplicateGroup = {
  reason: "name" | "email" | "phone";
  label: string;
  clients: { id: string; name: string; phones: string[]; email: string | null; visits: number; lastVisitAt: string | null; balanceMinor: number; createdAt: string }[];
};

/** Candidates: same name (any word order, ё = е), same email, or the same last 10 digits of a phone. */
export async function findDuplicates(ctx: Ctx): Promise<DuplicateGroup[]> {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const rows = await many<{ id: string; name: string; email: string | null; balance_minor: number; created_at: Date; phones: string[] | null; visits: number; last_visit: Date | null; imported_visits: number }>(
    ctx.db,
    `SELECT c.id, c.name, c.email, c.balance_minor, c.created_at, c.imported_visits,
            (SELECT array_agg(p.phone_e164 ORDER BY p.is_primary DESC) FROM client_phones p WHERE p.client_id = c.id AND p.deleted_at IS NULL) AS phones,
            (SELECT count(*)::int FROM appointments a WHERE a.client_id = c.id AND a.status NOT IN ('cancelled')) AS visits,
            (SELECT max(a.starts_at) FROM appointments a WHERE a.client_id = c.id) AS last_visit
     FROM clients c WHERE c.deleted_at IS NULL`,
  );
  const ignored = await many<{ client_a: string; client_b: string }>(ctx.db, "SELECT client_a, client_b FROM client_not_duplicates");
  const skip = new Set(ignored.map((row) => `${row.client_a}|${row.client_b}`));
  const buckets = new Map<string, { reason: DuplicateGroup["reason"]; label: string; ids: Set<string> }>();
  const add = (key: string, reason: DuplicateGroup["reason"], label: string, id: string) => {
    const bucket = buckets.get(key) ?? { reason, label, ids: new Set<string>() };
    bucket.ids.add(id);
    buckets.set(key, bucket);
  };
  for (const row of rows) {
    const key = nameKey(row.name);
    // A lone first name ("Анна") matches too many different people to be useful.
    if (key.includes(" ") && key !== "без имени") add(`n:${key}`, "name", row.name, row.id);
    if (row.email) add(`e:${row.email.toLowerCase()}`, "email", row.email, row.id);
    for (const phone of row.phones ?? []) add(`p:${phone.replace(/\D/g, "").slice(-10)}`, "phone", phone, row.id);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    let ids = [...bucket.ids];
    if (ids.length < 2) continue;
    // Drop a group where every pair was marked "different people".
    const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
    if (pairs.every((pair) => skip.has(pair))) continue;
    ids = ids.sort();
    const signature = ids.join(",");
    if (seen.has(signature)) continue;
    seen.add(signature);
    groups.push({
      reason: bucket.reason,
      label: bucket.label,
      clients: ids
        .map((id) => byId.get(id)!)
        .sort((a, b) => Number(b.visits) + Number(b.imported_visits) - Number(a.visits) - Number(a.imported_visits))
        .map((row) => ({
          id: row.id,
          name: row.name,
          phones: row.phones ?? [],
          email: row.email,
          visits: Number(row.visits) + Number(row.imported_visits),
          lastVisitAt: row.last_visit ? new Date(row.last_visit).toISOString() : null,
          balanceMinor: Number(row.balance_minor),
          createdAt: new Date(row.created_at).toISOString(),
        })),
    });
  }
  const order = { phone: 0, email: 1, name: 2 };
  return groups.sort((a, b) => order[a.reason] - order[b.reason]).slice(0, 200);
}

export async function markNotDuplicates(ctx: Ctx, ids: string[]) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const unique = [...new Set(ids)].sort();
  if (unique.length < 2) throw new AppError("VALIDATION", "Нужно минимум два клиента");
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      await ctx.db.query(
        "INSERT INTO client_not_duplicates (tenant_id, client_a, client_b, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [ctx.actor.tenantId, unique[i], unique[j], ctx.actor.userId],
      );
    }
  }
  return { ok: true };
}

/** Moves everything from `secondaryId` into `primaryId`. Owner and admin. */
export async function mergeClients(ctx: Ctx, primaryId: string, secondaryId: string) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Объединять клиентов может администратор или владелец");
  if (primaryId === secondaryId) throw new AppError("VALIDATION", "Выберите двух разных клиентов");
  // Lock both rows in a fixed order so two merges cannot deadlock.
  const cards = await many<Card>(ctx.db, "SELECT * FROM clients WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE", [[primaryId, secondaryId]]);
  const primary = cards.find((card) => card.id === primaryId);
  const secondary = cards.find((card) => card.id === secondaryId);
  if (!primary || !secondary) throw new AppError("NOT_FOUND", "Клиент не найден или уже объединён");

  const moved: Record<string, number> = {};
  const move = async (table: string, extra = "") => {
    const result = await ctx.db.query(`UPDATE ${table} SET client_id = $1 WHERE client_id = $2 ${extra}`, [primaryId, secondaryId]);
    if (result.rowCount) moved[table] = result.rowCount;
  };
  await move("appointments");
  await move("payments");
  await move("balance_adjustments");
  await move("bonus_ledger");
  await move("certificates");
  await move("client_memberships");
  await move("online_payments");
  await move("outbound_messages");
  await move("client_tags", "AND tag NOT IN (SELECT tag FROM client_tags WHERE client_id = $1)");
  await ctx.db.query("DELETE FROM client_tags WHERE client_id = $1", [secondaryId]);
  // Telegram: keep the staying card's chat; otherwise take the other one's.
  const hasChat = await one<{ id: string }>(ctx.db, "SELECT id FROM telegram_links WHERE client_id = $1", [primaryId]);
  if (hasChat) await ctx.db.query("DELETE FROM telegram_links WHERE client_id = $1", [secondaryId]);
  else await move("telegram_links");
  await ctx.db.query("DELETE FROM telegram_link_tokens WHERE client_id = $1", [secondaryId]);
  await ctx.db.query("DELETE FROM client_not_duplicates WHERE client_a = $1 OR client_b = $1", [secondaryId]);

  // Phones join the staying card as extra numbers.
  const phones = await many<{ id: string; phone_e164: string }>(ctx.db, "SELECT id, phone_e164 FROM client_phones WHERE client_id = $1 AND deleted_at IS NULL", [secondaryId]);
  for (const phone of phones) {
    await ctx.db.query("UPDATE client_phones SET client_id = $1, is_primary = false WHERE id = $2", [primaryId, phone.id]);
  }

  const notes = [primary.notes, secondary.notes].map((text) => text.trim()).filter(Boolean);
  const firstConsent = [primary.consent_pd_at, secondary.consent_pd_at].filter(Boolean).sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0] ?? null;
  await ctx.db.query(
    `UPDATE clients SET
       email = COALESCE(email, $2), birth_date = COALESCE(birth_date, $3::date), notes = $4,
       balance_minor = balance_minor + $5, bonus_balance = bonus_balance + $6,
       consent_pd_at = $7, consent_pd_source = COALESCE(consent_pd_source, $8),
       consent_marketing = consent_marketing OR $9, consent_marketing_at = COALESCE(consent_marketing_at, $10),
       imported_visits = imported_visits + $11, imported_revenue_minor = imported_revenue_minor + $12,
       imported_last_visit = GREATEST(imported_last_visit, $13::date),
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [
      primaryId,
      secondary.email,
      secondary.birth_date,
      [...new Set(notes)].join("\n"),
      Number(secondary.balance_minor),
      Number(secondary.bonus_balance),
      firstConsent,
      secondary.consent_pd_source,
      secondary.consent_marketing,
      secondary.consent_marketing_at,
      Number(secondary.imported_visits),
      Number(secondary.imported_revenue_minor),
      secondary.imported_last_visit,
    ],
  );
  await ctx.db.query(
    `UPDATE clients SET merged_into_id = $1, deleted_at = $3, balance_minor = 0, bonus_balance = 0, version = version + 1, updated_at = now() WHERE id = $2`,
    [primaryId, secondaryId, ctx.now.toISOString()],
  );
  // Cards merged into the secondary earlier now point at the staying one.
  await ctx.db.query("UPDATE clients SET merged_into_id = $1 WHERE merged_into_id = $2", [primaryId, secondaryId]);
  const diff = {
    from: { id: secondaryId, name: secondary.name, phones: phones.map((phone) => phone.phone_e164), balanceMinor: Number(secondary.balance_minor), bonus: Number(secondary.bonus_balance) },
    moved,
  };
  await audit(ctx, { entity: "client", entityId: primaryId, action: "client.merged", diff });
  await audit(ctx, { entity: "client", entityId: secondaryId, action: "client.merged_into", diff: { into: primaryId } });
  return { primaryId, moved };
}
