import { describe, expect, it } from "vitest";

import {
  mean,
  normalCdf,
  poissonRateTest,
  regularizedIncompleteBeta,
  studentTCdf,
  twoProportionTest,
  welchTest,
} from "@/server/guardrails/stats";

describe("distributions", () => {
  it("matches reference normal and t values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 5);
    // t(10): P(T <= 2.228139) = 0.975; t(3): P(T <= -3.182446) = 0.025
    expect(studentTCdf(2.228139, 10)).toBeCloseTo(0.975, 5);
    expect(studentTCdf(-3.182446, 3)).toBeCloseTo(0.025, 5);
    expect(studentTCdf(1.959964, Number.POSITIVE_INFINITY)).toBeCloseTo(0.975, 5);
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    expect(regularizedIncompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 10);
    expect(regularizedIncompleteBeta(0.9, 2, 5)).toBeCloseTo(0.999945, 5);
  });
});

describe("tests", () => {
  it("two-proportion test flags a higher test share", () => {
    const harm = twoProportionTest(60, 100, 30, 100);
    expect(harm.delta).toBeCloseTo(0.3);
    expect(harm.pValue).toBeLessThan(0.001);
    expect(twoProportionTest(30, 100, 60, 100).pValue).toBeGreaterThan(0.999);
    expect(twoProportionTest(0, 10, 0, 10)).toEqual({ delta: 0, pValue: 1 });
    expect(twoProportionTest(10, 10, 10, 10).pValue).toBe(1);
  });

  it("Welch test flags a lower test mean", () => {
    const test = { n: 50, sum: 50 * 1.5, sumSquares: 50 * (1.5 ** 2 + 1) };
    const control = { n: 50, sum: 50 * 2.5, sumSquares: 50 * (2.5 ** 2 + 1) };
    const result = welchTest(test, control);
    expect(mean(test)).toBeCloseTo(1.5);
    expect(result.delta).toBeCloseTo(-1);
    expect(result.pValue).toBeLessThan(0.001);
    expect(welchTest({ n: 1, sum: 2, sumSquares: 4 }, { n: 1, sum: 3, sumSquares: 9 })).toEqual({ delta: -1, pValue: 0 });
    expect(welchTest({ n: 1, sum: 3, sumSquares: 9 }, { n: 1, sum: 3, sumSquares: 9 }).pValue).toBe(1);
  });

  it("Poisson rate test compares rates per exposure and handles zeros", () => {
    const result = poissonRateTest(40, 1_000_000, 20, 1_000_000);
    expect(result.delta).toBeCloseTo(1);
    expect(result.pValue).toBeLessThan(0.01);
    expect(poissonRateTest(0, 1000, 0, 1000).delta).toBeCloseTo(0);
  });
});
