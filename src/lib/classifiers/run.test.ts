import { describe, expect, it, vi } from "vitest";

import { classifyMock, MOCK_INFO } from "@/lib/classifiers/mock";
import type { ClassifierProvider } from "@/lib/classifiers/provider";
import { classifyAll } from "@/lib/classifiers/run";
import type { Review } from "@/lib/types";

function review(id: string): Review {
  return {
    id,
    store: "apple_app_store",
    platform: "ios",
    rating: 4,
    title: "",
    body: "Great app",
    createdAt: "2026-09-20T12:00:00Z",
    dateSemantics: "created_at",
    source: "api",
  };
}

function provider(
  failIds: string[],
  options: { maxBatch?: number; concurrency?: number } = {},
): ClassifierProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    info: MOCK_INFO,
    maxBatch: options.maxBatch ?? 2,
    concurrency: options.concurrency ?? 2,
    calls,
    async classify(reviews) {
      calls.push(reviews.map((item) => item.id));
      return reviews.map((item) =>
        failIds.includes(item.id)
          ? { ok: false as const, error: `failed ${item.id}` }
          : { ok: true as const, classification: classifyMock(item) },
      );
    },
  };
}

describe("classifyAll", () => {
  it("batches by provider size and keeps going past per-review failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = provider(["b"]);

    const run = await classifyAll(fake, ["a", "b", "c", "d", "e"].map(review));

    expect(fake.calls).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(run.analyzed.map((item) => item.id)).toEqual(["a", "c", "d", "e"]);
    expect(run.failed).toBe(1);
    consoleError.mockRestore();
  });

  it("fails the run only when every review fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(classifyAll(provider(["a"]), [review("a")])).rejects.toThrow(
      "Classification failed for every review (mock)",
    );
    consoleError.mockRestore();
  });

  it("treats a missing outcome as a failure and handles empty input", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const short: ClassifierProvider = {
      ...provider([]),
      classify: async (reviews) => [
        { ok: true, classification: classifyMock(reviews[0]) },
      ],
    };

    const run = await classifyAll(short, [review("a"), review("b")]);
    expect(run.failed).toBe(1);
    await expect(classifyAll(short, [])).resolves.toEqual({ analyzed: [], failed: 0 });
    consoleError.mockRestore();
  });
});
