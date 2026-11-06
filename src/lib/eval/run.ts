import {
  AD_SUBREASON_KEYS,
  REASON_KEYS,
  TAXONOMY_VERSION,
  type ClassificationOutcome,
  type ClassifierProvider,
} from "@/lib/classifiers/provider";
import { toReview, type DatasetLabel, type DatasetRow } from "@/lib/eval/dataset";
import {
  accuracy,
  bootstrapMacroF1Ci,
  confusionMatrix,
  costPer1k,
  macroF1,
  meanAbsoluteError,
  perClassMetrics,
  percentile,
  quadraticWeightedKappa,
  unclassifiedRate,
  type ClassMetrics,
  type ConfidenceInterval,
  type ConfusionMatrix,
} from "@/lib/eval/metrics";
import type { AdSubreasonKey, ReasonKey, SentimentScore } from "@/lib/types";

export const REPORT_SCHEMA_VERSION = 1;

/** Pseudo-label for a review the provider failed to classify. */
export const UNCLASSIFIED = "unclassified";
/** Pseudo-label for "no ad sub-reason" in the ad sub-reason metrics. */
export const NO_AD_SUBREASON = "none";

export interface EvaluateOptions {
  /** Reviews per `classify` call. Defaults to the provider's `maxBatch`. */
  batchSize?: number;
  /** Concurrent `classify` calls. Defaults to 1 so latency is not inflated by contention. */
  concurrency?: number;
  /** Millisecond clock used to time each batch. Defaults to `performance.now`. */
  now?: () => number;
  /** ISO timestamp recorded in the report. Defaults to the current time. */
  generatedAt?: string;
  dataset?: { name: string; sha256: string };
  bootstrap?: { iterations?: number; seed?: number; confidence?: number };
}

export interface RowPrediction {
  sentiment: SentimentScore;
  primaryReason: ReasonKey;
  secondaryReason: ReasonKey | null;
  adSubreason: AdSubreasonKey | null;
  provider: string;
  model: string;
  costUsd: number | null;
}

export interface RowResult {
  id: string;
  language: string;
  truth: DatasetLabel;
  prediction: RowPrediction | null;
  error: string | null;
}

export interface LanguageBreakdown {
  n: number;
  unclassifiedRate: number | null;
  reasonMacroF1: number | null;
  reasonAccuracy: number | null;
  sentimentMae: number | null;
}

