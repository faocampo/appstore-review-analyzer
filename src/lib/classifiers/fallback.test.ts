import { describe, expect, it, vi } from "vitest";

import { withFallback } from "@/lib/classifiers/fallback";
import { MOCK_INFO, classifyMock } from "@/lib/classifiers/mock";
import type { ClassifierProvider } from "@/lib/classifiers/provider";
import type { Review } from "@/lib/types";

function review(id: string): Review {
  return {
    id,
    store: "google_play",
    platform: "android",
    rating: 2,
    title: "",
    body: "Too many ads",
    createdAt: "2026-10-01T00:00:00Z",
    dateSemantics: "created_at",
    source: "api",
  };
}

function provider(
  name: "openrouter" | "jev",
  behavior: (id: string) => boolean | "throw",
): ClassifierProvider & { calls: number } {
  const fake = {
    info: { ...MOCK_INFO, provider: name },
    maxBatch: 10,
    concurrency: 2,
    calls: 0,
    async classify(reviews: Review[]) {
      fake.calls += 1;
      if (reviews.some((item) => behavior(item.id) === "throw")) throw new Error("boom");
      return reviews.map((item) =>
        behavior(item.id)
          ? { ok: true as const, classification: { ...classifyMock(item), provider: name } }
          : { ok: false as const, error: `${name} failed` },
      );
    },
  };
  return fake;
}

describe("withFallback", () => {
  it("retries only the failed reviews on the fallback", async () => {
    const primary = provider("openrouter", (id) => id !== "b");
    const fallback = provider("jev", () => true);
    const wrapped = withFallback(primary, fallback, { failureThreshold: 3, cooldownMs: 1000 });

    const outcomes = await wrapped.classify([review("a"), review("b")]);

    expect(outcomes.map((item) => item.ok && item.classification.provider)).toEqual([
      "openrouter",
      "jev",
    ]);
    expect(wrapped.info.provider).toBe("openrouter");
  });

  it("opens the circuit after consecutive failures and half-opens after cooldown", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let clock = 0;
    const primary = provider("openrouter", () => "throw");
    const fallback = provider("jev", () => true);
    const wrapped = withFallback(primary, fallback, {
      failureThreshold: 2,
      cooldownMs: 1000,
      now: () => clock,
    });

    await wrapped.classify([review("a")]);
    await wrapped.classify([review("a")]);
    expect(wrapped.circuitOpenUntil).toBe(1000);

    await wrapped.classify([review("a")]);
    expect(primary.calls).toBe(2);

    clock = 1001;
    await wrapped.classify([review("a")]);
    expect(primary.calls).toBe(3);
    consoleError.mockRestore();
  });

  it("resets the failure count after a success and keeps failures the fallback cannot fix", async () => {
    const primary = provider("openrouter", (id) => id === "ok");
    const fallback = provider("jev", () => false);
    const wrapped = withFallback(primary, fallback, { failureThreshold: 1, cooldownMs: 1000 });

    const outcomes = await wrapped.classify([review("ok"), review("bad")]);
    expect(outcomes[1]).toEqual({ ok: false, error: "openrouter failed" });
    expect(wrapped.circuitOpenUntil).toBe(0);
    await expect(wrapped.classify([])).resolves.toEqual([]);
  });

  it("converts non-Error throws into failures", async () => {
    const primary: ClassifierProvider = {
      ...provider("openrouter", () => true),
      classify: async () => {
        throw "nope";
      },
    };
    const fallback = provider("jev", () => false);
    const wrapped = withFallback(primary, fallback, { failureThreshold: 5, cooldownMs: 1 });

    await expect(wrapped.classify([review("a")])).resolves.toEqual([
      { ok: false, error: "classification failed" },
    ]);
  });
});
