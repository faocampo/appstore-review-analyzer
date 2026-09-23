import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyWithJev } from "@/lib/jev";
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

describe("classifyWithJev", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("accepts TypeSafe's continuous score and maps it to a sentiment level", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_MODEL", "jev-latest");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              sentiment: {
                type: "score",
                score: 3.83,
                confidence: 0.85,
                probabilities: {
                  0: 0,
                  1: 0,
                  2: 0,
                  3: 0.17,
                  4: 0.83,
                },
              },
              primary_reason: {
                type: "choice",
                choice: "praise_general",
                confidence: 1,
                probabilities: {
                  praise_general: 1,
                  other_unclear: 0,
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(classifyWithJev(review)).resolves.toMatchObject({
      sentimentScore: 4,
      sentimentLabel: "highly_positive",
      sentimentExpectedValue: 3.83,
      primaryReason: "praise_general",
      model: "jev-1.13.0",
    });
  });

  it.each([undefined, "typesafe_api_key_placeholder"])(
    "requires a configured TypeSafe key",
    async (apiKey) => {
      if (apiKey) vi.stubEnv("TYPESAFE_API_KEY", apiKey);
      else vi.stubEnv("TYPESAFE_API_KEY", "");

      await expect(classifyWithJev(review)).rejects.toThrow(
        "TYPESAFE_API_KEY is not configured",
      );
    },
  );

  it("reports TypeSafe provider errors", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad model", { status: 400 })),
    );

    await expect(classifyWithJev(review)).rejects.toThrow(
      "TypeSafe System One returned 400: bad model",
    );
  });

  it("supports array probabilities and falls back for unknown reasons", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          answers: {
            sentiment: {
              score: 1.2,
              confidence: 0.7,
              probabilities: [0.1, 0.7, 0.2],
            },
            primary_reason: {
              choice: "unsupported_reason",
              confidence: 0.6,
              probabilities: [0.2, 0.8],
            },
          },
        }),
      ),
    );

    await expect(classifyWithJev(review)).resolves.toMatchObject({
      sentimentScore: 1,
      sentimentLabel: "negative",
      sentimentProbabilities: {
        highly_negative: 0.1,
        negative: 0.7,
        neutral_mixed: 0.2,
        positive: 0,
        highly_positive: 0,
      },
      primaryReason: "other_unclear",
      model: "jev-1.13.0",
    });
  });

  it("accepts label-keyed sentiment probabilities", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_MODEL", "custom-model");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          answers: {
            sentiment: {
              score: 2,
              confidence: 0.5,
              probabilities: {
                neutral_mixed: 1,
              },
            },
            primary_reason: {
              choice: "ads",
              confidence: 0.9,
              probabilities: {
                ads: 0.9,
              },
            },
          },
        }),
      ),
    );

    const result = await classifyWithJev(review);
    expect(result.sentimentProbabilities.neutral_mixed).toBe(1);
    expect(result.primaryReason).toBe("ads");
    expect(result.model).toBe("custom-model");
  });
});
