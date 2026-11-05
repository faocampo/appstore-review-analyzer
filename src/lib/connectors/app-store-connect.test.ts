import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAppleReviews } from "@/lib/connectors/app-store-connect";

vi.mock("@/lib/credentials/apple", () => ({
  getAppStoreConnectToken: vi.fn().mockResolvedValue("apple-token"),
}));

function appleReview(id: string, createdDate: string, body = "Useful app") {
  return { id, attributes: { rating: 4, title: "Title", body, createdDate } };
}

describe("fetchAppleReviews", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("normalizes written reviews and follows pagination", async () => {
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
            appleReview("empty-review", "2026-09-19T12:00:00Z", "  "),
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

    const result = await fetchAppleReviews({ appId: "app/id" });

    expect(result.reviews).toEqual([
      expect.objectContaining({
        id: "review-1",
        platform: "ios",
        rating: 5,
        territory: "USA",
        createdAt: "2026-09-20T12:00:00.000Z",
      }),
      expect.objectContaining({ id: "review-2", title: "", body: "Needs work" }),
    ]);
    expect(result.reviews[0]).not.toHaveProperty("reviewerNickname");
    expect(result.coverage).toMatchObject({
      status: "complete",
      pagesFetched: 2,
      truncated: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("apps/app%2Fid/customerReviews"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer apple-token" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.test/page-2",
      expect.any(Object),
    );
  });

  it("stops paginating once reviews are older than the start date", async () => {
    vi.stubEnv("APPLE_MAX_PAGES", "5");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          appleReview("in-period", "2026-09-10T00:00:00Z"),
          appleReview("too-old", "2026-08-20T00:00:00Z"),
        ],
        links: { next: "https://example.test/page-2" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAppleReviews({ appId: "123", startDate: "2026-09-01" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.reviews.map((review) => review.id)).toEqual(["in-period"]);
    expect(result.coverage).toMatchObject({ status: "complete", truncated: false });
  });

  it("flags truncation when the page limit is hit before the start date", async () => {
    vi.stubEnv("APPLE_MAX_PAGES", "1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          data: [appleReview("recent", "2026-09-20T00:00:00Z")],
          links: { next: "https://example.test/page-2" },
        }),
      ),
    );

    const result = await fetchAppleReviews({ appId: "123", startDate: "2026-09-01" });

    expect(result.coverage).toMatchObject({ status: "partial", truncated: true });
    expect(result.coverage.note).toContain("1-page limit");
  });

  it("reports provider errors without exposing the response body", async () => {
    vi.stubEnv("APPLE_MAX_PAGES", "invalid");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAppleReviews({ appId: "123" })).rejects.toThrow(
      "App Store Connect returned HTTP 429.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
