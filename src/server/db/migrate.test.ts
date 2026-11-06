import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate, pendingMigrations } from "@/server/db/migrate";
import { SYSTEM, withScope } from "@/server/db/pool";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function seedTenant(name: string): Promise<{ tenantId: string; appId: string }> {
  return withScope(db.pool, SYSTEM, async (client) => {
    const tenant = await client.query<{ id: string }>(
      "insert into tenant (loomit_publisher_id, name) values ($1, $1) returning id",
      [name],
    );
    const app = await client.query<{ id: string }>(
      "insert into app (tenant_id, loomit_app_id, name, android_package) values ($1, $2, $2, 'com.example.app') returning id",
      [tenant.rows[0].id, `${name}-app`],
    );
    return { tenantId: tenant.rows[0].id, appId: app.rows[0].id };
  });
}

describe("migrations", () => {
  it("are applied once and reported as complete", async () => {
    await expect(migrate(db.pool)).resolves.toEqual([]);
    await expect(pendingMigrations(db.pool)).resolves.toEqual([]);
  });

  it("report a broken migration with its name and roll it back", async () => {
    await expect(
      migrate(db.pool, [{ name: "9999_broken", sql: "create table oops (; " }]),
    ).rejects.toThrow("Migration 9999_broken failed");
    await expect(pendingMigrations(db.pool, [{ name: "9999_broken", sql: "" }])).resolves.toEqual([
      "9999_broken",
    ]);
  });
});

describe("row-level security", () => {
  it("isolates tenants and blocks unscoped access", async () => {
    const a = await seedTenant("publisher-a");
    const b = await seedTenant("publisher-b");

    const visibleToA = await withScope(db.pool, { tenantId: a.tenantId }, (client) =>
      client.query<{ id: string }>("select id from app"),
    );
    expect(visibleToA.rows.map((row) => row.id)).toEqual([a.appId]);

    await expect(
      withScope(db.pool, { tenantId: a.tenantId }, (client) =>
        client.query(
          "insert into app (tenant_id, loomit_app_id, name) values ($1, 'sneaky', 'sneaky')",
          [b.tenantId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    const unscoped = await db.pool.query("select id from app");
    expect(unscoped.rowCount).toBe(0);

    const all = await withScope(db.pool, SYSTEM, (client) => client.query("select id from app"));
    expect(all.rowCount).toBe(2);
  });

  it("does not leak scope across pooled connections", async () => {
    const a = await seedTenant("publisher-c");
    await withScope(db.pool, { tenantId: a.tenantId }, (client) => client.query("select 1"));
    const after = await db.pool.query<{ setting: string | null }>(
      "select current_setting('app.tenant_id', true) as setting",
    );
    expect(after.rows[0].setting ?? "").toBe("");
  });
});
