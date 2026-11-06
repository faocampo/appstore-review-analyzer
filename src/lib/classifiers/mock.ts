import {
  REASON_KEYS,
  TAXONOMY_VERSION,
  buildClassification,
  type ClassifierInfo,
  type ClassifierProvider,
} from "@/lib/classifiers/provider";
import {
  SENTIMENT_LABELS,
  type AdSubreasonKey,
  type Classification,
  type ReasonKey,
  type Review,
  type SentimentLabel,
  type SentimentScore,
} from "@/lib/types";

export const MOCK_INFO: ClassifierInfo = {
  provider: "mock",
  model: "mock-rules-v1",
  promptVersion: "rules-v2",
  taxonomyVersion: TAXONOMY_VERSION,
};

/**
 * Keywords match whole words (or word prefixes ending in "*"), in EN/ES/PT,
 * so "ads" never matches "downloads" and "ios" never matches "anuncios".
 */
const REASON_KEYWORDS: Record<ReasonKey, string[]> = {
  ads: ["ad", "ads", "advert*", "commercial*", "anuncio*", "anúncio*", "publicidad*", "propaganda*"],
  stability: ["crash*", "freez*", "bug*", "error*", "broken", "reliab*", "cierra", "se cierra", "trava*", "fecha sozinho"],
  performance: ["slow", "loading", "fast", "battery", "lag*", "responsive", "lento", "lenta", "demora*"],
  login_account: ["login", "log in", "logged out", "account", "password", "verification", "cuenta", "conta", "contraseña", "senha"],
  payments_subscriptions: ["charged", "subscription*", "billing", "refund*", "purchase*", "payment*", "cobr*", "suscripci*", "assinatura*", "reembolso*"],
  features_functionality: ["feature*", "option*", "export*", "function*", "función", "funcionalidad*", "funcionalidade*"],
  usability_navigation: ["easy", "design", "navigation", "interface", "find", "onboarding", "fácil", "facil", "diseño"],
  content_quality: ["content", "article*", "catalog*", "quality", "contenido", "conteúdo", "calidad", "qualidade"],
  support: ["support", "reply", "customer service", "help desk", "soporte", "suporte", "atención al cliente"],
  privacy_security: ["privacy", "tracking", "permission*", "secure", "security", "privacidad", "privacidade", "seguridad", "segurança"],
  pricing_value: ["price*", "expensive", "cheap", "value", "premium", "free", "caro", "cara", "precio*", "preço*", "gratis", "grátis"],
  update_regression: ["latest update", "after update", "new update", "used are gone", "actualización", "atualização"],
  compatibility: ["android 15", "ios", "device", "phone", "compatible", "blank", "dispositivo", "celular"],
  praise_general: ["love", "great", "best", "amazing", "excellent", "super useful", "me encanta", "excelente", "genial", "adoro", "ótimo", "otimo"],
  other_unclear: [],
};

const patternCache = new Map<string, RegExp>();

/** Whole-word (Unicode-aware) match; a trailing "*" allows any word ending. */
function matches(text: string, keyword: string): boolean {
  let pattern = patternCache.get(keyword);
  if (!pattern) {
    const prefix = keyword.endsWith("*");
    const escaped = (prefix ? keyword.slice(0, -1) : keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${prefix ? "" : "(?![\\p{L}\\p{N}])"}`, "iu");
    patternCache.set(keyword, pattern);
  }
  return pattern.test(text);
}

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
  "me encanta",
  "excelente",
  "ótimo",
  "otimo",
  "adoro",
];

const NEGATIVE_WORDS = [
  "unusable",
  "crash*",
  "broken",
  "slow",
  "charged",
  "gone",
  "blank",
  "issue*",
  "problem*",
  "no funciona",
  "não funciona",
  "horrible",
  "horrível",
  "pésimo",
  "péssimo",
];

function scoreFromRating(review: Review): SentimentScore {
  const text = `${review.title} ${review.body}`.toLowerCase();
  const positiveHits = POSITIVE_WORDS.filter((word) => matches(text, word)).length;
  const negativeHits = NEGATIVE_WORDS.filter((word) => matches(text, word)).length;
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

const AD_SUBREASON_KEYWORDS: Array<[AdSubreasonKey, string[]]> = [
  ["ad_reward_failure", ["reward", "didn't get", "did not get", "no coins"]],
  ["ad_breaks_app", ["crash*", "freez*", "stuck", "black screen", "trava*"]],
  ["ad_audio", ["sound", "audio", "loud", "volume"]],
  ["ad_inappropriate", ["inappropriate", "offensive", "explicit", "scam"]],
  ["ad_intrusive", ["can't close", "cannot close", "close button", "unskippable", "full screen", "popup"]],
  ["ad_frequency", ["every", "too many", "constant*", "after each", "all the time", "cada", "demasiad*", "muitos", "muitas"]],
];

function rankReasons(review: Review): Array<[ReasonKey, number]> {
  const text = `${review.title} ${review.body}`.toLowerCase();
  return REASON_KEYS.map((reason) => [
    reason,
    REASON_KEYWORDS[reason].filter((keyword) => matches(text, keyword)).length,
  ] as [ReasonKey, number])
    .filter(([, hits]) => hits > 0)
    .sort((left, right) => right[1] - left[1]);
}

function findReasons(review: Review): {
  primary: ReasonKey;
  secondary: ReasonKey | null;
} {
  const ranked = rankReasons(review);
  const fallback: ReasonKey = review.rating >= 4 ? "praise_general" : "other_unclear";
  return {
    primary: ranked[0]?.[0] ?? fallback,
    secondary: ranked[1]?.[0] ?? null,
  };
}

function findAdSubreason(review: Review): AdSubreasonKey {
  const text = `${review.title} ${review.body}`.toLowerCase();
  const match = AD_SUBREASON_KEYWORDS.find(([, keywords]) =>
    keywords.some((keyword) => matches(text, keyword)),
  );
  return match?.[0] ?? "ad_other";
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
  const { primary: primaryReason, secondary } = findReasons(review);

  return buildClassification({
    info: MOCK_INFO,
    providerScore: sentimentScore,
    sentimentProbabilities: probabilities,
    sentimentConfidence: probabilities[SENTIMENT_LABELS[sentimentScore]],
    primaryReason,
    secondaryReason: secondary,
    adSubreason: findAdSubreason(review),
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
