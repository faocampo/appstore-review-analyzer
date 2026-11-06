import { describe, expect, it } from "vitest";

import {
  accuracy,
  bootstrapMacroF1Ci,
  cohensKappa,
  confusionMatrix,
  costPer1k,
  createRng,
  macroF1,
  mean,
  meanAbsoluteError,
  perClassMetrics,
  percentile,
  quadraticWeightedKappa,
  unclassifiedRate,
} from "@/lib/eval/metrics";

describe("confusionMatrix", () => {
  it("counts truth rows against predicted columns over the sorted union", () => {
    const result = confusionMatrix(["b", "a", "a", "c"], ["b", "b", "a", "a"]);
    expect(result.labels).toEqual(["a", "b", "c"]);
    expect(result.matrix).toEqual([
      [1, 1, 0],
      [0, 1, 0],
      [1, 0, 0],
    ]);
    expect(result.total).toBe(4);
  });

  it("uses an explicit label order", () => {
    const result = confusionMatrix(["a"], ["a"], ["z", "a"]);
    expect(result.labels).toEqual(["z", "a"]);
    expect(result.matrix).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });

  it("rejects truth and predicted labels missing from an explicit list", () => {
    expect(() => confusionMatrix(["x"], ["a"], ["a"])).toThrow('Label "x"');
    expect(() => confusionMatrix(["a"], ["y"], ["a"])).toThrow('Label "y"');
  });

  it("returns an empty matrix for empty input", () => {
    expect(confusionMatrix([], [])).toEqual({ labels: [], matrix: [], total: 0 });
  });

  it("rejects inputs of different lengths", () => {
    expect(() => confusionMatrix(["a"], [])).toThrow("same length");
  });
});

describe("perClassMetrics", () => {
  it("computes precision, recall and F1 per class", () => {
    const truth = ["a", "a", "a", "b", "b", "c"];
    const predicted = ["a", "a", "b", "b", "c", "c"];
    const metrics = perClassMetrics(truth, predicted);

    expect(metrics.map((m) => m.label)).toEqual(["a", "b", "c"]);
    expect(metrics[0]).toEqual({
      label: "a",
      precision: 1,
      recall: 2 / 3,
      f1: 0.8,
      support: 3,
      predicted: 2,
    });
    expect(metrics[1].precision).toBe(0.5);
    expect(metrics[1].recall).toBe(0.5);
    expect(metrics[1].f1).toBe(0.5);
    expect(metrics[2].precision).toBe(0.5);
    expect(metrics[2].recall).toBe(1);
    expect(metrics[2].f1).toBeCloseTo(2 / 3);
  });

  it("reports null precision for never-predicted and null recall for absent classes", () => {
    const [missed, spurious] = perClassMetrics(["a"], ["b"]);
    expect(missed).toMatchObject({ label: "a", precision: null, recall: 0, f1: 0 });
    expect(spurious).toMatchObject({ label: "b", precision: 0, recall: null, f1: 0 });
  });

  it("restricts reporting to the given labels while still counting other values as errors", () => {
    const metrics = perClassMetrics(["a", "a"], ["a", "unclassified"], {
      labels: ["a", "b"],
    });
    expect(metrics).toEqual([
      { label: "a", precision: 1, recall: 0.5, f1: 2 / 3, support: 2, predicted: 1 },
      { label: "b", precision: null, recall: null, f1: null, support: 0, predicted: 0 },
    ]);
  });
});

describe("macroF1", () => {
  it("averages F1 over classes present in truth or predictions", () => {
    const truth = ["a", "a", "a", "b", "b", "c"];
    const predicted = ["a", "a", "b", "b", "c", "c"];
    expect(macroF1(truth, predicted)).toBeCloseTo((0.8 + 0.5 + 2 / 3) / 3);
  });

  it("ignores listed classes that never appear", () => {
    expect(macroF1(["a", "b"], ["a", "b"], { labels: ["a", "b", "c", "d"] })).toBe(1);
  });

  it("is 0 when every prediction is wrong", () => {
    expect(macroF1(["a", "b"], ["b", "a"])).toBe(0);
  });

  it("returns null for empty input or when no listed class appears", () => {
    expect(macroF1([], [])).toBeNull();
    expect(macroF1(["x"], ["x"], { labels: ["a"] })).toBeNull();
  });
});