export interface EvalReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAt: string;
  dataset: { name: string | null; sha256: string | null };
  provider: string;
  model: string;
  promptVersion: string;
  taxonomyVersion: string;
  /** provider/model pairs that actually produced classifications. */
  modelsObserved: string[];
  n: number;
  classified: number;
  unclassifiedRate: number | null;
  /** Sentiment metrics over classified reviews only. */
  sentiment: {
    n: number;
    mae: number | null;
    qwk: number | null;
    accuracy: number | null;
  };
  /** Reason metrics over all reviews; unclassified reviews count as misses. */
  reason: {
    n: number;
    macroF1: number | null;
    macroF1Ci: ConfidenceInterval | null;
    accuracy: number | null;
    /** Predicted primary equals the true primary or the true secondary reason. */
    lenientAccuracy: number | null;
    perClass: ClassMetrics[];
    confusion: ConfusionMatrix;
  };
  /** Rows whose truth or prediction has an ad sub-reason. */
  adSubreason: {
    n: number;
    macroF1: number | null;
    accuracy: number | null;
    perClass: ClassMetrics[];
  };
  costPer1k: number | null;
  costTotalUsd: number | null;
  /** Share of reviews whose cost the provider reported. */
  costKnownRate: number | null;
  batchSize: number;
  batches: number;
  /** Latency of one `classify` call (one batch). */
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  wallTimeMs: number;
  byLanguage: Record<string, LanguageBreakdown>;
  warnings: string[];
  rows: RowResult[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function timedClassify(
  provider: ClassifierProvider,
  rows: DatasetRow[],
  now: () => number,
): Promise<{ outcomes: ClassificationOutcome[]; latencyMs: number }> {
  const started = now();
  let outcomes: ClassificationOutcome[];
  try {
    outcomes = await provider.classify(rows.map(toReview));
  } catch (error) {
    const message = errorText(error);
    outcomes = rows.map(() => ({ ok: false as const, error: message }));
  }
  return { outcomes, latencyMs: now() - started };
}

function toRowResult(row: DatasetRow, outcome: ClassificationOutcome | undefined): RowResult {
  const base = { id: row.id, language: row.language, truth: row.label };
  if (!outcome) return { ...base, prediction: null, error: "no result returned" };
  if (!outcome.ok) return { ...base, prediction: null, error: outcome.error };

  const classification = outcome.classification;
  return {
    ...base,
    prediction: {
      sentiment: classification.sentimentScore,
      primaryReason: classification.primaryReason,
      secondaryReason: classification.secondaryReason,
      adSubreason: classification.adSubreason,
      provider: classification.provider,
      model: classification.model,
      costUsd: classification.costUsd,
    },
    error: null,
  };
}

function reasonPairs(rows: readonly RowResult[]): { truth: string[]; predicted: string[] } {
  return {
    truth: rows.map((row) => row.truth.primaryReason),
    predicted: rows.map((row) => row.prediction?.primaryReason ?? UNCLASSIFIED),
  };
}

function sentimentMetrics(rows: readonly RowResult[]): EvalReport["sentiment"] {
  const classified = rows.filter((row) => row.prediction);
  const truth = classified.map((row) => row.truth.sentiment);
  const predicted = classified.map((row) => row.prediction?.sentiment as number);
  return {
    n: classified.length,
    mae: meanAbsoluteError(truth, predicted),
    qwk: quadraticWeightedKappa(truth, predicted, { min: 0, max: 4 }),
    accuracy: accuracy(truth, predicted),
  };
}

function adSubreasonMetrics(rows: readonly RowResult[]): EvalReport["adSubreason"] {
  const relevant = rows.filter(
    (row) => row.truth.adSubreason !== null || Boolean(row.prediction?.adSubreason),
  );
  const truth = relevant.map((row) => row.truth.adSubreason ?? NO_AD_SUBREASON);
  const predicted = relevant.map((row) =>
    row.prediction ? (row.prediction.adSubreason ?? NO_AD_SUBREASON) : UNCLASSIFIED,
  );
  const labels = AD_SUBREASON_KEYS;
  return {
    n: relevant.length,
    macroF1: macroF1(truth, predicted, { labels }),
    accuracy: accuracy(truth, predicted),
    perClass: perClassMetrics(truth, predicted, { labels }).filter(
      (metrics) => metrics.f1 !== null,
    ),
  };
}

function languageBreakdown(rows: readonly RowResult[]): Record<string, LanguageBreakdown> {
  const groups = new Map<string, RowResult[]>();
  for (const row of rows) {
    groups.set(row.language, [...(groups.get(row.language) ?? []), row]);
  }

  return Object.fromEntries(
    [...groups.keys()].sort().map((language) => {
      const group = groups.get(language) as RowResult[];
      const { truth, predicted } = reasonPairs(group);
      return [
        language,
        {
          n: group.length,
          unclassifiedRate: unclassifiedRate(group.map((row) => ({ ok: Boolean(row.prediction) }))),
          reasonMacroF1: macroF1(truth, predicted, { labels: REASON_KEYS }),
          reasonAccuracy: accuracy(truth, predicted),
          sentimentMae: sentimentMetrics(group).mae,
        },
      ];
    }),
  );
}

/** Builds the report from per-row results. Exposed for tests and re-scoring. */
export function buildReport(
  provider: Pick<ClassifierProvider, "info">,
  rows: RowResult[],
  run: {
    batchSize: number;
    latencies: number[];
    wallTimeMs: number;
    generatedAt: string;
    dataset?: { name: string; sha256: string };
    bootstrap?: EvaluateOptions["bootstrap"];
  },
): EvalReport {
  const { truth, predicted } = reasonPairs(rows);
  const labelsSeen = new Set<string>(predicted);
  const confusionLabels: string[] = labelsSeen.has(UNCLASSIFIED)
    ? [...REASON_KEYS, UNCLASSIFIED]
    : [...REASON_KEYS];
  const costs = rows.map((row) => row.prediction?.costUsd ?? null);
  const knownCosts = costs.filter((cost): cost is number => cost !== null);
  const classified = rows.filter((row) => row.prediction).length;

  const warnings: string[] = [];
  if (provider.info.taxonomyVersion !== TAXONOMY_VERSION) {
    warnings.push(
      `Provider taxonomy ${provider.info.taxonomyVersion} differs from the dataset taxonomy ${TAXONOMY_VERSION}.`,
    );
  }
  const modelsObserved = [
    ...new Set(
      rows.flatMap((row) =>
        row.prediction ? [`${row.prediction.provider}/${row.prediction.model}`] : [],
      ),
    ),
  ].sort();
  const expected = `${provider.info.provider}/${provider.info.model}`;
  if (modelsObserved.some((model) => model !== expected)) {
    warnings.push(
      `Classifications came from ${modelsObserved.join(", ")}, not only ${expected}: results mix models (fallback or provider routing).`,
    );
  }
  if (rows.length && !classified) {
    warnings.push("No review was classified; check the provider configuration.");
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: run.generatedAt,
    dataset: { name: run.dataset?.name ?? null, sha256: run.dataset?.sha256 ?? null },
    provider: provider.info.provider,
    model: provider.info.model,
    promptVersion: provider.info.promptVersion,
    taxonomyVersion: provider.info.taxonomyVersion,
    modelsObserved,
    n: rows.length,
    classified,
    unclassifiedRate: unclassifiedRate(rows.map((row) => ({ ok: Boolean(row.prediction) }))),
    sentiment: sentimentMetrics(rows),
    reason: {
      n: rows.length,
      macroF1: macroF1(truth, predicted, { labels: REASON_KEYS }),
      macroF1Ci: bootstrapMacroF1Ci(truth, predicted, {
        ...run.bootstrap,
        labels: REASON_KEYS,
      }),
      accuracy: accuracy(truth, predicted),
      lenientAccuracy: rows.length
        ? rows.filter(
            (row) =>
              row.prediction !== null &&
              (row.prediction.primaryReason === row.truth.primaryReason ||
                row.prediction.primaryReason === row.truth.secondaryReason),
          ).length / rows.length
        : null,
      perClass: perClassMetrics(truth, predicted, { labels: REASON_KEYS }).filter(
        (metrics) => metrics.f1 !== null,
      ),
      confusion: confusionMatrix(truth, predicted, confusionLabels),
    },
    adSubreason: adSubreasonMetrics(rows),
    costPer1k: costPer1k(costs, rows.length),
    costTotalUsd: knownCosts.length ? knownCosts.reduce((sum, cost) => sum + cost, 0) : null,
    costKnownRate: rows.length ? knownCosts.length / rows.length : null,
    batchSize: run.batchSize,
    batches: run.latencies.length,
    latencyMsP50: percentile(run.latencies, 50),
    latencyMsP95: percentile(run.latencies, 95),
    wallTimeMs: run.wallTimeMs,
    byLanguage: languageBreakdown(rows),
    warnings,
    rows,
  };
}

/**
 * Runs `provider` over a labeled dataset in batches and scores the result.
 * Provider failures (thrown or per-item) are recorded as unclassified rows;
 * they never abort the evaluation.
 */
export async function evaluateProvider(
  provider: ClassifierProvider,
  rows: readonly DatasetRow[],
  options: EvaluateOptions = {},
): Promise<EvalReport> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? provider.maxBatch));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const now = options.now ?? (() => performance.now());
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const batches = chunk(rows, batchSize);
  const results: RowResult[] = [];
  const latencies: number[] = [];
  const started = now();

  for (const wave of chunk(batches, concurrency)) {
    const timed = await Promise.all(wave.map((batch) => timedClassify(provider, batch, now)));
    timed.forEach(({ outcomes, latencyMs }, waveIndex) => {
      latencies.push(latencyMs);
      wave[waveIndex].forEach((row, rowIndex) => {
        results.push(toRowResult(row, outcomes[rowIndex]));
      });
    });
  }

  return buildReport(provider, results, {
    batchSize,
    latencies,
    wallTimeMs: now() - started,
    generatedAt,
    dataset: options.dataset,
    bootstrap: options.bootstrap,
  });
}

