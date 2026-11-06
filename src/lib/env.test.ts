import { afterEach, describe, expect, it, vi } from "vitest";

import { envInteger, isConfigured } from "@/lib/env";

describe("env helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parses and clamps integers", () => {
    vi.stubEnv("TEST_INT", "500");
    expect(envInteger("TEST_INT", 5, { min: 1, max: 50 })).toBe(50);
    vi.stubEnv("TEST_INT", "nope");
    expect(envInteger("TEST_INT", 5, { min: 1, max: 50 })).toBe(5);
  });

  it("treats placeholders as unconfigured", () => {
    expect(isConfigured("real-value")).toBe(true);
    expect(isConfigured("api_key_placeholder")).toBe(false);
    expect(isConfigured(undefined)).toBe(false);
  });
});
