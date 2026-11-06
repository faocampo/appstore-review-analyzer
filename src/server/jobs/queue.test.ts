import { parquetReadObjects } from "hyparquet";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createMockClassifier } from "@/lib/classifiers/mock";
import { SYSTEM, withScope } from "@/server/db/pool";
import type { ObjectStorage } from "@/server/ingestion/imports";
import { QUEUES, createBoss, handlers, startWorkers, type JobDeps, type QueueName, type Sender } from "@/server/jobs/queue";
import { registry } from "@/server/metrics";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";
import { appleReviewPayload, seedConnectedApp, testSecretStore } from "@/server/testing/fixtures";

vi.mock("@/lib/credentials/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/credentials/google")>()),
  mintGoogleAccessToken: vi.fn().mockResolvedValue("google-token"),
}));

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  async presignPut(key: string) {
    return `https://example.test/${key}`;
  }
  async get(key: string) {
    return this.objects.get(key) ?? new Uint8Array();
  }
  async put(key: string, body: Uint8Array | string) {
    this.objects.set(key, typeof body === "string" ? Buffer.from(body) : body);
  }
}

function capture(): Sender & { sent: Array<{ name: QueueName; data: object }> } {
  const sent: Array<{ name: QueueName; data: object }> = [];
  return { sent, send: async (name, data) => void sent.push({ name, data }) };
}

function deps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    pool: db.pool,
    secrets: testSecretStore(db.pool),
    classifier: createMockClassifier,
    notify: {},
    alertCooldownHours: 24,
    now: () => new Date("2026-11-06T12:00:00Z"),
    ...overrides,
  };
}

describe("job handlers", () => {
  it("chains sync → classify → rollup and schedules syncs", async () => {
    const jobDeps = deps();
    const seed = await seedConnectedApp(db.pool, jobDeps.secrets as ReturnType<typeof testSecretStore>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(appleReviewPayload([{ id: "r1", createdDate: "2026-11-05T10:00:00Z" }]))),
    );
    const sender = capture();

    await handlers[QUEUES.scheduleSyncs]({}, jobDeps, sender);
    expect(sender.sent.filter((item) => item.name === QUEUES.sync)).toHaveLength(2);

    sender.sent.length = 0;
    await handlers[QUEUES.sync]({ connectionId: seed.apple.id }, jobDeps, sender);
    expect(sender.sent.map((item) => item.name)).toEqual([QUEUES.classify, QUEUES.rollup]);

    const classify = await handlers[QUEUES.classify](sender.sent[0].data as Record<string, unknown>, jobDeps, sender);
    expect(classify).toMatchObject({ classified: 1 });
    const rollup = await handlers[QUEUES.rollup](sender.sent[1].data as Record<string, unknown>, jobDeps, sender);
    expect(rollup).toEqual({ buckets: 1 });
    await expect(handlers[QUEUES.rollup]({ appId: seed.app.id, days: [] }, jobDeps, sender)).resolves.toEqual({ buckets: 0 });
    await expect(handlers[QUEUES.sync]({}, jobDeps, sender)).rejects.toThrow("missing a required string field");
  });

  it("exports yesterday's rollups as Parquet and refreshes gauges", async () => {
    const exports = new MemoryStorage();
    const jobDeps = deps({ exports });
    const result = (await handlers[QUEUES.export]({}, jobDeps, capture())) as { key: string; rows: number };
    expect(result.key).toBe("rollups/day=2026-11-05/rollups.parquet");
    expect(result.rows).toBeGreaterThan(0);
    const bytes = exports.objects.get(result.key)!;
    const rows = await parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    expect(rows[0]).toMatchObject({ day: "2026-11-05", store: "apple_app_store", reviews: 1 });

    await expect(handlers[QUEUES.export]({}, deps(), capture())).resolves.toEqual({ skipped: true });
    await handlers[QUEUES.gauges]({}, jobDeps, capture());
    const text = await registry.getSingleMetricAsString("reviewsignal_connections");
    expect(text).toContain('status="active"');
    await expect(handlers[QUEUES.retention]({}, jobDeps, capture())).resolves.toEqual({ deleted: 0 });
  });

  it("evaluates scheduled experiments, enqueues alert delivery and skips unknown ones", async () => {
    const jobDeps = deps();
    const sender = capture();
    await expect(
      handlers[QUEUES.evaluate]({ experimentId: "00000000-0000-0000-0000-000000000000" }, jobDeps, sender),
    ).resolves.toEqual({ skipped: true });
    await expect(handlers[QUEUES.scheduleEvaluations]({}, jobDeps, sender)).resolves.toEqual({ scheduled: 0 });
    await expect(handlers[QUEUES.importUpload]({ uploadId: "00000000-0000-0000-0000-000000000000" }, jobDeps, sender)).rejects.toThrow(
      "not configured",
    );
  });
});

