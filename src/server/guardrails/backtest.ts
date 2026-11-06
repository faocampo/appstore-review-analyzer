import { z } from "zod";

import type { GuardrailMetric, GuardrailStatus } from "@/server/api/contracts";
import { linkExperimentSchema } from "@/server/api/contracts";
import type { Pool } from "@/server/db/pool";
import { evaluateExperiment } from "@/server/guardrails/evaluate";

export const backtestFileSchema = z.object({
  /** Optional threshold overrides to calibrate, per metric. */
  rules: z
    .partialRecord(z.enum(["G1", "G2", "G3", "G4"]), z.object({ warn: z.number(), breach: z.number(), minN: z.number().int().positive() }))
    .optional(),
  experiments: z
    .array(
      z.object({
        loomitPublisherId: z.string().min(1),
        loomitExperimentId: z.string().min(1),
        link: linkExperimentSchema,
        /** Ground truth from the experiment readout, when known. */
        outcome: z.enum(["harmful", "neutral"]).optional(),
      }),
    )
    .min(1),
});

export type BacktestFile = z.infer<typeof backtestFileSchema>;

export interface BacktestRow {
  loomitExperimentId: string;
  status: GuardrailStatus | "app_not_found";
  metrics: Partial<Record<GuardrailMetric, GuardrailStatus>>;
  outcome?: "harmful" | "neutral";
}

export interface BacktestSummary {
  rows: BacktestRow[];
  evaluated: number;
  insufficient: number;
  alerted: number;
  /** Share of labeled-neutral experiments that would have alerted (warn or breach). */
  falsePositiveRate: number | null;
  /** Share of labeled-harmful experiments that would have alerted. */
  truePositiveRate: number | null;
}

/**
 * Replays guardrails over historical experiments against the data already
 * in ReviewSignal. Every experiment is linked and evaluated inside a
 * transaction that is rolled back, so a backtest never writes anything.
 */
export async function runBacktest(pool: Pool, input: BacktestFile, now = new Date()): Promise<BacktestSummary> {
  const rows: BacktestRow[] = [];
  for (const item of input.experiments) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const { rows: apps } = await client.query<{ id: string; tenant_id: string }>(
        `select a.id, a.tenant_id from app a join tenant t on t.id = a.tenant_id
         where t.loomit_publisher_id = $1 and a.loomit_app_id = $2`,
        [item.loomitPublisherId, item.link.loomitAppId],
      );
      const app = apps[0];
      if (!app) {
        rows.push({ loomitExperimentId: item.loomitExperimentId, status: "app_not_found", metrics: {}, outcome: item.outcome });
        continue;
      }
      for (const [metric, rule] of Object.entries(input.rules ?? {})) {
        await client.query(
          `insert into guardrail_rule (tenant_id, app_id, metric, warn_threshold, breach_threshold, min_n)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (tenant_id, app_id, metric) do update set warn_threshold = excluded.warn_threshold,
             breach_threshold = excluded.breach_threshold, min_n = excluded.min_n`,
          [app.tenant_id, app.id, metric, rule.warn, rule.breach, rule.minN],
        );
      }
      const { rows: experiment } = await client.query<{ id: string }>(
        `insert into experiment (tenant_id, app_id, loomit_experiment_id, name, attribution_mode, dimension, arms,
           start_at, end_at, baseline_start, baseline_end)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (tenant_id, loomit_experiment_id) do update set arms = excluded.arms
         returning id`,
        [
          app.tenant_id, app.id, `backtest:${item.loomitExperimentId}`, item.link.name, item.link.attributionMode,
          item.link.dimension ?? null, JSON.stringify(item.link.arms), item.link.startAt, item.link.endAt ?? null,
          item.link.baselineStart ?? null, item.link.baselineEnd ?? null,
        ],
      );
      const outcome = await evaluateExperiment(client, experiment[0].id, { now });
      rows.push({
        loomitExperimentId: item.loomitExperimentId,
        status: outcome?.status ?? "insufficient",
        metrics: Object.fromEntries((outcome?.results ?? []).map((result) => [result.metric, result.status])),
        outcome: item.outcome,
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }

  const alerted = (row: BacktestRow) => row.status === "warn" || row.status === "breach";
  const rate = (label: "harmful" | "neutral") => {
    const labeled = rows.filter((row) => row.outcome === label && row.status !== "app_not_found" && row.status !== "insufficient");
    return labeled.length ? labeled.filter(alerted).length / labeled.length : null;
  };
  return {
    rows,
    evaluated: rows.filter((row) => row.status !== "app_not_found").length,
    insufficient: rows.filter((row) => row.status === "insufficient").length,
    alerted: rows.filter(alerted).length,
    falsePositiveRate: rate("neutral"),
    truePositiveRate: rate("harmful"),
  };
}
