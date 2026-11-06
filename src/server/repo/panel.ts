import type {
  CoverageDayStatus,
  CoverageResponse,
  RangeQuery,
  ReasonsResponse,
  ReviewDto,
  ReviewsResponse,
  TimeseriesResponse,
  TimeseriesTotals,
  VersionsResponse,
} from "@/server/api/contracts";
import type { Client } from "@/server/db/pool";
import { daysBetween } from "@/server/repo/coverage";
import { currentModelVersion } from "@/server/repo/rollups";
import {
  AD_SUBREASON_DEFINITIONS,
  REASON_DEFINITIONS,
  SENTIMENT_LABELS,
  type AdSubreasonKey,
  type ReasonKey,
  type Store,
} from "@/lib/types";

const COVERAGE_RANK: Record<CoverageDayStatus, number> = { unknown: 0, partial: 1, complete: 2 };

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function filters(query: RangeQuery, startIndex: number, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.store) {
    values.push(query.store);
    clauses.push(`${prefix}store = $${startIndex + values.length - 1}`);
  }
  if (query.appVersion) {
    values.push(query.appVersion);
    clauses.push(`coalesce(${prefix}app_version, '') = $${startIndex + values.length - 1}`);
  }
  if (query.territory) {
    values.push(query.territory);
    clauses.push(`coalesce(${prefix}territory, '') = $${startIndex + values.length - 1}`);
  }
  return { sql: clauses.length ? ` and ${clauses.join(" and ")}` : "", values };
}

async function connectedStores(client: Client, appId: string, store?: Store): Promise<string[]> {
  const { rows } = await client.query<{ store: string }>(
    "select store from store_connection where app_id = $1 and status <> 'disabled'",
    [appId],
  );
  const stores = rows.map((row) => row.store);
  return store ? stores.filter((item) => item === store) : stores;
}

async function coverageMap(client: Client, appId: string, from: string, to: string) {
  const { rows } = await client.query<{ day: string; store: string; status: CoverageDayStatus }>(
    `select to_char(day, 'YYYY-MM-DD') as day, store, status from coverage_day
     where app_id = $1 and day between $2::date and $3::date`,
    [appId, from, to],
  );
  return new Map(rows.map((row) => [`${row.store}:${row.day}`, row.status]));
}

/** Mean expected sentiment with a 95% normal interval; nulls below min N. */
function summarize(
  bucket: { n: number; sumEv: number; sumEv2: number; sumRating: number; negative: number; adsNegative: number },
  minN: number,
): TimeseriesTotals {
  const sufficient = bucket.n >= minN;
  const mean = bucket.n ? bucket.sumEv / bucket.n : 0;
  const variance = bucket.n > 1 ? Math.max(0, (bucket.sumEv2 - bucket.n * mean * mean) / (bucket.n - 1)) : 0;
  const halfWidth = 1.96 * Math.sqrt(variance / Math.max(bucket.n, 1));
  return {
    n: bucket.n,
    averageSentiment: sufficient ? round(mean) : null,
    sentimentCi: sufficient ? [round(Math.max(0, mean - halfWidth)), round(Math.min(4, mean + halfWidth))] : null,
    averageRating: sufficient ? round(bucket.sumRating / bucket.n) : null,
    negativeShare: sufficient ? round(bucket.negative / bucket.n) : null,
    adsNegativeShare: sufficient ? (bucket.negative ? round(bucket.adsNegative / bucket.negative) : 0) : null,
  };
}

