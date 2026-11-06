import { migrations as defaultMigrations, type Migration } from "@/server/db/migrations";
import type { Pool } from "@/server/db/pool";

const LOCK_ID = 727_281_001;

/**
 * Applies pending migrations in order, each in its own transaction, under a
 * session advisory lock so concurrent pods cannot race. Returns the names
 * applied in this run.
 */
export async function migrate(
  pool: Pool,
  migrations: Migration[] = defaultMigrations,
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
    const done = new Set(rows.map((row) => row.name));

    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      try {
        await client.query("begin");
        // Data backfills in migrations must see every tenant's rows.
        await client.query("select set_config('app.bypass_rls', 'on', true)");
        await client.query(migration.sql);
        await client.query("insert into schema_migrations (name) values ($1)", [migration.name]);
        await client.query("commit");
        applied.push(migration.name);
      } catch (error) {
        await client.query("rollback");
        throw new Error(
          `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/** Names of migrations not yet applied; used by /readyz. */
export async function pendingMigrations(
  pool: Pool,
  migrations: Migration[] = defaultMigrations,
): Promise<string[]> {
  const exists = await pool.query<{ exists: boolean }>(
    "select to_regclass('schema_migrations') is not null as exists",
  );
  if (!exists.rows[0]?.exists) return migrations.map((migration) => migration.name);
  const { rows } = await pool.query<{ name: string }>("select name from schema_migrations");
  const done = new Set(rows.map((row) => row.name));
  return migrations.filter((migration) => !done.has(migration.name)).map((m) => m.name);
}
