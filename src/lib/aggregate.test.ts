import { describe, expect, it } from "vitest";

import { aggregateReviews } from "@/lib/aggregate";
import { classifyMock } from "@/lib/mock-classifier";
import type { AnalyzedReview, Review } from "@/lib/types";

function analyzed(review: Review): AnalyzedReview {
  return { ...review, analysis: classifyMock(review) };
}

describe("aggregateReviews", () => {
  it("filters by created date and calculates deterministic metrics", () => {
    const reviews = [
      analyzed({
        id: "1",
        store: "google_play",
        platform: "android",
        rating: 1,
        title: "Too many ads",
        body: "Ads make it unusable.",
        createdAt: "2026-09-10T12:00:00Z",
        dateSemantics: "created_at",
        source: "csv",
      }),
      analyzed({
        id: "2",
        store: "apple_app_store",
        platform: "ios",
        rating: 5,
        title: "Excellent",
        body: "I love this useful app.",
        createdAt: "2026-09-12T12:00:00Z",
        dateSemantics: "created_at",
        source: "csv",
      }),
      analyzed({
        id: "3",
        store: "google_play",
        platform: "android",
        rating: 3,
        title: "Old review",
        body: "This should not be included.",
        createdAt: "2026-08-12T12:00:00Z",
        dateSemantics: "created_at",
        source: "csv",
      }),
    ];

    const result = aggregateReviews({
      appName: "Test app",
      sourceMode: "csv",
      analysisMode: "mock",
      model: "mock-rules-v1",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      lastN: 10,
      reviews,
    });

    expect(result.metrics.reviewsAnalyzed).toBe(2);
    expect(result.metrics.averageRating).toBe(3);
    expect(result.metrics.androidReviews).toBe(1);
    expect(result.metrics.iosReviews).toBe(1);
    expect(result.reasons.negative[0]?.reason).toBe("ads");
  });

  it("throws when the period contains no written reviews", () => {
    expect(() =>
      aggregateReviews({
        appName: "Empty",
        sourceMode: "demo",
        analysisMode: "mock",
        model: "mock-rules-v1",
        startDate: "2020-01-01",
        endDate: "2020-01-02",
        lastN: 10,
        reviews: [],
      }),
    ).toThrow("No written reviews");
  });

  it("groups neutral reasons, limits latest reviews, and de-duplicates notices", () => {
    const reviews = [
      analyzed({
        id: "newer",
        store: "google_play",
        platform: "android",
        rating: 3,
        title: "Fine",
        body: "The content is fine.",
        createdAt: "2026-09-30T23:59:59.999Z",
        dateSemantics: "created_at",
        source: "csv",
      }),
      analyzed({
        id: "older",
        store: "apple_app_store",
        platform: "ios",
        rating: 3,
        title: "Fine",
        body: "The content is fine.",
        createdAt: "2026-09-01T00:00:00.000Z",
        dateSemantics: "created_at",
        source: "csv",
      }),
    ];

    const result = aggregateReviews({
      appName: "Test app",
      sourceMode: "csv",
      analysisMode: "mock",
      model: "mock-rules-v1",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      lastN: 1,
      reviews,
      notices: ["Duplicate", "Duplicate"],
    });

    expect(result.reviews.map((review) => review.id)).toEqual(["newer"]);
    expect(result.reasons.neutral).toEqual([
      expect.objectContaining({
        reason: "content_quality",
        count: 2,
        share: 1,
      }),
    ]);
    expect(result.notices.filter((notice) => notice === "Duplicate")).toHaveLength(
      1,
    );
  });
});
