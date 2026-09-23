import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/analyze/route";
import { analyzeReviews } from "@/lib/analyze";

vi.mock("@/lib/analyze", () => ({
  analyzeReviews: vi.fn(),
}));

const validBody = {
  appName: "Test app",
  sourceMode: "demo",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  lastN: 10,
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/analyze", () => {
  beforeEach(() => {
    vi.mocked(analyzeReviews).mockReset();
  });

  it("returns the analysis result", async () => {
    vi.mocked(analyzeReviews).mockResolvedValue({
      appName: "Test app",
    } as Awaited<ReturnType<typeof analyzeReviews>>);

    const response = await POST(request(validBody));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ appName: "Test app" });
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

  it("returns runtime error messages", async () => {
    vi.mocked(analyzeReviews).mockRejectedValue(new Error("Provider failed"));

    const response = await POST(request(validBody));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Provider failed",
    });
  });

  it("returns a generic message for unknown runtime failures", async () => {
    vi.mocked(analyzeReviews).mockRejectedValue("failure");

    const response = await POST(request(validBody));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "The analysis could not be completed.",
    });
  });
});
