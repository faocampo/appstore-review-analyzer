import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAppleReviews } from "@/lib/app-store-connect";
import { analyzeReviews } from "@/lib/analyze";
import { parseReviewCsv } from "@/lib/csv";
import { fetchGooglePlayReviews } from "@/lib/google-play";
import { classifyWithJev } from "@/lib/jev";
import { classifyMock } from "@/lib/mock-classifier";
import type { Classification, Review } from "@/lib/types";

vi.mock("@/lib/app-store-connect", () => ({
  fetchAppleReviews: vi.fn(),
}));
vi.mock("@/lib/csv", () => ({
  parseReviewCsv: vi.fn(),
}));
vi.mock("@/lib/google-play", () => ({
  fetchGooglePlayReviews: vi.fn(),
}));
vi.mock("@/lib/jev", () => ({
  classifyWithJev: vi.fn(),
}));

const googleReview: Review = {
  id: "google-review",
  store: "google_play",
  platform: "android",
  rating: 4,
  title: "Good",
  body: "Great app",
  createdAt: "2026-09-20T12:00:00Z",
  dateSemantics: "last_modified_fallback",
  source: "api",
};

const appleReview: Review = {
  id: "apple-review",
  store: "apple_app_store",
  platform: "ios",
  rating: 2,
  title: "Problem",
  body: "The app is slow",
  createdAt: "2026-09-19T12:00:00Z",
  dateSemantics: "created_at",
  source: "api",
};

const baseInput = {
  appName: "Test app",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  lastN: 10,
};

function jevClassification(review: Review): Classification {
  return {
    ...classifyMock(review),
    model: "jev-test",
  };
}

describe("analyzeReviews", () => {
  beforeEach(() => {
    vi.mocked(fetchGooglePlayReviews).mockReset();
    vi.mocked(fetchAppleReviews).mockReset();
    vi.mocked(parseReviewCsv).mockReset();
    vi.mocked(classifyWithJev).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("analyzes the synthetic demo in mock mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    vi.stubEnv("ANALYSIS_MODE", "mock");

    const result = await analyzeReviews({
      ...baseInput,
      sourceMode: "demo",
      startDate: "2026-08-01",
    });

    expect(result.metrics.reviewsAnalyzed).toBe(12);
    expect(result.analysisMode).toBe("mock");
    expect(result.model).toBe("mock-rules-v1");
    expect(result.notices).toContainEqual(expect.stringContaining("Demo mode"));
  });

  it("normalizes multiple CSV exports and reports skipped rows", async () => {
    vi.stubEnv("ANALYSIS_MODE", "mock");
    vi.mocked(parseReviewCsv)
      .mockReturnValueOnce({ reviews: [googleReview], skippedRows: 1 })
      .mockReturnValueOnce({ reviews: [appleReview], skippedRows: 0 });

    const result = await analyzeReviews({
      ...baseInput,
      sourceMode: "csv",
      csvFiles: [
        { name: "google.csv", platform: "android", content: "google" },
        { name: "apple.csv", platform: "ios", content: "apple" },
      ],
    });

    expect(parseReviewCsv).toHaveBeenCalledTimes(2);
    expect(result.metrics.reviewsAnalyzed).toBe(2);
    expect(result.notices).toContainEqual(
      expect.stringContaining("google.csv: skipped 1 rows"),
    );
  });

  it("continues when one live source fails", async () => {
    vi.stubEnv("ANALYSIS_MODE", "mock");
    vi.mocked(fetchGooglePlayReviews).mockResolvedValue([googleReview]);
    vi.mocked(fetchAppleReviews).mockRejectedValue(
      new Error("Apple unavailable"),
    );

    const result = await analyzeReviews({
      ...baseInput,
      sourceMode: "live_api",
      androidPackage: "com.example.app",
      appleAppId: "123",
      translationLanguage: "es",
    });

    expect(fetchGooglePlayReviews).toHaveBeenCalledWith({
      packageName: "com.example.app",
      translationLanguage: "es",
    });
    expect(result.metrics.androidReviews).toBe(1);
    expect(result.notices).toContainEqual(
      expect.stringContaining("App Store Connect: Apple unavailable"),
    );
  });

  it("combines errors when every selected live source fails", async () => {
    vi.mocked(fetchGooglePlayReviews).mockRejectedValue("denied");
    vi.mocked(fetchAppleReviews).mockRejectedValue(new Error("expired"));

    await expect(
      analyzeReviews({
        ...baseInput,
        sourceMode: "live_api",
        androidPackage: "com.example.app",
        appleAppId: "123",
      }),
    ).rejects.toThrow(
      "Google Play: request failed App Store Connect: expired",
    );
  });

  it("uses Jev classification in batches", async () => {
    vi.stubEnv("ANALYSIS_MODE", "jev");
    const reviews = Array.from({ length: 7 }, (_, index) => ({
      ...googleReview,
      id: `review-${index}`,
    }));
    vi.mocked(parseReviewCsv).mockReturnValue({
      reviews,
      skippedRows: 0,
    });
    vi.mocked(classifyWithJev).mockImplementation(async (review) =>
      jevClassification(review),
    );

    const result = await analyzeReviews({
      ...baseInput,
      sourceMode: "csv",
      csvFiles: [
        { name: "reviews.csv", platform: "android", content: "reviews" },
      ],
    });

    expect(classifyWithJev).toHaveBeenCalledTimes(7);
    expect(result.analysisMode).toBe("jev");
    expect(result.model).toBe("jev-test");
  });

  it.each([
    {
      sourceMode: "demo" as const,
      startDate: "2020-01-01",
      endDate: "2020-01-02",
    },
    {
      sourceMode: "csv" as const,
      csvFiles: undefined,
    },
  ])("rejects requests with no period reviews", async (input) => {
    await expect(
      analyzeReviews({
        ...baseInput,
        ...input,
      }),
    ).rejects.toThrow("No written reviews");
  });
});
