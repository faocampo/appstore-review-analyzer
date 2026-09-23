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
});