describe("accuracy and mean", () => {
  it("computes the share of exact matches", () => {
    expect(accuracy(["a", "b", "c", "d"], ["a", "b", "x", "y"])).toBe(0.5);
    expect(accuracy([1, 2], [1, 2])).toBe(1);
  });

  it("returns null for empty input", () => {
    expect(accuracy([], [])).toBeNull();
    expect(mean([])).toBeNull();
  });

  it("rejects inputs of different lengths", () => {
    expect(() => accuracy([1], [1, 2])).toThrow("same length");
  });
});

describe("meanAbsoluteError", () => {
  it("averages absolute differences", () => {
    expect(meanAbsoluteError([0, 2, 4], [1, 2, 1])).toBeCloseTo(4 / 3);
  });

  it("returns null for empty input", () => {
    expect(meanAbsoluteError([], [])).toBeNull();
  });
});

describe("quadraticWeightedKappa", () => {
  it("is 1 for perfect agreement and -1 for perfect reversal", () => {
    expect(quadraticWeightedKappa([0, 1, 2, 3, 4], [0, 1, 2, 3, 4])).toBe(1);
    expect(quadraticWeightedKappa([0, 4], [4, 0])).toBe(-1);
  });

  it("matches Cohen's kappa on a binary scale", () => {
    const truth = [0, 0, 1, 1];
    const predicted = [0, 1, 1, 1];
    expect(quadraticWeightedKappa(truth, predicted, { min: 0, max: 1 })).toBeCloseTo(0.5);
    expect(cohensKappa(truth.map(String), predicted.map(String))).toBeCloseTo(0.5);
  });

  it("penalises distant disagreements more than adjacent ones", () => {
    const truth = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4];
    const near = [1, 1, 2, 3, 4, 0, 1, 2, 3, 3];
    const far = [4, 1, 2, 3, 4, 0, 1, 2, 3, 0];
    const nearKappa = quadraticWeightedKappa(truth, near) as number;
    const farKappa = quadraticWeightedKappa(truth, far) as number;
    expect(nearKappa).toBeGreaterThan(farKappa);
    expect(nearKappa).toBeLessThan(1);
  });

  it("matches a hand-computed value", () => {
    // Observed weighted disagreement: (1/16)·1 + (4/16)·1 = 5/16.
    // Marginals: truth [1,1,1,0,1], predicted [1,0,3,0,0], n = 4.
    const truth = [0, 1, 2, 4];
    const predicted = [0, 2, 2, 2];
    let expected = 0;
    const truthTotals = [1, 1, 1, 0, 1];
    const predictedTotals = [1, 0, 3, 0, 0];
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        expected += (((i - j) ** 2) / 16) * truthTotals[i] * predictedTotals[j] / 4;
      }
    }
    const observed = (1 / 16) * 1 + (4 / 16) * 1;
    expect(quadraticWeightedKappa(truth, predicted)).toBeCloseTo(1 - observed / expected);
  });

  it("returns null for empty input and when kappa is undefined", () => {
    expect(quadraticWeightedKappa([], [])).toBeNull();
    expect(quadraticWeightedKappa([2, 2], [2, 2])).toBeNull();
    expect(quadraticWeightedKappa([3], [3], { min: 3, max: 3 })).toBeNull();
  });

  it("rejects values outside the integer range", () => {
    expect(() => quadraticWeightedKappa([5], [0])).toThrow("outside");
    expect(() => quadraticWeightedKappa([0], [1.5])).toThrow("outside");
    expect(() => quadraticWeightedKappa([0], [-1])).toThrow("outside");
  });
});

