import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/analyze/route";
import { resetRateLimits } from "@/lib/access";
import { analyzeReviews } from "@/lib/analyze";
import { PublicError } from "@/lib/errors";

vi.mock("@/lib/analyze", () => ({ analyzeReviews: vi.fn() }));

const validBody = {
  appName: "Test app",
  sourceMode: "demo",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  lastN: 10,
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/analyze", () => {
  beforeEach(() => {
    vi.mocked(analyzeReviews).mockReset();
    resetRateLimits();
    vi.stubEnv("ANALYZE_API_TOKEN", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("returns the analysis result", async () => {
    vi.mocked(analyzeReviews).mockResolvedValue({ appName: "Test app" } as Awaited<ReturnType<typeof analyzeReviews>>);

    const response = await POST(request(validBody));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ appName: "Test app" });
  });

  it("requires the bearer token when one is configured", async () => {
    vi.stubEnv("ANALYZE_API_TOKEN", "token-1");
    vi.mocked(analyzeReviews).mockResolvedValue({ appName: "ok" } as Awaited<ReturnType<typeof analyzeReviews>>);

    expect((await POST(request(validBody))).status).toBe(401);
    expect((await POST(request(validBody, { Authorization: "Bearer token-1" }))).status).toBe(200);
  });

  it("fails closed in production without an access token", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await POST(request(validBody));

    expect(response.status).toBe(503);
    expect(analyzeReviews).not.toHaveBeenCalled();
  });

  it("rate limits each client", async () => {
    vi.stubEnv("ANALYZE_RATE_LIMIT_PER_MINUTE", "1");
    vi.mocked(analyzeReviews).mockResolvedValue({ appName: "ok" } as Awaited<ReturnType<typeof analyzeReviews>>);

    expect((await POST(request(validBody))).status).toBe(200);
    const limited = await POST(request(validBody));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("returns actionable validation errors", async () => {
    const response = await POST(request({ ...validBody, lastN: 0 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid analysis request.",
      details: [expect.stringContaining(">=1")],
    });
    expect(analyzeReviews).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "The request body must be valid JSON." });
  });

  it("returns public error messages with their status", async () => {
    vi.mocked(analyzeReviews).mockRejectedValue(new PublicError("No written reviews were found in the selected period.", 422));

    const response = await POST(request(validBody));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "No written reviews were found in the selected period." });
  });

  it("hides internal error details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(analyzeReviews).mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.12:5432"));

    const response = await POST(request(validBody));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "The analysis could not be completed." });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
