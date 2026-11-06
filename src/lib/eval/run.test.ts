import { describe, expect, it } from "vitest";

import { createMockClassifier } from "@/lib/classifiers/mock";
import {
  TAXONOMY_VERSION,
  buildClassification,
  type ClassificationOutcome,
  type ClassifierInfo,
  type ClassifierProvider,
} from "@/lib/classifiers/provider";
import type { DatasetRow } from "@/lib/eval/dataset";
import {
  GATE_KEYS,
  buildReport,
  checkGate,
  compareReports,
  evaluateProvider,
  parseGateArgs,
  type EvalReport,
} from "@/lib/eval/run";
import type { AdSubreasonKey, ReasonKey, Review, SentimentScore } from "@/lib/types";

const INFO: ClassifierInfo = {
  provider: "openrouter",
  model: "fake-model",
  promptVersion: "fake-v1",
  taxonomyVersion: TAXONOMY_VERSION,
};

function row(
  id: string,
  sentiment: SentimentScore,
  primaryReason: ReasonKey,
  options: {
    language?: string;
    secondaryReason?: ReasonKey | null;
    adSubreason?: AdSubreasonKey | null;
    body?: string;
    rating?: number;
  } = {},
): DatasetRow {
  return {
    id,
    store: "google_play",
    language: options.language ?? "en",
    rating: options.rating ?? sentiment + 1,
    title: "",
    body: options.body ?? `review ${id}`,
    label: {
      sentiment,
      primaryReason,
      secondaryReason: options.secondaryReason ?? null,
      adSubreason: options.adSubreason ?? null,
    },
  };
}

interface FakeAnswer {
  sentiment?: SentimentScore;
  primaryReason?: ReasonKey;
  secondaryReason?: ReasonKey | null;
  adSubreason?: AdSubreasonKey | null;
  costUsd?: number | null;
  model?: string;
  error?: string;
}

/**
 * A provider that answers from a table keyed by review id. Unlisted reviews
 * echo nothing useful: they are classified as other_unclear, sentiment 2.
 */
function fakeProvider(
  answers: Record<string, FakeAnswer>,
  options: {
    maxBatch?: number;
    info?: ClassifierInfo;
    throwOn?: string;
    /** Drop the last outcome of the batch containing this id. */
    dropIn?: string;
    calls?: Review[][];
  } = {},
): ClassifierProvider {
  const info = options.info ?? INFO;
  return {
    info,
    maxBatch: options.maxBatch ?? 2,
    concurrency: 1,
    async classify(reviews) {
      options.calls?.push(reviews);
      if (options.throwOn && reviews.some((review) => review.id === options.throwOn)) {
        throw new Error("upstream exploded");
      }
      const outcomes: ClassificationOutcome[] = reviews.map((review) => {
        const answer = answers[review.id] ?? {};
        if (answer.error) return { ok: false, error: answer.error };
        return {
          ok: true,
          classification: buildClassification({
            info,
            model: answer.model,
            providerScore: answer.sentiment ?? 2,
            sentimentProbabilities: null,
            sentimentConfidence: 0.9,
            primaryReason: answer.primaryReason ?? "other_unclear",
            secondaryReason: answer.secondaryReason ?? null,
            adSubreason: answer.adSubreason ?? null,
            reasonProbabilities: null,
            reasonConfidence: 0.9,
            costUsd: answer.costUsd ?? null,
          }),
        };
      });
      return options.dropIn && reviews.some((review) => review.id === options.dropIn)
        ? outcomes.slice(0, -1)
        : outcomes;
    },
  };
}

function counter(step: number): () => number {
  let time = 0;
  return () => {
    const current = time;
    time += step;
    return current;
  };
}

const ROWS: DatasetRow[] = [
  row("a", 0, "ads", { adSubreason: "ad_frequency" }),
  row("b", 1, "stability", { secondaryReason: "ads", adSubreason: "ad_breaks_app", language: "es" }),
  row("c", 4, "praise_general", { language: "pt" }),
  row("d", 2, "pricing_value", { language: "es" }),
];

