import { PgBoss, type Job } from "pg-boss";

import type { ClassifierProvider } from "@/lib/classifiers/provider";
import { SYSTEM, withScope, type Pool } from "@/server/db/pool";
import { deliverAlert } from "@/server/guardrails/alerts";
import { evaluateExperiment } from "@/server/guardrails/evaluate";
import { classifyApp } from "@/server/ingestion/classify";
import { importPlayReports, importUpload, type ObjectStorage } from "@/server/ingestion/imports";
import { syncConnection } from "@/server/ingestion/sync";
import { exportRollups } from "@/server/jobs/export";
import { refreshGauges } from "@/server/jobs/gauges";
import { metrics } from "@/server/metrics";
import { currentModelVersion, rebuildRollups } from "@/server/repo/rollups";
import type { SecretStore } from "@/server/secrets/store";

export const QUEUES = {
  sync: "sync",
  scheduleSyncs: "schedule-syncs",
  classify: "classify",
  rollup: "rollup",
  importUpload: "import-upload",
  importReports: "import-play-reports",
  evaluate: "evaluate",
  scheduleEvaluations: "schedule-evaluations",
  deliverAlert: "deliver-alert",
  export: "export",
  gauges: "refresh-gauges",
  retention: "retention",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobDeps {
  pool: Pool;
  secrets: SecretStore;
  classifier: () => ClassifierProvider;
  uploads?: ObjectStorage;
  exports?: ObjectStorage;
  notify: { url?: string; secret?: string };
  alertCooldownHours: number;
  now?: () => Date;
}

/** Minimal sender interface so handlers can enqueue follow-ups (and tests can capture them). */
export interface Sender {
  send(name: QueueName, data: object, options?: { singletonKey?: string; startAfter?: number }): Promise<unknown>;
}

type Handler = (data: Record<string, unknown>, deps: JobDeps, sender: Sender) => Promise<unknown>;

const str = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new Error("job is missing a required string field");
  return value;
};

/** Job handlers. Exported for direct testing without a queue. */
export const handlers: Record<QueueName, Handler> = {
  async [QUEUES.sync](data, deps, sender) {
    const mode = data.mode === "backfill" || data.mode === "incremental" ? data.mode : undefined;
    const result = await syncConnection(deps, str(data.connectionId), mode);
    if (result.status === "succeeded") {
      await sender.send(QUEUES.classify, { appId: result.appId, tenantId: result.tenantId }, { singletonKey: result.appId });
      if (result.days.length) await sender.send(QUEUES.rollup, { appId: result.appId, days: result.days });
    }
    return result;
  },

  async [QUEUES.scheduleSyncs](_data, deps, sender) {
    const { rows } = await withScope(deps.pool, SYSTEM, (client) =>
      client.query<{ id: string }>("select id from store_connection where status in ('active', 'pending', 'error')"),
    );
    for (const row of rows) {
      await sender.send(QUEUES.sync, { connectionId: row.id }, { singletonKey: row.id });
    }
    return { scheduled: rows.length };
  },

  async [QUEUES.classify](data, deps, sender) {
    const result = await classifyApp(deps, { appId: str(data.appId), tenantId: str(data.tenantId) });
    // More pending work (budget allowing): continue in a follow-up job.
    if (!result.budgetExhausted && result.classified + result.failed >= 2_000) {
      await sender.send(QUEUES.classify, { appId: result.appId, tenantId: str(data.tenantId) }, { singletonKey: result.appId, startAfter: 5 });
    }
    return result;
  },

  async [QUEUES.rollup](data, deps) {
    const appId = str(data.appId);
    const days = Array.isArray(data.days) ? data.days.filter((day): day is string => typeof day === "string") : [];
    return withScope(deps.pool, SYSTEM, async (client) => {
      const modelVersion = await currentModelVersion(client, appId);
      if (!modelVersion || !days.length) return { buckets: 0 };
      return { buckets: await rebuildRollups(client, { appId, modelVersion, days }) };
    });
  },

  async [QUEUES.importUpload](data, deps, sender) {
    const result = await importUpload(deps, str(data.uploadId));
    await sender.send(QUEUES.classify, { appId: result.appId, tenantId: result.tenantId }, { singletonKey: result.appId });
    if (result.days.length) await sender.send(QUEUES.rollup, { appId: result.appId, days: result.days });
    return result;
  },

  async [QUEUES.importReports](data, deps, sender) {
    const appId = str(data.appId);
    const result = await importPlayReports(deps, { appId, months: typeof data.months === "number" ? data.months : undefined });
    await sender.send(QUEUES.classify, { appId, tenantId: str(data.tenantId) }, { singletonKey: appId });
    if (result.days.length) await sender.send(QUEUES.rollup, { appId, days: result.days });
    return result;
  },

  async [QUEUES.evaluate](data, deps, sender) {
    const outcome = await withScope(deps.pool, SYSTEM, (client) =>
      evaluateExperiment(client, str(data.experimentId), {
        now: deps.now?.(),
        alertCooldownHours: deps.alertCooldownHours,
      }),
    );
    if (!outcome) return { skipped: true };
    metrics.guardrailEvaluations.inc({ status: outcome.status });
    for (const alertId of outcome.newAlerts) await sender.send(QUEUES.deliverAlert, { alertId });
    return { status: outcome.status, alerts: outcome.newAlerts.length };
  },

  async [QUEUES.scheduleEvaluations](_data, deps, sender) {
    const { rows } = await withScope(deps.pool, SYSTEM, (client) =>
      client.query<{ id: string }>(
        `select id from experiment
         where status = 'active' or (end_at is not null and end_at > now() - interval '2 days')`,
      ),
    );
    for (const row of rows) await sender.send(QUEUES.evaluate, { experimentId: row.id }, { singletonKey: row.id });
    return { scheduled: rows.length };
  },

  async [QUEUES.deliverAlert](data, deps) {
    return withScope(deps.pool, SYSTEM, (client) => deliverAlert(client, str(data.alertId), deps.notify, deps.now));
  },

  async [QUEUES.export](_data, deps) {
    if (!deps.exports) return { skipped: true };
    return exportRollups(deps.pool, deps.exports, deps.now?.() ?? new Date());
  },

  async [QUEUES.gauges](_data, deps) {
    await refreshGauges(deps.pool);
    return { ok: true };
  },

  async [QUEUES.retention](_data, deps) {
    const { rowCount } = await withScope(deps.pool, SYSTEM, (client) =>
      client.query(
        `delete from review r using tenant t
         where r.tenant_id = t.id and r.created_at < now() - make_interval(days => t.retention_days)`,
      ),
    );
    return { deleted: rowCount ?? 0 };
  },
};

