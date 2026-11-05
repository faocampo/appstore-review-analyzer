import { afterEach, describe, expect, it, vi } from "vitest";

import { getClassifier, resolveClassifierId } from "@/lib/classifiers";

describe("classifier selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [{ CLASSIFIER_PROVIDER: "OpenRouter" }, "openrouter"],
    [{ CLASSIFIER_PROVIDER: "jev" }, "jev"],
    [{ CLASSIFIER_PROVIDER: "mock", ANALYSIS_MODE: "jev" }, "mock"],
    [{ CLASSIFIER_PROVIDER: "", ANALYSIS_MODE: "jev" }, "jev"],
    [{ CLASSIFIER_PROVIDER: "", ANALYSIS_MODE: "mock" }, "mock"],
    [{ CLASSIFIER_PROVIDER: "", ANALYSIS_MODE: "", NODE_ENV: "production" }, "openrouter"],
    [{ CLASSIFIER_PROVIDER: "", ANALYSIS_MODE: "", NODE_ENV: "development" }, "mock"],
  ])("resolves %o to %s", (env, expected) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect(resolveClassifierId()).toBe(expected);
    expect(getClassifier().info.provider).toBe(expected);
  });

  it("rejects unknown providers", () => {
    vi.stubEnv("CLASSIFIER_PROVIDER", "gpt");
    expect(() => resolveClassifierId()).toThrow('Unknown CLASSIFIER_PROVIDER "gpt"');
  });
});
