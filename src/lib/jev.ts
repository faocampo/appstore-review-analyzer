import { z } from "zod";

import {
  REASON_DEFINITIONS,
  SENTIMENT_LABELS,
  type Classification,
  type ReasonKey,
  type Review,
  type SentimentLabel,
  type SentimentScore,
} from "@/lib/types";

const probabilitySchema = z.union([
  z.array(z.number()),
  z.record(z.string(), z.number()),
]);

const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.object({
    sentiment: z.object({
      score: z.number().min(0).max(4),
      probabilities: probabilitySchema,
      confidence: z.number().min(0).max(1),
    }),
    primary_reason: z.object({
      choice: z.string(),
      probabilities: probabilitySchema,
      confidence: z.number().min(0).max(1),
    }),
  }),
});

function scoreProbabilities(
  value: z.infer<typeof probabilitySchema>,
): Record<SentimentLabel, number> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      SENTIMENT_LABELS.map((label, index) => [label, value[index] ?? 0]),
    ) as Record<SentimentLabel, number>;
  }

  return Object.fromEntries(
    SENTIMENT_LABELS.map((label, index) => [
      label,
      value[label] ?? value[String(index)] ?? 0,
    ]),
  ) as Record<SentimentLabel, number>;
}

function reasonProbabilities(
  value: z.infer<typeof probabilitySchema>,
): Record<ReasonKey, number> {
  const reasons = Object.keys(REASON_DEFINITIONS) as ReasonKey[];
  if (Array.isArray(value)) {
    return Object.fromEntries(
      reasons.map((reason, index) => [reason, value[index] ?? 0]),
    ) as Record<ReasonKey, number>;
  }

  return Object.fromEntries(
    reasons.map((reason) => [reason, value[reason] ?? 0]),
  ) as Record<ReasonKey, number>;
}

function isReason(value: string): value is ReasonKey {
  return value in REASON_DEFINITIONS;
}

export async function classifyWithJev(review: Review): Promise<Classification> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || apiKey.endsWith("_placeholder")) {
    throw new Error(
      "ANALYSIS_MODE is set to jev but TYPESAFE_API_KEY is not configured.",
    );
  }

  const requestedModel = process.env.TYPESAFE_MODEL ?? "jev-1.13.0";
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: requestedModel,
      state: {
        review_id: review.id,
        store: review.store,
        platform: review.platform,
        title: review.title,
        body: review.body,
        rating: review.rating,
        language: review.language,
        territory: review.territory,
      },
      questions: {
        sentiment: {
          type: "score",
          instructions:
            "How positive or negative is the review text toward the app overall?",
          criteria: [
            "Highly negative: strong dissatisfaction, severe complaint, abandonment, harm, or explicit rejection",
            "Negative: clear dissatisfaction, complaint, or poor experience",
            "Neutral or mixed: factual, ambiguous, or balanced positive and negative feedback",
            "Positive: clear satisfaction, praise, or positive experience",
            "Highly positive: enthusiastic praise, strong recommendation, delight, or loyalty",
          ],
        },
        primary_reason: {
          type: "choice",
          instructions: "What is the main reason for the review?",
          criteria: REASON_DEFINITIONS,
        },
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `TypeSafe System One returned ${response.status}: ${detail.slice(0, 300)}`,
    );
  }

  const payload = jevResponseSchema.parse(await response.json());
  const sentimentExpectedValue = payload.answers.sentiment.score;
  const sentimentScore = Math.round(sentimentExpectedValue) as SentimentScore;
  const probabilities = scoreProbabilities(
    payload.answers.sentiment.probabilities,
  );
  const selectedReason = payload.answers.primary_reason.choice;
  const primaryReason = isReason(selectedReason)
    ? selectedReason
    : "other_unclear";

  return {
    sentimentScore,
    sentimentLabel: SENTIMENT_LABELS[sentimentScore],
    sentimentExpectedValue,
    sentimentProbabilities: probabilities,
    sentimentConfidence: payload.answers.sentiment.confidence,
    primaryReason,
    reasonProbabilities: reasonProbabilities(
      payload.answers.primary_reason.probabilities,
    ),
    reasonConfidence: payload.answers.primary_reason.confidence,
    model: payload.model ?? requestedModel,
  };
}
