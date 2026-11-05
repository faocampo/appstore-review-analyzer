import {
  REASON_KEYS,
  TAXONOMY_VERSION,
  buildClassification,
  type ClassifierInfo,
  type ClassifierProvider,
} from "@/lib/classifiers/provider";
import {
  SENTIMENT_LABELS,
  type Classification,
  type ReasonKey,
  type Review,
  type SentimentLabel,
  type SentimentScore,
} from "@/lib/types";

export const MOCK_INFO: ClassifierInfo = {
  provider: "mock",
  model: "mock-rules-v1",
  promptVersion: "rules-v1",
  taxonomyVersion: TAXONOMY_VERSION,
};

const REASON_KEYWORDS: Record<ReasonKey, string[]> = {
  ads: ["ad ", "ads", "advert", "commercial"],
  stability: ["crash", "freeze", "bug", "error", "broken", "reliable"],
  performance: ["slow", "loading", "fast", "battery", "lag", "responsive"],
  login_account: ["login", "log in", "logged out", "account", "password", "verification"],
  payments_subscriptions: ["charged", "subscription", "billing", "refund", "purchase", "payment"],
  features_functionality: ["feature", "option", "export", "function"],
  usability_navigation: ["easy", "design", "navigation", "interface", "find", "onboarding"],
  content_quality: ["content", "article", "catalog", "quality"],
  support: ["support", "reply", "customer service", "help desk"],
  privacy_security: ["privacy", "tracking", "permission", "secure", "security"],
  pricing_value: ["price", "expensive", "cheap", "value", "premium", "free"],
  update_regression: ["latest update", "after update", "new update", "used are gone"],
  compatibility: ["android 15", "ios ", "device", "phone", "compatible", "blank"],
  praise_general: ["love", "great", "best", "amazing", "excellent", "super useful"],
  other_unclear: [],
};

const POSITIVE_WORDS = [
  "love",
  "great",
  "best",
  "amazing",
  "excellent",
  "useful",
  "easy",
  "fast",
  "reliable",
];

const NEGATIVE_WORDS = [
  "unusable",
  "crash",
  "broken",
  "slow",
  "charged",
  "gone",
  "blank",
  "issue",
  "problem",
];

function scoreFromRating(review: Review): SentimentScore {
  const text = `${review.title} ${review.body}`.toLowerCase();
  const positiveHits = POSITIVE_WORDS.filter((word) => text.includes(word)).length;
  const negativeHits = NEGATIVE_WORDS.filter((word) => text.includes(word)).length;
  let score = Math.max(0, Math.min(4, review.rating - 1));

  if (negativeHits > positiveHits && score > 0) {
    score -= 1;
  } else if (positiveHits > negativeHits && score < 4) {
    score += 1;
  }

  return score as SentimentScore;
}

function sentimentProbabilities(
  score: SentimentScore,
): Record<SentimentLabel, number> {
  const weights = SENTIMENT_LABELS.map((_, index) => {
    const distance = Math.abs(index - score);
    if (distance === 0) return 0.72;
    if (distance === 1) return 0.12;
    return 0.02;
  });
  const total = weights.reduce((sum, value) => sum + value, 0);

  return Object.fromEntries(
    SENTIMENT_LABELS.map((label, index) => [label, weights[index] / total]),
  ) as Record<SentimentLabel, number>;
}

function findReason(review: Review): ReasonKey {
  const text = `${review.title} ${review.body}`.toLowerCase();
  let bestReason: ReasonKey = review.rating >= 4 ? "praise_general" : "other_unclear";
  let bestHits = 0;

  for (const reason of REASON_KEYS) {
    const hits = REASON_KEYWORDS[reason].filter((keyword) =>
      text.includes(keyword),
    ).length;
    if (hits > bestHits) {
      bestReason = reason;
      bestHits = hits;
    }
  }

  return bestReason;
}

function reasonProbabilities(
  primaryReason: ReasonKey,
): Record<ReasonKey, number> {
  const secondaryWeight = 0.25 / (REASON_KEYS.length - 1);
  return Object.fromEntries(
    REASON_KEYS.map((key) => [
      key,
      key === primaryReason ? 0.75 : secondaryWeight,
    ]),
  ) as Record<ReasonKey, number>;
}

/** Transparent, deterministic keyword and rating rules. No network calls. */
export function classifyMock(review: Review): Classification {
  const sentimentScore = scoreFromRating(review);
  const probabilities = sentimentProbabilities(sentimentScore);
  const primaryReason = findReason(review);

  return buildClassification({
    info: MOCK_INFO,
    providerScore: sentimentScore,
    sentimentProbabilities: probabilities,
    sentimentConfidence: probabilities[SENTIMENT_LABELS[sentimentScore]],
    primaryReason,
    reasonProbabilities: reasonProbabilities(primaryReason),
    reasonConfidence: 0.75,
  });
}

export function createMockClassifier(): ClassifierProvider {
  return {
    info: MOCK_INFO,
    maxBatch: 100,
    concurrency: 1,
    async classify(reviews) {
      return reviews.map((review) => ({
        ok: true as const,
        classification: classifyMock(review),
      }));
    },
  };
}
