import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LinkExperimentRequest } from "@/server/api/contracts";
import { SYSTEM, withScope } from "@/server/db/pool";
import { deliverAlert, signPayload } from "@/server/guardrails/alerts";
import {
  evaluateExperiment,
  evaluateMetrics,
  guardrailView,
  linkExperiment,
  overallStatus,
} from "@/server/guardrails/evaluate";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";
import { seedConnectedApp, testSecretStore } from "@/server/testing/fixtures";

let db: TestDatabase;
const MODEL = "mock/mock-rules-v1/rules-v2/reasons-v2";

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface DayRow {
  day: string;
  appVersion?: string;
  territory?: string;
  n: number;
  negative: number;
  adsNegative: number;
  meanEv: number;
  meanRating: number;
}

async function seedRollups(tenantId: string, appId: string, rows: DayRow[]) {
  await withScope(db.pool, SYSTEM, async (client) => {
    // A classification row makes MODEL the app's current model version.
    const review = await client.query<{ id: string }>(
      `insert into review (tenant_id, app_id, store, store_review_id, created_at, date_semantics, rating, body, text_hash, source, app_version)
       values ($1, $2, 'google_play', $3, '2026-10-20T00:00:00Z', 'created_at', 3, 'x', 'h', 'api', '6.4.0') returning id`,
      [tenantId, appId, `seed-${Math.random()}`],
    );
    await client.query(
      `insert into classification (tenant_id, review_id, text_hash, model_version, provider, model, prompt_version, taxonomy_version,
         sentiment_score, sentiment_ev, sentiment_estimator, sentiment_confidence, primary_reason, reason_confidence)
       values ($1, $2, 'h', $3, 'mock', 'mock-rules-v1', 'rules-v2', 'reasons-v2', 2, 2, 'provider_score', 0.7, 'other_unclear', 0.7)`,
      [tenantId, review.rows[0].id, MODEL],
    );
    for (const row of rows) {
      await client.query(
        `insert into review_daily_rollup (tenant_id, app_id, store, day, app_version, territory, model_version, n, sum_ev, sum_ev2,
           sum_rating, sum_rating2, negative, neutral, positive, ads_negative)
         values ($1, $2, 'google_play', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $7::int - $12::int, $13)`,
        [
          tenantId, appId, row.day, row.appVersion ?? "", row.territory ?? "", MODEL, row.n,
          row.meanEv * row.n, (row.meanEv ** 2 + 0.8) * row.n, row.meanRating * row.n, (row.meanRating ** 2 + 1.2) * row.n,
          row.negative, row.adsNegative,
        ],
      );
    }
  });
}

function days(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10),
  );
}

describe("guardrail metrics", () => {
  const totals = (overrides: Partial<Parameters<typeof evaluateMetrics>[0]> = {}) => ({
    n: 200, sumEv: 400, sumEv2: 960, sumRating: 600, sumRating2: 2040, negative: 60, adsNegative: 12,
    days: 10, dau: 50_000, daily: new Map(), ...overrides,
  });
  const rules = {
    G1: { warn: 0.05, breach: 0.1, minN: 20 },
    G2: { warn: 0.15, breach: 0.3, minN: 20 },
    G3: { warn: 0.25, breach: 0.5, minN: 10 },
    G4: { warn: 0.15, breach: 0.3, minN: 20 },
  };

  it("flags breaches in the harmful direction only", () => {
    const harmed = evaluateMetrics(
      totals({ adsNegative: 36, sumEv: 300, sumEv2: 610, sumRating: 500, sumRating2: 1490 }),
      totals(),
      rules,
    );
    expect(harmed.map((item) => [item.metric, item.status])).toEqual([
      ["G1", "breach"],
      ["G2", "breach"],
      ["G3", "breach"],
      ["G4", "breach"],
    ]);
    expect(overallStatus(harmed)).toBe("breach");

    const improved = evaluateMetrics(totals(), totals({ adsNegative: 36, sumEv: 300, sumEv2: 610 }), rules);
    expect(improved.every((item) => item.status === "ok")).toBe(true);
    expect(overallStatus(improved)).toBe("ok");
  });

  it("reports warn for moderate changes and insufficient below minimum N or without DAU", () => {
    const warn = evaluateMetrics(totals({ adsNegative: 120, negative: 600, n: 2000 }), totals({ adsNegative: 84, negative: 600, n: 2000 }), rules);
    expect(warn.find((item) => item.metric === "G1")?.status).toBe("warn");
    expect(overallStatus(warn)).toBe("warn");

    const thin = evaluateMetrics(totals({ n: 5, negative: 2, dau: null }), totals(), rules);
    expect(thin.map((item) => item.status)).toEqual(["insufficient", "insufficient", "insufficient", "insufficient"]);
    expect(thin.find((item) => item.metric === "G3")?.note).toContain("DAU");
    expect(overallStatus(thin)).toBe("insufficient");

    const fewAds = evaluateMetrics(totals({ adsNegative: 2 }), totals({ adsNegative: 3 }), rules);
    expect(fewAds.find((item) => item.metric === "G3")?.note).toContain("ad-complaint reviews");
  });
});

