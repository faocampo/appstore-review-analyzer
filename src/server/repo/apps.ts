import type { AppDto, ConnectionDto, ConnectionStatus, CreateAppRequest } from "@/server/api/contracts";
import type { Client } from "@/server/db/pool";
import type { Store } from "@/lib/types";

export interface AppRow {
  id: string;
  tenant_id: string;
  loomit_app_id: string;
  name: string;
  android_package: string | null;
  apple_app_id: string | null;
  play_reports_bucket: string | null;
}

export interface ConnectionRow {
  id: string;
  tenant_id: string;
  app_id: string;
  store: Store;
  secret_ref: string | null;
  status: ConnectionStatus;
  last_verified_at: Date | null;
  last_synced_at: Date | null;
  last_error: string | null;
  watermark: Date | null;
  backfilled_at: Date | null;
}

const APP_COLUMNS =
  "id, tenant_id, loomit_app_id, name, android_package, apple_app_id, play_reports_bucket";
const CONNECTION_COLUMNS =
  "id, tenant_id, app_id, store, secret_ref, status, last_verified_at, last_synced_at, last_error, watermark, backfilled_at";

export async function upsertApp(
  client: Client,
  tenantId: string,
  input: CreateAppRequest,
): Promise<AppRow> {
  const { rows } = await client.query<AppRow>(
    `insert into app (tenant_id, loomit_app_id, name, android_package, apple_app_id, play_reports_bucket)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, loomit_app_id) do update set
       name = excluded.name, android_package = excluded.android_package,
       apple_app_id = excluded.apple_app_id, play_reports_bucket = excluded.play_reports_bucket
     returning ${APP_COLUMNS}`,
    [
      tenantId,
      input.loomitAppId,
      input.name,
      input.androidPackage ?? null,
      input.appleAppId ?? null,
      input.playReportsBucket ?? null,
    ],
  );
  return rows[0];
}

export async function listApps(client: Client): Promise<AppRow[]> {
  const { rows } = await client.query<AppRow>(`select ${APP_COLUMNS} from app order by name`);
  return rows;
}

export async function getApp(client: Client, appId: string): Promise<AppRow | null> {
  if (!isUuid(appId)) return null;
  const { rows } = await client.query<AppRow>(`select ${APP_COLUMNS} from app where id = $1`, [appId]);
  return rows[0] ?? null;
}

export async function getAppByLoomitId(client: Client, loomitAppId: string): Promise<AppRow | null> {
  const { rows } = await client.query<AppRow>(
    `select ${APP_COLUMNS} from app where loomit_app_id = $1`,
    [loomitAppId],
  );
  return rows[0] ?? null;
}

export async function listConnections(client: Client, appIds?: string[]): Promise<ConnectionRow[]> {
  const { rows } = await client.query<ConnectionRow>(
    appIds
      ? `select ${CONNECTION_COLUMNS} from store_connection where app_id = any($1::uuid[]) order by store`
      : `select ${CONNECTION_COLUMNS} from store_connection order by store`,
    appIds ? [appIds] : [],
  );
  return rows;
}

export async function getConnection(client: Client, connectionId: string): Promise<ConnectionRow | null> {
  const { rows } = await client.query<ConnectionRow>(
    `select ${CONNECTION_COLUMNS} from store_connection where id = $1`,
    [connectionId],
  );
  return rows[0] ?? null;
}

export async function upsertConnection(
  client: Client,
  input: { tenantId: string; appId: string; store: Store; secretRef: string },
): Promise<ConnectionRow> {
  const { rows } = await client.query<ConnectionRow>(
    `insert into store_connection (tenant_id, app_id, store, secret_ref, status)
     values ($1, $2, $3, $4, 'pending')
     on conflict (app_id, store) do update set secret_ref = excluded.secret_ref,
       status = 'pending', last_error = null
     returning ${CONNECTION_COLUMNS}`,
    [input.tenantId, input.appId, input.store, input.secretRef],
  );
  return rows[0];
}

export async function markConnection(
  client: Client,
  connectionId: string,
  update: { status: ConnectionStatus; error?: string | null; verified?: boolean; synced?: boolean; watermark?: Date | null; backfilled?: boolean },
): Promise<void> {
  await client.query(
    `update store_connection set
       status = $2,
       last_error = $3,
       last_verified_at = case when $4 then now() else last_verified_at end,
       last_synced_at = case when $5 then now() else last_synced_at end,
       watermark = coalesce($6, watermark),
       backfilled_at = case when $7 then now() else backfilled_at end
     where id = $1`,
    [
      connectionId,
      update.status,
      update.error ?? null,
      update.verified ?? false,
      update.synced ?? false,
      update.watermark ?? null,
      update.backfilled ?? false,
    ],
  );
}

export function toConnectionDto(row: ConnectionRow): ConnectionDto {
  return {
    store: row.store,
    status: row.status,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastError: row.last_error,
    watermark: row.watermark?.toISOString() ?? null,
  };
}

export function toAppDto(app: AppRow, connections: ConnectionRow[]): AppDto {
  return {
    id: app.id,
    loomitAppId: app.loomit_app_id,
    name: app.name,
    androidPackage: app.android_package,
    appleAppId: app.apple_app_id,
    playReportsBucket: app.play_reports_bucket,
    connections: connections.filter((row) => row.app_id === app.id).map(toConnectionDto),
  };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