export type MetricVerdict = "better" | "worse" | "same" | "n/a";

export interface MetricDelta {
  key: string;
  label: string;
  higherIsBetter: boolean;
  candidate: number | null;
  baseline: number | null;
  delta: number | null;
  verdict: MetricVerdict;
}

export interface ReportComparison {
  candidate: string;
  baseline: string;
  metrics: MetricDelta[];
  warnings: string[];
}

const COMPARED_METRICS: Array<{
  key: string;
  label: string;
  higherIsBetter: boolean;
  value: (report: EvalReport) => number | null;
}> = [
  { key: "reasonMacroF1", label: "Reason macro-F1", higherIsBetter: true, value: (r) => r.reason.macroF1 },
  { key: "reasonAccuracy", label: "Reason accuracy", higherIsBetter: true, value: (r) => r.reason.accuracy },
  {
    key: "adSubreasonMacroF1",
    label: "Ad sub-reason macro-F1",
    higherIsBetter: true,
    value: (r) => r.adSubreason.macroF1,
  },
  { key: "sentimentMae", label: "Sentiment MAE", higherIsBetter: false, value: (r) => r.sentiment.mae },
  { key: "sentimentQwk", label: "Sentiment QWK", higherIsBetter: true, value: (r) => r.sentiment.qwk },
  {
    key: "unclassifiedRate",
    label: "Unclassified rate",
    higherIsBetter: false,
    value: (r) => r.unclassifiedRate,
  },
  { key: "costPer1k", label: "Cost per 1k (USD)", higherIsBetter: false, value: (r) => r.costPer1k },
  { key: "latencyMsP95", label: "Batch latency p95 (ms)", higherIsBetter: false, value: (r) => r.latencyMsP95 },
];

