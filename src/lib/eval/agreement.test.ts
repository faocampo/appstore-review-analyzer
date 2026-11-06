import { describe, expect, it } from "vitest";

import {
  computeAgreement,
  interpretKappa,
  pairAnnotations,
  renderAgreement,
  suggestGate,
} from "@/lib/eval/agreement";
import type { DatasetLabel, DatasetRow } from "@/lib/eval/dataset";

function annotation(
  id: string,
  annotator: string,
  label: Partial<DatasetLabel>,
  overrides: Partial<DatasetRow> = {},
): DatasetRow {
  return {
    id,
    store: "google_play",
    language: "en",
    rating: 2,
    title: "",
    body: `text ${id}`,
    annotator,
    label: {
      sentiment: 1,
      primaryReason: "stability",
      secondaryReason: null,
      adSubreason: null,
      ...label,
    },
    ...overrides,
  };
}

describe("pairAnnotations", () => {
  it("pairs annotators per id in name order and warns about anomalies", () => {
    const { pairs, warnings } = pairAnnotations([
      annotation("1", "bob", { sentiment: 2 }),
      annotation("1", "alice", { sentiment: 1 }),
      annotation("2", "alice", {}),
      annotation("3", "carol", {}),
      annotation("3", "alice", {}),
      annotation("3", "bob", {}),
      annotation("4", "alice", {}),
      annotation("4", "bob", {}, { body: "changed" }),
    ]);

    expect(pairs.map((pair) => [pair.id, pair.firstAnnotator, pair.secondAnnotator])).toEqual([
      ["1", "alice", "bob"],
      ["3", "alice", "bob"],
      ["4", "alice", "bob"],
    ]);
    expect(pairs[0].first.sentiment).toBe(1);
    expect(warnings).toEqual([
      'id "2" has a single annotation; skipped.',
      'id "3" has 3 annotations; using alice and bob.',
      'id "4" has different review text per annotator; check the export.',
    ]);
  });

  it("tolerates rows without an annotator name", () => {
    const { pairs } = pairAnnotations([
      annotation("1", "b", {}),
      { ...annotation("1", "a", {}), annotator: undefined },
    ]);
    expect(pairs[0]).toMatchObject({ firstAnnotator: "", secondAnnotator: "b" });
  });
});

describe("computeAgreement", () => {
  const rows = [
    annotation("1", "a", { primaryReason: "ads", adSubreason: "ad_frequency", sentiment: 0 }),
    annotation("1", "b", { primaryReason: "ads", adSubreason: "ad_intrusive", sentiment: 0 }),
    annotation("2", "a", { primaryReason: "stability", sentiment: 1 }),
    annotation("2", "b", { primaryReason: "stability", sentiment: 1 }),
    annotation("3", "a", { primaryReason: "praise_general", sentiment: 4 }),
    annotation("3", "b", { primaryReason: "praise_general", sentiment: 3, secondaryReason: "usability_navigation" }),
    annotation("4", "a", { primaryReason: "pricing_value", sentiment: 2 }),
    annotation("4", "b", { primaryReason: "payments_subscriptions", sentiment: 1 }, { language: "es" }),
  ];

  it("computes kappa, QWK, ad sub-reason agreement and disagreements", () => {
    const report = computeAgreement(pairAnnotations(rows).pairs);

    expect(report.n).toBe(4);
    expect(report.annotators).toEqual(["a", "b"]);
    expect(report.primaryReason.observedAgreement).toBe(0.75);
    expect(report.primaryReason.kappa).toBeGreaterThan(0.6);
    expect(report.primaryReason.macroF1).toBeCloseTo(0.6);
    expect(report.sentiment.exactAgreement).toBe(0.5);
    expect(report.sentiment.withinOne).toBe(1);
    expect(report.sentiment.mae).toBe(0.5);
    expect(report.sentiment.qwk).toBeGreaterThan(0.8);
    expect(report.adSubreason).toEqual({ n: 1, kappa: 0, observedAgreement: 0 });
    expect(report.disagreements.map((item) => [item.id, item.fields])).toEqual([
      ["1", ["adSubreason"]],
      ["3", ["secondaryReason", "sentiment"]],
      ["4", ["primaryReason", "sentiment"]],
    ]);
  });

  it("counts ad rows where only one annotator saw ads and distant sentiment", () => {
    const report = computeAgreement(
      pairAnnotations([
        annotation("1", "a", { primaryReason: "ads", adSubreason: "ad_audio", sentiment: 0 }),
        annotation("1", "b", { primaryReason: "support", sentiment: 3 }),
        annotation("2", "a", { primaryReason: "support", sentiment: 1 }),
        annotation("2", "b", { primaryReason: "ads", adSubreason: "ad_frequency", sentiment: 1 }),
      ]).pairs,
    );
    expect(report.adSubreason.n).toBe(2);
    expect(report.adSubreason.observedAgreement).toBe(0);
    expect(report.sentiment.withinOne).toBe(0.5);
    expect(
      renderAgreement(report, suggestGate(report)),
    ).toContain("| 1 | en | primaryReason, sentiment, adSubreason | ads/ad_audio s0 | support s3 |");
  });

  it("returns nulls for no pairs", () => {
    const report = computeAgreement([]);
    expect(report).toMatchObject({
      n: 0,
      annotators: [],
      primaryReason: { kappa: null, observedAgreement: null, macroF1: null },
      sentiment: { qwk: null, exactAgreement: null, withinOne: null, mae: null },
      adSubreason: { n: 0, kappa: null },
      disagreements: [],
    });
  });
});

