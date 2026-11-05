import { describe, expect, it } from "vitest";

import { classifyMock, createMockClassifier } from "@/lib/classifiers/mock";
import type { ReasonKey, Review } from "@/lib/types";

function review(rating: number, title: string, body: string): Review {
  return {
    id: `${rating}-${title}`,
    store: "google_play",
    platform: "android",
    rating,
    title,
    body,
    createdAt: "2026-09-20T12:00:00Z",
    dateSemantics: "created_at",
    source: "demo",
  };
}

describe("classifyMock", () => {
  it.each([
    {
      input: review(4, "Great", "Love this easy app"),
      score: 4,
      reason: "praise_general",
    },
    {
      input: review(4, "Problem", "The app is broken and unusable"),
      score: 2,
      reason: "stability",
    },
    {
      input: review(1, "Failure", "broken unusable"),
      score: 0,
      reason: "stability",
    },
    {
      input: review(5, "Plain", "Nothing specific"),
      score: 4,
      reason: "praise_general",
    },
    {
      input: review(3, "Plain", "Nothing specific"),
      score: 2,
      reason: "other_unclear",
    },
  ] satisfies Array<{
    input: Review;
    score: number;
    reason: ReasonKey;
  }>)("classifies rating and text signals", ({ input, score, reason }) => {
    const result = classifyMock(input);

    expect(result.sentimentScore).toBe(score);
    expect(result.primaryReason).toBe(reason);
    expect(result.sentimentConfidence).toBeGreaterThan(0.7);
    expect(
      Object.values(result.sentimentProbabilities ?? {}).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBeCloseTo(1);
    expect(result.reasonProbabilities?.[reason]).toBe(0.75);
    expect(result.sentimentEstimator).toBe("probability_weighted");
    expect(result.provider).toBe("mock");
  });

  it("exposes a provider that classifies every review", async () => {
    const provider = createMockClassifier();
    const outcomes = await provider.classify([
      review(5, "Great", "Love it"),
      review(1, "Bad", "broken"),
    ]);

    expect(provider.info.model).toBe("mock-rules-v1");
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });
});
