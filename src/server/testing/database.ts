import { randomBytes } from "node:crypto";

import pg from "pg";

import { migrate } from "@/server/db/migrate";
import { createPool, type Pool } from "@/server/db/pool";

/**
 * Admin connection for creating throwaway test databases. CI provides a
 * Postgres service; locally run Postgres 16 on 5433 (see CONTRIBUTING notes
 * in README) or set TEST_DATABASE_ADMIN_URL.
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5433/postgres";
const APP_ROLE = "reviewsignal_test";

export interface TestDatabase {
  pool: Pool;
  url: string;
  drop: () => Promise<void>;
}

/**
 * Creates a fresh database owned by a NON-superuser role (superusers bypass
 * row-level security, which would make tenancy tests meaningless), applies
 * all migrations as that role, and returns a pool connected as it.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `rs_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const role = await admin.query("select 1 from pg_roles where rolname = $1", [APP_ROLE]);
    if (!role.rowCount) {
      await admin.query(`create role ${APP_ROLE} login nosuperuser nobypassrls password 'test'`).catch(
        // Parallel test files may race on role creation.
        (error: { code?: string }) => {
          if (error.code !== "23505" && error.code !== "42710") throw error;
        },
      );
    }
    await admin.query(`create database ${name} owner ${APP_ROLE}`);
  } finally {
    await admin.end();
  }

  const url = new URL(ADMIN_URL);
  url.username = APP_ROLE;
  url.password = "test";
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 5);
  await migrate(pool);

  return {
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
