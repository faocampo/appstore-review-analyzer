import { describe, expect, it } from "vitest";

import { TAXONOMY_VERSION, type ClassifierInfo } from "@/lib/classifiers/provider";
import {
  formatNumber,
  formatPercent,
  parseReportJson,
  renderJson,
  renderMarkdown,
  renderSummary,
} from "@/lib/eval/report";
import { buildReport, checkGate, compareReports, type RowResult } from "@/lib/eval/run";

const INFO: ClassifierInfo = {
  provider: "openrouter",
  model: "fake-model",
  promptVersion: "fake-v1",
  taxonomyVersion: TAXONOMY_VERSION,
};

function result(
  id: string,
  language: string,
  truth: RowResult["truth"],
  prediction: Partial<NonNullable<RowResult["prediction"]>> | null,
  error: string | null = null,
): RowResult {
  return {
    id,
    language,
    truth,
    prediction: prediction
      ? {
          sentiment: truth.sentiment,
          primaryReason: truth.primaryReason,
          secondaryReason: null,
          adSubreason: null,
          provider: "openrouter",
          model: "fake-model",
          costUsd: 0.001,
          ...prediction,
        }
      : null,
    error,
  };
}

const ROWS: RowResult[] = [
  result("a", "en", { sentiment: 0, primaryReason: "ads", secondaryReason: null, adSubreason: "ad_audio" }, { adSubreason: "ad_audio" }),
  result("b", "es", { sentiment: 1, primaryReason: "stability", secondaryReason: null, adSubreason: null }, { primaryReason: "performance", sentiment: 2 }),
  result("c", "es", { sentiment: 1, primaryReason: "stability", secondaryReason: null, adSubreason: null }, { primaryReason: "performance" }),
  result("d", "pt", { sentiment: 4, primaryReason: "praise_general", secondaryReason: null, adSubreason: null }, null, "timeout | retry"),
];

function sampleReport(rows: RowResult[] = ROWS) {
  return buildReport({ info: INFO }, rows, {
    batchSize: 2,
    latencies: [120, 340],
    wallTimeMs: 460,
    generatedAt: "2026-11-06T00:00:00.000Z",
    dataset: { name: "sample.jsonl", sha256: "0123456789abcdef" },
    bootstrap: { iterations: 20 },
  });
}

