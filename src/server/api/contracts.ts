/**
 * ReviewSignal API v1 contracts, shared by the Fastify API, the Next.js
 * panels and the Loomit backend integration. Request bodies and queries are
 * validated with these Zod schemas; responses are typed with the interfaces.
 */
import { z } from "zod";

import { isValidServiceAccountKey } from "@/lib/credentials/service-account";

import type {
  AdSubreasonKey,
  ReasonKey,
  SentimentLabel,
  Store,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const isoDate = z.iso.date();
export const storeSchema = z.enum(["google_play", "apple_app_store"]);
export type CoverageDayStatus = "complete" | "partial" | "unknown";
export type GuardrailStatus = "ok" | "warn" | "breach" | "insufficient";
export type GuardrailMetric = "G1" | "G2" | "G3" | "G4";

/** Longest range a panel query may cover (about three years). */
export const MAX_RANGE_DAYS = 1_100;
const EARLIEST_DATE = "2008-01-01";

export const rangeQuerySchema = z
  .object({
    from: isoDate.refine((value) => value >= EARLIEST_DATE, `from must be on or after ${EARLIEST_DATE}`),
    to: isoDate,
    store: storeSchema.optional(),
    appVersion: z.string().max(64).optional(),
    territory: z.string().max(8).optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: "from must be on or before to",
    path: ["from"],
  })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= MAX_RANGE_DAYS, {
    message: `the range may cover at most ${MAX_RANGE_DAYS} days`,
    path: ["to"],
  });

export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export interface ApiError {
  error: string;
  details?: string[];
}

// ---------------------------------------------------------------------------
// Apps and connections
// ---------------------------------------------------------------------------

export const createAppSchema = z
  .object({
    loomitAppId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    androidPackage: z
      .string()
      .trim()
      .regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/, "invalid Android package")
      .optional(),
    appleAppId: z.string().trim().regex(/^\d{5,15}$/, "invalid Apple ID").optional(),
    playReportsBucket: z
      .string()
      .trim()
      .regex(/^pubsite_prod_[\w-]+$/, "invalid Play reports bucket")
      .optional(),
  })
  .refine((value) => value.androidPackage || value.appleAppId, {
    message: "Provide an Android package or an Apple ID.",
    path: ["androidPackage"],
  });

export type CreateAppRequest = z.infer<typeof createAppSchema>;

/**
 * Google Play access. Recommended: the publisher invites X3M's service
 * account (GET /v1/onboarding returns its email) and sends
 * `{ useX3mServiceAccount: true }`. Alternatively the publisher supplies its
 * own service-account key. Credentials are write-only.
 */
export const googleCredentialsSchema = z.union([
  z.object({ useX3mServiceAccount: z.literal(true) }),
  z.object({
    serviceAccountJson: z
      .string()
      .min(20)
      .max(20_000)
      .refine(isValidServiceAccountKey, "must be a Google service-account key (type \"service_account\")"),
  }),
]);

export const appleCredentialsSchema = z.object({
  issuerId: z.string().trim().min(8).max(64),
  keyId: z.string().trim().min(6).max(32),
  privateKey: z.string().min(100).max(10_000),
});

export type ConnectionStatus = "pending" | "active" | "error" | "disabled";

export interface ConnectionDto {
  store: Store;
  status: ConnectionStatus;
  lastVerifiedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  watermark: string | null;
}

export interface AppDto {
  id: string;
  loomitAppId: string;
  name: string;
  androidPackage: string | null;
  appleAppId: string | null;
  playReportsBucket: string | null;
  /** True when Loomit registered the store identifiers; required for X3M's Google account. */
  identityVerified: boolean;
  connections: ConnectionDto[];
}

export const uploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  platform: z.enum(["android", "ios"]),
  byteSize: z.number().int().positive().max(50_000_000, "Files are limited to 50 MB; split larger exports by month."),
});

export interface AppsResponse {
  items: AppDto[];
}

export interface OnboardingResponse {
  /** Email of X3M's Google service account to invite in Play Console; null when not configured. */
  googleServiceAccountEmail: string | null;
  /** Play Console permissions to grant to that account. */
  googlePermissions: string[];
  /** App Store Connect API key role to use. */
  appleKeyRole: string;
}

/** Response of PUT /v1/apps/{appId}/connections/{store}. */
export interface ConnectionWriteResponse {
  store: Store;
  status: ConnectionStatus;
}

