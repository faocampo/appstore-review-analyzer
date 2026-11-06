/**
 * Small, dependency-free statistics for guardrails. All tests are one-sided
 * in the harmful direction: a guardrail asks "is the test arm worse?".
 */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf; |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function logGamma(value: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let x = value;
  let y = value;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (const coefficient of coefficients) series += coefficient / ++y;
  x = value;
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

/** Continued fraction for the regularized incomplete beta (Numerical Recipes betacf). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Student t CDF with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(df) || df > 1e6) return normalCdf(t);
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

export interface TestResult {
  delta: number;
  /** One-sided p-value for "test is worse than control". */
  pValue: number;
}

/** Two-proportion z-test; harm means the test proportion is higher. */
export function twoProportionTest(
  testCount: number,
  testN: number,
  controlCount: number,
  controlN: number,
): TestResult {
  const p1 = testCount / testN;
  const p2 = controlCount / controlN;
  const pooled = (testCount + controlCount) / (testN + controlN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / testN + 1 / controlN));
  const delta = p1 - p2;
  if (se === 0) return { delta, pValue: delta > 0 ? 0 : 1 };
  return { delta, pValue: 1 - normalCdf(delta / se) };
}

export interface MeanSummary {
  n: number;
  sum: number;
  sumSquares: number;
}

export function mean(summary: MeanSummary): number {
  return summary.sum / summary.n;
}

function variance(summary: MeanSummary): number {
  if (summary.n < 2) return 0;
  return Math.max(0, (summary.sumSquares - (summary.sum * summary.sum) / summary.n) / (summary.n - 1));
}

/** Welch's t-test; harm means the test mean is lower. */
export function welchTest(test: MeanSummary, control: MeanSummary): TestResult {
  const delta = mean(test) - mean(control);
  const v1 = variance(test) / test.n;
  const v2 = variance(control) / control.n;
  const se = Math.sqrt(v1 + v2);
  if (se === 0) return { delta, pValue: delta < 0 ? 0 : 1 };
  const df = (v1 + v2) ** 2 / ((v1 * v1) / (test.n - 1) + (v2 * v2) / (control.n - 1));
  return { delta, pValue: studentTCdf(delta / se, df) };
}

/**
 * Poisson rate comparison via the log rate ratio (counts per exposure);
 * harm means the test rate is higher. `delta` is the relative change
 * (ratio − 1). Adds 0.5 to zero counts for a finite log ratio.
 */
export function poissonRateTest(
  testCount: number,
  testExposure: number,
  controlCount: number,
  controlExposure: number,
): TestResult {
  const x1 = testCount || 0.5;
  const x2 = controlCount || 0.5;
  const ratio = x1 / testExposure / (x2 / controlExposure);
  const se = Math.sqrt(1 / x1 + 1 / x2);
  return { delta: ratio - 1, pValue: 1 - normalCdf(Math.log(ratio) / se) };
}
