import {
  REPORT_SCHEMA_VERSION,
  type EvalReport,
  type GateResult,
  type ReportComparison,
} from "@/lib/eval/run";
import type { ClassMetrics } from "@/lib/eval/metrics";

export interface ReportExtras {
  gate?: GateResult;
  comparison?: ReportComparison;
}

const MISSING = "—";

export function formatNumber(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? MISSING : value.toFixed(digits);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? MISSING : `${(value * 100).toFixed(digits)}%`;
}

function formatSigned(value: number | null, digits = 3): string {
  if (value === null) return MISSING;
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function classTable(metrics: ClassMetrics[], heading: string): string {
  if (!metrics.length) return "_No rows._";
  return table(
    [heading, "Support", "Predicted", "Precision", "Recall", "F1"],
    metrics.map((m) => [
      m.label,
      String(m.support),
      String(m.predicted),
      formatNumber(m.precision),
      formatNumber(m.recall),
      formatNumber(m.f1),
    ]),
  );
}

function topConfusions(report: EvalReport, limit: number): Array<[string, string, number]> {
  const { labels, matrix } = report.reason.confusion;
  const pairs: Array<[string, string, number]> = [];
  matrix.forEach((row, truthIndex) => {
    row.forEach((count, predictedIndex) => {
      if (count && truthIndex !== predictedIndex) {
        pairs.push([labels[truthIndex], labels[predictedIndex], count]);
      }
    });
  });
  return pairs
    .sort((left, right) => right[2] - left[2] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function summaryRows(report: EvalReport): string[][] {
  const ci = report.reason.macroF1Ci;
  return [
    [
      "Reason macro-F1",
      ci
        ? `${formatNumber(report.reason.macroF1)} (${Math.round(ci.confidence * 100)}% CI ${formatNumber(ci.lower)}–${formatNumber(ci.upper)})`
        : formatNumber(report.reason.macroF1),
    ],
    ["Reason accuracy", formatPercent(report.reason.accuracy)],
    ["Reason accuracy, lenient (primary or secondary)", formatPercent(report.reason.lenientAccuracy)],
    [
      "Ad sub-reason macro-F1",
      `${formatNumber(report.adSubreason.macroF1)} (n = ${report.adSubreason.n})`,
    ],
    ["Sentiment MAE (0–4)", `${formatNumber(report.sentiment.mae)} (n = ${report.sentiment.n})`],
    ["Sentiment QWK", formatNumber(report.sentiment.qwk)],
    ["Sentiment exact accuracy", formatPercent(report.sentiment.accuracy)],
    ["Unclassified rate", formatPercent(report.unclassifiedRate)],
    [
      "Cost per 1,000 reviews (USD)",
      report.costPer1k === null
        ? `${MISSING} (provider reports no cost)`
        : `${formatNumber(report.costPer1k, 4)} (cost known for ${formatPercent(report.costKnownRate)})`,
    ],
    [
      "Batch latency p50 / p95 (ms)",
      `${formatNumber(report.latencyMsP50, 0)} / ${formatNumber(report.latencyMsP95, 0)} (batch size ${report.batchSize}, ${report.batches} batches)`,
    ],
    ["Wall time (s)", formatNumber(report.wallTimeMs / 1000, 1)],
  ];
}

function gateSection(gate: GateResult): string {
  const lines = [`## Gate: ${gate.passed ? "PASSED" : "FAILED"}`, ""];
  if (!gate.checks.length) {
    lines.push("_No thresholds were set._");
    return lines.join("\n");
  }
  lines.push(
    table(
      ["Check", "Threshold", "Actual", "Result"],
      gate.checks.map((check) => [
        check.key,
        formatNumber(check.threshold, 4),
        formatNumber(check.actual, 4),
        check.passed ? "pass" : "FAIL",
      ]),
    ),
  );
  return lines.join("\n");
}

function comparisonSection(comparison: ReportComparison): string {
  const lines = [`## Comparison with baseline ${comparison.baseline}`, ""];
  for (const warning of comparison.warnings) lines.push(`> **Warning:** ${warning}`, "");
  lines.push(
    table(
      ["Metric", "Candidate", "Baseline", "Delta", "Verdict"],
      comparison.metrics.map((metric) => [
        metric.label,
        formatNumber(metric.candidate, 4),
        formatNumber(metric.baseline, 4),
        formatSigned(metric.delta, 4),
        metric.verdict,
      ]),
    ),
    "",
    "Deltas inside the macro-F1 confidence interval are within sampling noise.",
  );
  return lines.join("\n");
}

/** Human-readable Markdown report. */
export function renderMarkdown(report: EvalReport, extras: ReportExtras = {}): string {
  const sections: string[] = [
    `# Classifier evaluation: ${report.provider}/${report.model}`,
    [
      `- Generated: ${report.generatedAt}`,
      `- Dataset: ${report.dataset.name ?? "(unnamed)"}${report.dataset.sha256 ? ` (sha256 ${report.dataset.sha256.slice(0, 12)})` : ""}`,
      `- Prompt version: ${report.promptVersion}; taxonomy: ${report.taxonomyVersion}`,
      `- Reviews: ${report.n} (${report.classified} classified)`,
      `- Models observed: ${report.modelsObserved.length ? report.modelsObserved.join(", ") : MISSING}`,
    ].join("\n"),
  ];

  if (report.warnings.length) {
    sections.push(report.warnings.map((warning) => `> **Warning:** ${warning}`).join("\n>\n"));
  }

  sections.push(`## Summary\n\n${table(["Metric", "Value"], summaryRows(report))}`);
  sections.push(
    "Reason metrics count unclassified reviews as misses. Sentiment metrics cover classified reviews only.",
  );

  if (extras.gate) sections.push(gateSection(extras.gate));
  if (extras.comparison) sections.push(comparisonSection(extras.comparison));

  sections.push(`## Primary reason by class\n\n${classTable(report.reason.perClass, "Reason")}`);
  sections.push(
    `## Ad sub-reason by class\n\nRows whose label or prediction has an ad sub-reason (n = ${report.adSubreason.n}).\n\n${classTable(report.adSubreason.perClass, "Ad sub-reason")}`,
  );

  const languages = Object.entries(report.byLanguage);
  sections.push(
    `## By language\n\n${
      languages.length
        ? table(
            ["Language", "n", "Reason macro-F1", "Reason accuracy", "Sentiment MAE", "Unclassified"],
            languages.map(([language, breakdown]) => [
              language,
              String(breakdown.n),
              formatNumber(breakdown.reasonMacroF1),
              formatPercent(breakdown.reasonAccuracy),
              formatNumber(breakdown.sentimentMae),
              formatPercent(breakdown.unclassifiedRate),
            ]),
          )
        : "_No rows._"
    }`,
  );

  const confusions = topConfusions(report, 10);
  sections.push(
    `## Most frequent reason confusions\n\n${
      confusions.length
        ? table(
            ["Truth", "Predicted", "Count"],
            confusions.map(([truth, predicted, count]) => [truth, predicted, String(count)]),
          )
        : "_None._"
    }`,
  );

  const failed = report.rows.filter((row) => row.error !== null);
  if (failed.length) {
    const shown = failed.slice(0, 20);
    sections.push(
      [
        `## Unclassified reviews (${failed.length})`,
        "",
        ...shown.map((row) => `- \`${row.id}\`: ${cell(row.error as string)}`),
        ...(failed.length > shown.length ? [`- … and ${failed.length - shown.length} more`] : []),
      ].join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

/**
 * Machine-readable report. The top level is the `EvalReport` itself, so the
 * file can be passed back as `--baseline`; gate and comparison are extra keys.
 */
export function renderJson(report: EvalReport, extras: ReportExtras = {}): string {
  return `${JSON.stringify({ ...report, ...extras }, null, 2)}\n`;
}

/** Parses a JSON report written by `renderJson`, e.g. a baseline. */
export function parseReportJson(text: string): EvalReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The report is not valid JSON.");
  }
  const report = value as Partial<EvalReport> | null;
  if (
    !report ||
    typeof report !== "object" ||
    report.schemaVersion !== REPORT_SCHEMA_VERSION ||
    typeof report.reason !== "object" ||
    typeof report.sentiment !== "object"
  ) {
    throw new Error(
      `The report is not an evaluation report with schemaVersion ${REPORT_SCHEMA_VERSION}.`,
    );
  }
  return report as EvalReport;
}

/** One-paragraph console summary. */
export function renderSummary(report: EvalReport, extras: ReportExtras = {}): string {
  const lines = [
    `${report.provider}/${report.model} on ${report.dataset.name ?? "dataset"} (n = ${report.n})`,
    ...summaryRows(report).map(([label, value]) => `  ${label}: ${value}`),
  ];
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  if (extras.comparison) {
    lines.push(`  vs ${extras.comparison.baseline}:`);
    for (const warning of extras.comparison.warnings) lines.push(`    warning: ${warning}`);
    for (const metric of extras.comparison.metrics) {
      lines.push(`    ${metric.label}: ${formatSigned(metric.delta, 4)} (${metric.verdict})`);
    }
  }
  if (extras.gate) {
    lines.push(`  gate: ${extras.gate.passed ? "PASSED" : "FAILED"}`);
    for (const failure of extras.gate.failures) lines.push(`    - ${failure}`);
  }
  return lines.join("\n");
}
