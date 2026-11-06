import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { parseReviewCsv } from "@/lib/connectors/csv";
import { PublicError, publicMessage, upstreamError } from "@/lib/errors";
import { SYSTEM, withScope, type Pool } from "@/server/db/pool";
import { GCS_READ_SCOPE, tokenForConnection } from "@/server/ingestion/credentials";
import { metrics } from "@/server/metrics";
import { getApp, listConnections } from "@/server/repo/apps";
import { daysBetween, recordCoverage } from "@/server/repo/coverage";
import { upsertReviews } from "@/server/repo/reviews";
import type { SecretStore } from "@/server/secrets/store";

/** Object storage used for CSV uploads; S3 in deployed environments. */
/** Largest CSV the worker will import. */
export const MAX_UPLOAD_BYTES = 50_000_000;

export interface ObjectStorage {
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  /** Object size in bytes, or null when the object does not exist. */
  size(key: string): Promise<number | null>;
  get(key: string): Promise<Uint8Array>;
  /** Deletes every object under a prefix (tenant offboarding). */
  deletePrefix(prefix: string): Promise<number>;
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
}

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }

  async size(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? 0;
    } catch (error) {
      if ((error as { name?: string }).name === "NotFound" || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((item) => (item.Key ? [{ Key: item.Key }] : []));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new PublicError("Uploaded file not found.", 404);
    return result.Body.transformToByteArray();
  }

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }
}

export interface ImportDeps {
  pool: Pool;
  secrets: SecretStore;
  uploads?: ObjectStorage;
}

/** Imports a CSV previously uploaded through a presigned URL. */
export async function importUpload(
  deps: ImportDeps,
  uploadId: string,
): Promise<{ upserted: number; skippedRows: number; days: string[]; appId: string; tenantId: string }> {
  if (!deps.uploads) throw new PublicError("CSV uploads are not configured (UPLOADS_BUCKET).", 503);
  const upload = await withScope(deps.pool, SYSTEM, async (client) => {
    const { rows } = await client.query<{
      id: string; tenant_id: string; app_id: string; object_key: string; file_name: string; platform: "android" | "ios"; status: string;
    }>("select id, tenant_id, app_id, object_key, file_name, platform, status from upload where id = $1", [uploadId]);
    return rows[0] ?? null;
  });
  if (!upload) throw new PublicError("Upload not found.", 404);

  try {
    // The presigned PUT cannot cap the size, so check it before reading.
    const size = await deps.uploads.size(upload.object_key);
    if (size === null) throw new PublicError("The file was not uploaded.", 404);
    if (size > MAX_UPLOAD_BYTES) {
      throw new PublicError(`The file is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB. Split it by month and import each part.`, 413);
    }
    const bytes = await deps.uploads.get(upload.object_key);
    const parsed = parseReviewCsv({
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      platform: upload.platform,
      fileName: upload.file_name,
    });
    const written = await withScope(deps.pool, SYSTEM, async (client) => {
      const result = await upsertReviews(client, {
        tenantId: upload.tenant_id,
        appId: upload.app_id,
        source: "csv",
        reviews: parsed.reviews,
      });
      await client.query("update upload set status = 'imported', imported_at = now(), error = null where id = $1", [uploadId]);
      return result;
    });
    metrics.ingestionRuns.inc({ store: upload.platform === "android" ? "google_play" : "apple_app_store", status: "succeeded" });
    return { upserted: written.upserted, skippedRows: parsed.skippedRows, days: written.days, appId: upload.app_id, tenantId: upload.tenant_id };
  } catch (error) {
    const message = publicMessage(error, "Import failed. See server logs.");
    if (!(error instanceof PublicError)) console.error(`[reviewsignal] import ${uploadId} failed`, error);
    await withScope(deps.pool, SYSTEM, (client) =>
      client.query("update upload set status = 'failed', error = $2 where id = $1", [uploadId, message]),
    );
    throw error instanceof PublicError ? error : new PublicError(message, 500);
  }
}

const REPORT_PATTERN = /reviews\/reviews_(.+)_(\d{4})(\d{2})\.csv$/;

/**
 * Backfills Google Play history from the developer's Play Console reports
 * bucket (monthly UTF-16 CSVs), using the same service account. Months that
 * are complete and fully in the past are recorded as complete coverage.
 */
export async function importPlayReports(
  deps: ImportDeps,
  input: { appId: string; months?: number; now?: Date },
): Promise<{ files: number; upserted: number; days: string[] }> {
  const now = input.now ?? new Date();
  const loaded = await withScope(deps.pool, SYSTEM, async (client) => {
    const app = await getApp(client, input.appId);
    const connection = (await listConnections(client, [input.appId])).find((row) => row.store === "google_play");
    return { app, connection };
  });
  const { app, connection } = loaded;
  if (!app || !connection) throw new PublicError("The app has no Google Play connection.", 409);
  if (!app.play_reports_bucket || !app.android_package) {
    throw new PublicError("Set the Play reports bucket and Android package to import history.", 409);
  }

  const token = await tokenForConnection(deps.secrets, connection, app, { scopes: [GCS_READ_SCOPE] });
  const prefix = `reviews/reviews_${app.android_package}_`;
  const listUrl = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(app.play_reports_bucket)}/o`);
  listUrl.searchParams.set("prefix", prefix);
  const items: Array<{ name: string }> = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
    const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!list.ok) throw await upstreamError("Google Cloud Storage", list);
    const page = (await list.json()) as { items?: Array<{ name: string }>; nextPageToken?: string };
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const listing = { items };

  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (input.months ?? 24), 1));
  const files = (listing.items ?? [])
    .map((item) => ({ name: item.name, match: REPORT_PATTERN.exec(item.name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => Boolean(item.match))
    .filter((item) => new Date(Date.UTC(Number(item.match[2]), Number(item.match[3]) - 1, 1)) >= oldest)
    .sort((left, right) => left.name.localeCompare(right.name));

  let upserted = 0;
  const days = new Set<string>();
  for (const file of files) {
    const download = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(app.play_reports_bucket)}/o/${encodeURIComponent(file.name)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!download.ok) throw await upstreamError("Google Cloud Storage", download);
    const parsed = parseReviewCsv({
      content: Buffer.from(await download.arrayBuffer()).toString("base64"),
      encoding: "base64",
      platform: "android",
      fileName: file.name,
    });
    const year = Number(file.match[2]);
    const month = Number(file.match[3]);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));
    const monthComplete = monthEnd < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const written = await withScope(deps.pool, SYSTEM, async (client) => {
      const result = await upsertReviews(client, { tenantId: app.tenant_id, appId: app.id, source: "report", reviews: parsed.reviews });
      await recordCoverage(client, {
        tenantId: app.tenant_id,
        appId: app.id,
        store: "google_play",
        days: daysBetween(monthStart, monthComplete ? monthEnd : now),
        status: monthComplete ? "complete" : "partial",
        source: "play_reports",
      });
      return result;
    });
    upserted += written.upserted;
    written.days.forEach((day) => days.add(day));
  }

  return { files: files.length, upserted, days: [...days].sort() };
}

export function createUploadsStorage(config: { UPLOADS_BUCKET?: string; AWS_REGION?: string }): ObjectStorage | undefined {
  if (!config.UPLOADS_BUCKET) return undefined;
  return new S3ObjectStorage(new S3Client({ region: config.AWS_REGION }), config.UPLOADS_BUCKET);
}
