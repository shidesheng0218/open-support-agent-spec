import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { withTransaction } from "./pool.js";

// src/ (or dist/) -> package root; migrations live next to src/.
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/** Fixed key for the migration advisory lock; shared by every migrator. */
const MIGRATION_LOCK_KEY = 8_151_204_301;

/**
 * Apply pending SQL migrations in filename order, each in its own
 * transaction, recorded in schema_migrations. Idempotent.
 *
 * The whole run is serialized behind a session-level advisory lock. Without it
 * two concurrent migrators race on `CREATE TABLE IF NOT EXISTS` and one dies
 * with a duplicate pg_type error — which is exactly what a rolling deploy (or
 * two parallel test files) does. The lock makes "migrate at boot" safe to run
 * from every replica.
 */
export async function migrate(pool: Pool): Promise<string[]> {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      return await runMigrations(pool);
    } finally {
      await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    lock.release();
  }
}

async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await pool.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id),
  );
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}
