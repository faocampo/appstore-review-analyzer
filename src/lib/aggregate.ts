import type { ClassifierInfo } from "@/lib/classifiers/provider";
import { PublicError } from "@/lib/errors";
import {
  AD_SUBREASON_DEFINITIONS,
  REASON_DEFINITIONS,
  SENTIMENT_LABELS,
  type AdSubreasonKey,
  type AdSubreasonSummary,
  type AnalysisResult,
  type AnalyzedReview,
  type PeriodMembership,
  type ReasonKey,
  type ReasonSummary,
  type SentimentEstimator,
  type SentimentGroup,
  type SentimentLabel,
  type SourceCoverage,
  type SourceMode,
} from "@/lib/types";

function round(value: number, decimals = 2): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function sentimentGroup(label: SentimentLabel): SentimentGroup {
  if (label === "highly_negative" || label === "negative") return "negative";
  if (label === "neutral_mixed") return "neutral";
  return "positive";
}

function summarizeReasons(
  reviews: AnalyzedReview[],
  group: SentimentGroup,
): ReasonSummary[] {
  const groupedReviews = reviews.filter(
    (review) => sentimentGroup(review.analysis.sentimentLabel) === group,
  );
  const counts = new Map<ReasonKey, number>();

  for (const review of groupedReviews) {
    const reason = review.analysis.primaryReason;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([reason, count]) => ({
      reason,
      label: REASON_DEFINITIONS[reason],
      count,
      share: count / groupedReviews.length,
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
}

function summarizeAdSubreasons(reviews: AnalyzedReview[]): AdSubreasonSummary[] {
  const counts = new Map<AdSubreasonKey, number>();
  let total = 0;
  for (const review of reviews) {
    const subreason = review.analysis.adSubreason;
    if (!subreason || sentimentGroup(review.analysis.sentimentLabel) !== "negative") {
      continue;
    }
    total += 1;
    counts.set(subreason, (counts.get(subreason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([subreason, count]) => ({
      subreason,
      label: AD_SUBREASON_DEFINITIONS[subreason],
      count,
      share: count / total,
    }))
    .sort((left, right) => right.count - left.count);
}

function periodMembership(reviews: AnalyzedReview[]): PeriodMembership {
  const semantics = new Set(reviews.map((review) => review.dateSemantics));
  if (semantics.size > 1) return "mixed";
  return semantics.has("last_modified_fallback") ? "last_modified" : "created_at";
}

function sentimentEstimator(reviews: AnalyzedReview[]): SentimentEstimator {
  const estimators = new Set(
    reviews.map((review) => review.analysis.sentimentEstimator),
  );
  if (estimators.size > 1) return "mixed";
  return estimators.has("provider_score") ? "provider_score" : "probability_weighted";
}

export function aggregateReviews(options: {
  appName: string;
  sourceMode: SourceMode;
  classifier: ClassifierInfo;
  startDate: string;
  endDate: string;
  lastN: number;
  reviews: AnalyzedReview[];
  unclassified?: number;
  coverage?: SourceCoverage[];
  notices?: string[];
}): AnalysisResult {
  const periodStart = new Date(`${options.startDate}T00:00:00.000Z`).getTime();
  const periodEnd = new Date(`${options.endDate}T23:59:59.999Z`).getTime();
  const inPeriod = options.reviews
    .filter((review) => {
      const createdAt = new Date(review.createdAt).getTime();
      return createdAt >= periodStart && createdAt <= periodEnd;
    })
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    );

  if (!inPeriod.length) {
    throw new PublicError(
      "No written reviews were found in the selected period.",
      422,
    );
  }

  const reviewCount = inPeriod.length;
  const averageSentiment =
    inPeriod.reduce(
      (sum, review) => sum + review.analysis.sentimentExpectedValue,
      0,
    ) / reviewCount;
  const averageRating =
    inPeriod.reduce((sum, review) => sum + review.rating, 0) / reviewCount;
  const averageConfidence =
    inPeriod.reduce(
      (sum, review) => sum + review.analysis.sentimentConfidence,
      0,
    ) / reviewCount;

  const sentimentDistribution = SENTIMENT_LABELS.map((label) => {
    const count = inPeriod.filter(
      (review) => review.analysis.sentimentLabel === label,
    ).length;
    return {
      label,
      count,
      share: count / reviewCount,
    };
  });

  return {
    appName: options.appName,
    sourceMode: options.sourceMode,
    analysisMode: options.classifier.provider,
    model: inPeriod[0].analysis.model,
    classifier: {
      provider: options.classifier.provider,
      model: inPeriod[0].analysis.model,
      promptVersion: options.classifier.promptVersion,
      taxonomyVersion: options.classifier.taxonomyVersion,
    },
    period: {
      startDate: options.startDate,
      endDate: options.endDate,
      membership: periodMembership(inPeriod),
    },
    metrics: {
      reviewsAnalyzed: reviewCount,
      reviewsUnclassified: options.unclassified ?? 0,
      averageSentiment: round(averageSentiment),
      sentimentEstimator: sentimentEstimator(inPeriod),
      averageRating: round(averageRating),
      averageConfidence: round(averageConfidence),
      androidReviews: inPeriod.filter((review) => review.platform === "android")
        .length,
      iosReviews: inPeriod.filter((review) => review.platform === "ios").length,
    },
    sentimentDistribution,
    coverage: options.coverage ?? [],
    reasons: {
      negative: summarizeReasons(inPeriod, "negative"),
      neutral: summarizeReasons(inPeriod, "neutral"),
      positive: summarizeReasons(inPeriod, "positive"),
    },
    adSubreasons: summarizeAdSubreasons(inPeriod),
    reviews: inPeriod.slice(0, options.lastN),
    notices: [
      "Average rating is calculated from written reviews only; star-only ratings require a separate store ratings export.",
      ...(periodMembership(inPeriod) === "created_at"
        ? []
        : [
            "Google Play API reviews are placed in the period by their last-modified date, because the API does not expose the creation date.",
          ]),
      ...new Set(options.notices ?? []),
    ],
  };
}