function perfectAnswers(rows: DatasetRow[], costUsd: number | null = null): Record<string, FakeAnswer> {
  return Object.fromEntries(
    rows.map((value) => [
      value.id,
      {
        sentiment: value.label.sentiment,
        primaryReason: value.label.primaryReason,
        secondaryReason: value.label.secondaryReason,
        adSubreason: value.label.adSubreason,
        costUsd,
      },
    ]),
  );
}

describe("evaluateProvider", () => {
  it("scores a perfect provider", async () => {
    const calls: Review[][] = [];
    const report = await evaluateProvider(fakeProvider(perfectAnswers(ROWS, 0.002), { calls }), ROWS, {
      now: counter(5),
      generatedAt: "2026-11-06T00:00:00.000Z",
      dataset: { name: "set.jsonl", sha256: "abc" },
      bootstrap: { iterations: 50 },
    });

    expect(calls.map((batch) => batch.map((review) => review.id))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(calls[0][0]).toMatchObject({ platform: "android", language: "en" });
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-11-06T00:00:00.000Z",
      dataset: { name: "set.jsonl", sha256: "abc" },
      provider: "openrouter",
      model: "fake-model",
      promptVersion: "fake-v1",
      taxonomyVersion: TAXONOMY_VERSION,
      modelsObserved: ["openrouter/fake-model"],
      n: 4,
      classified: 4,
      unclassifiedRate: 0,
      sentiment: { n: 4, mae: 0, qwk: 1, accuracy: 1 },
      reason: { n: 4, macroF1: 1, accuracy: 1, lenientAccuracy: 1 },
      adSubreason: { n: 2, macroF1: 1, accuracy: 1 },
      batchSize: 2,
      batches: 2,
      latencyMsP50: 5,
      latencyMsP95: 5,
      warnings: [],
    });
    expect(report.reason.macroF1Ci).toMatchObject({ lower: 1, upper: 1, iterations: 50 });
    expect(report.reason.perClass.map((metrics) => metrics.label)).toEqual([
      "ads",
      "stability",
      "pricing_value",
      "praise_general",
    ]);
    expect(report.reason.confusion.labels).not.toContain("unclassified");
    expect(report.costPer1k).toBeCloseTo(2);
    expect(report.costTotalUsd).toBeCloseTo(0.008);
    expect(report.costKnownRate).toBe(1);
    expect(Object.keys(report.byLanguage)).toEqual(["en", "es", "pt"]);
    expect(report.byLanguage.es).toEqual({
      n: 2,
      unclassifiedRate: 0,
      reasonMacroF1: 1,
      reasonAccuracy: 1,
      sentimentMae: 0,
    });
    expect(report.rows[0]).toMatchObject({
      id: "a",
      error: null,
      prediction: { primaryReason: "ads", adSubreason: "ad_frequency", costUsd: 0.002 },
    });
  });

  it("records failures as unclassified without aborting", async () => {
    const answers: Record<string, FakeAnswer> = {
      ...perfectAnswers(ROWS),
      a: { error: "rate limited" },
    };
    const rows = [...ROWS, row("e", 3, "support"), row("f", 3, "support")];
    // Batches: [a,b] (a fails), [c,d] (d dropped), [e,f] (throws).
    const report = await evaluateProvider(
      fakeProvider(answers, { throwOn: "e", dropIn: "d" }),
      rows,
      { bootstrap: { iterations: 20 } },
    );

    expect(report.classified).toBe(2);
    expect(report.unclassifiedRate).toBeCloseTo(4 / 6);
    expect(report.rows.map((value) => value.error)).toEqual([
      "rate limited",
      null,
      null,
      "no result returned",
      "upstream exploded",
      "upstream exploded",
    ]);
    expect(report.sentiment.n).toBe(2);
    expect(report.reason.accuracy).toBeCloseTo(2 / 6);
    expect(report.reason.confusion.labels.at(-1)).toBe("unclassified");
    // "a" is an ad row whose prediction is missing: a miss for ad_frequency.
    expect(report.adSubreason.n).toBe(2);
    expect(report.adSubreason.accuracy).toBe(0.5);
    expect(report.costPer1k).toBeNull();
    expect(report.costTotalUsd).toBeNull();
    expect(report.costKnownRate).toBe(0);
    expect(report.byLanguage.en.unclassifiedRate).toBe(1);
    expect(report.byLanguage.en.sentimentMae).toBeNull();
    expect(report.latencyMsP50).toBeGreaterThanOrEqual(0);
  });

  it("measures each batch separately and honours batch size and concurrency", async () => {
    const calls: Review[][] = [];
    const report = await evaluateProvider(fakeProvider({}, { calls, maxBatch: 50 }), ROWS, {
      batchSize: 1,
      concurrency: 2,
      now: counter(1),
      bootstrap: { iterations: 10 },
    });
    expect(calls).toHaveLength(4);
    expect(report.batchSize).toBe(1);
    expect(report.batches).toBe(4);
    expect(report.latencyMsP95).not.toBeNull();
  });

  it("scores ad sub-reasons only on rows where truth or prediction has one", async () => {
    const answers: Record<string, FakeAnswer> = {
      ...perfectAnswers(ROWS),
      a: { primaryReason: "ads", adSubreason: "ad_audio", sentiment: 0 },
      // A spurious ad prediction on a non-ad row.
      d: { primaryReason: "ads", adSubreason: "ad_intrusive", sentiment: 1 },
    };
    const report = await evaluateProvider(fakeProvider(answers), ROWS, {
      bootstrap: { iterations: 10 },
    });

    expect(report.adSubreason.n).toBe(3);
    expect(report.adSubreason.accuracy).toBeCloseTo(1 / 3);
    expect(report.adSubreason.perClass.map((metrics) => metrics.label)).toEqual([
      "ad_frequency",
      "ad_intrusive",
      "ad_audio",
      "ad_breaks_app",
    ]);
    expect(report.reason.lenientAccuracy).toBe(0.75);
    expect(report.sentiment.mae).toBeCloseTo(0.25);
  });

  it("warns when results mix models or the taxonomy differs", async () => {
    const report = await evaluateProvider(
      fakeProvider(
        { a: { model: "other-model" } },
        { info: { ...INFO, taxonomyVersion: "reasons-v1" } },
      ),
      ROWS.slice(0, 2),
      { bootstrap: { iterations: 10 } },
    );
    expect(report.modelsObserved).toEqual(["openrouter/fake-model", "openrouter/other-model"]);
    expect(report.warnings).toEqual([
      expect.stringContaining("taxonomy reasons-v1 differs"),
      expect.stringContaining("results mix models"),
    ]);
  });

  it("warns when nothing was classified", async () => {
    const report = await evaluateProvider(
      fakeProvider({}, { throwOn: "a" }),
      ROWS.slice(0, 1),
      { bootstrap: { iterations: 10 } },
    );
    expect(report.warnings).toEqual([expect.stringContaining("No review was classified")]);
    expect(report.reason.macroF1).toBe(0);
    expect(report.sentiment.mae).toBeNull();
  });

  it("records non-Error throws as text", async () => {
    const provider: ClassifierProvider = {
      ...fakeProvider({}),
      async classify() {
        throw "plain string failure";
      },
    };
    const report = await evaluateProvider(provider, ROWS.slice(0, 1), {
      bootstrap: { iterations: 10 },
    });
    expect(report.rows[0].error).toBe("plain string failure");
  });

  it("returns null metrics for an empty dataset", async () => {
    const report = await evaluateProvider(fakeProvider({}), []);
    expect(report).toMatchObject({
      n: 0,
      unclassifiedRate: null,
      sentiment: { n: 0, mae: null, qwk: null, accuracy: null },
      reason: { macroF1: null, macroF1Ci: null, accuracy: null, lenientAccuracy: null },
      adSubreason: { n: 0, macroF1: null, accuracy: null },
      costPer1k: null,
      costKnownRate: null,
      batches: 0,
      latencyMsP50: null,
      latencyMsP95: null,
      byLanguage: {},
      warnings: [],
    });
    expect(report.dataset).toEqual({ name: null, sha256: null });
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
  });

  it("runs the mock classifier end to end", async () => {
    const rows = [
      row("m1", 0, "ads", { body: "An ad after every level, too many ads", rating: 1, adSubreason: "ad_frequency" }),
      row("m2", 1, "stability", { body: "It keeps crashing on launch", rating: 1 }),
      row("m3", 4, "praise_general", { body: "I love it, amazing", rating: 5 }),
    ];
    const report = await evaluateProvider(createMockClassifier(), rows, {
      bootstrap: { iterations: 10 },
    });
    expect(report.provider).toBe("mock");
    expect(report.classified).toBe(3);
    expect(report.reason.accuracy).toBe(1);
    expect(report.costPer1k).toBeNull();
    expect(report.batches).toBe(1);
  });
});