function bucketStart(day: string, granularity: "day" | "week"): string {
  if (granularity === "day") return day;
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7; // ISO week starts Monday
  return new Date(date.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

export async function timeseries(
  client: Client,
  appId: string,
  query: RangeQuery & { granularity: "day" | "week" },
  minN: number,
): Promise<TimeseriesResponse> {
  const modelVersion = await currentModelVersion(client, appId);
  const where = filters(query, 5);
  const { rows } = modelVersion
    ? await client.query<{ day: string; n: number; sum_ev: number; sum_ev2: number; sum_rating: number; negative: number; ads_negative: number }>(
        `select to_char(day, 'YYYY-MM-DD') as day, sum(n)::int as n, sum(sum_ev) as sum_ev, sum(sum_ev2) as sum_ev2,
           sum(sum_rating) as sum_rating, sum(negative)::int as negative, sum(ads_negative)::int as ads_negative
         from review_daily_rollup
         where app_id = $1 and model_version = $2 and day between $3::date and $4::date${where.sql}
         group by day order by day`,
        [appId, modelVersion, query.from, query.to, ...where.values],
      )
    : { rows: [] };

  const stores = await connectedStores(client, appId, query.store);
  const coverage = await coverageMap(client, appId, query.from, query.to);
  const buckets = new Map<string, { n: number; sumEv: number; sumEv2: number; sumRating: number; negative: number; adsNegative: number; coverage: CoverageDayStatus }>();

  for (const day of daysBetween(query.from, query.to)) {
    const key = bucketStart(day, query.granularity);
    const bucket = buckets.get(key) ?? { n: 0, sumEv: 0, sumEv2: 0, sumRating: 0, negative: 0, adsNegative: 0, coverage: "complete" as CoverageDayStatus };
    const dayCoverage = stores.length
      ? stores.reduce<CoverageDayStatus>((worst, store) => {
          const status = coverage.get(`${store}:${day}`) ?? "unknown";
          return COVERAGE_RANK[status] < COVERAGE_RANK[worst] ? status : worst;
        }, "complete")
      : "unknown";
    if (COVERAGE_RANK[dayCoverage] < COVERAGE_RANK[bucket.coverage]) bucket.coverage = dayCoverage;
    buckets.set(key, bucket);
  }
  for (const row of rows) {
    const bucket = buckets.get(bucketStart(row.day, query.granularity));
    if (!bucket) continue;
    bucket.n += row.n;
    bucket.sumEv += Number(row.sum_ev);
    bucket.sumEv2 += Number(row.sum_ev2);
    bucket.sumRating += Number(row.sum_rating);
    bucket.negative += row.negative;
    bucket.adsNegative += row.ads_negative;
  }

  const points = [...buckets.entries()].map(([period, bucket]) => ({
    period,
    ...summarize(bucket, minN),
    coverage: bucket.coverage,
  }));

  const { rows: releases } = await client.query<{ app_version: string; first_seen: string }>(
    `select app_version, to_char(first_seen at time zone 'UTC', 'YYYY-MM-DD') as first_seen
     from app_version_seen where app_id = $1 and first_seen >= $2::date and first_seen < ($3::date + 1)
     order by first_seen`,
    [appId, query.from, query.to],
  );

  const { rows: dimensionRows } = modelVersion
    ? await client.query<{ territories: string[] | null; versions: string[] | null }>(
        `select array_agg(distinct territory) filter (where territory <> '') as territories,
           array_agg(distinct app_version) filter (where app_version <> '') as versions
         from review_daily_rollup where app_id = $1 and model_version = $2 and day between $3::date and $4::date`,
        [appId, modelVersion, query.from, query.to],
      )
    : { rows: [] };

  const total = rows.reduce(
    (sum, row) => ({
      n: sum.n + row.n,
      sumEv: sum.sumEv + Number(row.sum_ev),
      sumEv2: sum.sumEv2 + Number(row.sum_ev2),
      sumRating: sum.sumRating + Number(row.sum_rating),
      negative: sum.negative + row.negative,
      adsNegative: sum.adsNegative + row.ads_negative,
    }),
    { n: 0, sumEv: 0, sumEv2: 0, sumRating: 0, negative: 0, adsNegative: 0 },
  );
  const totals = summarize(total, minN);

  return {
    appId,
    from: query.from,
    to: query.to,
    granularity: query.granularity,
    modelVersion,
    minN,
    totals,
    points,
    releases: releases.map((row) => ({ appVersion: row.app_version, firstSeen: row.first_seen })),
    dimensions: {
      territories: (dimensionRows[0]?.territories ?? []).sort(),
      appVersions: (dimensionRows[0]?.versions ?? []).sort(),
    },
  };
}

const GROUP_SQL: Record<ReasonsResponse["group"], string> = {
  negative: "c.sentiment_score <= 1",
  neutral: "c.sentiment_score = 2",
  positive: "c.sentiment_score >= 3",
};

const GROUP_COLUMN: Record<ReasonsResponse["group"], string> = {
  negative: "negative_reason_counts",
  neutral: "neutral_reason_counts",
  positive: "positive_reason_counts",
};

/** Reason ranking and weekly trend, read from rollups only. */
export async function reasons(
  client: Client,
  appId: string,
  query: RangeQuery & { group: ReasonsResponse["group"] },
  minN: number,
): Promise<ReasonsResponse> {
  const modelVersion = (await currentModelVersion(client, appId)) ?? "";
  const where = filters(query, 5);
  const params = [appId, modelVersion, query.from, query.to, ...where.values];
  const scope = `from review_daily_rollup where app_id = $1 and model_version = $2 and day between $3::date and $4::date${where.sql}`;

  const { rows } = await client.query<{ reason: ReasonKey; count: number }>(
    `select key as reason, sum(value::int)::int as count from (select ${GROUP_COLUMN[query.group]} as counts ${scope}) r,
       jsonb_each_text(r.counts) group by key order by count desc, key`,
    params,
  );
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  // Ad sub-reasons are only recorded for negative ad complaints.
  const { rows: subreasons } =
    query.group === "negative"
      ? await client.query<{ subreason: AdSubreasonKey; count: number }>(
          `select key as subreason, sum(value::int)::int as count from (select ad_subreason_counts as counts ${scope}) r,
             jsonb_each_text(r.counts) group by key order by count desc, key`,
          params,
        )
      : { rows: [] };
  const subTotal = subreasons.reduce((sum, row) => sum + row.count, 0);
  const top = rows.slice(0, 5).map((row) => row.reason);
  const { rows: trendRows } = await client.query<{ period: string; reason: ReasonKey; count: number }>(
    `select to_char(date_trunc('week', r.day), 'YYYY-MM-DD') as period, key as reason, sum(value::int)::int as count
     from (select day, ${GROUP_COLUMN[query.group]} as counts ${scope}) r, jsonb_each_text(r.counts)
     where key = any($${params.length + 1}::text[]) group by 1, 2 order by 1, 2`,
    [...params, top],
  );
  const trend = new Map<string, Partial<Record<ReasonKey, number>>>();
  for (const row of trendRows) {
    const counts = trend.get(row.period) ?? {};
    counts[row.reason] = row.count;
    trend.set(row.period, counts);
  }

  return {
    from: query.from,
    to: query.to,
    group: query.group,
    minN,
    total,
    reasons: rows.map((row) => ({
      reason: row.reason,
      label: REASON_DEFINITIONS[row.reason] ?? row.reason,
      count: row.count,
      share: round(row.count / total),
    })),
    adSubreasons: subreasons.map((row) => ({
      subreason: row.subreason,
      label: AD_SUBREASON_DEFINITIONS[row.subreason] ?? row.subreason,
      count: row.count,
      share: round(row.count / subTotal),
    })),
    trend: [...trend.entries()].map(([period, counts]) => ({ period, counts })),
  };
}

export async function versions(client: Client, appId: string, query: RangeQuery, minN: number): Promise<VersionsResponse> {
  const modelVersion = await currentModelVersion(client, appId);
  const where = filters({ ...query, appVersion: undefined }, 5);
  const { rows } = modelVersion
    ? await client.query<{ app_version: string; n: number; sum_ev: number; sum_rating: number; negative: number; ads_negative: number }>(
        `select app_version, sum(n)::int as n, sum(sum_ev) as sum_ev, sum(sum_rating) as sum_rating,
           sum(negative)::int as negative, sum(ads_negative)::int as ads_negative
         from review_daily_rollup
         where app_id = $1 and model_version = $2 and day between $3::date and $4::date and app_version <> ''${where.sql}
         group by app_version`,
        [appId, modelVersion, query.from, query.to, ...where.values],
      )
    : { rows: [] };
  const { rows: firstSeen } = await client.query<{ app_version: string; first_seen: string }>(
    `select app_version, to_char(first_seen at time zone 'UTC', 'YYYY-MM-DD') as first_seen
     from app_version_seen where app_id = $1`,
    [appId],
  );
  const seen = new Map(firstSeen.map((row) => [row.app_version, row.first_seen]));
  const ordered = rows
    .map((row) => ({ ...row, firstSeen: seen.get(row.app_version) ?? query.from }))
    .sort((left, right) => left.firstSeen.localeCompare(right.firstSeen) || left.app_version.localeCompare(right.app_version));

  let previous: number | null = null;
  const summaries = ordered.map((row) => {
    const sufficient = row.n >= minN;
    const average = sufficient ? round(Number(row.sum_ev) / row.n) : null;
    const delta = average !== null && previous !== null ? round(average - previous) : null;
    if (average !== null) previous = average;
    return {
      appVersion: row.app_version,
      firstSeen: row.firstSeen,
      n: row.n,
      averageSentiment: average,
      averageRating: sufficient ? round(Number(row.sum_rating) / row.n) : null,
      negativeShare: sufficient ? round(row.negative / row.n) : null,
      adsNegativeShare: sufficient ? (row.negative ? round(row.ads_negative / row.negative) : 0) : null,
      deltaSentiment: delta,
      status: sufficient ? ("ok" as const) : ("insufficient" as const),
    };
  });

  return { from: query.from, to: query.to, minN, versions: summaries.reverse() };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") return [value[0], value[1]];
  } catch {
    // fall through
  }
  return null;
}

export async function reviewsPage(
  client: Client,
  appId: string,
  query: RangeQuery & { sentiment?: ReasonsResponse["group"]; reason?: string; limit: number; cursor?: string },
): Promise<ReviewsResponse> {
  const modelVersion = (await currentModelVersion(client, appId)) ?? "";
  const params: unknown[] = [appId, modelVersion, query.from, query.to];
  const clauses: string[] = [];
  const where = filters(query, params.length + 1, "r");
  params.push(...where.values);
  if (query.sentiment) clauses.push(GROUP_SQL[query.sentiment]);
  if (query.reason) {
    params.push(query.reason);
    clauses.push(`(c.primary_reason = $${params.length} or c.secondary_reason = $${params.length})`);
  }
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    params.push(cursor[0], cursor[1]);
    clauses.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(query.limit + 1);

  const { rows } = await client.query<{
    id: string; store: Store; store_review_id: string; created_at: Date; date_semantics: ReviewDto["dateSemantics"];
    rating: number; title: string; body: string; language: string | null; territory: string | null; app_version: string | null;
    sentiment_score: number | null; sentiment_confidence: number | null; primary_reason: ReasonKey | null;
    secondary_reason: ReasonKey | null; ad_subreason: AdSubreasonKey | null; model_version: string | null;
  }>(
    `select r.id, r.store, r.store_review_id, r.created_at, r.date_semantics, r.rating, r.title, r.body, r.language,
       r.territory, r.app_version, c.sentiment_score, c.sentiment_confidence, c.primary_reason, c.secondary_reason,
       c.ad_subreason, c.model_version
     from review r
     left join classification c on c.review_id = r.id and c.text_hash = r.text_hash and c.model_version = $2
     where r.app_id = $1 and r.created_at >= ($3::date::timestamp at time zone 'UTC')
       and r.created_at < (($4::date + 1)::timestamp at time zone 'UTC')${where.sql}
       ${clauses.length ? `and ${clauses.join(" and ")}` : ""}
     order by r.created_at desc, r.id desc
     limit $${params.length}`,
    params,
  );

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      store: row.store,
      storeReviewId: row.store_review_id,
      createdAt: row.created_at.toISOString(),
      dateSemantics: row.date_semantics,
      rating: row.rating,
      title: row.title,
      body: row.body,
      language: row.language,
      territory: row.territory,
      appVersion: row.app_version,
      classification:
        row.sentiment_score === null || row.primary_reason === null || row.model_version === null
          ? null
          : {
              sentimentLabel: SENTIMENT_LABELS[row.sentiment_score],
              sentimentScore: row.sentiment_score,
              sentimentConfidence: row.sentiment_confidence ?? 0,
              primaryReason: row.primary_reason,
              secondaryReason: row.secondary_reason,
              adSubreason: row.ad_subreason,
              modelVersion: row.model_version,
            },
    })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export async function coverage(client: Client, appId: string, query: RangeQuery): Promise<CoverageResponse> {
  const stores = (await connectedStores(client, appId, query.store)) as Store[];
  const known = await coverageMap(client, appId, query.from, query.to);
  const days = daysBetween(query.from, query.to).flatMap((day) =>
    stores.map((store) => ({ day, store, status: known.get(`${store}:${day}`) ?? ("unknown" as CoverageDayStatus) })),
  );
  return {
    from: query.from,
    to: query.to,
    days,
    summary: stores.map((store) => {
      const mine = days.filter((item) => item.store === store);
      return {
        store,
        complete: mine.filter((item) => item.status === "complete").length,
        partial: mine.filter((item) => item.status === "partial").length,
        unknown: mine.filter((item) => item.status === "unknown").length,
      };
    }),
  };
}
