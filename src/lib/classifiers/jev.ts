import { z } from "zod";

import {
  REASON_KEYS,
  SENTIMENT_CRITERIA,
  TAXONOMY_VERSION,
  buildClassification,
  delay,
  errorMessage,
  isAdSubreason,
  isReason,
  validDistribution,
  type ClassificationOutcome,
  type ClassifierInfo,
  type ClassifierProvider,
} from "@/lib/classifiers/provider";
import { envInteger, isConfigured } from "@/lib/env";
import { PublicError, upstreamError } from "@/lib/errors";
import {
  AD_SUBREASON_DEFINITIONS,
  REASON_DEFINITIONS,
  SENTIMENT_LABELS,
  type Classification,
  type ReasonKey,
  type Review,
  type SentimentLabel,
} from "@/lib/types";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const PROMPT_VERSION = "jev-questions-v2";

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
    ad_subreason: z.object({ choice: z.string() }).optional(),
  }),
});

type Probabilities = z.infer<typeof probabilitySchema>;

/**
 * Sentiment probabilities may arrive as a five-item array or keyed by label
 * or by score index ("0"–"4"). Anything else is rejected (null) rather than
 * guessed, and the provider's own score is used instead.
 */
function sentimentProbabilities(
  value: Probabilities,
): Record<SentimentLabel, number> | null {
  if (Array.isArray(value)) {
    if (value.length !== SENTIMENT_LABELS.length) return null;
    return validDistribution(
      SENTIMENT_LABELS,
      Object.fromEntries(SENTIMENT_LABELS.map((label, i) => [label, value[i]])),
    );
  }

  return validDistribution(
    SENTIMENT_LABELS,
    Object.fromEntries(
      SENTIMENT_LABELS.map((label, index) => [
        label,
        value[label] ?? value[String(index)] ?? 0,
      ]),
    ),
  );
}

/**
 * Reason probabilities are accepted only when keyed by reason; positional
 * arrays are ambiguous across taxonomy versions and are ignored.
 */
function reasonProbabilities(
  value: Probabilities,
): Record<ReasonKey, number> | null {
  if (Array.isArray(value)) return null;
  return validDistribution(
    REASON_KEYS,
    Object.fromEntries(REASON_KEYS.map((reason) => [reason, value[reason] ?? 0])),
  );
}

function jevInfo(): ClassifierInfo {
  return {
    provider: "jev",
    model: process.env.TYPESAFE_MODEL ?? "jev-1.13.0",
    promptVersion: PROMPT_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
  };
}

function requestBody(review: Review, model: string): string {
  return JSON.stringify({
    model,
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
        criteria: SENTIMENT_CRITERIA,
      },
      primary_reason: {
        type: "choice",
        instructions: "What is the main reason for the review?",
        criteria: REASON_DEFINITIONS,
      },
      ad_subreason: {
        type: "choice",
        instructions:
          "If the review complains about ads, what kind of ad complaint is it?",
        criteria: { ...AD_SUBREASON_DEFINITIONS, none: "The review is not about ads" },
      },
    },
  });
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Configuration errors abort the run: every review would fail the same way. */
function assertJevConfigured(): string {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!isConfigured(apiKey)) {
    throw new PublicError(
      "The Jev classifier is selected but TYPESAFE_API_KEY is not configured.",
    );
  }
  return apiKey;
}

export async function classifyWithJev(review: Review): Promise<Classification> {
  const apiKey = assertJevConfigured();

  const info = jevInfo();
  const maxRetries = envInteger("CLASSIFIER_MAX_RETRIES", 2, { min: 0, max: 5 });
  const baseDelay = envInteger("CLASSIFIER_RETRY_BASE_MS", 500, {
    min: 0,
    max: 10_000,
  });
  const timeout = envInteger("CLASSIFIER_TIMEOUT_MS", 30_000, {
    min: 1_000,
    max: 120_000,
  });

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: requestBody(review, info.model),
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      // Network errors and timeouts are transient: retry within budget.
      if (attempt < maxRetries) {
        await delay(baseDelay * 2 ** attempt);
        continue;
      }
      throw new PublicError(`TypeSafe System One request failed: ${errorMessage(error)}`, 502);
    }

    if (!response.ok) {
      if (isRetryable(response.status) && attempt < maxRetries) {
        await response.body?.cancel();
        await delay(baseDelay * 2 ** attempt);
        continue;
      }
      throw await upstreamError("TypeSafe System One", response);
    }

    const payload = jevResponseSchema.parse(await response.json());
    const selectedReason = payload.answers.primary_reason.choice;
    const selectedSubreason = payload.answers.ad_subreason?.choice ?? "";

    return buildClassification({
      info,
      model: payload.model,
      providerScore: payload.answers.sentiment.score,
      sentimentProbabilities: sentimentProbabilities(
        payload.answers.sentiment.probabilities,
      ),
      sentimentConfidence: payload.answers.sentiment.confidence,
      primaryReason: isReason(selectedReason) ? selectedReason : "other_unclear",
      // Jev answers one reason per question; no secondary reason.
      secondaryReason: null,
      adSubreason: isAdSubreason(selectedSubreason) ? selectedSubreason : null,
      reasonProbabilities: reasonProbabilities(
        payload.answers.primary_reason.probabilities,
      ),
      reasonConfidence: payload.answers.primary_reason.confidence,
    });
  }
}

export function createJevClassifier(): ClassifierProvider {
  return {
    info: jevInfo(),
    maxBatch: 1,
    concurrency: envInteger("CLASSIFIER_CONCURRENCY", 6, { min: 1, max: 20 }),
    async classify(reviews): Promise<ClassificationOutcome[]> {
      assertJevConfigured();
      return Promise.all(
        reviews.map(async (review) => {
          try {
            return { ok: true as const, classification: await classifyWithJev(review) };
          } catch (error) {
            return { ok: false as const, error: errorMessage(error) };
          }
        }),
      );
    },
  };
}