function reportWith(overrides: {
  macroF1?: number | null;
  mae?: number | null;
  qwk?: number | null;
  cost?: number | null;
  sha?: string;
  n?: number;
  taxonomy?: string;
}): EvalReport {
  const base = buildReport({ info: INFO }, [], {
    batchSize: 1,
    latencies: [100, 200],
    wallTimeMs: 300,
    generatedAt: "2026-11-06T00:00:00.000Z",
    dataset: { name: "set.jsonl", sha256: overrides.sha ?? "abc" },
  });
  return {
    ...base,
    n: overrides.n ?? 10,
    taxonomyVersion: overrides.taxonomy ?? base.taxonomyVersion,
    unclassifiedRate: 0.01,
    costPer1k: overrides.cost === undefined ? 0.5 : overrides.cost,
    sentiment: { n: 10, mae: overrides.mae === undefined ? 0.5 : overrides.mae, qwk: overrides.qwk === undefined ? 0.8 : overrides.qwk, accuracy: 0.6 },
    reason: { ...base.reason, macroF1: overrides.macroF1 === undefined ? 0.7 : overrides.macroF1, accuracy: 0.75 },
    adSubreason: { ...base.adSubreason, macroF1: 0.6 },
  };
}

describe("compareReports", () => {
  it("labels each metric better, worse, same or n/a", () => {
    const comparison = compareReports(
      reportWith({ macroF1: 0.75, mae: 0.6, cost: null }),
      reportWith({}),
    );
    const byKey = Object.fromEntries(comparison.metrics.map((metric) => [metric.key, metric]));

    expect(comparison.candidate).toBe("openrouter/fake-model (fake-v1)");
    expect(comparison.warnings).toEqual([]);
    expect(byKey.reasonMacroF1).toMatchObject({ verdict: "better" });
    expect(byKey.reasonMacroF1.delta).toBeCloseTo(0.05);
    expect(byKey.sentimentMae).toMatchObject({ verdict: "worse", higherIsBetter: false });
    expect(byKey.sentimentQwk).toMatchObject({ verdict: "same", delta: 0 });
    expect(byKey.costPer1k).toMatchObject({ verdict: "n/a", delta: null, baseline: 0.5 });
    expect(byKey.latencyMsP95).toMatchObject({ verdict: "same" });
  });

  it("warns about different datasets, sizes and taxonomies", () => {
    expect(compareReports(reportWith({ sha: "x" }), reportWith({})).warnings).toEqual([
      expect.stringContaining("different datasets"),
    ]);
    expect(
      compareReports(reportWith({ n: 9, taxonomy: "reasons-v1" }), reportWith({})).warnings,
    ).toEqual([
      expect.stringContaining("different review counts (9 vs 10)"),
      expect.stringContaining("Taxonomy versions differ"),
    ]);
  });
});

