import { fetchAppleReviews } from "@/lib/connectors/app-store-connect";
import { GOOGLE_REVIEW_API_WINDOW_DAYS, fetchGooglePlayReviews } from "@/lib/connectors/google-play";
import type { ConnectorResult } from "@/lib/connectors/types";
import { PublicError, publicMessage } from "@/lib/errors";
import { SYSTEM, withScope, type Pool } from "@/server/db/pool";
import { tokenForConnection } from "@/server/ingestion/credentials";
import { metrics } from "@/server/metrics";
import { getApp, getConnection, markConnection, type AppRow, type ConnectionRow } from "@/server/repo/apps";
import { daysBetween, recordCoverage } from "@/server/repo/coverage";
import { upsertReviews } from "@/server/repo/reviews";
import type { SecretStore } from "@/server/secrets/store";

export interface SyncDeps {
  pool: Pool;
  secrets: SecretStore;
  now?: () => Date;
}

export interface SyncResult {
  connectionId: string;
  appId: string;
  tenantId: string;
  upserted: number;
  days: string[];
  truncated: boolean;
  status: "succeeded" | "failed";
  error?: string;
}

/** Apple history fetched on the first (backfill) sync. */
const APPLE_BACKFILL_DAYS = 365;

async function fetchForConnection(
  app: AppRow,
  connection: ConnectionRow,
  token: string,
  mode: "incremental" | "backfill",
  now: Date,
): Promise<{ result: ConnectorResult; coverageFrom: Date }> {
  if (connection.store === "google_play") {
    if (!app.android_package) throw new PublicError("The app has no Android package.", 409);
    const windowStart = new Date(now.getTime() - GOOGLE_REVIEW_API_WINDOW_DAYS * 86_400_000);
    const stopAt = mode === "incremental" ? connection.watermark ?? undefined : undefined;
    const result = await fetchGooglePlayReviews({
      packageName: app.android_package,
      accessToken: token,
      stopAt,
      maxPages: mode === "backfill" ? 50 : undefined,
      now: now.getTime(),
    });
    // The API only ever covers about the last week, whatever the watermark.
    const coverageFrom = stopAt && stopAt > windowStart ? stopAt : windowStart;
    return { result, coverageFrom };
  }

  if (!app.apple_app_id) throw new PublicError("The app has no Apple ID.", 409);
  const since =
    mode === "incremental" && connection.watermark
      ? connection.watermark
      : new Date(now.getTime() - APPLE_BACKFILL_DAYS * 86_400_000);
  const result = await fetchAppleReviews({
    appId: app.apple_app_id,
    accessToken: token,
    since,
    maxPages: mode === "backfill" ? 50 : undefined,
  });
  return { result, coverageFrom: since };
}

/**
 * Incremental (or first-time backfill) sync of one store connection:
 * fetch since the watermark, upsert idempotently, advance the watermark,
 * and record coverage for the days the fetch fully covered.
 */
export async function syncConnection(
  deps: SyncDeps,
  connectionId: string,
  requestedMode?: "incremental" | "backfill",
): Promise<SyncResult> {
  const now = deps.now?.() ?? new Date();
  const loaded = await withScope(deps.pool, SYSTEM, async (client) => {
    const connection = await getConnection(client, connectionId);
    const app = connection ? await getApp(client, connection.app_id) : null;
    return connection && app ? { connection, app } : null;
  });
  if (!loaded) throw new PublicError("Connection not found.", 404);
  const { connection, app } = loaded;
  if (connection.status === "disabled") {
    return { connectionId, appId: app.id, tenantId: app.tenant_id, upserted: 0, days: [], truncated: false, status: "succeeded" };
  }
  const mode = requestedMode ?? (connection.backfilled_at ? "incremental" : "backfill");

  const runId = await withScope(deps.pool, SYSTEM, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "insert into ingestion_run (tenant_id, app_id, store, mode) values ($1, $2, $3, $4) returning id",
      [app.tenant_id, app.id, connection.store, mode],
    );
    return rows[0].id;
  });

  try {
    const token = await tokenForConnection(deps.secrets, connection);
    const { result, coverageFrom } = await fetchForConnection(app, connection, token, mode, now);
    metrics.ingestionPages.inc({ store: connection.store }, result.coverage.pagesFetched ?? 0);

    const newest = result.reviews.reduce<Date | null>((latest, review) => {
      const stamp = new Date(review.updatedAt ?? review.createdAt);
      return !latest || stamp > latest ? stamp : latest;
    }, null);

    const upsert = await withScope(deps.pool, SYSTEM, async (client) => {
      const written = await upsertReviews(client, {
        tenantId: app.tenant_id,
        appId: app.id,
        source: "api",
        reviews: result.reviews,
      });
      await recordCoverage(client, {
        tenantId: app.tenant_id,
        appId: app.id,
        store: connection.store,
        days: daysBetween(coverageFrom, now),
        status: result.coverage.truncated ? "partial" : "complete",
        source: `${connection.store}_api`,
      });
      await client.query(
        `update ingestion_run set finished_at = now(), status = 'succeeded', pages = $2,
           reviews_upserted = $3, truncated = $4 where id = $1`,
        [runId, result.coverage.pagesFetched ?? 0, written.upserted, result.coverage.truncated],
      );
      // A truncated run must not advance the watermark past reviews it never saw.
      await markConnection(client, connection.id, {
        status: "active",
        synced: true,
        watermark: result.coverage.truncated ? null : newest,
        backfilled: mode === "backfill" && !result.coverage.truncated,
      });
      return written;
    });

    metrics.ingestionRuns.inc({ store: connection.store, status: "succeeded" });
    return {
      connectionId, appId: app.id, tenantId: app.tenant_id, upserted: upsert.upserted,
      days: upsert.days, truncated: result.coverage.truncated, status: "succeeded",
    };
  } catch (error) {
    const message = publicMessage(error, "Sync failed. See server logs.");
    if (!(error instanceof PublicError)) console.error(`[reviewsignal] sync ${connectionId} failed`, error);
    const rateLimited = /HTTP 429/.test(message);
    if (rateLimited) metrics.ingestionRateLimited.inc({ store: connection.store });
    metrics.ingestionRuns.inc({ store: connection.store, status: "failed" });
    await withScope(deps.pool, SYSTEM, async (client) => {
      await client.query(
        "update ingestion_run set finished_at = now(), status = 'failed', error = $2, rate_limited = $3 where id = $1",
        [runId, message, rateLimited],
      );
      // Rate limits are transient; keep the connection active so it retries.
      await markConnection(client, connection.id, {
        status: rateLimited ? connection.status : "error",
        error: message,
      });
    });
    return { connectionId, appId: app.id, tenantId: app.tenant_id, upserted: 0, days: [], truncated: false, status: "failed", error: message };
  }
}
