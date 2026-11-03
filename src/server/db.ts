import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { mapPgError } from "@/domain/errors";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://app_user:app_pass@127.0.0.1:5432/ambeauty";

export const pool = new Pool({ connectionString, max: 10 });

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function many<T extends QueryResultRow>(
  db: PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params);
  return result.rows;
}

export async function one<T extends QueryResultRow>(
  db: PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await many<T>(db, text, params);
  return rows[0] ?? null;
}

export async function poolOne<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await pool.query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function withSession<T>(
  settings: { tenantId?: string; userId?: string },
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (settings.tenantId) {
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [settings.tenantId]);
    }
    if (settings.userId) {
      await db.query("SELECT set_config('app.user_id', $1, true)", [settings.userId]);
    }
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      /* connection already closed */
    }
    throw mapPgError(error);
  } finally {
    db.release();
  }
}
