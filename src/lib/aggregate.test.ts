import { describe, expect, it } from "vitest";

import { aggregateReviews } from "@/lib/aggregate";
import { MOCK_INFO, classifyMock } from "@/lib/classifiers/mock";
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
      classifier: MOCK_INFO,
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
    expect(result.period.membership).toBe("created_at");
    expect(result.metrics.sentimentEstimator).toBe("probability_weighted");
    expect(result.metrics.reviewsUnclassified).toBe(0);
    expect(result.classifier).toEqual({
      provider: "mock",
      model: "mock-rules-v1",
      promptVersion: "rules-v2",
      taxonomyVersion: "reasons-v2",
    });
    expect(result.coverage).toEqual([]);
    expect(result.adSubreasons).toEqual([
      expect.objectContaining({ subreason: "ad_frequency", count: 1, share: 1 }),
    ]);
  });

  it("labels last-modified and mixed period membership and estimators", () => {
    const google = analyzed({
      id: "g",
      store: "google_play",
      platform: "android",
      rating: 4,
      title: "",
      body: "Great app",
      createdAt: "2026-09-10T12:00:00Z",
      dateSemantics: "last_modified_fallback",
      source: "api",
    });
    const apple = {
      ...analyzed({
        id: "a",
        store: "apple_app_store",
        platform: "ios",
        rating: 2,
        title: "",
        body: "Slow",
        createdAt: "2026-09-11T12:00:00Z",
        dateSemantics: "created_at",
        source: "api",
      }),
    };
    apple.analysis = { ...apple.analysis, sentimentEstimator: "provider_score" };

    const base = {
      appName: "Test",
      sourceMode: "live_api" as const,
      classifier: MOCK_INFO,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      lastN: 5,
      unclassified: 3,
    };

    const googleOnly = aggregateReviews({ ...base, reviews: [google] });
    expect(googleOnly.period.membership).toBe("last_modified");
    expect(googleOnly.notices).toContainEqual(
      expect.stringContaining("last-modified date"),
    );

    const mixed = aggregateReviews({ ...base, reviews: [google, apple] });
    expect(mixed.period.membership).toBe("mixed");
    expect(mixed.metrics.sentimentEstimator).toBe("mixed");
    expect(mixed.metrics.reviewsUnclassified).toBe(3);

    const providerOnly = aggregateReviews({ ...base, reviews: [apple] });
    expect(providerOnly.metrics.sentimentEstimator).toBe("provider_score");
  });

  it("throws when the period contains no written reviews", () => {
    expect(() =>
      aggregateReviews({
        appName: "Empty",
        sourceMode: "demo",
        classifier: MOCK_INFO,
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
      classifier: MOCK_INFO,
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
