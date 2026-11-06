/**
 * Typed, clearly synthetic fixtures for the publisher panels (fixture mode).
 *
 * Everything is generated deterministically from the requested range so the
 * filters behave like the real API: "Tidepool Puzzles" is a fictional app
 * (example.com package) whose v6.4 release raised ad frequency. Pages that
 * render these fixtures show the SAMPLE DATA tag.
 */
import type {
  AdSubreasonCount,
  AppDto,
  AppsResponse,
  ConnectionDto,
  ConnectionWriteResponse,
  CoverageDayStatus,
  CoverageResponse,
  CreateAppRequest,
  GuardrailMetricResult,
  GuardrailResponse,
  ImportResponse,
  OnboardingResponse,
  ReasonCount,
  ReasonsResponse,
  ReleaseMarker,
  ReviewDto,
  ReviewsResponse,
  TimeseriesPoint,
  TimeseriesResponse,
  TimeseriesTotals,
  UploadResponse,
  VerifyResponse,
  VersionSummary,
  VersionsResponse,
} from "@/server/api/contracts";
import {
  AD_SUBREASON_DEFINITIONS,
  REASON_DEFINITIONS,
  type AdSubreasonKey,
  type ReasonKey,
  type SentimentLabel,
  type Store,
} from "@/lib/types";

import type {
  RangeParams,
  ReasonsParams,
  ReviewsParams,
  TimeseriesParams,
  UploadRequest,
} from "./api-client";
import { addDays, daysBetween, eachDay, formatShortDate, isoWeekStart, utcToday } from "./dates";

