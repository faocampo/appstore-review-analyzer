import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeReviews, dedupeReviews } from "@/lib/analyze";
import { getClassifier } from "@/lib/classifiers";
import { MOCK_INFO, classifyMock, createMockClassifier } from "@/lib/classifiers/mock";
import { fetchAppleReviews } from "@/lib/connectors/app-store-connect";
import { parseReviewCsv } from "@/lib/connectors/csv";
import { fetchGooglePlayReviews } from "@/lib/connectors/google-play";
import { PublicError } from "@/lib/errors";
import type { Review, SourceCoverage } from "@/lib/types";

vi.mock("@/lib/connectors/app-store-connect", () => ({ fetchAppleReviews: vi.fn() }));
vi.mock("@/lib/connectors/csv", () => ({ parseReviewCsv: vi.fn() }));
vi.mock("@/lib/connectors/google-play", () => ({ fetchGooglePlayReviews: vi.fn() }));
vi.mock("@/lib/classifiers", () => ({ getClassifier: vi.fn() }));

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

function coverage(source: SourceCoverage["source"], extra: Partial<SourceCoverage> = {}): SourceCoverage {
  return {
    source,
    label: source,
    status: "complete",
    reviewsFetched: 1,
    truncated: false,
    dateSemantics: "created_at",
    ...extra,
  };
}

const baseInput = {
  appName: "Test app",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  lastN: 10,
};

