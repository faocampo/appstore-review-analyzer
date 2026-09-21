import {
  REASON_DEFINITIONS,
  SENTIMENT_LABELS,
  type AnalysisMode,
  type AnalysisResult,
  type AnalyzedReview,
  type ReasonKey,
  type ReasonSummary,
  type SentimentGroup,
  type SentimentLabel,
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
      share: groupedReviews.length ? count / groupedReviews.length : 0,
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
}

export function aggregateReviews(options: {
  appName: string;
  sourceMode: SourceMode;
  analysisMode: AnalysisMode;
  model: string;
  startDate: string;
  endDate: string;
  lastN: number;
  reviews: AnalyzedReview[];
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
    throw new Error("No written reviews were found in the selected period.");
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
    analysisMode: options.analysisMode,
    model: options.model,
    period: {
      startDate: options.startDate,
      endDate: options.endDate,
      membership: "created_at",
    },
    metrics: {
      reviewsAnalyzed: reviewCount,
      averageSentiment: round(averageSentiment),
      averageRating: round(averageRating),
      averageConfidence: round(averageConfidence),
      androidReviews: inPeriod.filter((review) => review.platform === "android")
        .length,
      iosReviews: inPeriod.filter((review) => review.platform === "ios").length,
    },
    sentimentDistribution,
    reasons: {
      negative: summarizeReasons(inPeriod, "negative"),
      neutral: summarizeReasons(inPeriod, "neutral"),
      positive: summarizeReasons(inPeriod, "positive"),
    },
    reviews: inPeriod.slice(0, options.lastN),
    notices: [
      "Average rating is calculated from written reviews only; star-only ratings require a separate store ratings export.",
      ...new Set(options.notices ?? []),
    ],
  };
}