describe("cohensKappa", () => {
  it("matches the textbook example (kappa = 0.4)", () => {
    const first = [
      ...Array<string>(20).fill("yes"),
      ...Array<string>(5).fill("yes"),
      ...Array<string>(10).fill("no"),
      ...Array<string>(15).fill("no"),
    ];
    const second = [
      ...Array<string>(20).fill("yes"),
      ...Array<string>(5).fill("no"),
      ...Array<string>(10).fill("yes"),
      ...Array<string>(15).fill("no"),
    ];
    expect(cohensKappa(first, second)).toBeCloseTo(0.4);
  });

  it("is 1 for perfect agreement over several labels", () => {
    expect(cohensKappa(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("handles labels used by only one rater", () => {
    // po = 0, pe = 0.5·0 + 0.5·0 = 0 → kappa 0.
    expect(cohensKappa(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("returns null for empty input and when chance agreement is 1", () => {
    expect(cohensKappa([], [])).toBeNull();
    expect(cohensKappa(["a", "a"], ["a", "a"])).toBeNull();
  });
});

describe("percentile", () => {
  it("interpolates linearly between ranks", () => {
    const values = [4, 1, 3, 2];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 50)).toBe(2.5);
    expect(percentile(values, 95)).toBeCloseTo(3.85);
    expect(percentile(values, 100)).toBe(4);
    expect(percentile([7], 95)).toBe(7);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it("returns null for empty input and rejects invalid percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(() => percentile([1], -1)).toThrow("between 0 and 100");
    expect(() => percentile([1], 101)).toThrow("between 0 and 100");
    expect(() => percentile([1], Number.NaN)).toThrow("between 0 and 100");
  });
});

describe("costPer1k", () => {
  it("scales the known cost to 1,000 reviews", () => {
    expect(costPer1k([0.001, 0.002, 0.003])).toBeCloseTo(2);
  });

  it("counts reviews with unknown cost in the denominator", () => {
    expect(costPer1k([0.004, null, undefined, Number.NaN])).toBeCloseTo(1);
    expect(costPer1k([0.004], 8)).toBeCloseTo(0.5);
  });

  it("returns null when no cost is known or there are no reviews", () => {
    expect(costPer1k([])).toBeNull();
    expect(costPer1k([null, null])).toBeNull();
    expect(costPer1k([0.1], 0)).toBeNull();
  });
});

describe("unclassifiedRate", () => {
  it("is the share of failed outcomes", () => {
    expect(unclassifiedRate([{ ok: true }, { ok: false }, { ok: true }, { ok: false }])).toBe(
      0.5,
    );
  });

  it("returns null for empty input", () => {
    expect(unclassifiedRate([])).toBeNull();
  });
});

describe("createRng", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const first = createRng(7);
    const second = createRng(7);
    const other = createRng(8);
    const a = Array.from({ length: 50 }, () => first());
    const b = Array.from({ length: 50 }, () => second());
    const c = Array.from({ length: 50 }, () => other());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe("bootstrapMacroF1Ci", () => {
  const truth = ["a", "a", "b", "b", "c", "c", "a", "b", "c", "a"];
  const predicted = ["a", "b", "b", "b", "c", "a", "a", "c", "c", "a"];

  it("is deterministic for a seed and brackets the point estimate", () => {
    const first = bootstrapMacroF1Ci(truth, predicted, { iterations: 300, seed: 1 });
    const second = bootstrapMacroF1Ci(truth, predicted, { iterations: 300, seed: 1 });
    expect(first).toEqual(second);
    const point = macroF1(truth, predicted) as number;
    expect(first?.lower).toBeLessThanOrEqual(point);
    expect(first?.upper).toBeGreaterThanOrEqual(point);
    expect(first).toMatchObject({ confidence: 0.95, iterations: 300, seed: 1 });
  });

  it("uses defaults of 1,000 iterations, 95% and seed 42", () => {
    expect(bootstrapMacroF1Ci(truth, predicted)).toMatchObject({
      iterations: 1000,
      confidence: 0.95,
      seed: 42,
    });
  });

  it("collapses to a point for perfect predictions", () => {
    expect(bootstrapMacroF1Ci(["a", "b"], ["a", "b"], { iterations: 50 })).toMatchObject({
      lower: 1,
      upper: 1,
    });
  });

  it("returns null for empty input or when no listed class ever appears", () => {
    expect(bootstrapMacroF1Ci([], [])).toBeNull();
    expect(bootstrapMacroF1Ci(["x"], ["x"], { labels: ["a"], iterations: 5 })).toBeNull();
  });

  it("rejects invalid options", () => {
    expect(() => bootstrapMacroF1Ci(["a"], ["a"], { iterations: 0 })).toThrow("iterations");
    expect(() => bootstrapMacroF1Ci(["a"], ["a"], { iterations: 1.5 })).toThrow("iterations");
    expect(() => bootstrapMacroF1Ci(["a"], ["a"], { confidence: 1 })).toThrow("Confidence");
    expect(() => bootstrapMacroF1Ci(["a"], ["a"], { confidence: 0 })).toThrow("Confidence");
  });
});
