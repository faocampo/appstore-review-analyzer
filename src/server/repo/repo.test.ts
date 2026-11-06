import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SYSTEM, withScope } from "@/server/db/pool";
import { tokenForConnection } from "@/server/ingestion/credentials";
import { getConnection, markConnection } from "@/server/repo/apps";
import { coverageDays, daysBetween, recordCoverage } from "@/server/repo/coverage";
import { getTenant } from "@/server/repo/tenants";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";
import { seedConnectedApp, testSecretStore } from "@/server/testing/fixtures";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("repositories", () => {
  it("reads tenants, never downgrades complete coverage, and lists coverage days", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    await withScope(db.pool, SYSTEM, async (client) => {
      expect(await getTenant(client, seed.tenant.id)).toMatchObject({ loomit_publisher_id: seed.tenant.loomit_publisher_id });
      expect(await getTenant(client, "00000000-0000-0000-0000-000000000000")).toBeNull();
      const input = { tenantId: seed.tenant.id, appId: seed.app.id, store: "google_play", source: "api" };
      await recordCoverage(client, { ...input, days: ["2026-11-01", "2026-11-02"], status: "complete" });
      await recordCoverage(client, { ...input, days: ["2026-11-02", "2026-11-03"], status: "partial" });
      await recordCoverage(client, { ...input, days: [], status: "partial" });
      expect(await coverageDays(client, seed.app.id, "2026-11-01", "2026-11-03")).toEqual([
        { day: "2026-11-01", store: "google_play", status: "complete" },
        { day: "2026-11-02", store: "google_play", status: "complete" },
        { day: "2026-11-03", store: "google_play", status: "partial" },
      ]);
    });
    expect(daysBetween("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("refuses to mint tokens without usable stored credentials", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    const connection = await withScope(db.pool, SYSTEM, (client) => getConnection(client, seed.apple.id));
    await expect(tokenForConnection(secrets, { ...connection!, secret_ref: null })).rejects.toThrow("no stored credentials");
    await secrets.put(seed.tenant.id, seed.appleRef, { issuerId: "only" });
    await expect(tokenForConnection(secrets, connection!)).rejects.toThrow("missing or malformed");
    await withScope(db.pool, SYSTEM, (client) =>
      markConnection(client, seed.apple.id, { status: "disabled", error: "off" }),
    );
    expect((await withScope(db.pool, SYSTEM, (client) => getConnection(client, seed.apple.id)))?.status).toBe("disabled");
  });
});