const SAME_EPSILON = 1e-9;

export function describeReport(report: Pick<EvalReport, "provider" | "model" | "promptVersion">): string {
  return `${report.provider}/${report.model} (${report.promptVersion})`;
}

/** Metric-by-metric comparison of a candidate report against a baseline. */
export function compareReports(candidate: EvalReport, baseline: EvalReport): ReportComparison {
  const warnings: string[] = [];
  if (candidate.dataset.sha256 !== baseline.dataset.sha256) {
    warnings.push("The reports were produced on different datasets (sha256 differs); deltas are not comparable.");
  } else if (candidate.n !== baseline.n) {
    warnings.push(`The reports cover different review counts (${candidate.n} vs ${baseline.n}).`);
  }
  if (candidate.taxonomyVersion !== baseline.taxonomyVersion) {
    warnings.push(
      `Taxonomy versions differ (${candidate.taxonomyVersion} vs ${baseline.taxonomyVersion}).`,
    );
  }

  const metrics = COMPARED_METRICS.map(({ key, label, higherIsBetter, value }) => {
    const candidateValue = value(candidate);
    const baselineValue = value(baseline);
    if (candidateValue === null || baselineValue === null) {
      return { key, label, higherIsBetter, candidate: candidateValue, baseline: baselineValue, delta: null, verdict: "n/a" as const };
    }
    const delta = candidateValue - baselineValue;
    let verdict: MetricVerdict = "same";
    if (Math.abs(delta) > SAME_EPSILON) {
      verdict = delta > 0 === higherIsBetter ? "better" : "worse";
    }
    return { key, label, higherIsBetter, candidate: candidateValue, baseline: baselineValue, delta, verdict };
  });

  return {
    candidate: describeReport(candidate),
    baseline: describeReport(baseline),
    metrics,
    warnings,
  };
}

export interface GateThresholds {
  minReasonMacroF1?: number;
  maxSentimentMae?: number;
  minQwk?: number;
  maxCostPer1k?: number;
  maxUnclassifiedRate?: number;
  minAdSubreasonMacroF1?: number;
  maxLatencyMsP95?: number;
  /** Allowed macro-F1 drop versus the baseline; 0 means "match or beat". */
  maxReasonMacroF1DropVsBaseline?: number;
  /** Allowed sentiment MAE increase versus the baseline. */
  maxSentimentMaeIncreaseVsBaseline?: number;
  /** Allowed QWK drop versus the baseline. */
  maxQwkDropVsBaseline?: number;
}

export type GateKey = keyof GateThresholds;

export interface GateCheck {
  key: GateKey;
  threshold: number;
  actual: number | null;
  passed: boolean;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
  checks: GateCheck[];
}

type Bound = "min" | "max";

const ABSOLUTE_GATES: Record<
  Exclude<GateKey, `${string}VsBaseline`>,
  { bound: Bound; label: string; value: (report: EvalReport) => number | null }