export const FIXTURE_MIN_N = 20;
const MODEL_VERSION = "sample-classifier · prompt v3";
const STORES: Store[] = ["google_play", "apple_app_store"];

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Uniform in [0, 1), stable for a given seed string. */
function rand(seed: string): number {
  let t = (hash(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Roughly standard-normal noise. */
function noise(seed: string): number {
  return (rand(`${seed}:a`) + rand(`${seed}:b`) + rand(`${seed}:c`) + rand(`${seed}:d`) - 2) * 1.7;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pick<T>(items: readonly T[], seed: string): T {
  return items[Math.floor(rand(seed) * items.length)];
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// App model: releases and a daily review model per store
// ---------------------------------------------------------------------------

const RELEASES = [
  { appVersion: "6.1", offset: -232, sentiment: 2.55 },
  { appVersion: "6.2", offset: -160, sentiment: 2.62 },
  { appVersion: "6.3", offset: -88, sentiment: 2.71 },
  { appVersion: "6.4", offset: -21, sentiment: 2.16 },
] as const;

function releaseDate(offset: number): string {
  return addDays(utcToday(), offset);
}

/** Index of the latest release on or before the day. */
function activeRelease(day: string): number {
  const k = daysBetween(utcToday(), day);
  let active = 0;
  RELEASES.forEach((release, index) => {
    if (release.offset <= k) active = index;
  });
  return active;
}

interface RawDay {
  n: number;
  sentimentSum: number;
  ratingSum: number;
  negatives: number;
  adNegatives: number;
  coverage: CoverageDayStatus;
}

function volumeScale(appId: string): number {
  return appId.includes("sparse") ? 0.15 : 1;
}

function storeCoverage(store: Store, k: number): CoverageDayStatus {
  // Play reports land a day or two late; one partial export per store.
  if (store === "google_play") {
    if (k <= 1) return "unknown";
    if (k === 9 || k === 64) return "partial";
  } else {
    if (k === 0) return "unknown";
    if (k === 37) return "partial";
  }
  return "complete";
}

/** Share of a day's reviews written on the active release, the one before, and the one before that. */
const VERSION_MIX = [0.88, 0.1, 0.02];

function rawDay(appId: string, store: Store, day: string, territory?: string, appVersion?: string): RawDay {
  const k = daysBetween(day, utcToday());
  const coverage = storeCoverage(store, k);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const index = activeRelease(day);
  const afterBadRelease = index === RELEASES.length - 1;
  const sinceRelease = daysBetween(releaseDate(RELEASES[index].offset), day);

  let n = (store === "google_play" ? 15 : 8) * (weekday === 0 || weekday === 6 ? 1.25 : 1);
  n *= 0.7 + rand(`${appId}:${store}:${day}:n`) * 0.6;
  if (afterBadRelease) n *= 1.3;
  n *= volumeScale(appId);
  if (territory) n *= 0.2;
  const versionIndex = appVersion ? RELEASES.findIndex((release) => release.appVersion === appVersion) : -1;
  if (appVersion) n *= versionIndex >= 0 && index - versionIndex >= 0 ? (VERSION_MIX[index - versionIndex] ?? 0) : 0;
  if (coverage === "unknown") n = 0;
  if (coverage === "partial") n *= 0.45;
  n = Math.round(n);

  const previous = RELEASES[Math.max(0, index - 1)].sentiment;
  const settle = clamp(sinceRelease / 3, 0, 1);
  const phaseMean = versionIndex >= 0 ? RELEASES[versionIndex].sentiment : previous + (RELEASES[index].sentiment - previous) * settle;
  const baseMean = phaseMean + (store === "apple_app_store" ? 0.1 : 0);
  const mean = clamp(baseMean + (noise(`${appId}:${store}:${day}:s`) * 0.9) / Math.sqrt(Math.max(n, 1)), 0, 4);
  const rating = clamp(1 + mean * 0.98 + noise(`${appId}:${store}:${day}:r`) * 0.05, 1, 5);
  const negShare = clamp((afterBadRelease ? 0.42 : 0.3) + (noise(`${appId}:${store}:${day}:ng`) * 0.08) / Math.sqrt(Math.max(n, 1)), 0, 1);
  const adShare = clamp((afterBadRelease ? 0.41 : 0.21) + noise(`${appId}:${store}:${day}:ad`) * 0.04, 0, 1);
  const negatives = Math.round(n * negShare);
  return {
    n,
    sentimentSum: n * mean,
    ratingSum: n * rating,
    negatives,
    adNegatives: Math.round(negatives * adShare),
    coverage,
  };
}

const COVERAGE_RANK: Record<CoverageDayStatus, number> = { complete: 0, partial: 1, unknown: 2 };

function worst(a: CoverageDayStatus, b: CoverageDayStatus): CoverageDayStatus {
  return COVERAGE_RANK[a] >= COVERAGE_RANK[b] ? a : b;
}

function combinedDay(appId: string, day: string, params: RangeParams): RawDay {
  const stores = params.store ? [params.store] : STORES;
  return stores
    .map((store) => rawDay(appId, store, day, params.territory, params.appVersion))
    .reduce<RawDay>(
      (sum, item) => ({
        n: sum.n + item.n,
        sentimentSum: sum.sentimentSum + item.sentimentSum,
        ratingSum: sum.ratingSum + item.ratingSum,
        negatives: sum.negatives + item.negatives,
        adNegatives: sum.adNegatives + item.adNegatives,
        coverage: worst(sum.coverage, item.coverage),
      }),
      { n: 0, sentimentSum: 0, ratingSum: 0, negatives: 0, adNegatives: 0, coverage: "complete" },
    );
}

function sumDays(days: RawDay[]): RawDay {
  return days.reduce<RawDay>(
    (sum, item) => ({
      n: sum.n + item.n,
      sentimentSum: sum.sentimentSum + item.sentimentSum,
      ratingSum: sum.ratingSum + item.ratingSum,
      negatives: sum.negatives + item.negatives,
      adNegatives: sum.adNegatives + item.adNegatives,
      coverage: worst(sum.coverage, item.coverage),
    }),
    { n: 0, sentimentSum: 0, ratingSum: 0, negatives: 0, adNegatives: 0, coverage: "complete" },
  );
}

function toTotals(raw: RawDay): TimeseriesTotals {
  const enough = raw.n >= FIXTURE_MIN_N;
  const mean = raw.n ? raw.sentimentSum / raw.n : 0;
  const half = enough ? (1.96 * 1.15) / Math.sqrt(raw.n) : 0;
  return {
    n: raw.n,
    averageSentiment: enough ? round(mean) : null,
    sentimentCi: enough ? [round(clamp(mean - half, 0, 4)), round(clamp(mean + half, 0, 4))] : null,
    averageRating: enough ? round(raw.ratingSum / raw.n) : null,
    negativeShare: enough ? round(raw.negatives / raw.n) : null,
    adsNegativeShare: enough && raw.negatives > 0 ? round(raw.adNegatives / raw.negatives) : null,
  };
}

function toPoint(period: string, raw: RawDay): TimeseriesPoint {
  return { period, ...toTotals(raw), coverage: raw.coverage };
}

/** Versions with any reviews in the range (the active release and the two before it, per day). */
function versionsIn(from: string, to: string): string[] {
  const seen = new Set<number>();
  for (const day of eachDay(from, to)) {
    const active = activeRelease(day);
    VERSION_MIX.forEach((_, back) => {
      if (active - back >= 0) seen.add(active - back);
    });
  }
  return [...seen].sort((a, b) => b - a).map((index) => RELEASES[index].appVersion);
}

function releasesIn(from: string, to: string): ReleaseMarker[] {
  return RELEASES.map((release) => ({ appVersion: release.appVersion, firstSeen: releaseDate(release.offset) })).filter(
    (release) => release.firstSeen >= from && release.firstSeen <= to,
  );
}

// ---------------------------------------------------------------------------
// Evolution panel endpoints
// ---------------------------------------------------------------------------

export function fixtureTimeseries(appId: string, params: TimeseriesParams): TimeseriesResponse {
  const days = eachDay(params.from, params.to).map((day) => ({ day, raw: combinedDay(appId, day, params) }));
  let points: TimeseriesPoint[];
  if (params.granularity === "week") {
    const buckets = new Map<string, RawDay[]>();
    for (const { day, raw } of days) {
      const week = isoWeekStart(day);
      buckets.set(week, [...(buckets.get(week) ?? []), raw]);
    }
    points = [...buckets.entries()].map(([week, raws]) => toPoint(week, sumDays(raws)));
  } else {
    points = days.map(({ day, raw }) => toPoint(day, raw));
  }
  return {
    appId,
    from: params.from,
    to: params.to,
    granularity: params.granularity,
    modelVersion: MODEL_VERSION,
    minN: FIXTURE_MIN_N,
    totals: toTotals(sumDays(days.map(({ raw }) => raw))),
    points,
    releases: releasesIn(params.from, params.to),
    dimensions: {
      territories: [...new Set<string>(TERRITORIES)].sort(),
      appVersions: versionsIn(params.from, params.to),
    },
  };
}

const NEGATIVE_WEIGHTS: Partial<Record<ReasonKey, number>> = {
  stability: 0.24,
  performance: 0.15,
  payments_subscriptions: 0.1,
  usability_navigation: 0.1,
  features_functionality: 0.09,
  update_regression: 0.08,
  login_account: 0.06,
  content_quality: 0.05,
  other_unclear: 0.05,
  support: 0.04,
  compatibility: 0.04,
};

const NEUTRAL_WEIGHTS: Partial<Record<ReasonKey, number>> = {
  features_functionality: 0.3,
  ads: 0.2,
  content_quality: 0.18,
  usability_navigation: 0.14,
  pricing_value: 0.1,
  other_unclear: 0.08,
};

const POSITIVE_WEIGHTS: Partial<Record<ReasonKey, number>> = {
  praise_general: 0.55,
  content_quality: 0.25,
  features_functionality: 0.12,
  usability_navigation: 0.08,
};

const AD_SUBREASON_WEIGHTS: Record<AdSubreasonKey, number> = {
  ad_frequency: 0.44,
  ad_intrusive: 0.22,
  ad_reward_failure: 0.12,
  ad_audio: 0.09,
  ad_breaks_app: 0.07,
  ad_inappropriate: 0.04,
  ad_other: 0.02,
};

function reasonCounts(adCount: number, rest: number, weights: Partial<Record<ReasonKey, number>>): ReasonCount[] {
  const counts: Array<{ reason: ReasonKey; count: number }> = adCount > 0 ? [{ reason: "ads", count: adCount }] : [];
  for (const [reason, weight] of Object.entries(weights) as Array<[ReasonKey, number]>) {
    const count = Math.round(rest * weight);
    if (count > 0) counts.push({ reason, count });
  }
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return counts
    .sort((a, b) => b.count - a.count)
    .map((item) => ({
      reason: item.reason,
      label: REASON_DEFINITIONS[item.reason],
      count: item.count,
      share: total ? round(item.count / total) : 0,
    }));
}

export function fixtureReasons(appId: string, params: ReasonsParams): ReasonsResponse {
  const days = eachDay(params.from, params.to).map((day) => ({ day, raw: combinedDay(appId, day, params) }));
  const sum = sumDays(days.map((item) => item.raw));
  let reasons: ReasonCount[];
  if (params.group === "negative") {
    const adPrimary = Math.round(sum.adNegatives * 0.85);
    const includesRegression = days.some(({ day }) => activeRelease(day) === RELEASES.length - 1);
    const weights = { ...NEGATIVE_WEIGHTS, update_regression: includesRegression ? 0.08 : 0.01 };
    reasons = reasonCounts(adPrimary, sum.negatives - adPrimary, weights);
  } else if (params.group === "neutral") {
    const neutral = Math.round(sum.n * 0.18);
    reasons = reasonCounts(0, neutral, NEUTRAL_WEIGHTS);
  } else {
    reasons = reasonCounts(0, sum.n - sum.negatives - Math.round(sum.n * 0.18), POSITIVE_WEIGHTS);
  }
  const total = reasons.reduce((acc, item) => acc + item.count, 0);

  // Ad sub-reasons only exist for the negative group.
  const adTotal = params.group === "negative" ? sum.adNegatives : 0;
  const subCounts = (Object.entries(AD_SUBREASON_WEIGHTS) as Array<[AdSubreasonKey, number]>)
    .map(([subreason, weight]) => ({ subreason, count: Math.round(adTotal * weight) }))
    .filter((item) => item.count > 0);
  const subTotal = subCounts.reduce((acc, item) => acc + item.count, 0);
  const adSubreasons: AdSubreasonCount[] = subCounts.map((item) => ({
    subreason: item.subreason,
    label: AD_SUBREASON_DEFINITIONS[item.subreason],
    count: item.count,
    share: subTotal ? round(item.count / subTotal) : 0,
  }));

  const top = reasons.slice(0, 3);
  const weeks = new Map<string, RawDay[]>();
  for (const { day, raw } of days) {
    const week = isoWeekStart(day);
    weeks.set(week, [...(weeks.get(week) ?? []), raw]);
  }
  const trend = [...weeks.entries()].map(([period, raws]) => {
    const week = sumDays(raws);
    const counts: Partial<Record<ReasonKey, number>> = {};
    for (const item of top) {
      counts[item.reason] =
        item.reason === "ads"
          ? Math.round(week.adNegatives * 0.85)
          : Math.round((week.negatives - week.adNegatives) * (NEGATIVE_WEIGHTS[item.reason] ?? 0));
    }
    return { period, counts };
  });

  return {
    from: params.from,
    to: params.to,
    group: params.group,
    minN: FIXTURE_MIN_N,
    total,
    reasons,
    adSubreasons: params.group === "negative" ? adSubreasons : [],
    trend,
  };
}

export function fixtureVersions(appId: string, params: RangeParams): VersionsResponse {
  const totals = RELEASES.map(() => 0);
  const unfiltered = { ...params, appVersion: undefined };
  for (const day of eachDay(params.from, params.to)) {
    const raw = combinedDay(appId, day, unfiltered);
    const active = activeRelease(day);
    VERSION_MIX.forEach((share, back) => {
      if (active - back >= 0) totals[active - back] += raw.n * share;
    });
  }
  const versions: VersionSummary[] = [];
  RELEASES.forEach((release, index) => {
    const n = Math.round(totals[index]);
    if (n === 0) return;
    const ok = n >= FIXTURE_MIN_N;
    const sentiment = ok ? round(release.sentiment + noise(`${appId}:v:${release.appVersion}`) * 0.02, 2) : null;
    const previous = versions.at(-1);
    versions.push({
      appVersion: release.appVersion,
      firstSeen: releaseDate(release.offset),
      n,
      averageSentiment: sentiment,
      averageRating: sentiment === null ? null : round(1 + sentiment * 0.98, 2),
      negativeShare: ok ? (index === RELEASES.length - 1 ? 0.42 : 0.3) : null,
      adsNegativeShare: ok ? (index === RELEASES.length - 1 ? 0.41 : 0.21) : null,
      deltaSentiment:
        sentiment !== null && previous?.averageSentiment != null ? round(sentiment - previous.averageSentiment, 2) : null,
      status: ok ? "ok" : "insufficient",
    });
  });
  return {
    from: params.from,
    to: params.to,
    minN: FIXTURE_MIN_N,
    versions: params.appVersion ? versions.filter((item) => item.appVersion === params.appVersion) : versions,
  };
}

export function fixtureCoverage(appId: string, params: RangeParams): CoverageResponse {
  const stores = params.store ? [params.store] : STORES;
  const days: CoverageResponse["days"] = [];
  for (const day of eachDay(params.from, params.to)) {
    const k = daysBetween(day, utcToday());
    for (const store of stores) days.push({ day, store, status: storeCoverage(store, k) });
  }
  const summary = stores.map((store) => {
    const own = days.filter((item) => item.store === store);
    return {
      store,
      complete: own.filter((item) => item.status === "complete").length,
      partial: own.filter((item) => item.status === "partial").length,
      unknown: own.filter((item) => item.status === "unknown").length,
    };
  });
  return { from: params.from, to: params.to, days, summary };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

interface Template {
  title: string;
  body: string;
  language: string;
}

const AD_TEMPLATES: Record<AdSubreasonKey, Template[]> = {
  ad_frequency: [
    { title: "An ad after every level", body: "Since the update there is a video after every single level. I can't finish a puzzle in peace anymore.", language: "en" },
    { title: "Demasiados anuncios", body: "Ahora sale un anuncio después de cada nivel. Antes era cada tres o cuatro.", language: "es" },
  ],
  ad_intrusive: [
    { title: "Can't close the ads", body: "The close button is tiny and half the time it opens the store instead.", language: "en" },
  ],
  ad_reward_failure: [
    { title: "No reward after the video", body: "Watched the full ad for extra moves and didn't get them. Happened three times today.", language: "en" },
    { title: "Não recebi a recompensa", body: "Assisti o vídeo inteiro e as dicas não apareceram.", language: "pt" },
  ],
  ad_audio: [{ title: "Loud ads", body: "Ads play at full volume even with the game muted.", language: "en" }],
  ad_breaks_app: [{ title: "Black screen after ads", body: "The game freezes on a black screen after an ad and I have to restart it.", language: "en" }],
  ad_inappropriate: [{ title: "Ads not for kids", body: "Some ads are not appropriate for a family puzzle game.", language: "en" }],
  ad_other: [{ title: "Ads changed", body: "Something about the ads changed and I don't like it.", language: "en" }],
};

const REASON_TEMPLATES: Partial<Record<ReasonKey, Template[]>> = {
  stability: [
    { title: "Crashes on the daily challenge", body: "Opening the daily challenge crashes the app every time.", language: "en" },
    { title: "Se cierra sola", body: "La app se cierra al abrir el reto diario.", language: "es" },
  ],
  performance: [{ title: "Laggy animations", body: "Board animations stutter on my older phone.", language: "en" }],
  payments_subscriptions: [{ title: "No-ads pack not restored", body: "Bought the no-ads pack but it disappeared after reinstalling.", language: "en" }],
  usability_navigation: [{ title: "Settings are hard to find", body: "After the redesign I can't find where to turn off notifications.", language: "en" }],
  features_functionality: [
    { title: "Please add undo", body: "An undo button for the last move would make this perfect.", language: "en" },
  ],
  update_regression: [{ title: "Update broke hints", body: "Hints stopped working after the latest version.", language: "en" }],
  login_account: [{ title: "Progress gone", body: "Signed in again and my progress was reset to level 1.", language: "en" }],
  content_quality: [{ title: "Clever new levels", body: "The new level pack is creative and well designed.", language: "en" }],
  praise_general: [
    { title: "Relaxing", body: "Great puzzles for the commute, I play every day.", language: "en" },
    { title: "Muito bom", body: "Jogo relaxante, os desafios diários são ótimos.", language: "pt" },
  ],
  pricing_value: [{ title: "Fair price", body: "Worth it for the price, but the hint packs are expensive.", language: "en" }],
  other_unclear: [{ title: "Ok", body: "It's fine.", language: "en" }],
  support: [{ title: "No reply from support", body: "Wrote to support twice about my purchase, no answer.", language: "en" }],
  compatibility: [{ title: "Doesn't fit my tablet", body: "The board is cut off on my tablet in landscape.", language: "en" }],
};

const TERRITORIES = ["US", "US", "GB", "ES", "MX", "BR", "DE", "FR", "IN"] as const;
const SCORES: Record<SentimentLabel, 0 | 1 | 2 | 3 | 4> = {
  highly_negative: 0,
  negative: 1,
  neutral_mixed: 2,
  positive: 3,
  highly_positive: 4,
};

function weightedPick<K extends string>(weights: Partial<Record<K, number>>, seed: string): K {
  const entries = Object.entries(weights) as Array<[K, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let target = rand(seed) * total;
  for (const [key, weight] of entries) {
    target -= weight;
    if (target <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

function sampleReviews(appId: string, from: string, to: string): ReviewDto[] {
  const reviews: ReviewDto[] = [];
  const perDay = appId.includes("sparse") ? 0.4 : 3;
  for (const day of eachDay(from, to).reverse()) {
    const count = Math.floor(perDay + rand(`${appId}:${day}:count`));
    for (let index = 0; index < count; index += 1) {
      const seed = `${appId}:${day}:${index}`;
      const store: Store = rand(`${seed}:store`) < 0.65 ? "google_play" : "apple_app_store";
      const k = daysBetween(day, utcToday());
      if (storeCoverage(store, k) === "unknown") continue;
      const active = activeRelease(day);
      const afterBadRelease = active === RELEASES.length - 1;
      const versionIndex = Math.max(0, active - (rand(`${seed}:ver`) < 0.88 ? 0 : 1));

      const roll = rand(`${seed}:sent`);
      const negShare = afterBadRelease ? 0.42 : 0.3;
      const label: SentimentLabel =
        roll < negShare * 0.45
          ? "highly_negative"
          : roll < negShare
            ? "negative"
            : roll < negShare + 0.18
              ? "neutral_mixed"
              : roll < 0.85
                ? "positive"
                : "highly_positive";

      let primaryReason: ReasonKey;
      let adSubreason: AdSubreasonKey | null = null;
      if (label === "highly_negative" || label === "negative") {
        const isAd = rand(`${seed}:ad`) < (afterBadRelease ? 0.41 : 0.21);
        primaryReason = isAd ? "ads" : weightedPick(NEGATIVE_WEIGHTS, `${seed}:reason`);
        if (isAd) adSubreason = weightedPick(AD_SUBREASON_WEIGHTS, `${seed}:sub`);
      } else if (label === "neutral_mixed") {
        primaryReason = weightedPick(NEUTRAL_WEIGHTS, `${seed}:reason`);
        if (primaryReason === "ads") adSubreason = "ad_frequency";
      } else {
        primaryReason = weightedPick(POSITIVE_WEIGHTS, `${seed}:reason`);
      }
      const secondaryReason: ReasonKey | null =
        primaryReason !== "ads" && SCORES[label] <= 2 && rand(`${seed}:second`) < 0.15 ? "ads" : null;
      if (secondaryReason === "ads" && !adSubreason) adSubreason = "ad_frequency";

      const templates = adSubreason && primaryReason === "ads" ? AD_TEMPLATES[adSubreason] : REASON_TEMPLATES[primaryReason];
      const template = pick(templates ?? REASON_TEMPLATES.other_unclear ?? [], `${seed}:text`);
      const score = SCORES[label];
      const hour = String(Math.floor(rand(`${seed}:h`) * 24)).padStart(2, "0");
      const minute = String(Math.floor(rand(`${seed}:m`) * 60)).padStart(2, "0");
      const idNumber = hash(seed).toString(10).padStart(10, "0");

      reviews.push({
        id: `rev_${hash(`${seed}:id`).toString(36)}`,
        store,
        storeReviewId: store === "google_play" ? `gp:AOqpTO${hash(seed).toString(36).toUpperCase()}` : idNumber,
        createdAt: `${day}T${hour}:${minute}:00Z`,
        dateSemantics: store === "google_play" && rand(`${seed}:sem`) < 0.1 ? "last_modified_fallback" : "created_at",
        rating: clamp(Math.round(1 + score + (rand(`${seed}:rating`) < 0.15 ? -1 : 0)), 1, 5),
        title: template.title,
        body: template.body,
        language: template.language,
        territory: pick(TERRITORIES, `${seed}:territory`),
        appVersion: RELEASES[versionIndex].appVersion,
        classification: {
          sentimentLabel: label,
          sentimentScore: score,
          sentimentConfidence: round(0.62 + rand(`${seed}:conf`) * 0.33, 2),
          primaryReason,
          secondaryReason,
          adSubreason,
          modelVersion: MODEL_VERSION,
        },
      });
    }
  }
  return reviews;
}

const SENTIMENT_GROUPS: Record<NonNullable<ReviewsParams["sentiment"]>, SentimentLabel[]> = {
  negative: ["highly_negative", "negative"],
  neutral: ["neutral_mixed"],
  positive: ["positive", "highly_positive"],
};

export function fixtureReviews(appId: string, params: ReviewsParams): ReviewsResponse {
  const limit = params.limit ?? 50;
  const offset = params.cursor?.startsWith("o:") ? Number(params.cursor.slice(2)) || 0 : 0;
  const matches = sampleReviews(appId, params.from, params.to).filter((review) => {
    if (params.store && review.store !== params.store) return false;
    if (params.territory && review.territory !== params.territory) return false;
    if (params.appVersion && review.appVersion !== params.appVersion) return false;
    const classification = review.classification;
    if (params.sentiment && (!classification || !SENTIMENT_GROUPS[params.sentiment].includes(classification.sentimentLabel))) {
      return false;
    }
    if (
      params.reason &&
      (!classification || (classification.primaryReason !== params.reason && classification.secondaryReason !== params.reason))
    ) {
      return false;
    }
    return true;
  });
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const items = matches.slice(offset, offset + limit);
  return { items, nextCursor: offset + limit < matches.length ? `o:${offset + limit}` : null };
}

// ---------------------------------------------------------------------------
// Apps, connections, uploads (in-memory, per browser tab)
// ---------------------------------------------------------------------------

function sampleApp(id: string): AppDto {
  const sparse = id.includes("sparse");
  return {
    id,
    loomitAppId: sparse ? "lmt-app-sample-0002" : "lmt-app-sample-0001",
    name: sparse ? "Pebble Sort (sample)" : "Tidepool Puzzles (sample)",
    androidPackage: sparse ? "com.example.pebblesort" : "com.example.tidepool",
    appleAppId: sparse ? null : "1000000001",
    playReportsBucket: sparse ? null : "pubsite_prod_sample-0001",
    identityVerified: true,
    connections: [
      {
        store: "google_play",
        status: "active",
        lastVerifiedAt: `${addDays(utcToday(), -30)}T09:12:00Z`,
        lastSyncedAt: `${utcToday()}T06:00:00Z`,
        lastError: null,
        watermark: addDays(utcToday(), -2),
      },
      ...(sparse
        ? []
        : [
            {
              store: "apple_app_store" as const,
              status: "error" as const,
              lastVerifiedAt: `${addDays(utcToday(), -30)}T09:20:00Z`,
              lastSyncedAt: `${addDays(utcToday(), -1)}T22:00:00Z`,
              lastError: "App Store Connect rejected the key (401). Check that the key is active and has the Customer Support role.",
              watermark: addDays(utcToday(), -1),
            },
          ]),
    ],
  };
}

const appStore = new Map<string, AppDto>();

function ensureApps(): Map<string, AppDto> {
  if (!appStore.size) {
    appStore.set("demo-app", sampleApp("demo-app"));
    appStore.set("demo-sparse", sampleApp("demo-sparse"));
  }
  return appStore;
}

export async function fixtureListApps(): Promise<AppsResponse> {
  return { items: [...ensureApps().values()] };
}

export async function fixtureGetApp(appId: string): Promise<AppDto> {
  return ensureApps().get(appId) ?? sampleApp(appId);
}

/** Fixture-only toggle: `/connect?fixture=1&x3m=0` simulates an environment without X3M's account. */
export async function fixtureOnboarding(): Promise<OnboardingResponse> {
  const withoutX3m = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("x3m") === "0";
  return {
    googleServiceAccountEmail: withoutX3m ? null : "reviewsignal-sample@x3m-sample-project.iam.gserviceaccount.com",
    googlePermissions: ["View app information (read-only)", "Download bulk reports (read-only)"],
    appleKeyRole: "Customer Support",
  };
}

export async function fixtureCreateApp(input: CreateAppRequest): Promise<AppDto> {
  await delay(250);
  const id = `app_${hash(`${input.loomitAppId}:${input.name}`).toString(36)}`;
  const app: AppDto = {
    id,
    loomitAppId: input.loomitAppId,
    name: input.name,
    androidPackage: input.androidPackage ?? null,
    appleAppId: input.appleAppId ?? null,
    playReportsBucket: input.playReportsBucket ?? null,
    identityVerified: false,
    connections: [],
  };
  ensureApps().set(id, app);
  return app;
}

function updateConnection(appId: string, store: Store, patch: Partial<ConnectionDto>): ConnectionDto {
  const apps = ensureApps();
  const app = apps.get(appId) ?? sampleApp(appId);
  const current: ConnectionDto = app.connections.find((item) => item.store === store) ?? {
    store,
    status: "pending",
    lastVerifiedAt: null,
    lastSyncedAt: null,
    lastError: null,
    watermark: null,
  };
  const next = { ...current, ...patch };
  apps.set(appId, { ...app, connections: [...app.connections.filter((item) => item.store !== store), next] });
  return next;
}

/** Connections whose credentials were (re)written in this tab; only those verify successfully. */
const rewritten = new Set<string>();

export async function fixturePutConnection(appId: string, store: Store): Promise<ConnectionWriteResponse> {
  await delay(300);
  rewritten.add(`${appId}:${store}`);
  const next = updateConnection(appId, store, { status: "pending", lastError: null });
  return { store: next.store, status: next.status };
}

export async function fixtureVerifyConnection(appId: string, store: Store): Promise<VerifyResponse> {
  await delay(500);
  const current = ensureApps().get(appId)?.connections.find((item) => item.store === store);
  if (current?.status === "error" && !rewritten.has(`${appId}:${store}`)) {
    const error = current.lastError ?? "The store rejected the credentials.";
    updateConnection(appId, store, { status: "error", lastError: error });
    return { store, status: "error", error };
  }
  updateConnection(appId, store, { status: "active", lastError: null, lastVerifiedAt: new Date().toISOString() });
  return { store, status: "active", error: null };
}

const uploads = new Map<string, { fileName: string; startedAt: number }>();

export async function fixtureCreateUpload(appId: string, upload: UploadRequest): Promise<UploadResponse> {
  await delay(200);
  const uploadId = `upl_${hash(`${appId}:${upload.fileName}:${upload.byteSize}`).toString(36)}`;
  uploads.set(uploadId, { fileName: upload.fileName, startedAt: 0 });
  return {
    uploadId,
    uploadUrl: `https://uploads.example.com/sample/${uploadId}.csv`,
    headers: { "Content-Type": "text/csv" },
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function uploadState(uploadId: string): ImportResponse {
  const upload = uploads.get(uploadId);
  if (!upload || !upload.startedAt) return { uploadId, status: "pending", importedAt: null, error: null };
  if (Date.now() - upload.startedAt < 3_000) return { uploadId, status: "pending", importedAt: null, error: null };
  if (upload.fileName.toLowerCase().includes("fail")) {
    return { uploadId, status: "failed", importedAt: null, error: "Row 1 is not a store review export header (expected Package Name, App Version Code, …)." };
  }
  return { uploadId, status: "imported", importedAt: new Date(upload.startedAt + 3_000).toISOString(), error: null };
}

export async function fixtureStartImport(_appId: string, uploadId: string): Promise<ImportResponse> {
  await delay(250);
  const upload = uploads.get(uploadId);
  uploads.set(uploadId, { fileName: upload?.fileName ?? "upload.csv", startedAt: Date.now() });
  return uploadState(uploadId);
}

export async function fixtureGetUpload(_appId: string, uploadId: string): Promise<ImportResponse> {
  await delay(120);
  return uploadState(uploadId);
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

function guardrailSeries(
  id: string,
  start: string,
  end: string,
  windowStart: string,
  lift: number,
  sparse: boolean,
): GuardrailResponse["series"] {
  return eachDay(start, end).map((day) => {
    const inWindow = day >= windowStart;
    const ramp = inWindow ? clamp((daysBetween(windowStart, day) + 1) / 4, 0, 1) : 0;
    const testN = sparse
      ? Math.floor(rand(`${id}:${day}:tn`) * 7)
      : rand(`${id}:${day}:tn`) < 0.08
        ? Math.floor(rand(`${id}:${day}:tz`) * 3)
        : 8 + Math.floor(rand(`${id}:${day}:tn2`) * 12);
    const controlN = sparse ? Math.floor(rand(`${id}:${day}:cn`) * 9) : 18 + Math.floor(rand(`${id}:${day}:cn2`) * 12);
    // Daily shares below 5 negative reviews are withheld (null); n = 0 days carry no value at all.
    return {
      day,
      test: testN < 5 ? null : round(clamp(0.215 + lift * ramp + noise(`${id}:${day}:t`) * 0.018, 0, 1)),
      control: controlN < 5 ? null : round(clamp(0.222 + noise(`${id}:${day}:c`) * 0.012, 0, 1)),
      testN,
      controlN,
    };
  });
}

const METRIC_DEFINITIONS: Record<
  GuardrailMetricResult["metric"],
  Pick<GuardrailMetricResult, "label" | "harm" | "unit" | "valueUnit" | "thresholds">
> = {
  G1: { label: "Ad-complaint share of negative reviews", harm: "increase", unit: "share", valueUnit: "share", thresholds: { warn: 0.05, breach: 0.1, minN: 20 } },
  G2: { label: "Sentiment EV (0–4)", harm: "decrease", unit: "points", valueUnit: "points", thresholds: { warn: 0.15, breach: 0.3, minN: 20 } },
  G3: { label: "Ad-related negative reviews per 100k DAU", harm: "increase", unit: "relative", valueUnit: "per100k", thresholds: { warn: 0.25, breach: 0.5, minN: 10 } },
  G4: { label: "Written-review rating (1–5)", harm: "decrease", unit: "stars", valueUnit: "stars", thresholds: { warn: 0.2, breach: 0.4, minN: 20 } },
};

function metric(
  id: GuardrailMetricResult["metric"],
  status: GuardrailMetricResult["status"],
  test: [number, number | null],
  control: [number, number | null],
  delta: number | null,
  pValue: number | null,
  note: string | null = null,
): GuardrailMetricResult {
  return {
    metric: id,
    ...METRIC_DEFINITIONS[id],
    status,
    test: { n: test[0], value: test[1] },
    control: { n: control[0], value: control[1] },
    delta,
    pValue,
    note,
  };
}

export function fixtureGuardrails(experimentId: string): GuardrailResponse {
  const today = utcToday();
  const evaluatedAt = `${today}T05:00:00Z`;
  const base = {
    experimentId: `exp_${hash(experimentId).toString(36)}`,
    loomitExperimentId: experimentId,
    evaluatedAt,
    modelVersion: MODEL_VERSION,
  };

  if (experimentId.includes("insufficient")) {
    const start = addDays(today, -6);
    return {
      ...base,
      name: "Rewarded video on level fail (sample)",
      status: "insufficient",
      attributionMode: "dimension",
      attributionLabel: "Dimension-attributable · app version",
      dimension: "app_version",
      arms: [
        { key: "rv-on-fail", role: "test", values: ["6.5-beta"], dau: 9_400 },
        { key: "current", role: "control", values: ["6.4"], dau: 151_000 },
      ],
      window: { start, end: addDays(today, -1) },
      baseline: null,
      metrics: [
        metric("G1", "insufficient", [9, null], [31, 0.226], null, null, "The test arm has 9 negative reviews; at least 20 are needed."),
        metric("G2", "insufficient", [14, null], [96, 2.41], null, null, "The test arm has 14 reviews; at least 20 are needed."),
        metric("G3", "insufficient", [4, null], [7, null], null, null, "Too few ad-related negative reviews in both arms."),
        metric("G4", "insufficient", [14, null], [96, 3.31], null, null, "The test arm has 14 reviews; at least 20 are needed."),
      ],
      confounders: [],
      series: guardrailSeries(experimentId, addDays(start, -10), addDays(today, -1), start, 0.05, true),
    };
  }

  if (experimentId.includes("prepost")) {
    const start = addDays(today, -14);
    return {
      ...base,
      name: "Banner refresh 30s → 45s, all users (sample)",
      status: "ok",
      attributionMode: "pre_post",
      attributionLabel: "Pre/post with controls",
      dimension: null,
      arms: [
        { key: "tidepool", role: "test", values: [], dau: 412_000 },
        { key: "control-apps", role: "control", values: ["Pebble Sort (sample)", "Harbor Blocks (sample)"], dau: 236_000 },
      ],
      window: { start, end: addDays(today, -1) },
      baseline: { start: addDays(start, -28), end: addDays(start, -1) },
      metrics: [
        metric("G1", "ok", [388, 0.205], [802, 0.219], -0.014, 0.58),
        metric("G2", "ok", [1204, 2.66], [2480, 2.63], 0.03, 0.44),
        metric("G3", "ok", [80, 4.1], [176, 4.4], -0.068, 0.61),
        metric("G4", "ok", [1204, 3.58], [2480, 3.55], 0.03, 0.52),
      ],
      confounders: [],
      series: guardrailSeries(experimentId, addDays(start, -14), addDays(today, -1), start, -0.01, false),
    };
  }

  const start = addDays(today, -24);
  const release = releaseDate(-21);
  const partialDay = addDays(today, -9);
  return {
    ...base,
    name: "Interstitial cap 90s → 60s in LATAM (sample)",
    status: "warn",
    attributionMode: "dimension",
    attributionLabel: "Dimension-attributable · territory",
    dimension: "territory",
    arms: [
      { key: "cap-60s", role: "test", values: ["BR", "MX", "AR"], dau: 182_000 },
      { key: "cap-90s", role: "control", values: ["CO", "CL", "PE"], dau: 241_000 },
    ],
    window: { start, end: addDays(today, -1) },
    baseline: null,
    metrics: [
      metric("G1", "warn", [412, 0.318], [655, 0.224], 0.094, 0.0021),
      metric("G2", "ok", [1290, 2.31], [2050, 2.38], -0.07, 0.21),
      metric("G3", "ok", [131, 3.1], [147, 2.6], 0.192, 0.18),
      metric("G4", "ok", [1290, 3.21], [2050, 3.27], -0.06, 0.34),
    ],
    confounders: [
      { kind: "release", detail: `v6.4 reached both arms on ${formatShortDate(release)}, inside the test window.`, day: release, appVersion: "6.4" },
      { kind: "coverage", detail: `Google Play reported ${formatShortDate(partialDay)} as partial; both arms are affected.`, day: partialDay },
    ],
    series: guardrailSeries(experimentId, addDays(start, -14), addDays(today, -1), start, 0.105, false),
  };
}
