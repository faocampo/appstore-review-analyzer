import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyWithJev, createJevClassifier } from "@/lib/classifiers/jev";
import type { Review } from "@/lib/types";

const review: Review = {
  id: "review-1",
  store: "google_play",
  platform: "android",
  title: "Great",
  body: "The app works very well and is easy to use.",
  rating: 5,
  language: "en",
  territory: "US",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
  dateSemantics: "last_modified_fallback",
  source: "api",
};

function jevAnswer(overrides: {
  score?: number;
  sentimentProbabilities?: unknown;
  choice?: string;
  reasonProbabilities?: unknown;
  model?: string;
}) {
  return {
    ...(overrides.model ? { model: overrides.model } : {}),
    answers: {
      sentiment: {
        score: overrides.score ?? 3.83,
        confidence: 0.85,
        probabilities: overrides.sentimentProbabilities ?? {
          0: 0,
          1: 0,
          2: 0,
          3: 0.17,
          4: 0.83,
        },
      },
      primary_reason: {
        choice: overrides.choice ?? "praise_general",
        confidence: 0.9,
        probabilities: overrides.reasonProbabilities ?? { praise_general: 1 },
      },
    },
  };
}

describe("Jev classifier", () => {
  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("CLASSIFIER_RETRY_BASE_MS", "0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("weights the expected value by a valid five-level distribution", async () => {
    vi.stubEnv("TYPESAFE_MODEL", "jev-latest");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json(jevAnswer({ model: "jev-1.13.0" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyWithJev(review);

    expect(result).toMatchObject({
      sentimentScore: 4,
      sentimentLabel: "highly_positive",
      sentimentEstimator: "probability_weighted",
      primaryReason: "praise_general",
      provider: "jev",
      model: "jev-1.13.0",
      taxonomyVersion: "reasons-v2",
      promptVersion: "jev-questions-v2",
      secondaryReason: null,
      adSubreason: null,
    });
    expect(result.sentimentExpectedValue).toBeCloseTo(3.83);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.model).toBe("jev-latest");
    expect(body.state).not.toHaveProperty("reviewerNickname");
  });

  it("falls back to the provider score when probabilities are incomplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          jevAnswer({
            score: 1.2,
            sentimentProbabilities: [0.1, 0.7, 0.2],
            choice: "unsupported_reason",
            reasonProbabilities: [0.2, 0.8],
          }),
        ),
      ),
    );

    const result = await classifyWithJev(review);

    expect(result).toMatchObject({
      sentimentScore: 1,
      sentimentLabel: "negative",
      sentimentExpectedValue: 1.2,
      sentimentEstimator: "provider_score",
      sentimentProbabilities: null,
      reasonProbabilities: null,
      primaryReason: "other_unclear",
      model: "jev-1.13.0",
    });
  });

  it("maps label-keyed and five-item array probabilities by label", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            jevAnswer({
              score: 2,
              sentimentProbabilities: { neutral_mixed: 1 },
              choice: "ads",
              reasonProbabilities: { ads: 1 },
            }),
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            jevAnswer({ score: 0.2, sentimentProbabilities: [0.8, 0.2, 0, 0, 0] }),
          ),
        ),
    );

    const labelKeyed = await classifyWithJev(review);
    expect(labelKeyed.sentimentProbabilities?.neutral_mixed).toBe(1);
    expect(labelKeyed.reasonProbabilities?.ads).toBe(1);
    expect(labelKeyed.primaryReason).toBe("ads");

    const arrayBased = await classifyWithJev(review);
    expect(arrayBased.sentimentProbabilities?.highly_negative).toBeCloseTo(0.8);
    expect(arrayBased.sentimentExpectedValue).toBeCloseTo(0.2);
  });

  it("rejects distributions that do not sum to one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(jevAnswer({ score: 3, sentimentProbabilities: [0.5, 0.5, 0.5, 0, 0] })),
      ),
    );

    const result = await classifyWithJev(review);
    expect(result.sentimentEstimator).toBe("provider_score");
    expect(result.sentimentExpectedValue).toBe(3);
  });

  it.each([undefined, "typesafe_api_key_placeholder"])(
    "requires a configured TypeSafe key",
    async (apiKey) => {
      vi.stubEnv("TYPESAFE_API_KEY", apiKey ?? "");

      await expect(classifyWithJev(review)).rejects.toThrow(
        "TYPESAFE_API_KEY is not configured",
      );
      await expect(createJevClassifier().classify([review])).rejects.toThrow(
        "TYPESAFE_API_KEY is not configured",
      );
    },
  );

  it("retries rate limits, then reports provider errors without the body", async () => {
    vi.stubEnv("CLASSIFIER_MAX_RETRIES", "1");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("still busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(classifyWithJev(review)).rejects.toThrow(
      "TypeSafe System One returned HTTP 503.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("returns per-review outcomes from the provider adapter", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(jevAnswer({})))
        .mockResolvedValueOnce(new Response("bad request", { status: 400 })),
    );

    const provider = createJevClassifier();
    const outcomes = await provider.classify([review, { ...review, id: "review-2" }]);

    expect(provider.maxBatch).toBe(1);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]).toEqual({
      ok: false,
      error: "TypeSafe System One returned HTTP 400.",
    });
    consoleError.mockRestore();
  });

  it("maps the ad sub-reason answer and ignores 'none'", async () => {
    const withSubreason = (choice: string) => {
      const answer = jevAnswer({ choice: "ads", score: 0.5 });
      return Response.json({
        ...answer,
        answers: { ...answer.answers, ad_subreason: { choice } },
      });
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(withSubreason("ad_reward_failure"))
        .mockResolvedValueOnce(withSubreason("none")),
    );

    expect((await classifyWithJev(review)).adSubreason).toBe("ad_reward_failure");
    expect((await classifyWithJev(review)).adSubreason).toBe("ad_other");
  });
});

describe("Jev network resilience", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("retries network errors and reports a safe error after the budget", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("CLASSIFIER_RETRY_BASE_MS", "0");
    vi.stubEnv("CLASSIFIER_MAX_RETRIES", "1");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json(jevAnswer({})));
    vi.stubGlobal("fetch", fetchMock);
    await expect(classifyWithJev(review)).resolves.toMatchObject({ provider: "jev" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(classifyWithJev(review)).rejects.toThrow("TypeSafe System One request failed: fetch failed");
  });

  it("prices each review from the contract price so budgets apply", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_COST_PER_REVIEW_USD", "0.0004");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(jevAnswer({}))));
    expect((await classifyWithJev(review)).costUsd).toBe(0.0004);
    vi.stubEnv("TYPESAFE_COST_PER_REVIEW_USD", "");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(jevAnswer({}))));
    expect((await classifyWithJev(review)).costUsd).toBeNull();
  });
});
