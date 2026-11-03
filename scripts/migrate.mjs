import fs from "node:fs";
import pg from "pg";

const connectionString =
  process.env.MIGRATE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/ambeauty";

const dir = new URL("../db/migrations/", import.meta.url);
const files = fs
  .readdirSync(dir)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();

const client = new pg.Client({ connectionString });
await client.connect();
await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

// Databases created before the runner existed already have 001 applied.
const legacy = await client.query("SELECT to_regclass('public.tenants') AS name");
if (legacy.rows[0].name) {
  await client.query("INSERT INTO schema_migrations (name) VALUES ('001_init.sql') ON CONFLICT DO NOTHING");
}

const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
let applied = 0;
for (const name of files) {
  if (done.has(name)) continue;
  const sql = fs.readFileSync(new URL(name, dir), "utf8");
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user");
    await client.query("COMMIT");
    console.log(`Applied ${name}`);
    applied += 1;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Failed ${name}`);
    throw error;
  }
}
if (applied === 0) console.log("Schema up to date");
await client.end();