> = {
  minReasonMacroF1: { bound: "min", label: "reason macro-F1", value: (r) => r.reason.macroF1 },
  maxSentimentMae: { bound: "max", label: "sentiment MAE", value: (r) => r.sentiment.mae },
  minQwk: { bound: "min", label: "sentiment QWK", value: (r) => r.sentiment.qwk },
  maxCostPer1k: { bound: "max", label: "cost per 1k reviews (USD)", value: (r) => r.costPer1k },
  maxUnclassifiedRate: { bound: "max", label: "unclassified rate", value: (r) => r.unclassifiedRate },
  minAdSubreasonMacroF1: {
    bound: "min",
    label: "ad sub-reason macro-F1",
    value: (r) => r.adSubreason.macroF1,
  },
  maxLatencyMsP95: { bound: "max", label: "batch latency p95 (ms)", value: (r) => r.latencyMsP95 },
};

function difference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

const RELATIVE_GATES: Record<
  Extract<GateKey, `${string}VsBaseline`>,
  { label: string; value: (candidate: EvalReport, baseline: EvalReport) => number | null }
> = {
  maxReasonMacroF1DropVsBaseline: {
    label: "reason macro-F1 drop vs baseline",
    value: (c, b) => difference(b.reason.macroF1, c.reason.macroF1),
  },
  maxSentimentMaeIncreaseVsBaseline: {
    label: "sentiment MAE increase vs baseline",
    value: (c, b) => difference(c.sentiment.mae, b.sentiment.mae),
  },
  maxQwkDropVsBaseline: {
    label: "sentiment QWK drop vs baseline",
    value: (c, b) => difference(b.sentiment.qwk, c.sentiment.qwk),
  },
};

export const GATE_KEYS = [
  ...Object.keys(ABSOLUTE_GATES),
  ...Object.keys(RELATIVE_GATES),
] as GateKey[];

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

/**
 * Checks a report against thresholds. Only thresholds that are set are
 * checked. A metric that cannot be computed (null) fails its check, and a
 * `…VsBaseline` threshold fails when no baseline is given.
 */
export function checkGate(
  report: EvalReport,
  thresholds: GateThresholds,
  baseline?: EvalReport,
): GateResult {
  const checks: GateCheck[] = [];
  const failures: string[] = [];

  for (const key of GATE_KEYS) {
    const threshold = thresholds[key];
    if (threshold === undefined) continue;

    let actual: number | null;
    let label: string;
    let bound: Bound = "max";
    if (key in ABSOLUTE_GATES) {
      const gate = ABSOLUTE_GATES[key as keyof typeof ABSOLUTE_GATES];
      actual = gate.value(report);
      label = gate.label;
      bound = gate.bound;
    } else {
      const gate = RELATIVE_GATES[key as keyof typeof RELATIVE_GATES];
      label = gate.label;
      if (!baseline) {
        checks.push({ key, threshold, actual: null, passed: false });
        failures.push(`${key}: ${label} needs a baseline report (--baseline).`);
        continue;
      }
      actual = gate.value(report, baseline);
    }

    if (actual === null) {
      checks.push({ key, threshold, actual, passed: false });
      failures.push(`${key}: ${label} could not be computed.`);
      continue;
    }

    const passed = bound === "min" ? actual >= threshold : actual <= threshold;
    checks.push({ key, threshold, actual, passed });
    if (!passed) {
      failures.push(
        `${key}: ${label} is ${format(actual)}, ${bound === "min" ? "below the minimum" : "above the maximum"} ${format(threshold)}.`,
      );
    }
  }

  return { passed: failures.length === 0, failures, checks };
}

/** Parses CLI `key=value` gate entries into thresholds. */
export function parseGateArgs(entries: readonly string[]): GateThresholds {
  const thresholds: GateThresholds = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const key = separator > 0 ? entry.slice(0, separator).trim() : "";
    const raw = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!key || !raw) {
      throw new Error(`Gate "${entry}" must look like key=value.`);
    }
    if (!(GATE_KEYS as string[]).includes(key)) {
      throw new Error(`Unknown gate "${key}". Use one of: ${GATE_KEYS.join(", ")}.`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`Gate "${key}" needs a number (got "${raw}").`);
    }
    thresholds[key as GateKey] = value;
  }
  return thresholds;
}
