import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SYSTEM, withScope } from "@/server/db/pool";
import { backtestFileSchema, runBacktest } from "@/server/guardrails/backtest";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";
import { seedConnectedApp, testSecretStore } from "@/server/testing/fixtures";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("guardrail backtest", () => {
  it("evaluates labeled experiments read-only and reports alert rates", async () => {
    const seed = await seedConnectedApp(db.pool, testSecretStore(db.pool), "pub-bt");
    await withScope(db.pool, SYSTEM, async (client) => {
      const review = await client.query<{ id: string }>(
        `insert into review (tenant_id, app_id, store, store_review_id, created_at, date_semantics, rating, body, text_hash, source)
         values ($1, $2, 'google_play', 'x', '2026-10-01', 'created_at', 1, 'x', 'h', 'api') returning id`,
        [seed.tenant.id, seed.app.id],
      );
      await client.query(
        `insert into classification (tenant_id, review_id, text_hash, model_version, provider, model, prompt_version, taxonomy_version,
           sentiment_score, sentiment_ev, sentiment_estimator, sentiment_confidence, primary_reason, reason_confidence)
         values ($1, $2, 'h', 'm', 'mock', 'm', 'p', 't', 0, 0, 'provider_score', 1, 'ads', 1)`,
        [seed.tenant.id, review.rows[0].id],
      );
      for (const [territory, ads] of [["BR", 15], ["MX", 3]] as const) {
        await client.query(
          `insert into review_daily_rollup (tenant_id, app_id, store, day, territory, model_version, n, sum_ev, sum_ev2, sum_rating,
             sum_rating2, negative, neutral, positive, ads_negative)
           values ($1, $2, 'google_play', '2026-10-05', $3, 'm', 60, 120, 300, 180, 600, 30, 10, 20, $4)`,
          [seed.tenant.id, seed.app.id, territory, ads],
        );
      }
    });

    const arms = [
      { key: "t", role: "test" as const, values: ["BR"] },
      { key: "c", role: "control" as const, values: ["MX"] },
    ];
    const base = { loomitAppId: seed.app.loomit_app_id, attributionMode: "dimension" as const, dimension: "territory" as const, startAt: "2026-10-01T00:00:00Z", endAt: "2026-10-10T00:00:00Z" };
    const file = backtestFileSchema.parse({
      experiments: [
        { loomitPublisherId: "pub-bt", loomitExperimentId: "harmful-1", outcome: "harmful", link: { ...base, name: "A", arms } },
        { loomitPublisherId: "pub-bt", loomitExperimentId: "neutral-1", outcome: "neutral", link: { ...base, name: "B", arms: arms.map((arm) => ({ ...arm, values: [arm.role === "test" ? "MX" : "BR"] })) } },
        { loomitPublisherId: "pub-bt", loomitExperimentId: "missing", link: { ...base, loomitAppId: "nope", name: "C", arms } },
      ],
      rules: { G1: { warn: 0.1, breach: 0.2, minN: 10 } },
    });

    const summary = await runBacktest(db.pool, file, new Date("2026-10-11T00:00:00Z"));
    expect(summary.rows.map((row) => [row.loomitExperimentId, row.status])).toEqual([
      ["harmful-1", "breach"],
      ["neutral-1", "ok"],
      ["missing", "app_not_found"],
    ]);
    expect(summary).toMatchObject({ evaluated: 2, alerted: 1, falsePositiveRate: 0, truePositiveRate: 1 });

    const leftovers = await withScope(db.pool, SYSTEM, (client) =>
      client.query("select (select count(*) from experiment)::int as experiments, (select count(*) from guardrail_rule)::int as rules"),
    );
    expect(leftovers.rows[0]).toEqual({ experiments: 0, rules: 0 });
  });
});
