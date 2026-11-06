import { createHash } from "node:crypto";

import type { Client } from "@/server/db/pool";
import type { Classification, Review } from "@/lib/types";

/** Identity of the text a classification was made from. */
export function textHash(review: Pick<Review, "title" | "body">): string {
  return createHash("sha256").update(`${review.title}\n${review.body}`).digest("hex");
}

/**
 * Version key that groups comparable classifications. Built from the
 * configured classifier (not the model id a provider echoes back, which can
 * carry a dated suffix) so pending detection and rollups stay stable.
 */
export function modelVersionOf(info: { provider: string; model: string; promptVersion: string; taxonomyVersion: string }): string {
  return `${info.provider}/${info.model}/${info.promptVersion}/${info.taxonomyVersion}`;
}

export interface UpsertResult {
  upserted: number;
  /** UTC days touched by new or changed reviews (for rollups and classification). */
  days: string[];
}

/**
 * Idempotent upsert keyed by (app, store, store review id). A changed text
 * gets a new text_hash, so the review is picked up again for classification.
 */
export async function upsertReviews(
  client: Client,
  input: { tenantId: string; appId: string; source: "api" | "csv" | "report"; reviews: Review[] },
): Promise<UpsertResult> {
  const days = new Set<string>();
  let upserted = 0;
  const chunkSize = 500;

  for (let index = 0; index < input.reviews.length; index += chunkSize) {
    const chunk = input.reviews.slice(index, index + chunkSize);
    const { rows } = await client.query<{ day: string }>(
      `insert into review (tenant_id, app_id, store, store_review_id, created_at, last_modified_at,
         date_semantics, rating, title, body, language, territory, app_version, text_hash, source)
       select $1, $2, r.store, r.store_review_id, r.created_at, r.last_modified_at, r.date_semantics,
         r.rating, r.title, r.body, r.language, r.territory, r.app_version, r.text_hash, $3
       from jsonb_to_recordset($4::jsonb) as r(
         store text, store_review_id text, created_at timestamptz, last_modified_at timestamptz,
         date_semantics text, rating smallint, title text, body text, language text,
         territory text, app_version text, text_hash text)
       on conflict (app_id, store, store_review_id) do update set
         created_at = excluded.created_at,
         last_modified_at = excluded.last_modified_at,
         rating = excluded.rating, title = excluded.title, body = excluded.body,
         language = coalesce(excluded.language, review.language),
         territory = coalesce(excluded.territory, review.territory),
         app_version = coalesce(excluded.app_version, review.app_version),
         text_hash = excluded.text_hash, updated_at = now()
       where review.text_hash is distinct from excluded.text_hash
          or review.rating is distinct from excluded.rating
          or review.created_at is distinct from excluded.created_at
       returning to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day`,
      [
        input.tenantId,
        input.appId,
        input.source,
        JSON.stringify(
          chunk.map((review) => ({
            store: review.store,
            store_review_id: review.id,
            created_at: review.createdAt,
            last_modified_at: review.updatedAt ?? null,
            date_semantics: review.dateSemantics,
            rating: Math.round(review.rating),
            title: review.title,
            body: review.body,
            language: review.language ?? null,
            territory: review.territory ?? null,
            app_version: review.appVersion ?? null,
            text_hash: textHash(review),
          })),
        ),
      ],
    );
    upserted += rows.length;
    for (const row of rows) days.add(row.day);
  }

  return { upserted, days: [...days].sort() };
}

export interface PendingReview extends Review {
  reviewUuid: string;
  textHash: string;
  tenantId: string;
}

/** Reviews of an app without a classification for this model version and current text. */
export async function pendingReviews(
  client: Client,
  appId: string,
  modelVersion: string,
  limit: number,
): Promise<PendingReview[]> {
  const { rows } = await client.query<{
    id: string; tenant_id: string; store: Review["store"]; store_review_id: string; created_at: Date;
    last_modified_at: Date | null; date_semantics: Review["dateSemantics"]; rating: number; title: string;
    body: string; language: string | null; territory: string | null; app_version: string | null; text_hash: string; source: string;
  }>(
    `select r.* from review r
     where r.app_id = $1 and not exists (
       select 1 from classification c
       where c.review_id = r.id and c.text_hash = r.text_hash and c.model_version = $2)
     order by r.created_at desc
     limit $3`,
    [appId, modelVersion, limit],
  );
  return rows.map((row) => ({
    reviewUuid: row.id,
    tenantId: row.tenant_id,
    textHash: row.text_hash,
    id: row.id,
    store: row.store,
    platform: row.store === "google_play" ? "android" : "ios",
    rating: row.rating,
    title: row.title,
    body: row.body,
    language: row.language ?? undefined,
    territory: row.territory ?? undefined,
    appVersion: row.app_version ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.last_modified_at?.toISOString(),
    dateSemantics: row.date_semantics,
    source: row.source === "csv" ? "csv" : "api",
  }));
}

export async function insertClassifications(
  client: Client,
  modelVersion: string,
  rows: Array<{ review: PendingReview; classification: Classification }>,
): Promise<string[]> {
  if (!rows.length) return [];
  const { rows: inserted } = await client.query<{ day: string }>(
    `with input as (
       select * from jsonb_to_recordset($1::jsonb) as c(
         tenant_id uuid, review_id uuid, text_hash text, model_version text, provider text, model text,
         prompt_version text, taxonomy_version text, sentiment_score smallint, sentiment_ev real,
         sentiment_estimator text, sentiment_probs jsonb, sentiment_confidence real, primary_reason text,
         secondary_reason text, ad_subreason text, reason_probs jsonb, reason_confidence real, cost_usd numeric)
     ), written as (
       insert into classification (tenant_id, review_id, text_hash, model_version, provider, model,
         prompt_version, taxonomy_version, sentiment_score, sentiment_ev, sentiment_estimator, sentiment_probs,
         sentiment_confidence, primary_reason, secondary_reason, ad_subreason, reason_probs, reason_confidence, cost_usd)
       select * from input
       on conflict (review_id, text_hash, model_version) do nothing
       returning review_id
     )
     select distinct to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD') as day
     from written w join review r on r.id = w.review_id`,
    [
      JSON.stringify(
        rows.map(({ review, classification }) => ({
          tenant_id: review.tenantId,
          review_id: review.reviewUuid,
          text_hash: review.textHash,
          model_version: modelVersion,
          provider: classification.provider,
          model: classification.model,
          prompt_version: classification.promptVersion,
          taxonomy_version: classification.taxonomyVersion,
          sentiment_score: classification.sentimentScore,
          sentiment_ev: classification.sentimentExpectedValue,
          sentiment_estimator: classification.sentimentEstimator,
          sentiment_probs: classification.sentimentProbabilities,
          sentiment_confidence: classification.sentimentConfidence,
          primary_reason: classification.primaryReason,
          secondary_reason: classification.secondaryReason,
          ad_subreason: classification.adSubreason,
          reason_probs: classification.reasonProbabilities,
          reason_confidence: classification.reasonConfidence,
          cost_usd: classification.costUsd,
        })),
      ),
    ],
  );
  return inserted.map((row) => row.day).sort();
}
