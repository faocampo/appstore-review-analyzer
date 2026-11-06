/**
 * Pure evaluation metrics for the classifier harness.
 *
 * Conventions:
 * - Paired inputs (truth, predicted) must have the same length; a mismatch is
 *   a programming error and throws.
 * - Empty inputs and undefined statistics return `null`, never `NaN`.
 */

function assertSameLength(left: readonly unknown[], right: readonly unknown[]): void {
  if (left.length !== right.length) {
    throw new Error(
      `Metric inputs must have the same length (got ${left.length} and ${right.length}).`,
    );
  }
}

function sortedUnion(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())].sort();
}

export interface ConfusionMatrix {
  /** Row and column order. Rows are truth, columns are predictions. */
  labels: string[];
  matrix: number[][];
  total: number;
}

/**
 * Counts (truth, predicted) pairs. `labels` fixes the row/column order and
 * must contain every value that appears; by default it is the sorted union.
 */
export function confusionMatrix(
  truth: readonly string[],
  predicted: readonly string[],
  labels?: readonly string[],
): ConfusionMatrix {
  assertSameLength(truth, predicted);
  const order = labels ? [...labels] : sortedUnion(truth, predicted);
  const index = new Map(order.map((label, position) => [label, position]));
  const matrix = order.map(() => order.map(() => 0));

  truth.forEach((actual, position) => {
    const row = index.get(actual);
    const column = index.get(predicted[position]);
    if (row === undefined || column === undefined) {
      throw new Error(
        `Label "${row === undefined ? actual : predicted[position]}" is not in the label list.`,
      );
    }
    matrix[row][column] += 1;
  });

  return { labels: order, matrix, total: truth.length };
}

export interface ClassMetrics {
  label: string;
  /** Null when the class was never predicted. */
  precision: number | null;
  /** Null when the class never occurs in the truth. */
  recall: number | null;
  /** Null only when the class is absent from both truth and predictions. */
  f1: number | null;
  /** Rows whose truth is this class. */
  support: number;
  /** Rows predicted as this class. */
  predicted: number;
}

/**
 * Per-class precision, recall and F1. `labels` selects which classes are
 * reported (default: the sorted union of truth and predictions). Values
 * outside `labels` still count as false positives/negatives for the
 * reported classes, so a pseudo-label such as "unclassified" penalises
 * recall without becoming a class of its own.
 */
export function perClassMetrics(
  truth: readonly string[],
  predicted: readonly string[],
  options: { labels?: readonly string[] } = {},
): ClassMetrics[] {
  assertSameLength(truth, predicted);
  const labels = options.labels ? [...options.labels] : sortedUnion(truth, predicted);

  return labels.map((label) => {
    let truePositives = 0;
    let support = 0;
    let predictedCount = 0;
    truth.forEach((actual, position) => {
      const isTruth = actual === label;
      const isPredicted = predicted[position] === label;
      if (isTruth) support += 1;
      if (isPredicted) predictedCount += 1;
      if (isTruth && isPredicted) truePositives += 1;
    });

    const denominator = support + predictedCount;
    return {
      label,
      precision: predictedCount ? truePositives / predictedCount : null,
      recall: support ? truePositives / support : null,
      // 2TP / (2TP + FP + FN) = 2TP / (support + predicted).
      f1: denominator ? (2 * truePositives) / denominator : null,
      support,
      predicted: predictedCount,
    };
  });
}

/**
 * Unweighted mean F1 over classes. Classes absent from both truth and
 * predictions are ignored. Null when no class qualifies (e.g. empty input).
 */
export function macroF1(
  truth: readonly string[],
  predicted: readonly string[],
  options: { labels?: readonly string[] } = {},
): number | null {
  const scores = perClassMetrics(truth, predicted, options)
    .map((metrics) => metrics.f1)
    .filter((f1): f1 is number => f1 !== null);
  return mean(scores);
}

export function accuracy(
  truth: readonly unknown[],
  predicted: readonly unknown[],
): number | null {
  assertSameLength(truth, predicted);
  if (!truth.length) return null;
  const correct = truth.filter((actual, position) => actual === predicted[position]).length;
  return correct / truth.length;
}

export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function meanAbsoluteError(
  truth: readonly number[],
  predicted: readonly number[],
): number | null {
  assertSameLength(truth, predicted);
  return mean(truth.map((actual, position) => Math.abs(actual - predicted[position])));
}

