import bcrypt from "bcryptjs";
import { afterAll } from "vitest";
import { asActor } from "@/server/auth";
import { closePool, withSession } from "@/server/db";
import type { Actor } from "@/server/types";
import { zonedDateTimeToUtc } from "@/domain/time";

export const DAY = "2026-11-03";
export const TZ = "Europe/Moscow";
export const NOW = new Date("2026-11-03T09:00:00.000Z");
const HASH = bcrypt.hashSync("ambeauty", 6);

export function at(hhmm: string, day = DAY): string {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return zonedDateTimeToUtc(day, hours * 60 + minutes, TZ).toISOString();
}

export function run<T>(actor: Actor, fn: Parameters<typeof asActor<T>>[1], now = NOW) {
  return asActor(actor, fn, now);
}

type Salon = {
  tenantId: string;
  branchId: string;
  otherBranchId: string;
  owner: Actor;
  admin: Actor;
  master: Actor;
  accountant: Actor;
  staffA: string;
  staffB: string;
  serviceId: string;
  serviceOnlyA: string;
  clientId: string;
  userIds: string[];
  destroy: () => Promise<void>;
};

const salons: Salon[] = [];

export async function createSalon(): Promise<Salon> {
  const tenantId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  const otherBranchId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const masterUserId = crypto.randomUUID();
  const accountantId = crypto.randomUUID();
  const staffA = crypto.randomUUID();
  const staffB = crypto.randomUUID();
  const serviceId = crypto.randomUUID();
  const serviceOnlyA = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const suffix = tenantId.slice(0, 8);
  const userIds = [ownerId, adminId, masterUserId, accountantId];

  await withSession({ tenantId, userId: ownerId }, async (db) => {
    await db.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `Salon ${suffix}`]);
    await db.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES
       ($1, $2, $9, 'Ольга'), ($3, $4, $9, 'Админ'), ($5, $6, $9, 'Алина'), ($7, $8, $9, 'Бухгалтер')`,
      [
        ownerId,
        `owner-${suffix}@test.local`,
        adminId,
        `admin-${suffix}@test.local`,
        masterUserId,
        `master-${suffix}@test.local`,
        accountantId,
        `buh-${suffix}@test.local`,
        HASH,
      ],
    );
    await db.query(
      `INSERT INTO branches (id, tenant_id, name, timezone, address) VALUES
       ($1, $3, 'Садовая', 'Europe/Moscow', 'Садовая, 14'),
       ($2, $3, 'Патриаршие', 'Europe/Moscow', 'Патриаршие')`,
      [branchId, otherBranchId, tenantId],
    );
    await db.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role, branch_id) VALUES
       ($1, $5, $6, 'owner', NULL),
       ($2, $5, $7, 'admin', $8),
       ($3, $5, $9, 'master', $8),
       ($4, $5, $10, 'accountant', $8)`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        tenantId,
        ownerId,
        adminId,
        branchId,
        masterUserId,
        accountantId,
      ],
    );
    await db.query(
      `INSERT INTO staff (id, tenant_id, user_id, display_name, color) VALUES
       ($1, $3, $4, 'Алина', '#e9a0c4'),
       ($2, $3, NULL, 'Марина', '#c7b6f2')`,
      [staffA, staffB, tenantId, masterUserId],
    );
    await db.query(
      `INSERT INTO staff_branches (staff_id, branch_id, tenant_id) VALUES
       ($1, $3, $4), ($2, $3, $4), ($1, $5, $4)`,
      [staffA, staffB, branchId, tenantId, otherBranchId],
    );
    await db.query(
      `INSERT INTO services (id, tenant_id, title, duration_min, price_minor, color) VALUES
       ($1, $3, 'Маникюр', 60, 150000, '#f8d0e4'),
       ($2, $3, 'Дизайн', 30, 50000, '#d5e4fb')`,
      [serviceId, serviceOnlyA, tenantId],
    );
    await db.query(
      `INSERT INTO service_staff (service_id, staff_id, tenant_id) VALUES
       ($1, $3, $4), ($1, $5, $4), ($2, $3, $4)`,
      [serviceId, serviceOnlyA, staffA, tenantId, staffB],
    );
    for (const staffId of [staffA, staffB]) {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        await db.query(
          `INSERT INTO schedule_templates (id, tenant_id, branch_id, staff_id, weekday, start_min, end_min, kind)
           VALUES ($1, $2, $3, $4, $5, 540, 1260, 'work')`,
          [crypto.randomUUID(), tenantId, branchId, staffId, weekday],
        );
      }
    }
    await db.query(
      `INSERT INTO clients (id, tenant_id, name, source) VALUES ($1, $2, 'Анна Смирнова', 'walk-in')`,
      [clientId, tenantId],
    );
    await db.query(
      `INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary)
       VALUES ($1, $2, $3, $4, true)`,
      [crypto.randomUUID(), tenantId, clientId, `+7999${suffix.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`],
    );
  });

  const base = { tenantId, email: "", name: "", branchId: null as string | null, staffId: null as string | null };
  const salon: Salon = {
    tenantId,
    branchId,
    otherBranchId,
    staffA,
    staffB,
    serviceId,
    serviceOnlyA,
    clientId,
    userIds,
    owner: { ...base, userId: ownerId, role: "owner", name: "Ольга", email: `owner-${suffix}@test.local` },
    admin: { ...base, userId: adminId, role: "admin", branchId, name: "Админ", email: `admin-${suffix}@test.local` },
    master: {
      ...base,
      userId: masterUserId,
      role: "master",
      branchId,
      staffId: staffA,
      name: "Алина",
      email: `master-${suffix}@test.local`,
    },
    accountant: {
      ...base,
      userId: accountantId,
      role: "accountant",
      branchId,
      name: "Бухгалтер",
      email: `buh-${suffix}@test.local`,
    },
    destroy: async () => {
      await asActor(salon.owner, async (ctx) => {
        await ctx.db.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
        await ctx.db.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
      });
    },
  };
  salons.push(salon);
  return salon;
}

export function useDb() {
  afterAll(async () => {
    for (const salon of salons.splice(0)) {
      await salon.destroy();
    }
    await closePool();
  });
}
