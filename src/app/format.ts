import {
  REASON_DEFINITIONS,
  type AnalysisResult,
  type CoverageStatus,
  type PeriodMembership,
  type SentimentLabel,
} from "@/lib/types";

export const SENTIMENT_COPY: Record<SentimentLabel, { label: string; short: string }> = {
  highly_negative: { label: "Highly negative", short: "Very neg." },
  negative: { label: "Negative", short: "Negative" },
  neutral_mixed: { label: "Neutral / mixed", short: "Mixed" },
  positive: { label: "Positive", short: "Positive" },
  highly_positive: { label: "Highly positive", short: "Very pos." },
};

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function formatRange(start: string, end: string): string {
  return `${formatDate(start)} – ${formatDate(end)}`;
}

/** Maps the 0–4 average onto the five-level scale used by the classifier. */
export function sentimentWord(value: number): string {
  if (value < 0.8) return "highly negative";
  if (value < 1.6) return "negative";
  if (value < 2.4) return "mixed";
  if (value < 3.2) return "positive";
  return "highly positive";
}

export function sentimentTone(label: SentimentLabel): "positive" | "negative" | "neutral" {
  if (label === "highly_negative" || label === "negative") return "negative";
  if (label === "neutral_mixed") return "neutral";
  return "positive";
}

/**
 * Point-stating title and subtitle derived only from the result.
 * Nothing is invented: when there is no negative feedback, no driver is named.
 */
export function headline(result: AnalysisResult): { title: string; subtitle: string } {
  const count = result.metrics.reviewsAnalyzed;
  const title = `Sentiment is ${sentimentWord(result.metrics.averageSentiment)} across ${count} review${count === 1 ? "" : "s"}`;
  const topNegative = result.reasons.negative[0];
  const negativeShare = result.sentimentDistribution
    .filter((item) => sentimentTone(item.label) === "negative")
    .reduce((sum, item) => sum + item.share, 0);

  const tied = result.reasons.negative.filter(
    (item) => item.count === topNegative?.count,
  ).length;
  if (topNegative && negativeShare > 0 && tied > 1) {
    return {
      title,
      subtitle: `${formatPercent(negativeShare)} of reviews are negative. No single complaint dominates: ${tied} reasons are tied at ${formatPercent(topNegative.share)} each.`,
    };
  }
  if (topNegative && negativeShare > 0) {
    return {
      title,
      subtitle: `${formatPercent(negativeShare)} of reviews are negative. Top complaint: ${REASON_DEFINITIONS[topNegative.reason].toLowerCase()} (${formatPercent(topNegative.share)} of negative reviews).`,
    };
  }
  return { title, subtitle: "No negative reviews in this period." };
}

export const COVERAGE_COPY: Record<CoverageStatus, { label: string; tone: "positive" | "neutral" | "negative" }> = {
  complete: { label: "Complete", tone: "positive" },
  partial: { label: "Partial", tone: "neutral" },
  failed: { label: "Failed", tone: "negative" },
};

export const MEMBERSHIP_COPY: Record<PeriodMembership, string> = {
  created_at: "Review creation date",
  last_modified: "Last-modified date (Google API)",
  mixed: "Creation date; last-modified for Google API",
};

export const CLASSIFIER_COPY: Record<AnalysisResult["analysisMode"], string> = {
  mock: "Rule-based (demo)",
  jev: "TypeSafe Jev",
  openrouter: "OpenRouter",
};

export const ESTIMATOR_COPY: Record<AnalysisResult["metrics"]["sentimentEstimator"], string> = {
  probability_weighted: "Probability-weighted",
  provider_score: "Model score",
  mixed: "Mixed estimators",
};

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