function assertOrdinal(values: readonly number[], min: number, max: number): void {
  for (const value of values) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Ordinal value ${value} is outside the integer range ${min}–${max}.`);
    }
  }
}

/**
 * Quadratic weighted kappa (Cohen's kappa with weights (i−j)²/(k−1)²) for
 * integer ratings in [min, max]. Null for empty input, and when the
 * expected disagreement is zero (both raters used one identical category),
 * where kappa is mathematically undefined.
 */
export function quadraticWeightedKappa(
  truth: readonly number[],
  predicted: readonly number[],
  { min = 0, max = 4 }: { min?: number; max?: number } = {},
): number | null {
  assertSameLength(truth, predicted);
  if (!truth.length) return null;
  assertOrdinal(truth, min, max);
  assertOrdinal(predicted, min, max);

  const size = max - min + 1;
  const observed = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const truthTotals = new Array<number>(size).fill(0);
  const predictedTotals = new Array<number>(size).fill(0);
  truth.forEach((actual, position) => {
    const row = actual - min;
    const column = predicted[position] - min;
    observed[row][column] += 1;
    truthTotals[row] += 1;
    predictedTotals[column] += 1;
  });

  const n = truth.length;
  const span = Math.max(size - 1, 1);
  let observedDisagreement = 0;
  let expectedDisagreement = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const weight = (row - column) ** 2 / span ** 2;
      observedDisagreement += weight * observed[row][column];
      expectedDisagreement += (weight * truthTotals[row] * predictedTotals[column]) / n;
    }
  }

  if (expectedDisagreement === 0) return null;
  return 1 - observedDisagreement / expectedDisagreement;
}

/**
 * Cohen's kappa for nominal labels. Null for empty input and when chance
 * agreement is 1 (both raters used a single identical label).
 */
export function cohensKappa(
  first: readonly string[],
  second: readonly string[],
): number | null {
  assertSameLength(first, second);
  if (!first.length) return null;

  const n = first.length;
  const firstCounts = new Map<string, number>();
  const secondCounts = new Map<string, number>();
  let agreements = 0;
  first.forEach((label, position) => {
    firstCounts.set(label, (firstCounts.get(label) ?? 0) + 1);
    secondCounts.set(second[position], (secondCounts.get(second[position]) ?? 0) + 1);
    if (label === second[position]) agreements += 1;
  });

  const observed = agreements / n;
  let expected = 0;
  for (const [label, count] of firstCounts) {
    expected += (count / n) * ((secondCounts.get(label) ?? 0) / n);
  }

  if (expected >= 1) return null;
  return (observed - expected) / (1 - expected);
}

/**
 * Percentile with linear interpolation between closest ranks (the default
 * "type 7" definition used by NumPy and R). `p` is in [0, 100].
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`Percentile must be between 0 and 100 (got ${p}).`);
  }
  if (!values.length) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

/**
 * USD per 1,000 reviews: the sum of known per-review costs divided by
 * `total` reviews (default: `costs.length`, so unknown costs count as
 * reviews processed). Null when no cost is known.
 */
export function costPer1k(
  costs: ReadonlyArray<number | null | undefined>,
  total: number = costs.length,
): number | null {
  const known = costs.filter(
    (cost): cost is number => typeof cost === "number" && Number.isFinite(cost),
  );
  if (!known.length || total <= 0) return null;
  return (known.reduce((sum, cost) => sum + cost, 0) / total) * 1000;
}

/** Share of outcomes that failed. Null for empty input. */
export function unclassifiedRate(outcomes: ReadonlyArray<{ ok: boolean }>): number | null {
  if (!outcomes.length) return null;
  return outcomes.filter((outcome) => !outcome.ok).length / outcomes.length;
}

/** Mulberry32: a small, fast, seeded PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  confidence: number;
  iterations: number;
  seed: number;
}

/**
 * Percentile bootstrap confidence interval for macro-F1: rows are resampled
 * with replacement `iterations` times using a seeded PRNG, so the result is
 * deterministic for a given input and seed. Null for empty input.
 */
export function bootstrapMacroF1Ci(
  truth: readonly string[],
  predicted: readonly string[],
  options: {
    iterations?: number;
    confidence?: number;
    seed?: number;
    labels?: readonly string[];
  } = {},
): ConfidenceInterval | null {
  assertSameLength(truth, predicted);
  const iterations = options.iterations ?? 1000;
  const confidence = options.confidence ?? 0.95;
  const seed = options.seed ?? 42;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`Bootstrap iterations must be a positive integer (got ${iterations}).`);
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error(`Confidence must be between 0 and 1 (got ${confidence}).`);
  }
  if (!truth.length) return null;

  const random = createRng(seed);
  const n = truth.length;
  const scores: number[] = [];
  const sampleTruth = new Array<string>(n);
  const samplePredicted = new Array<string>(n);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let position = 0; position < n; position += 1) {
      const pick = Math.floor(random() * n);
      sampleTruth[position] = truth[pick];
      samplePredicted[position] = predicted[pick];
    }
    const score = macroF1(sampleTruth, samplePredicted, { labels: options.labels });
    // A resample can contain only labels outside `labels`; skip it.
    if (score !== null) scores.push(score);
  }

  const tail = ((1 - confidence) / 2) * 100;
  const lower = percentile(scores, tail);
  const upper = percentile(scores, 100 - tail);
  if (lower === null || upper === null) return null;
  return { lower, upper, confidence, iterations, seed };
}