describe("job handlers: imports, experiments and alerts", () => {
  it("runs Play report imports, evaluations and alert delivery through handlers", async () => {
    const jobDeps = deps({ notify: { url: "https://loomit.example.test/notify", secret: "s" } });
    const seed = await seedConnectedApp(db.pool, jobDeps.secrets as ReturnType<typeof testSecretStore>);
    await withScope(db.pool, SYSTEM, (client) =>
      client.query("update app set play_reports_bucket = 'pubsite_prod_1' where id = $1", [seed.app.id]),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [] })));
    const sender = capture();
    await expect(
      handlers[QUEUES.importReports]({ appId: seed.app.id, tenantId: seed.tenant.id, months: 3 }, jobDeps, sender),
    ).resolves.toMatchObject({ files: 0 });
    expect(sender.sent.map((item) => item.name)).toEqual([QUEUES.classify]);

    const experimentId = await withScope(db.pool, SYSTEM, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into experiment (tenant_id, app_id, loomit_experiment_id, name, attribution_mode, arms, start_at, baseline_start, baseline_end)
         values ($1, $2, 'exp-jobs', 'Jobs', 'pre_post', '[{"key":"all","role":"test"}]', now() - interval '3 days', now() - interval '20 days', now() - interval '10 days')
         returning id`,
        [seed.tenant.id, seed.app.id],
      );
      return rows[0].id;
    });
    sender.sent.length = 0;
    await expect(handlers[QUEUES.scheduleEvaluations]({}, jobDeps, sender)).resolves.toEqual({ scheduled: 1 });
    await expect(handlers[QUEUES.evaluate]({ experimentId }, jobDeps, sender)).resolves.toMatchObject({ status: "insufficient", alerts: 0 });

    const alertId = await withScope(db.pool, SYSTEM, async (client) => {
      const evaluation = await client.query<{ id: string }>("select id from guardrail_evaluation where experiment_id = $1", [experimentId]);
      const { rows } = await client.query<{ id: string }>(
        `insert into alert (tenant_id, experiment_id, evaluation_id, metric, status, dedup_key)
         values ($1, $2, $3, 'G1', 'warn', 'k') returning id`,
        [seed.tenant.id, experimentId, evaluation.rows[0].id],
      );
      return rows[0].id;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(handlers[QUEUES.deliverAlert]({ alertId }, jobDeps, sender)).resolves.toBe("delivered");

    await withScope(db.pool, SYSTEM, (client) =>
      client.query("update store_connection set status = 'disabled' where id = $1", [seed.apple.id]),
    );
    await expect(handlers[QUEUES.sync]({ connectionId: seed.apple.id, mode: "incremental" }, jobDeps, sender)).resolves.toMatchObject({
      status: "succeeded",
      upserted: 0,
    });
  });
});

describe("pg-boss worker", () => {
  it("creates queues, schedules and processes a job end to end", async () => {
    const boss = createBoss(db.url);
    await boss.start();
    try {
      const jobDeps = deps();
      await startWorkers(boss, jobDeps, { sync: "0 */2 * * *", evaluate: "15 * * * *", export: "30 3 * * *" });
      const schedules = await boss.getSchedules();
      expect(schedules.map((item) => item.name).sort()).toEqual(
        [QUEUES.export, QUEUES.retention, QUEUES.scheduleEvaluations, QUEUES.scheduleSyncs].sort(),
      );
      const { startGaugeLoop } = await import("@/server/jobs/gauges");
      const stop = startGaugeLoop(db.pool, boss, 50);
      await vi.waitFor(async () => {
        expect(await registry.getSingleMetricAsString("reviewsignal_queue_depth")).toContain('queue="sync"');
      });
      stop();
      const id = await boss.send(QUEUES.gauges, {});
      await vi.waitFor(
        async () => {
          const job = await boss.getJobById(QUEUES.gauges, id!);
          expect(job?.state).toBe("completed");
        },
        { timeout: 15_000, interval: 250 },
      );
    } finally {
      await boss.stop({ graceful: false });
    }
    const count = await withScope(db.pool, SYSTEM, (client) => client.query("select 1"));
    expect(count.rowCount).toBe(1);
  }, 30_000);
});
