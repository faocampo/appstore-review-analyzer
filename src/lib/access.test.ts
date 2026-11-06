import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeRequest, checkRateLimit, clientKey, resetRateLimits } from "@/lib/access";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/analyze", { method: "POST", headers });
}

describe("authorizeRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is open outside production when no token is configured", () => {
    vi.stubEnv("ANALYZE_API_TOKEN", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(authorizeRequest(request())).toEqual({ allowed: true });
  });

  it("fails closed in production when no token is configured", () => {
    vi.stubEnv("ANALYZE_API_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(authorizeRequest(request())).toMatchObject({ allowed: false, status: 503 });
  });

  it("requires the configured bearer token", () => {
    vi.stubEnv("ANALYZE_API_TOKEN", "s3cret");
    expect(authorizeRequest(request({ Authorization: "Bearer s3cret" }))).toEqual({ allowed: true });
    expect(authorizeRequest(request({ Authorization: "bearer  s3cret " }))).toEqual({ allowed: true });
    expect(authorizeRequest(request({ Authorization: "Bearer wrong" }))).toMatchObject({ allowed: false, status: 401 });
    expect(authorizeRequest(request({ Authorization: "Bearer s3cre7" }))).toMatchObject({ allowed: false, status: 401 });
    expect(authorizeRequest(request())).toMatchObject({ allowed: false, status: 401 });
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetRateLimits());
  afterEach(() => vi.unstubAllEnvs());

  it("limits requests per client per minute", () => {
    vi.stubEnv("ANALYZE_RATE_LIMIT_PER_MINUTE", "2");
    const now = 1_000_000;
    expect(checkRateLimit("a", now).allowed).toBe(true);
    expect(checkRateLimit("a", now + 1).allowed).toBe(true);
    expect(checkRateLimit("a", now + 2)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(checkRateLimit("b", now + 2).allowed).toBe(true);
    expect(checkRateLimit("a", now + 60_000).allowed).toBe(true);
  });

  it("evicts expired windows when many clients are tracked", () => {
    for (let index = 0; index <= 10_000; index += 1) checkRateLimit(`c${index}`, 0);
    expect(checkRateLimit("late", 61_000).allowed).toBe(true);
  });

  it("derives the client key from proxy headers", () => {
    expect(clientKey(request({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" }))).toBe("1.1.1.1");
    expect(clientKey(request({ "x-real-ip": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientKey(request())).toBe("unknown");
  });
});
