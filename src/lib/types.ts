export const SENTIMENT_LABELS = [
  "highly_negative",
  "negative",
  "neutral_mixed",
  "positive",
  "highly_positive",
] as const;

export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];
export type SentimentScore = 0 | 1 | 2 | 3 | 4;
export type Store = "google_play" | "apple_app_store";
export type Platform = "android" | "ios";
export type SourceMode = "demo" | "live_api" | "csv";
export type AnalysisMode = "mock" | "jev";
export type SentimentGroup = "negative" | "neutral" | "positive";

export const REASON_DEFINITIONS = {
  ads: "Ads and interruptions",
  stability: "Crashes and reliability",
  performance: "Speed and performance",
  login_account: "Login and account access",
  payments_subscriptions: "Payments and subscriptions",
  features_functionality: "Features and functionality",
  usability_navigation: "Usability and navigation",
  content_quality: "Content quality",
  support: "Customer support",
  privacy_security: "Privacy and security",
  pricing_value: "Pricing and value",
  update_regression: "Update regression",
  compatibility: "Device and OS compatibility",
  praise_general: "General satisfaction",
  other_unclear: "Other or unclear",
} as const;

export type ReasonKey = keyof typeof REASON_DEFINITIONS;

export interface Review {
  id: string;
  store: Store;
  platform: Platform;
  rating: number;
  title: string;
  body: string;
  language?: string;
  territory?: string;
  appVersion?: string;
  createdAt: string;
  updatedAt?: string;
  dateSemantics: "created_at" | "last_modified_fallback";
  source: "demo" | "api" | "csv";
}

export interface Classification {
  sentimentScore: SentimentScore;
  sentimentLabel: SentimentLabel;
  sentimentExpectedValue: number;
  sentimentProbabilities: Record<SentimentLabel, number>;
  sentimentConfidence: number;
  primaryReason: ReasonKey;
  reasonProbabilities: Record<ReasonKey, number>;
  reasonConfidence: number;
  model: string;
}

export interface AnalyzedReview extends Review {
  analysis: Classification;
}

export interface AnalyzeInput {
  appName: string;
  sourceMode: SourceMode;
  startDate: string;
  endDate: string;
  lastN: number;
  androidPackage?: string;
  appleAppId?: string;
  translationLanguage?: string;
  csvFiles?: Array<{
    name: string;
    platform: Platform;
    content: string;
  }>;
}

export interface ReasonSummary {
  reason: ReasonKey;
  label: string;
  count: number;
  share: number;
}

export interface SentimentDistributionItem {
  label: SentimentLabel;
  count: number;
  share: number;
}

export interface AnalysisResult {
  appName: string;
  sourceMode: SourceMode;
  analysisMode: AnalysisMode;
  model: string;
  period: {
    startDate: string;
    endDate: string;
    membership: "created_at";
  };
  metrics: {
    reviewsAnalyzed: number;
    averageSentiment: number;
    averageRating: number;
    averageConfidence: number;
    androidReviews: number;
    iosReviews: number;
  };
  sentimentDistribution: SentimentDistributionItem[];
  reasons: Record<SentimentGroup, ReasonSummary[]>;
  reviews: AnalyzedReview[];
  notices: string[];
}
