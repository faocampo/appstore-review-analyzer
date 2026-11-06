/**
 * Guardrail backtest over historical Loomit experiments (read-only).
 * Usage: DATABASE_URL=... npx tsx scripts/backtest.ts --file experiments.json [--now 2026-11-06T00:00:00Z]
 * The file format is documented in docs/operations/guardrail-backtest.md.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { createPool } from "@/server/db/pool";
import { backtestFileSchema, runBacktest } from "@/server/guardrails/backtest";

const { values } = parseArgs({ options: { file: { type: "string" }, now: { type: "string" } } });
if (!values.file || !process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL=... npx tsx scripts/backtest.ts --file experiments.json [--now ISO]");
  process.exit(2);
}

const input = backtestFileSchema.parse(JSON.parse(await readFile(values.file, "utf8")));
const pool = createPool(process.env.DATABASE_URL, 2);
try {
  const summary = await runBacktest(pool, input, values.now ? new Date(values.now) : new Date());
  console.table(summary.rows.map((row) => ({ experiment: row.loomitExperimentId, status: row.status, outcome: row.outcome ?? "", ...row.metrics })));
  const percent = (value: number | null) => (value === null ? "n/a (no labeled experiments)" : `${(value * 100).toFixed(1)}%`);
  console.log(`Evaluated ${summary.evaluated}, insufficient ${summary.insufficient}, alerted ${summary.alerted}`);
  console.log(`False-positive rate (alerts on neutral experiments): ${percent(summary.falsePositiveRate)}`);
  console.log(`True-positive rate (alerts on harmful experiments): ${percent(summary.truePositiveRate)}`);
} finally {
  await pool.end();
}