const RETRY_POLICY: Partial<Record<QueueName, { retryLimit: number; retryDelay: number; retryBackoff: boolean }>> = {
  [QUEUES.sync]: { retryLimit: 2, retryDelay: 60, retryBackoff: true },
  [QUEUES.deliverAlert]: { retryLimit: 8, retryDelay: 30, retryBackoff: true },
  [QUEUES.importUpload]: { retryLimit: 1, retryDelay: 30, retryBackoff: false },
  [QUEUES.importReports]: { retryLimit: 2, retryDelay: 120, retryBackoff: true },
  [QUEUES.classify]: { retryLimit: 3, retryDelay: 60, retryBackoff: true },
};

export function createBoss(connectionString: string): PgBoss {
  const boss = new PgBoss({ connectionString, application_name: "reviewsignal-jobs" });
  boss.on("error", (error) => console.error("[reviewsignal] pg-boss error", error));
  return boss;
}

export function senderFor(boss: PgBoss): Sender {
  return {
    send: (name, data, options) => boss.send(name, data, options ?? {}),
  };
}

/** Creates queues, registers handlers and schedules. Returns once workers are polling. */
export async function startWorkers(
  boss: PgBoss,
  deps: JobDeps,
  schedules: { sync: string; evaluate: string; export: string },
): Promise<void> {
  const sender = senderFor(boss);
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name, RETRY_POLICY[name] ?? { retryLimit: 1, retryDelay: 30, retryBackoff: false });
    await boss.work<Record<string, unknown>>(name, async (jobs: Job<Record<string, unknown>>[]) => {
      for (const job of jobs) {
        try {
          await handlers[name](job.data ?? {}, deps, sender);
          metrics.jobs.inc({ queue: name, outcome: "completed" });
        } catch (error) {
          metrics.jobs.inc({ queue: name, outcome: "failed" });
          console.error(`[reviewsignal] job ${name} ${job.id} failed`, error);
          throw error;
        }
      }
    });
  }
  await boss.schedule(QUEUES.scheduleSyncs, schedules.sync);
  await boss.schedule(QUEUES.scheduleEvaluations, schedules.evaluate);
  await boss.schedule(QUEUES.export, schedules.export);
  await boss.schedule(QUEUES.gauges, "*/5 * * * *");
  await boss.schedule(QUEUES.retention, "45 4 * * *");
}
