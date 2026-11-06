import {
  AD_SUBREASON_DEFINITIONS,
  REASON_DEFINITIONS,
  SENTIMENT_LABELS,
  type AdSubreasonKey,
  type Classification,
  type ClassifierId,
  type ReasonKey,
  type Review,
  type SentimentLabel,
  type SentimentScore,
} from "@/lib/types";
import { clamp } from "@/lib/env";

export const TAXONOMY_VERSION = "reasons-v2";

export const SENTIMENT_CRITERIA = [
  "Highly negative: strong dissatisfaction, severe complaint, abandonment, harm, or explicit rejection",
  "Negative: clear dissatisfaction, complaint, or poor experience",
  "Neutral or mixed: factual, ambiguous, or balanced positive and negative feedback",
  "Positive: clear satisfaction, praise, or positive experience",
  "Highly positive: enthusiastic praise, strong recommendation, delight, or loyalty",
] as const;

export const REASON_KEYS = Object.keys(REASON_DEFINITIONS) as ReasonKey[];
export const AD_SUBREASON_KEYS = Object.keys(
  AD_SUBREASON_DEFINITIONS,
) as AdSubreasonKey[];

export function isAdSubreason(value: string): value is AdSubreasonKey {
  return Object.prototype.hasOwnProperty.call(AD_SUBREASON_DEFINITIONS, value);
}

export interface ClassifierInfo {
  provider: ClassifierId;
  model: string;
  promptVersion: string;
  taxonomyVersion: string;
}

export type ClassificationOutcome =
  | { ok: true; classification: Classification }
  | { ok: false; error: string };

/**
 * A pluggable review classifier. Implementations must return exactly one
 * outcome per input review, in input order, and report per-review failures
 * as `{ ok: false }` instead of throwing, so one bad item never aborts a run.
 */
export interface ClassifierProvider {
  readonly info: ClassifierInfo;
  /** Reviews per `classify` call. */
  readonly maxBatch: number;
  /** Concurrent `classify` calls. */
  readonly concurrency: number;
  classify(reviews: Review[]): Promise<ClassificationOutcome[]>;
}

const PROBABILITY_SUM_TOLERANCE = 0.05;

export function isReason(value: string): value is ReasonKey {
  return Object.prototype.hasOwnProperty.call(REASON_DEFINITIONS, value);
}

/**
 * Returns a normalized probability map only when every key is present,
 * every value is a finite non-negative number, and the values sum to ~1.
 */
export function validDistribution<Key extends string>(
  keys: readonly Key[],
  values: Partial<Record<Key, number>>,
): Record<Key, number> | null {
  const entries = keys.map((key) => values[key]);
  if (
    entries.some(
      (value) =>
        value === undefined || !Number.isFinite(value) || value < 0,
    )
  ) {
    return null;
  }

  const numbers = entries as number[];
  const total = numbers.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > PROBABILITY_SUM_TOLERANCE) return null;

  return Object.fromEntries(
    keys.map((key, index) => [key, numbers[index] / total]),
  ) as Record<Key, number>;
}

export function buildClassification(options: {
  info: ClassifierInfo;
  providerScore: number;
  sentimentProbabilities: Record<SentimentLabel, number> | null;
  sentimentConfidence: number;
  primaryReason: ReasonKey;
  secondaryReason?: ReasonKey | null;
  adSubreason?: AdSubreasonKey | null;
  reasonProbabilities: Record<ReasonKey, number> | null;
  reasonConfidence: number;
  costUsd?: number | null;
  model?: string;
}): Classification {
  const weighted = options.sentimentProbabilities
    ? SENTIMENT_LABELS.reduce(
        (sum, label, index) =>
          sum + index * (options.sentimentProbabilities?.[label] ?? 0),
        0,
      )
    : null;
  const expectedValue = clamp(weighted ?? options.providerScore, 0, 4);
  const sentimentScore = Math.round(expectedValue) as SentimentScore;

  return {
    sentimentScore,
    sentimentLabel: SENTIMENT_LABELS[sentimentScore],
    sentimentExpectedValue: expectedValue,
    sentimentEstimator:
      weighted === null ? "provider_score" : "probability_weighted",
    sentimentProbabilities: options.sentimentProbabilities,
    sentimentConfidence: clamp(options.sentimentConfidence, 0, 1),
    primaryReason: options.primaryReason,
    secondaryReason:
      options.secondaryReason && options.secondaryReason !== options.primaryReason
        ? options.secondaryReason
        : null,
    // Sub-reasons only apply when ads are one of the reasons.
    adSubreason:
      options.primaryReason === "ads" || options.secondaryReason === "ads"
        ? (options.adSubreason ?? "ad_other")
        : null,
    reasonProbabilities: options.reasonProbabilities,
    reasonConfidence: clamp(options.reasonConfidence, 0, 1),
    costUsd: options.costUsd ?? null,
    provider: options.info.provider,
    model: options.model ?? options.info.model,
    promptVersion: options.info.promptVersion,
    taxonomyVersion: options.info.taxonomyVersion,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "classification failed";
}

export async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
