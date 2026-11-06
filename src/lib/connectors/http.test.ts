import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry, retryAfterMs } from "@/lib/connectors/http";

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("retries 429 and 5xx, then returns the final response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test", {}, { retries: 2, baseDelayMs: 0 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors and stops at the retry budget", async () => {
    vi.stubEnv("STORE_MAX_RETRIES", "1");
    vi.stubEnv("STORE_RETRY_BASE_MS", "0");
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchWithRetry("https://example.test", {})).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const notFound = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", notFound);
    expect((await fetchWithRetry("https://example.test", {})).status).toBe(404);
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("parses Retry-After seconds and dates, capped at 60 s", () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("999")).toBe(60_000);
    expect(retryAfterMs("Thu, 05 Nov 2026 00:00:10 GMT", () => Date.parse("2026-11-05T00:00:00Z"))).toBe(10_000);
    expect(retryAfterMs("garbage")).toBeNull();
    expect(retryAfterMs("-5")).toBe(0);
  });
});