describe("experiment evaluation", () => {
  const now = new Date("2026-11-06T00:00:00Z");

  it("compares dimension arms, records confounders and alerts once per cool-down", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    const window = days("2026-10-20", 14);
    await seedRollups(seed.tenant.id, seed.app.id, [
      ...window.map((day) => ({ day, territory: "BR", n: 30, negative: 12, adsNegative: 7, meanEv: 1.6, meanRating: 2.8 })),
      ...window.map((day) => ({ day, territory: "MX", n: 30, negative: 10, adsNegative: 2, meanEv: 2.3, meanRating: 3.5 })),
    ]);
    const body: LinkExperimentRequest = {
      loomitAppId: seed.app.loomit_app_id,
      name: "Interstitial frequency +1",
      attributionMode: "dimension",
      dimension: "territory",
      arms: [
        { key: "treatment", role: "test", values: ["BR"], dau: 40_000 },
        { key: "control", role: "control", values: ["MX"], dau: 40_000 },
      ],
      startAt: "2026-10-20T00:00:00Z",
      endAt: "2026-11-02T23:59:59Z",
    };
    const experiment = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) =>
      linkExperiment(client, { tenantId: seed.tenant.id, appId: seed.app.id, loomitExperimentId: "exp-1", body }),
    );

    const outcome = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) =>
      evaluateExperiment(client, experiment.id, { now }),
    );
    expect(outcome?.status).toBe("breach");
    expect(outcome?.results.map((item) => item.status)).toEqual(["breach", "breach", "breach", "breach"]);
    expect(outcome?.newAlerts).toHaveLength(4);

    const repeat = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) =>
      evaluateExperiment(client, experiment.id, { now }),
    );
    expect(repeat?.newAlerts).toHaveLength(0);

    const view = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) => guardrailView(client, "exp-1"));
    expect(view).toMatchObject({ status: "breach", attributionMode: "dimension", loomitExperimentId: "exp-1" });
    expect(view?.attributionLabel).toContain("Dimension-attributable");
    expect(view?.confounders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "release", detail: expect.stringContaining("6.4.0") }),
        expect.objectContaining({ kind: "coverage" }),
      ]),
    );
    expect(view?.series[0]).toEqual({ day: "2026-10-20", test: 0.5833, control: 0.2, testN: 12, controlN: 10 });
    expect(view?.arms).toEqual([
      { key: "treatment", role: "test", values: ["BR"], dau: 40_000 },
      { key: "control", role: "control", values: ["MX"], dau: 40_000 },
    ]);
    expect(view?.metrics[0]).toMatchObject({ harm: "increase", unit: "share" });

    // Delivery: signed POST, marked delivered, then skipped.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const alertId = outcome!.newAlerts[0];
    const delivered = await withScope(db.pool, SYSTEM, (client) =>
      deliverAlert(client, alertId, { url: "https://loomit.example.test/notify", secret: "s3cret" }, () => now),
    );
    expect(delivered).toBe("delivered");
    const [, init] = fetchMock.mock.calls[0];
    const timestamp = init.headers["X-ReviewSignal-Timestamp"];
    expect(init.headers["X-ReviewSignal-Signature"]).toBe(signPayload("s3cret", timestamp, init.body));
    expect(JSON.parse(init.body)).toMatchObject({ loomitExperimentId: "exp-1", metric: "G1", status: "breach" });
    await expect(
      withScope(db.pool, SYSTEM, (client) => deliverAlert(client, alertId, { url: "https://x", secret: "s" })),
    ).resolves.toBe("skipped");

    // Failed delivery throws for queue retry and records the error.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(
      withScope(db.pool, SYSTEM, (client) => deliverAlert(client, outcome!.newAlerts[1], { url: "https://x", secret: "s" })),
    ).rejects.toThrow("HTTP 500");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(
      withScope(db.pool, SYSTEM, (client) => deliverAlert(client, outcome!.newAlerts[1], { url: "https://x", secret: "s" })),
    ).rejects.toThrow("ECONNRESET");
    await expect(
      withScope(db.pool, SYSTEM, (client) => deliverAlert(client, outcome!.newAlerts[2], {})),
    ).resolves.toBe("skipped");
  });

  it("uses a baseline window for pre/post experiments and honors per-app rules", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    await seedRollups(seed.tenant.id, seed.app.id, [
      ...days("2026-10-01", 14).map((day) => ({ day, n: 25, negative: 8, adsNegative: 2, meanEv: 2.2, meanRating: 3.4 })),
      ...days("2026-10-20", 14).map((day) => ({ day, n: 25, negative: 8, adsNegative: 3, meanEv: 2.15, meanRating: 3.35 })),
    ]);
    await withScope(db.pool, SYSTEM, (client) =>
      client.query(
        "insert into guardrail_rule (tenant_id, app_id, metric, warn_threshold, breach_threshold, min_n) values ($1, $2, 'G1', 0.01, 0.02, 5)",
        [seed.tenant.id, seed.app.id],
      ),
    );
    const experiment = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) =>
      linkExperiment(client, {
        tenantId: seed.tenant.id,
        appId: seed.app.id,
        loomitExperimentId: "exp-pp",
        body: {
          loomitAppId: seed.app.loomit_app_id,
          name: "Floor change",
          attributionMode: "pre_post",
          arms: [{ key: "all", role: "test" }],
          startAt: "2026-10-20T00:00:00Z",
          baselineStart: "2026-10-01T00:00:00Z",
          baselineEnd: "2026-10-14T23:59:59Z",
        },
      }),
    );
    const outcome = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) =>
      evaluateExperiment(client, experiment.id, { now: new Date("2026-11-02T23:00:00Z") }),
    );
    const g1 = outcome?.results.find((item) => item.metric === "G1");
    expect(g1?.thresholds).toEqual({ warn: 0.01, breach: 0.02, minN: 5 });
    expect(g1?.status).toBe("breach");
    expect(outcome?.results.find((item) => item.metric === "G2")?.status).toBe("ok");

    const view = await withScope(db.pool, { tenantId: seed.tenant.id }, (client) => guardrailView(client, "exp-pp"));
    expect(view?.baseline).toEqual({ start: "2026-10-01T00:00:00.000Z", end: "2026-10-14T23:59:59.000Z" });
    expect(view?.attributionLabel).toContain("Pre/post");
  });

  it("handles unknown experiments and apps without classifications", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    await withScope(db.pool, SYSTEM, async (client) => {
      await expect(evaluateExperiment(client, "00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
      await expect(guardrailView(client, "missing")).resolves.toBeNull();
      const experiment = await linkExperiment(client, {
        tenantId: seed.tenant.id,
        appId: seed.app.id,
        loomitExperimentId: "exp-empty",
        body: {
          loomitAppId: seed.app.loomit_app_id,
          name: "Empty",
          attributionMode: "pre_post",
          arms: [{ key: "all", role: "test" }],
          startAt: "2026-10-20T00:00:00Z",
          baselineStart: "2026-10-01T00:00:00Z",
          baselineEnd: "2026-10-14T00:00:00Z",
        },
      });
      const outcome = await evaluateExperiment(client, experiment.id);
      expect(outcome?.status).toBe("insufficient");
      const view = await guardrailView(client, "exp-empty");
      expect(view?.confounders).toContainEqual({ kind: "model_change", detail: "No classified reviews yet for this app." });
    });
  });
});