describe("checkGate", () => {
  it("passes when every set threshold is met and ignores unset ones", () => {
    const result = checkGate(reportWith({}), {
      minReasonMacroF1: 0.7,
      maxSentimentMae: 0.5,
      minQwk: 0.8,
      maxCostPer1k: 1,
      maxUnclassifiedRate: 0.02,
      minAdSubreasonMacroF1: 0.5,
      maxLatencyMsP95: 500,
    });
    expect(result).toMatchObject({ passed: true, failures: [] });
    expect(result.checks).toHaveLength(7);
  });

  it("passes trivially with no thresholds", () => {
    expect(checkGate(reportWith({}), {})).toEqual({ passed: true, failures: [], checks: [] });
  });

  it("reports minimum and maximum violations", () => {
    const result = checkGate(reportWith({ macroF1: 0.65, mae: 0.75 }), {
      minReasonMacroF1: 0.7,
      maxSentimentMae: 0.5,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      "minReasonMacroF1: reason macro-F1 is 0.6500, below the minimum 0.7000.",
      "maxSentimentMae: sentiment MAE is 0.7500, above the maximum 0.5000.",
    ]);
  });

  it("fails metrics that cannot be computed", () => {
    const result = checkGate(reportWith({ cost: null }), { maxCostPer1k: 1 });
    expect(result.failures).toEqual(["maxCostPer1k: cost per 1k reviews (USD) could not be computed."]);
    expect(result.checks[0]).toMatchObject({ actual: null, passed: false });
  });

  it("checks thresholds relative to a baseline", () => {
    const candidate = reportWith({ macroF1: 0.68, mae: 0.55, qwk: 0.82 });
    const baseline = reportWith({});
    const thresholds = {
      maxReasonMacroF1DropVsBaseline: 0,
      maxSentimentMaeIncreaseVsBaseline: 0.1,
      maxQwkDropVsBaseline: 0,
    };

    const result = checkGate(candidate, thresholds, baseline);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      expect.stringMatching(/^maxReasonMacroF1DropVsBaseline: reason macro-F1 drop vs baseline is 0\.0200/),
    ]);
    expect(result.checks.map((check) => check.passed)).toEqual([false, true, true]);

    expect(checkGate(candidate, { maxReasonMacroF1DropVsBaseline: 0.05 }, baseline).passed).toBe(true);
  });

  it("fails relative thresholds without a baseline or with a missing metric", () => {
    expect(checkGate(reportWith({}), { maxQwkDropVsBaseline: 0 }).failures).toEqual([
      "maxQwkDropVsBaseline: sentiment QWK drop vs baseline needs a baseline report (--baseline).",
    ]);
    expect(
      checkGate(reportWith({ qwk: null }), { maxQwkDropVsBaseline: 0 }, reportWith({})).failures,
    ).toEqual(["maxQwkDropVsBaseline: sentiment QWK drop vs baseline could not be computed."]);
  });
});

describe("parseGateArgs", () => {
  it("parses key=value thresholds", () => {
    expect(parseGateArgs(["minReasonMacroF1=0.7", " maxCostPer1k = 1.5 "])).toEqual({
      minReasonMacroF1: 0.7,
      maxCostPer1k: 1.5,
    });
    expect(parseGateArgs([])).toEqual({});
  });

  it("lists every known gate key", () => {
    expect(GATE_KEYS).toContain("maxReasonMacroF1DropVsBaseline");
    expect(GATE_KEYS).toContain("minQwk");
  });

  it("rejects malformed, unknown and non-numeric gates", () => {
    expect(() => parseGateArgs(["minQwk"])).toThrow("key=value");
    expect(() => parseGateArgs(["=1"])).toThrow("key=value");
    expect(() => parseGateArgs(["minQwk="])).toThrow("key=value");
    expect(() => parseGateArgs(["minFoo=1"])).toThrow('Unknown gate "minFoo"');
    expect(() => parseGateArgs(["minQwk=abc"])).toThrow("needs a number");
  });
});