describe("formatting helpers", () => {
  it("formats numbers and percentages with a dash for missing values", () => {
    expect(formatNumber(0.12345)).toBe("0.123");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatPercent(0.256)).toBe("25.6%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("renderMarkdown", () => {
  it("renders the summary, per-class, language, confusion and error sections", () => {
    const markdown = renderMarkdown(sampleReport());

    expect(markdown).toContain("# Classifier evaluation: openrouter/fake-model");
    expect(markdown).toContain("- Dataset: sample.jsonl (sha256 0123456789ab)");
    expect(markdown).toContain("| Metric | Value |");
    expect(markdown).toMatch(/\| Reason macro-F1 \| [0-9.]+ \(95% CI [0-9.]+–[0-9.]+\) \|/);
    expect(markdown).toContain("| Unclassified rate | 25.0% |");
    expect(markdown).toContain("cost known for 75.0%");
    expect(markdown).toContain("| Batch latency p50 / p95 (ms) | 230 / 329 (batch size 2, 2 batches) |");
    expect(markdown).toContain("| ads | 1 | 1 | 1.000 | 1.000 | 1.000 |");
    expect(markdown).toContain("| ad_audio | 1 | 1 | 1.000 | 1.000 | 1.000 |");
    expect(markdown).toContain("| es | 2 | 0.000 | 0.0% | 0.500 | 0.0% |");
    expect(markdown).toContain("| stability | performance | 2 |");
    expect(markdown).toContain("| praise_general | unclassified | 1 |");
    expect(markdown).toContain("## Unclassified reviews (1)");
    expect(markdown).toContain("- `d`: timeout \\| retry");
    expect(markdown).not.toContain("## Gate");
    expect(markdown).not.toContain("> **Warning:**");
  });

  it("renders gate, comparison and warnings when present", () => {
    const report = { ...sampleReport(), warnings: ["first", "second"] };
    const baseline = { ...sampleReport(), costPer1k: null };
    const markdown = renderMarkdown(report, {
      gate: checkGate(report, { minReasonMacroF1: 0.99, maxUnclassifiedRate: 0.5 }),
      comparison: compareReports(report, { ...baseline, dataset: { name: "x", sha256: "other" } }),
    });

    expect(markdown).toContain("> **Warning:** first\n>\n> **Warning:** second");
    expect(markdown).toContain("## Gate: FAILED");
    expect(markdown).toContain("| minReasonMacroF1 | 0.9900 |");
    expect(markdown).toContain("| FAIL |");
    expect(markdown).toContain("| maxUnclassifiedRate | 0.5000 | 0.2500 | pass |");
    expect(markdown).toContain("## Comparison with baseline openrouter/fake-model (fake-v1)");
    expect(markdown).toContain("> **Warning:** The reports were produced on different datasets");
    expect(markdown).toContain("| Reason macro-F1 |");
    expect(markdown).toContain("| 0.2500 | 0.2500 | 0.0000 | same |");
    expect(markdown).toContain("| Cost per 1k (USD) | 0.7500 | — | — | n/a |");
  });

  it("says when a gate has no thresholds", () => {
    const report = sampleReport();
    expect(renderMarkdown(report, { gate: checkGate(report, {}) })).toContain(
      "## Gate: PASSED\n\n_No thresholds were set._",
    );
  });

  it("handles an empty report and missing cost", () => {
    const empty = buildReport({ info: INFO }, [], {
      batchSize: 1,
      latencies: [],
      wallTimeMs: 0,
      generatedAt: "2026-11-06T00:00:00.000Z",
    });
    const markdown = renderMarkdown(empty);
    expect(markdown).toContain("- Dataset: (unnamed)\n");
    expect(markdown).toContain("- Models observed: —");
    expect(markdown).toContain("| Reason macro-F1 | — |");
    expect(markdown).toContain("— (provider reports no cost)");
    expect(markdown).toContain("## Primary reason by class\n\n_No rows._");
    expect(markdown).toContain("## By language\n\n_No rows._");
    expect(markdown).toContain("## Most frequent reason confusions\n\n_None._");
    expect(markdown).not.toContain("## Unclassified reviews");
  });

  it("orders tied confusions by truth label", () => {
    const markdown = renderMarkdown(
      sampleReport([
        result("x", "en", { sentiment: 1, primaryReason: "support", secondaryReason: null, adSubreason: null }, { primaryReason: "other_unclear" }),
        result("y", "en", { sentiment: 1, primaryReason: "compatibility", secondaryReason: null, adSubreason: null }, { primaryReason: "other_unclear" }),
      ]),
    );
    expect(markdown).toContain(
      "| compatibility | other_unclear | 1 |\n| support | other_unclear | 1 |",
    );
  });

  it("truncates long error lists", () => {
    const rows = Array.from({ length: 23 }, (_, index) =>
      result(
        `r${index}`,
        "en",
        { sentiment: 2, primaryReason: "other_unclear", secondaryReason: null, adSubreason: null },
        null,
        "boom\nagain",
      ),
    );
    const markdown = renderMarkdown(sampleReport(rows));
    expect(markdown).toContain("## Unclassified reviews (23)");
    expect(markdown).toContain("- `r0`: boom again");
    expect(markdown).toContain("- … and 3 more");
  });
});

describe("renderJson and parseReportJson", () => {
  it("round-trips a report with extras", () => {
    const report = sampleReport();
    const gate = checkGate(report, { minQwk: 0 });
    const parsed = parseReportJson(renderJson(report, { gate }));
    expect(parsed.reason.macroF1).toBe(report.reason.macroF1);
    expect((parsed as unknown as { gate: unknown }).gate).toEqual(gate);
    expect(renderJson(report).endsWith("}\n")).toBe(true);
  });

  it("rejects invalid JSON and non-report objects", () => {
    expect(() => parseReportJson("{")).toThrow("not valid JSON");
    expect(() => parseReportJson("null")).toThrow("schemaVersion 1");
    expect(() => parseReportJson("3")).toThrow("schemaVersion 1");
    expect(() => parseReportJson('{"schemaVersion":2}')).toThrow("schemaVersion 1");
    expect(() => parseReportJson('{"schemaVersion":1,"reason":{}}')).toThrow("schemaVersion 1");
  });
});

describe("renderSummary", () => {
  it("lists metrics, warnings, comparison and gate failures", () => {
    const report = { ...sampleReport(), warnings: ["mixed models"] };
    const summary = renderSummary(report, {
      comparison: compareReports(report, { ...report, dataset: { name: "x", sha256: "y" } }),
      gate: checkGate(report, { minReasonMacroF1: 0.99 }),
    });
    expect(summary).toContain("openrouter/fake-model on sample.jsonl (n = 4)");
    expect(summary).toContain("  Reason accuracy: 25.0%");
    expect(summary).toContain("  warning: mixed models");
    expect(summary).toContain("  vs openrouter/fake-model (fake-v1):");
    expect(summary).toContain("    warning: The reports were produced on different datasets");
    expect(summary).toContain("    Reason macro-F1: 0.0000 (same)");
    expect(summary).toContain("  gate: FAILED");
    expect(summary).toContain("    - minReasonMacroF1:");
  });

  it("prints a plain summary without extras", () => {
    const summary = renderSummary({ ...sampleReport(), dataset: { name: null, sha256: null } });
    expect(summary).toContain("on dataset (n = 4)");
    expect(summary).not.toContain("gate:");
  });

  it("shows positive deltas with a plus sign and a passing gate", () => {
    const better = { ...sampleReport(), sentiment: { ...sampleReport().sentiment, mae: 9 } };
    const summary = renderSummary(better, {
      comparison: compareReports(better, sampleReport()),
      gate: checkGate(better, {}),
    });
    expect(summary).toMatch(/Sentiment MAE: \+8\.\d{4} \(worse\)/);
    expect(summary).toContain("  gate: PASSED");
  });
});
