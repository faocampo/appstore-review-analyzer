import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGooglePlayReviews } from "@/lib/connectors/google-play";
import { getGooglePlayAccessToken } from "@/lib/credentials/google";

vi.mock("@/lib/credentials/google", () => ({
  getGooglePlayAccessToken: vi.fn().mockResolvedValue("google-token"),
}));

const NOW = Date.parse("2026-09-25T00:00:00Z");

function googleReview(options: {
  id: string;
  text?: string;
  seconds?: string | number;
}) {
  return {
    reviewId: options.id,
    comments: [
      {},
      {
        userComment: {
          text: options.text ?? "",
          starRating: 4,
          reviewerLanguage: "en",
          appVersionName: "1.2.3",
          lastModified: { seconds: options.seconds ?? "1789920000" },
        },
      },
    ],
  };
}

describe("fetchGooglePlayReviews", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("propagates credential errors", async () => {
    vi.mocked(getGooglePlayAccessToken).mockRejectedValueOnce(
      new Error("no credentials"),
    );

    await expect(
      fetchGooglePlayReviews({ packageName: "com.example.app" }),
    ).rejects.toThrow("no credentials");
  });

  it("normalizes written reviews, follows page tokens and never requests translation", async () => {
    vi.stubEnv("GOOGLE_PLAY_MAX_PAGES", "2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          reviews: [
            googleReview({ id: "review-1", text: "Works well" }),
            googleReview({ id: "empty-review" }),
          ],
          tokenPagination: { nextPageToken: "next-token" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          reviews: [
            googleReview({ id: "review-2", text: "Second page", seconds: 1789833600 }),
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGooglePlayReviews({
      packageName: "com.example/app",
      startDate: "2026-09-20",
      now: NOW,
    });

    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0]).toMatchObject({
      id: "review-1",
      platform: "android",
      rating: 4,
      body: "Works well",
      language: "en",
      appVersion: "1.2.3",
      dateSemantics: "last_modified_fallback",
      source: "api",
    });
    expect(result.coverage).toMatchObject({
      status: "complete",
      pagesFetched: 2,
      truncated: false,
      reviewsFetched: 2,
    });
    const firstUrl = fetchMock.mock.calls[0]?.[0] as URL;
    const secondUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(firstUrl.pathname).toContain("com.example%2Fapp/reviews");
    expect(firstUrl.searchParams.has("translationLanguage")).toBe(false);
    expect(secondUrl.searchParams.get("token")).toBe("next-token");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer google-token" },
    });
  });

  it("flags truncation at the page limit and periods beyond the API window", async () => {
    vi.stubEnv("GOOGLE_PLAY_MAX_PAGES", "1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          reviews: [googleReview({ id: "review-1", text: "Fine" })],
          tokenPagination: { nextPageToken: "more" },
        }),
      ),
    );

    const result = await fetchGooglePlayReviews({
      packageName: "com.example.app",
      startDate: "2026-08-01",
      now: NOW,
    });

    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.note).toContain("1-page limit");
    expect(result.coverage.note).toContain("last 7 days");
  });

  it("handles empty responses with default limits", async () => {
    vi.stubEnv("GOOGLE_PLAY_MAX_PAGES", "invalid");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGooglePlayReviews({ packageName: "com.example.app" });

    expect(result.reviews).toEqual([]);
    expect(result.coverage.status).toBe("complete");
    expect((fetchMock.mock.calls[0]?.[0] as URL).searchParams.has("token")).toBe(
      false,
    );
  });

  it("reports provider errors without exposing the response body", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret detail", { status: 403 })),
    );

    const error = await fetchGooglePlayReviews({
      packageName: "com.example.app",
    }).then(
      () => {
        throw new Error("expected a failure");
      },
      (caught: unknown) => caught as Error,
    );

    expect(error.message).toBe("Google Play returned HTTP 403.");
    expect(error.message).not.toContain("secret detail");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("secret detail"));
    consoleError.mockRestore();
  });
});