/** Response of POST /v1/apps/{appId}/connections/{store}/verify. */
export interface VerifyResponse {
  store: Store;
  status: "active" | "error";
  /** Safe, user-facing reason when verification failed. */
  error: string | null;
}

export interface UploadResponse {
  uploadId: string;
  uploadUrl: string;
  /** Headers the PUT to `uploadUrl` must send exactly (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

export type UploadStatus = "pending" | "imported" | "failed";

/** Response of POST /v1/apps/{appId}/imports and GET /v1/apps/{appId}/uploads/{uploadId}. */
export interface ImportResponse {
  uploadId: string;
  status: UploadStatus;
  importedAt: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Evolution panel
// ---------------------------------------------------------------------------

export const timeseriesQuerySchema = rangeQuerySchema.and(
  z.object({ granularity: z.enum(["day", "week"]).default("day") }),
);

export interface TimeseriesTotals {
  n: number;
  /** Null when n is below the minimum sample size. */
  averageSentiment: number | null;
  /** 95% interval for the mean expected sentiment; null when insufficient. */
  sentimentCi: [number, number] | null;
  averageRating: number | null;
  negativeShare: number | null;
  /** Share of negative reviews whose primary or secondary reason is ads. */
  adsNegativeShare: number | null;
}

export interface TimeseriesPoint extends TimeseriesTotals {
  /** Start of the bucket (UTC date). */
  period: string;
  coverage: CoverageDayStatus;
}

export interface ReleaseMarker {
  appVersion: string;
  firstSeen: string;
}

export interface TimeseriesResponse {
  appId: string;
  from: string;
  to: string;
  granularity: "day" | "week";
  modelVersion: string | null;
  minN: number;
  /** Pooled over the whole range (all buckets, including those below min N individually). */
  totals: TimeseriesTotals;
  points: TimeseriesPoint[];
  releases: ReleaseMarker[];
  /** Values present in the range, for filter pickers. */
  dimensions: { territories: string[]; appVersions: string[] };
}


export interface ReasonCount {
  reason: ReasonKey;
  label: string;
  count: number;
  share: number;
}

export interface AdSubreasonCount {
  subreason: AdSubreasonKey;
  label: string;
  count: number;
  share: number;
}

export interface ReasonsResponse {
  from: string;
  to: string;
  group: "negative" | "neutral" | "positive";
  minN: number;
  total: number;
  reasons: ReasonCount[];
  adSubreasons: AdSubreasonCount[];
  /** Counts per period for the top reasons, for trend lines. */
  trend: Array<{ period: string; counts: Partial<Record<ReasonKey, number>> }>;
}

export interface VersionSummary {
  appVersion: string;
  firstSeen: string;
  n: number;
  averageSentiment: number | null;
  averageRating: number | null;
  negativeShare: number | null;
  adsNegativeShare: number | null;
  /** Change in average sentiment vs. the previous version; null if either is insufficient. */
  deltaSentiment: number | null;
  status: "ok" | "insufficient";
}

export interface VersionsResponse {
  from: string;
  to: string;
  minN: number;
  versions: VersionSummary[];
}

export const reviewsQuerySchema = rangeQuerySchema.and(
  z.object({
    sentiment: z.enum(["negative", "neutral", "positive"]).optional(),
    reason: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(200).optional(),
  }),
);

export interface ReviewClassificationDto {
  sentimentLabel: SentimentLabel;
  sentimentScore: number;
  sentimentConfidence: number;
  primaryReason: ReasonKey;
  secondaryReason: ReasonKey | null;
  adSubreason: AdSubreasonKey | null;
  modelVersion: string;
}

export interface ReviewDto {
  id: string;
  store: Store;
  storeReviewId: string;
  createdAt: string;
  dateSemantics: "created_at" | "last_modified_fallback";
  rating: number;
  title: string;
  body: string;
  language: string | null;
  territory: string | null;
  appVersion: string | null;
  classification: ReviewClassificationDto | null;
}

export interface ReviewsResponse {
  items: ReviewDto[];
  nextCursor: string | null;
}

export interface CoverageResponse {
  from: string;
  to: string;
  days: Array<{ day: string; store: Store; status: CoverageDayStatus }>;
  summary: Array<{ store: Store; complete: number; partial: number; unknown: number }>;
}

// ---------------------------------------------------------------------------
// Experiments and guardrails
// ---------------------------------------------------------------------------

export const experimentArmSchema = z.object({
  key: z.string().trim().min(1).max(64),
  role: z.enum(["test", "control"]),
  /** Dimension values that identify this arm (dimension attribution only). */
  values: z.array(z.string().trim().min(1).max(64)).max(200).optional(),
  /** Average daily active users of the arm in the window, for per-DAU rates. */
  dau: z.number().nonnegative().optional(),
});

export const linkExperimentSchema = z
  .object({
    loomitAppId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(200),
    attributionMode: z.enum(["dimension", "pre_post"]),
    dimension: z.enum(["app_version", "territory", "store"]).optional(),
    arms: z.array(experimentArmSchema).min(1).max(20),
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }).optional(),
    baselineStart: z.iso.datetime({ offset: true }).optional(),
    baselineEnd: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((value, context) => {
    if (value.attributionMode === "dimension") {
      if (!value.dimension) {
        context.addIssue({ code: "custom", message: "dimension is required for dimension attribution", path: ["dimension"] });
      }
      const roles = new Set(value.arms.map((arm) => arm.role));
      if (!roles.has("test") || !roles.has("control")) {
        context.addIssue({ code: "custom", message: "dimension attribution needs a test and a control arm", path: ["arms"] });
      }
      if (value.arms.some((arm) => !arm.values?.length)) {
        context.addIssue({ code: "custom", message: "every arm needs dimension values", path: ["arms"] });
      }
    }
    const span = (start: string, end: string | undefined) =>
      (Date.parse(end ?? new Date().toISOString()) - Date.parse(start)) / 86_400_000;
    if (value.startAt < EARLIEST_DATE || span(value.startAt, value.endAt) > 366) {
      context.addIssue({ code: "custom", message: "the experiment window must start after 2008 and last at most 366 days", path: ["startAt"] });
    }
    if (
      value.baselineStart &&
      (value.baselineStart < EARLIEST_DATE || span(value.baselineStart, value.baselineEnd) > 366)
    ) {
      context.addIssue({ code: "custom", message: "the baseline window must start after 2008 and last at most 366 days", path: ["baselineStart"] });
    }
    if (value.attributionMode === "pre_post" && (!value.baselineStart || !value.baselineEnd)) {
      context.addIssue({ code: "custom", message: "pre_post attribution needs a baseline window", path: ["baselineStart"] });
    }
  });

export type LinkExperimentRequest = z.infer<typeof linkExperimentSchema>;

export interface GuardrailArmValue {
  n: number;
  value: number | null;
}

export interface GuardrailMetricResult {
  metric: GuardrailMetric;
  label: string;
  /** Which direction is harmful; thresholds are magnitudes in that direction. */
  harm: "increase" | "decrease";
  /** Unit of delta and thresholds. `relative` means ratio − 1. */
  unit: "share" | "points" | "stars" | "relative" | "per100k";
  /** Unit of the test and control values (differs from `unit` for G3: rates per 100k DAU, compared as a relative change). */
  valueUnit: "share" | "points" | "stars" | "relative" | "per100k";
  status: GuardrailStatus;
  test: GuardrailArmValue;
  control: GuardrailArmValue;
  /** test − control, in the metric's unit; null when insufficient. */
  delta: number | null;
  pValue: number | null;
  thresholds: { warn: number; breach: number; minN: number };
  /** Plain-language reason for `insufficient`, or a note. */
  note: string | null;
}

export interface Confounder {
  kind: "release" | "coverage" | "model_change";
  detail: string;
  /** UTC day the confounder starts, when it has one (e.g. a release). */
  day?: string;
  appVersion?: string;
}

export interface GuardrailResponse {
  experimentId: string;
  loomitExperimentId: string;
  name: string;
  evaluatedAt: string | null;
  status: GuardrailStatus;
  attributionMode: "dimension" | "pre_post";
  attributionLabel: string;
  dimension: "app_version" | "territory" | "store" | null;
  arms: Array<{ key: string; role: "test" | "control"; values: string[]; dau: number | null }>;
  modelVersion: string | null;
  window: { start: string; end: string };
  baseline: { start: string; end: string } | null;
  metrics: GuardrailMetricResult[];
  confounders: Confounder[];
  /** Daily ad-complaint share among negative reviews, test vs. control. */
  series: Array<{
    day: string;
    test: number | null;
    control: number | null;
    /** Negative reviews behind each day's share. */
    testN: number;
    controlN: number;
  }>;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface TenantHealthDto {
  tenantId: string;
  loomitPublisherId: string;
  name: string;
  apps: number;
  activeConnections: number;
  erroredConnections: number;
  lastSyncedAt: string | null;
  reviews30d: number;
  unclassified: number;
  spendTodayUsd: number;
  budgetUsd: number;
}
