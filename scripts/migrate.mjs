import fs from "node:fs";
import pg from "pg";

const connectionString =
  process.env.MIGRATE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/ambeauty";

const client = new pg.Client({ connectionString });
await client.connect();
const existing = await client.query("SELECT to_regclass('public.tenants') AS name");
if (existing.rows[0].name) {
  console.log("Schema already present, skip");
} else {
  const sql = fs.readFileSync(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8");
  await client.query(sql);
  console.log("Migrated");
}
await client.end();
