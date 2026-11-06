import type { Client } from "@/server/db/pool";

interface ClassifiedRow {
  tenant_id: string;
  store: string;
  day: string;
  app_version: string;
  territory: string;
  rating: number;
  sentiment_ev: number;
  sentiment_score: number;
  primary_reason: string;
  secondary_reason: string | null;
  ad_subreason: string | null;
}

interface Bucket {
  tenantId: string;
  store: string;
  day: string;
  appVersion: string;
  territory: string;
  n: number;
  sumEv: number;
  sumEv2: number;
  sumRating: number;
  sumRating2: number;
  negative: number;
  neutral: number;
  positive: number;
  adsNegative: number;
  reasons: Record<string, number>;
  negativeReasons: Record<string, number>;
  neutralReasons: Record<string, number>;
  positiveReasons: Record<string, number>;
  adSubreasons: Record<string, number>;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Aggregates classified reviews into daily rollup buckets (pure; exported for tests). */
export function aggregateBuckets(rows: ClassifiedRow[]): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const key = [row.store, row.day, row.app_version, row.territory].join("\u0000");
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        tenantId: row.tenant_id, store: row.store, day: row.day, appVersion: row.app_version,
        territory: row.territory, n: 0, sumEv: 0, sumEv2: 0, sumRating: 0, sumRating2: 0,
        negative: 0, neutral: 0, positive: 0, adsNegative: 0, reasons: {}, negativeReasons: {},
        neutralReasons: {}, positiveReasons: {}, adSubreasons: {},
      };
      buckets.set(key, bucket);
    }
    const ev = Number(row.sentiment_ev);
    bucket.n += 1;
    bucket.sumEv += ev;
    bucket.sumEv2 += ev * ev;
    bucket.sumRating += row.rating;
    bucket.sumRating2 += row.rating * row.rating;
    increment(bucket.reasons, row.primary_reason);
    if (row.sentiment_score <= 1) {
      bucket.negative += 1;
      increment(bucket.negativeReasons, row.primary_reason);
      if (row.primary_reason === "ads" || row.secondary_reason === "ads") {
        bucket.adsNegative += 1;
        if (row.ad_subreason) increment(bucket.adSubreasons, row.ad_subreason);
      }
    } else if (row.sentiment_score === 2) {
      bucket.neutral += 1;
      increment(bucket.neutralReasons, row.primary_reason);
    } else {
      bucket.positive += 1;
      increment(bucket.positiveReasons, row.primary_reason);
    }
  }
  return [...buckets.values()];
}

/**
 * Rebuilds rollups for the given app, model version and UTC days from the
 * current classification of each review's current text.
 */
export async function rebuildRollups(
  client: Client,
  input: { appId: string; modelVersion: string; days: string[] },
): Promise<number> {
  if (!input.days.length) return 0;
  const { rows } = await client.query<ClassifiedRow>(
    `select r.tenant_id, r.store, to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
       coalesce(r.app_version, '') as app_version, coalesce(r.territory, '') as territory, r.rating,
       c.sentiment_ev, c.sentiment_score, c.primary_reason, c.secondary_reason, c.ad_subreason
     from review r
     join classification c on c.review_id = r.id and c.text_hash = r.text_hash and c.model_version = $2
     where r.app_id = $1
       and r.created_at >= ((select min(d) from unnest($3::date[]) d)::timestamp at time zone 'UTC')
       and r.created_at < (((select max(d) from unnest($3::date[]) d) + 1)::timestamp at time zone 'UTC')
       and (r.created_at at time zone 'UTC')::date = any($3::date[])`,
    [input.appId, input.modelVersion, input.days],
  );
  await client.query(
    "delete from review_daily_rollup where app_id = $1 and model_version = $2 and day = any($3::date[])",
    [input.appId, input.modelVersion, input.days],
  );
  const buckets = aggregateBuckets(rows);
  if (!buckets.length) return 0;
  await client.query(
    `insert into review_daily_rollup (tenant_id, app_id, store, day, app_version, territory, model_version,
       n, sum_ev, sum_ev2, sum_rating, sum_rating2, negative, neutral, positive, ads_negative,
       reason_counts, negative_reason_counts, neutral_reason_counts, positive_reason_counts, ad_subreason_counts)
     select b."tenantId", $1, b.store, b.day::date, b."appVersion", b.territory, $2,
       b.n, b."sumEv", b."sumEv2", b."sumRating", b."sumRating2", b.negative, b.neutral, b.positive,
       b."adsNegative", b.reasons, b."negativeReasons", b."neutralReasons", b."positiveReasons", b."adSubreasons"
     from jsonb_to_recordset($3::jsonb) as b("tenantId" uuid, store text, day text, "appVersion" text,
       territory text, n int, "sumEv" float8, "sumEv2" float8, "sumRating" float8, "sumRating2" float8,
       negative int, neutral int, positive int, "adsNegative" int, reasons jsonb, "negativeReasons" jsonb,
       "neutralReasons" jsonb, "positiveReasons" jsonb, "adSubreasons" jsonb)`,
    [input.appId, input.modelVersion, JSON.stringify(buckets)],
  );
  return buckets.length;
}

/** The model version of the app's most recent classification (kept by a trigger). */
export async function currentModelVersion(client: Client, appId: string): Promise<string | null> {
  const { rows } = await client.query<{ current_model_version: string | null }>(
    "select current_model_version from app where id = $1",
    [appId],
  );
  return rows[0]?.current_model_version ?? null;
}

export async function addSpend(
  client: Client,
  input: { tenantId: string; costUsd: number; reviews: number; day?: string },
): Promise<void> {
  await client.query(
    `insert into classification_spend (tenant_id, day, cost_usd, reviews)
     values ($1, coalesce($4::date, (now() at time zone 'UTC')::date), $2, $3)
     on conflict (tenant_id, day) do update set
       cost_usd = classification_spend.cost_usd + excluded.cost_usd,
       reviews = classification_spend.reviews + excluded.reviews`,
    [input.tenantId, input.costUsd, input.reviews, input.day ?? null],
  );
}

export async function remainingBudget(client: Client, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ remaining: string }>(
    `select t.daily_budget_usd - coalesce(s.cost_usd, 0) as remaining
     from tenant t
     left join classification_spend s on s.tenant_id = t.id and s.day = (now() at time zone 'UTC')::date
     where t.id = $1`,
    [tenantId],
  );
  return Number(rows[0]?.remaining ?? 0);
}