describe("interpretKappa", () => {
  it.each([
    [null, "undefined"],
    [-0.1, "poor"],
    [0.1, "slight"],
    [0.3, "fair"],
    [0.5, "moderate"],
    [0.7, "substantial"],
    [0.9, "almost perfect"],
  ])("maps %s to %s", (kappa, label) => {
    expect(interpretKappa(kappa)).toBe(label);
  });
});

describe("suggestGate", () => {
  it("derives floors from human agreement", () => {
    const agreement = computeAgreement(
      pairAnnotations([
        annotation("1", "a", { primaryReason: "ads", adSubreason: "ad_audio", sentiment: 0 }),
        annotation("1", "b", { primaryReason: "ads", adSubreason: "ad_audio", sentiment: 0 }),
        annotation("2", "a", { primaryReason: "support", sentiment: 1 }),
        annotation("2", "b", { primaryReason: "support", sentiment: 2 }),
        annotation("3", "a", { primaryReason: "praise_general", sentiment: 4 }),
        annotation("3", "b", { primaryReason: "praise_general", sentiment: 4 }),
      ]).pairs,
    );
    const suggestion = suggestGate(agreement);

    expect(suggestion.thresholds).toEqual({
      maxReasonMacroF1DropVsBaseline: 0,
      minReasonMacroF1: 0.9,
      minQwk: Math.floor((agreement.sentiment.qwk as number) * 0.9 * 100) / 100,
      maxSentimentMae: 0.54,
    });
    expect(suggestion.rationale).toHaveLength(4);
    expect(suggestion.rationale.join("\n")).not.toContain("Warning");

    expect(suggestGate(agreement, { fraction: 0.5, maeMargin: 0 }).thresholds).toMatchObject({
      minReasonMacroF1: 0.5,
      maxSentimentMae: 0.34,
    });
  });

  it("skips undefined metrics and warns on low agreement", () => {
    const suggestion = suggestGate(computeAgreement([]));
    expect(suggestion.thresholds).toEqual({ maxReasonMacroF1DropVsBaseline: 0 });
    expect(suggestion.rationale).toEqual([
      expect.stringContaining("match or beat"),
      "minReasonMacroF1: not set (human macro-F1 is undefined).",
      "minQwk: not set (human QWK is undefined).",
      "maxSentimentMae: not set (no pairs).",
      expect.stringContaining("kappa is undefined (undefined)"),
    ]);

    const low = computeAgreement(
      pairAnnotations([
        annotation("1", "a", { primaryReason: "support" }),
        annotation("1", "b", { primaryReason: "stability" }),
        annotation("2", "a", { primaryReason: "stability" }),
        annotation("2", "b", { primaryReason: "support" }),
      ]).pairs,
    );
    expect(suggestGate(low).rationale.at(-1)).toMatch(/kappa is -1\.000 \(poor\)/);
  });
});

describe("renderAgreement", () => {
  it("renders metrics, warnings, disagreements and gate flags", () => {
    const { pairs } = pairAnnotations([
      annotation("1", "a", { primaryReason: "ads", adSubreason: "ad_audio", sentiment: 0 }),
      annotation("1", "b", { primaryReason: "stability", secondaryReason: "ads", adSubreason: "ad_breaks_app", sentiment: 1 }),
      annotation("2", "a", { primaryReason: "support" }),
      annotation("2", "b", { primaryReason: "support" }),
    ]);
    const agreement = computeAgreement(pairs);
    const text = renderAgreement(agreement, suggestGate(agreement), ["check export"]);

    expect(text).toContain("# Inter-annotator agreement");
    expect(text).toContain("- Pairs: 2; annotators: a, b");
    expect(text).toContain("- Warning: check export");
    expect(text).toContain("## Disagreements (1)");
    expect(text).toContain(
      "| 1 | en | primaryReason, secondaryReason, sentiment, adSubreason | ads/ad_audio s0 | stability+ads/ad_breaks_app s1 |",
    );
    expect(text).toContain("--gate maxReasonMacroF1DropVsBaseline=0 --gate minReasonMacroF1=");
  });

  it("renders an empty study", () => {
    const agreement = computeAgreement([]);
    const text = renderAgreement(agreement, suggestGate(agreement));
    expect(text).toContain("annotators: —");
    expect(text).toContain("Cohen's kappa — (undefined)");
    expect(text).toContain("## Disagreements (0)\n\n_None._");
  });
});