describe("analyzeReviews", () => {
  beforeEach(() => {
    vi.mocked(fetchGooglePlayReviews).mockReset();
    vi.mocked(fetchAppleReviews).mockReset();
    vi.mocked(parseReviewCsv).mockReset();
    vi.mocked(getClassifier).mockReset().mockReturnValue(createMockClassifier());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("analyzes the synthetic demo and reports its coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));

    const result = await analyzeReviews({ ...baseInput, sourceMode: "demo", startDate: "2026-08-01" });

    expect(result.metrics.reviewsAnalyzed).toBe(12);
    expect(result.analysisMode).toBe("mock");
    expect(result.model).toBe("mock-rules-v1");
    expect(result.coverage).toEqual([expect.objectContaining({ source: "demo", status: "complete" })]);
    expect(result.notices).toContainEqual(expect.stringContaining("Demo mode"));
  });

  it("normalizes CSV exports, passes encoding, and reports skipped rows", async () => {
    vi.mocked(parseReviewCsv)
      .mockReturnValueOnce({ reviews: [googleReview], skippedRows: 1 })
      .mockReturnValueOnce({ reviews: [appleReview], skippedRows: 0 });

    const result = await analyzeReviews({
      ...baseInput,
      sourceMode: "csv",
      csvFiles: [
        { name: "google.csv", platform: "android", encoding: "base64", content: "Z29vZ2xl" },
        { name: "apple.csv", platform: "ios", content: "apple" },
      ],
    });

    expect(parseReviewCsv).toHaveBeenCalledWith(expect.objectContaining({ encoding: "base64" }));
    expect(result.metrics.reviewsAnalyzed).toBe(2);
    expect(result.coverage.map((item) => item.label)).toEqual([
      "google.csv (Google Play export)",
      "apple.csv (App Store export)",
    ]);
    expect(result.coverage[0]?.note).toContain("Skipped 1 rows");
    expect(result.notices).toContainEqual(expect.stringContaining("google.csv: skipped 1 rows"));
  });

  it("continues when one live source fails and surfaces partial coverage", async () => {
    vi.mocked(fetchGooglePlayReviews).mockResolvedValue({
      reviews: [googleReview],
      coverage: coverage("google_play_api", { status: "partial", label: "Google Play API", note: "Window limited." }),
    });
    vi.mocked(fetchAppleReviews).mockRejectedValue(new PublicError("App Store Connect returned HTTP 401.", 502));

    const result = await analyzeReviews({
      ...baseInput,
      sourceMode: "live_api",
      androidPackage: "com.example.app",
      appleAppId: "123",
      translationLanguage: "es",
    });

    expect(fetchGooglePlayReviews).toHaveBeenCalledWith({ packageName: "com.example.app", startDate: "2026-09-01" });
    expect(fetchAppleReviews).toHaveBeenCalledWith({ appId: "123", startDate: "2026-09-01" });
    expect(result.metrics.androidReviews).toBe(1);
    expect(result.period.membership).toBe("last_modified");
    expect(result.coverage).toEqual([
      expect.objectContaining({ source: "google_play_api", status: "partial" }),
      expect.objectContaining({ source: "app_store_connect_api", status: "failed", note: "App Store Connect returned HTTP 401." }),
    ]);
    expect(result.notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining("App Store Connect: App Store Connect returned HTTP 401."),
        "Google Play API: Window limited.",
        expect.stringContaining("original language"),
      ]),
    );
  });

  it("hides internal error details when every live source fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetchGooglePlayReviews).mockRejectedValue(new Error("ECONNRESET internal host"));
    vi.mocked(fetchAppleReviews).mockRejectedValue(new PublicError("App Store Connect returned HTTP 401.", 502));

    const error = await analyzeReviews({
      ...baseInput,
      sourceMode: "live_api",
      androidPackage: "com.example.app",
      appleAppId: "123",
    }).then(
      () => {
        throw new Error("expected a failure");
      },
      (caught: unknown) => caught as PublicError,
    );

    expect(error).toBeInstanceOf(PublicError);
    expect(error.status).toBe(502);
    expect(error.message).toBe("Google Play: request failed App Store Connect: App Store Connect returned HTTP 401.");
    consoleError.mockRestore();
  });

  it("deduplicates reviews and excludes unclassified ones from metrics", async () => {
    const reviews = [googleReview, { ...googleReview, updatedAt: "2026-09-21T00:00:00Z", body: "Edited" }, appleReview];
    vi.mocked(parseReviewCsv).mockReturnValue({ reviews, skippedRows: 0 });
    vi.mocked(getClassifier).mockReturnValue({
      info: MOCK_INFO,
      maxBatch: 10,
      concurrency: 1,
      classify: async (batch) =>
        batch.map((item) =>
          item.store === "apple_app_store"
            ? { ok: false as const, error: "timeout" }
            : { ok: true as const, classification: classifyMock(item) },
        ),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await analyzeReviews({
      ...baseInput,
      sourceMode: "csv",
      csvFiles: [{ name: "reviews.csv", platform: "android", content: "x" }],
    });

    expect(result.metrics.reviewsAnalyzed).toBe(1);
    expect(result.metrics.reviewsUnclassified).toBe(1);
    expect(result.reviews[0]?.body).toBe("Edited");
    expect(result.notices).toEqual(
      expect.arrayContaining([
        "Removed 1 duplicate reviews (same store and review id).",
        "1 of 2 reviews could not be classified and are excluded from the metrics.",
      ]),
    );
    consoleError.mockRestore();
  });

  it.each([
    { sourceMode: "demo" as const, startDate: "2020-01-01", endDate: "2020-01-02" },
    { sourceMode: "csv" as const, csvFiles: undefined },
  ])("rejects requests with no period reviews", async (input) => {
    await expect(analyzeReviews({ ...baseInput, ...input })).rejects.toMatchObject({
      message: "No written reviews were found in the selected period.",
      status: 422,
    });
  });
});

describe("dedupeReviews", () => {
  it("keeps the most recently updated review per store and id", () => {
    const older = { ...appleReview, updatedAt: "2026-09-19T13:00:00Z", body: "old" };
    const newer = { ...appleReview, updatedAt: "2026-09-20T13:00:00Z", body: "new" };
    const sameIdOtherStore = { ...googleReview, id: "apple-review" };

    const result = dedupeReviews([newer, older, sameIdOtherStore]);

    expect(result.duplicates).toBe(1);
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews.find((item) => item.store === "apple_app_store")?.body).toBe("new");
  });
});
