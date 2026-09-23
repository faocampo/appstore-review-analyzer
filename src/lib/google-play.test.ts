import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGooglePlayReviews } from "@/lib/google-play";

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

  it.each([undefined, "google_play_access_token_placeholder"])(
    "requires a configured access token",
    async (token) => {
      if (token) vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", token);
      else vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "");

      await expect(
        fetchGooglePlayReviews({ packageName: "com.example.app" }),
      ).rejects.toThrow("GOOGLE_PLAY_ACCESS_TOKEN is not configured");
    },
  );

  it("normalizes written reviews and follows page tokens", async () => {
    vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "google-token");
    vi.stubEnv("GOOGLE_PLAY_MAX_PAGES", "2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          reviews: [
            googleReview({
              id: "review-1",
              text: "Works well",
              seconds: "1789920000",
            }),
            googleReview({ id: "empty-review" }),
          ],
          tokenPagination: { nextPageToken: "next-token" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          reviews: [
            googleReview({
              id: "review-2",
              text: "Second page",
              seconds: 1789833600,
            }),
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const reviews = await fetchGooglePlayReviews({
      packageName: "com.example/app",
      translationLanguage: "es",
    });

    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      id: "review-1",
      platform: "android",
      rating: 4,
      body: "Works well",
      language: "en",
      appVersion: "1.2.3",
      source: "api",
    });
    const firstUrl = fetchMock.mock.calls[0]?.[0] as URL;
    const secondUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(firstUrl.pathname).toContain("com.example%2Fapp/reviews");
    expect(firstUrl.searchParams.get("translationLanguage")).toBe("es");
    expect(secondUrl.searchParams.get("token")).toBe("next-token");
  });

  it("handles empty responses without optional parameters", async () => {
    vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "google-token");
    vi.stubEnv("GOOGLE_PLAY_MAX_PAGES", "invalid");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchGooglePlayReviews({ packageName: "com.example.app" }),
    ).resolves.toEqual([]);
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.has("translationLanguage")).toBe(false);
    expect(url.searchParams.has("token")).toBe(false);
  });

  it("reports provider errors", async () => {
    vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "google-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );

    await expect(
      fetchGooglePlayReviews({ packageName: "com.example.app" }),
    ).rejects.toThrow("Google Play returned 403: forbidden");
  });
});
