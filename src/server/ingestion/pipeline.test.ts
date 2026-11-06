import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createMockClassifier } from "@/lib/classifiers/mock";
import { SYSTEM, withScope } from "@/server/db/pool";
import { classifyApp } from "@/server/ingestion/classify";
import { syncConnection } from "@/server/ingestion/sync";
import { getConnection } from "@/server/repo/apps";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";
import { appleReviewPayload, seedConnectedApp, testSecretStore } from "@/server/testing/fixtures";

vi.mock("@/lib/credentials/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/credentials/google")>()),
  mintGoogleAccessToken: vi.fn().mockResolvedValue("google-tenant-token"),
}));

let db: TestDatabase;
const NOW = new Date("2026-11-06T12:00:00Z");

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ingestion pipeline", () => {
  it("backfills Apple, then syncs incrementally from the watermark, classifies and rolls up", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          appleReviewPayload([
            { id: "a1", createdDate: "2026-11-05T10:00:00Z", rating: 1, body: "Ads after every level, can't close them" },
            { id: "a2", createdDate: "2026-11-04T10:00:00Z", rating: 5, body: "Love this game" },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          appleReviewPayload([
            { id: "a3", createdDate: "2026-11-06T09:00:00Z", rating: 2, body: "Too many ads now" },
            { id: "a1", createdDate: "2026-11-05T10:00:00Z", rating: 1, body: "Ads after every level, can't close them" },
          ], "https://api.example.test/next"),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await syncConnection({ pool: db.pool, secrets, now: () => NOW }, seed.apple.id);
    expect(first).toMatchObject({ status: "succeeded", upserted: 2, truncated: false });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/apps/123456789/customerReviews");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer ey/);

    const afterBackfill = await withScope(db.pool, SYSTEM, (client) => getConnection(client, seed.apple.id));
    expect(afterBackfill?.status).toBe("active");
    expect(afterBackfill?.backfilled_at).not.toBeNull();
    expect(afterBackfill?.watermark?.toISOString()).toBe("2026-11-05T10:00:00.000Z");

    const second = await syncConnection({ pool: db.pool, secrets, now: () => NOW }, seed.apple.id);
    // a1 is at the watermark, so pagination stops and only a3 is new.
    expect(second).toMatchObject({ status: "succeeded", upserted: 1, truncated: false });

    const classified = await classifyApp(
      { pool: db.pool, classifier: createMockClassifier },
      { appId: seed.app.id, tenantId: seed.tenant.id },
    );
    expect(classified).toMatchObject({ classified: 3, failed: 0, budgetExhausted: false });
    expect(classified.modelVersion).toBe("mock/mock-rules-v1/rules-v2/reasons-v2");

    const again = await classifyApp(
      { pool: db.pool, classifier: createMockClassifier },
      { appId: seed.app.id, tenantId: seed.tenant.id },
    );
    expect(again.classified).toBe(0);

    const rollups = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) =>
      client.query<{ day: string; n: number; negative: number; ads_negative: number; ad_subreason_counts: Record<string, number> }>(
        "select to_char(day, 'YYYY-MM-DD') as day, n, negative, ads_negative, ad_subreason_counts from review_daily_rollup order by day",
      ),
    );
    expect(rollups.rows.map((row) => [row.day, row.n, row.negative, row.ads_negative])).toEqual([
      ["2026-11-04", 1, 0, 0],
      ["2026-11-05", 1, 1, 1],
      ["2026-11-06", 1, 1, 1],
    ]);
    expect(rollups.rows[1].ad_subreason_counts).toEqual({ ad_intrusive: 1 });

    const coverage = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) =>
      client.query<{ status: string; count: string }>(
        "select status, count(*) from coverage_day where store = 'apple_app_store' group by status",
      ),
    );
    expect(coverage.rows).toEqual([{ status: "complete", count: "366" }]);
  });

  it("marks Google coverage for the API window, and records failures without leaking details", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        Response.json({
          reviews: [
            {
              reviewId: "g1",
              comments: [{ userComment: { text: "Crashes after ads", starRating: 1, lastModified: { seconds: String(Date.parse("2026-11-05T00:00:00Z") / 1000) } } }],
            },
          ],
          tokenPagination: { nextPageToken: "more" },
        }),
      ),
    );
    vi.stubEnv("GOOGLE_PLAY_MAX_PAGES", "1");

    const result = await syncConnection({ pool: db.pool, secrets, now: () => NOW }, seed.google.id, "incremental");
    expect(result).toMatchObject({ status: "succeeded", upserted: 1, truncated: true });
    const google = await withScope(db.pool, SYSTEM, (client) => getConnection(client, seed.google.id));
    expect(google?.watermark).toBeNull();
    const coverage = await withScope(db.pool, SYSTEM, (client) =>
      client.query<{ status: string; count: string }>(
        "select status, count(*) from coverage_day where app_id = $1 and store = 'google_play' group by status",
        [seed.app.id],
      ),
    );
    expect(coverage.rows).toEqual([{ status: "partial", count: "8" }]);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("STORE_MAX_RETRIES", "0");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret body", { status: 403 })));
    const failed = await syncConnection({ pool: db.pool, secrets, now: () => NOW }, seed.google.id);
    expect(failed).toMatchObject({ status: "failed", error: "Google Play returned HTTP 403." });
    const errored = await withScope(db.pool, SYSTEM, (client) => getConnection(client, seed.google.id));
    expect(errored).toMatchObject({ status: "error", last_error: "Google Play returned HTTP 403." });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow", { status: 429 })));
    const limited = await syncConnection({ pool: db.pool, secrets, now: () => NOW }, seed.google.id);
    expect(limited.error).toBe("Google Play returned HTTP 429.");
    const runs = await withScope(db.pool, SYSTEM, (client) =>
      client.query<{ rate_limited: boolean }>("select rate_limited from ingestion_run where app_id = $1 and status = 'failed' order by started_at", [seed.app.id]),
    );
    expect(runs.rows.map((row) => row.rate_limited)).toEqual([false, true]);
    consoleError.mockRestore();
  });

  it("stops classification when the daily budget is spent and rejects unknown connections", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    await withScope(db.pool, SYSTEM, async (client) => {
      await client.query("update tenant set daily_budget_usd = 0 where id = $1", [seed.tenant.id]);
      await client.query(
        `insert into review (tenant_id, app_id, store, store_review_id, created_at, date_semantics, rating, body, text_hash, source)
         values ($1, $2, 'apple_app_store', 'x', now(), 'created_at', 3, 'ok', 'h', 'api')`,
        [seed.tenant.id, seed.app.id],
      );
    });
    const result = await classifyApp(
      { pool: db.pool, classifier: createMockClassifier },
      { appId: seed.app.id, tenantId: seed.tenant.id },
    );
    expect(result).toMatchObject({ classified: 0, budgetExhausted: true });

    await expect(
      syncConnection({ pool: db.pool, secrets }, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("Connection not found.");
  });
});
