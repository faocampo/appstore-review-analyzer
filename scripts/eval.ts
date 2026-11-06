/**
 * Classifier evaluation CLI (plan §3.2, milestone M1).
 *
 *   npx tsx scripts/eval.ts --dataset eval/datasets/sample.jsonl --provider mock
 *
 * Runs one classifier over a labeled JSONL dataset, writes a Markdown and a
 * JSON report, prints a summary, and exits 1 when a --gate check fails
 * (2 on usage or runtime errors). See eval/README.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { getClassifier } from "@/lib/classifiers/index";
import { loadDataset } from "@/lib/eval/dataset";
import { parseReportJson, renderJson, renderMarkdown, renderSummary } from "@/lib/eval/report";
import {
  GATE_KEYS,
  checkGate,
  compareReports,
  evaluateProvider,
  parseGateArgs,
} from "@/lib/eval/run";

const PROVIDERS = ["mock", "jev", "openrouter"] as const;
type ProviderId = (typeof PROVIDERS)[number];

const USAGE = `Usage: npx tsx scripts/eval.ts --dataset <file.jsonl> --provider <${PROVIDERS.join("|")}> [options]

Options:
  --model <id>              Model to evaluate (sets OPENROUTER_MODEL, or TYPESAFE_MODEL for jev)
  --baseline <report.json>  Compare with an earlier JSON report (e.g. the Jev run)
  --out <dir>               Report directory (default: eval/reports)
  --gate <key=value>        Threshold; repeatable. Keys: ${GATE_KEYS.join(", ")}
  --split <name>            Only evaluate rows whose "split" equals this value
  --batch-size <n>          Reviews per classify call (default: the provider's batch size)
  --concurrency <n>         Concurrent classify calls (default: 1, so latency is not inflated)
  --bootstrap <n>           Bootstrap iterations for the macro-F1 CI (default: 1000)
  --seed <n>                Bootstrap seed (default: 42)
  --env-file <path>         Load environment variables (API keys) from a file first
  -h, --help                Show this help`;

class UsageError extends Error {}

function positiveInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive integer (got "${raw}").`);
  }
  return value;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      baseline: { type: "string" },
      out: { type: "string", default: "eval/reports" },
      gate: { type: "string", multiple: true, default: [] },
      split: { type: "string" },
      "batch-size": { type: "string" },
      concurrency: { type: "string" },
      bootstrap: { type: "string" },
      seed: { type: "string" },
      "env-file": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.dataset) throw new UsageError("--dataset is required.");
  const providerId = values.provider?.trim().toLowerCase() as ProviderId | undefined;
  if (!providerId || !PROVIDERS.includes(providerId)) {
    throw new UsageError(`--provider must be one of ${PROVIDERS.join(", ")}.`);
  }
  if (values.model && providerId === "mock") {
    throw new UsageError("--model does not apply to the mock provider.");
  }
  const thresholds = parseGateArgs(values.gate);
  const batchSize = positiveInteger("batch-size", values["batch-size"]);
  const concurrency = positiveInteger("concurrency", values.concurrency);
  const iterations = positiveInteger("bootstrap", values.bootstrap);
  const seed = values.seed === undefined ? undefined : Number(values.seed);
  if (seed !== undefined && !Number.isInteger(seed)) {
    throw new UsageError(`--seed must be an integer (got "${values.seed}").`);
  }

  if (values["env-file"]) process.loadEnvFile(values["env-file"]);

  // Evaluate exactly one provider: a configured fallback would silently mix
  // another model's answers into the results.
  if (process.env.CLASSIFIER_FALLBACK_PROVIDER) {
    console.warn(
      `Ignoring CLASSIFIER_FALLBACK_PROVIDER=${process.env.CLASSIFIER_FALLBACK_PROVIDER} so only ${providerId} is evaluated.`,
    );
    delete process.env.CLASSIFIER_FALLBACK_PROVIDER;
  }
  process.env.CLASSIFIER_PROVIDER = providerId;
  if (values.model) {
    process.env[providerId === "jev" ? "TYPESAFE_MODEL" : "OPENROUTER_MODEL"] = values.model;
  }

  const dataset = await loadDataset(values.dataset);
  const rows = values.split ? dataset.rows.filter((row) => row.split === values.split) : dataset.rows;
  if (!rows.length) {
    throw new UsageError(
      values.split
        ? `No rows in ${values.dataset} have split "${values.split}".`
        : `${values.dataset} has no rows.`,
    );
  }

  const baseline = values.baseline
    ? parseReportJson(await readFile(values.baseline, "utf8"))
    : undefined;

  const provider = getClassifier();
  console.error(
    `Evaluating ${provider.info.provider}/${provider.info.model} on ${rows.length} reviews from ${dataset.name}…`,
  );
  const report = await evaluateProvider(provider, rows, {
    batchSize,
    concurrency,
    dataset: {
      name: values.split ? `${dataset.name} [split=${values.split}]` : dataset.name,
      sha256: dataset.sha256,
    },
    bootstrap: { iterations, seed },
  });

  const comparison = baseline ? compareReports(report, baseline) : undefined;
  const gate = Object.keys(thresholds).length ? checkGate(report, thresholds, baseline) : undefined;
  const extras = { comparison, gate };

  const outDir = resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const stem = `${report.generatedAt.replace(/[:.]/g, "-")}_${slug(`${report.provider}-${report.model}`)}`;
  const markdownPath = join(outDir, `${stem}.md`);
  const jsonPath = join(outDir, `${stem}.json`);
  await writeFile(markdownPath, renderMarkdown(report, extras));
  await writeFile(jsonPath, renderJson(report, extras));

  console.log(renderSummary(report, extras));
  console.log(`\nWrote ${markdownPath}\nWrote ${jsonPath}`);

  const firstError = report.rows.find((row) => row.error !== null)?.error;
  if (firstError) console.error(`First classification error: ${firstError}`);
  if (!report.classified) {
    console.error("No review was classified; treating the run as an error.");
    return 2;
  }
  return gate && !gate.passed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string })?.code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`\n${USAGE}`);
    }
    process.exitCode = 2;
  },
);
