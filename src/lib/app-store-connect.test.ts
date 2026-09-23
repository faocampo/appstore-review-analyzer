import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAppleReviews } from "@/lib/app-store-connect";

describe("fetchAppleReviews", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([undefined, "apple_app_store_connect_jwt_placeholder"])(
    "requires a configured access token",
    async (token) => {
      if (token) vi.stubEnv("APPLE_APP_STORE_CONNECT_TOKEN", token);
      else vi.stubEnv("APPLE_APP_STORE_CONNECT_TOKEN", "");

      await expect(fetchAppleReviews("123")).rejects.toThrow(
        "APPLE_APP_STORE_CONNECT_TOKEN is not configured",
      );
    },
  );

  it("normalizes written reviews and follows pagination", async () => {
    vi.stubEnv("APPLE_APP_STORE_CONNECT_TOKEN", "apple-token");
    vi.stubEnv("APPLE_MAX_PAGES", "2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "review-1",
              attributes: {
                rating: 5,
                title: "Great",
                body: "Very useful",
                reviewerNickname: "Reviewer",
                createdDate: "2026-09-20T12:00:00Z",
                territory: "USA",
              },
            },
            {
              id: "empty-review",
              attributes: {
                rating: 3,
                title: "",
                body: "  ",
                createdDate: "2026-09-19T12:00:00Z",
              },
            },
          ],
          links: { next: "https://example.test/page-2" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "review-2",
              attributes: {
                rating: 2,
                body: "Needs work",
                createdDate: "2026-09-18T12:00:00Z",
              },
            },
          ],
          links: { next: null },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAppleReviews("app/id")).resolves.toEqual([
      expect.objectContaining({
        id: "review-1",
        platform: "ios",
        rating: 5,
        territory: "USA",
        createdAt: "2026-09-20T12:00:00.000Z",
      }),
      expect.objectContaining({
        id: "review-2",
        title: "",
        body: "Needs work",
      }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("apps/app%2Fid/customerReviews"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer apple-token",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.test/page-2",
      expect.any(Object),
    );
  });

  it("honors a one-page limit and reports provider errors", async () => {
    vi.stubEnv("APPLE_APP_STORE_CONNECT_TOKEN", "apple-token");
    vi.stubEnv("APPLE_MAX_PAGES", "1");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAppleReviews("123")).rejects.toThrow(
      "App Store Connect returned 429: rate limited",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default page limit for invalid configuration", async () => {
    vi.stubEnv("APPLE_APP_STORE_CONNECT_TOKEN", "apple-token");
    vi.stubEnv("APPLE_MAX_PAGES", "invalid");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [],
        links: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAppleReviews("123")).resolves.toEqual([]);
  });
});
