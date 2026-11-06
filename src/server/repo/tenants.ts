import type { Client } from "@/server/db/pool";

export interface TenantRow {
  id: string;
  loomit_publisher_id: string;
  name: string;
  daily_budget_usd: string;
  retention_days: number;
}

/** Finds or provisions the tenant for a Loomit publisher (system scope). */
export async function ensureTenant(
  client: Client,
  loomitPublisherId: string,
  name?: string,
): Promise<TenantRow> {
  // Read first: this runs on every API request and must not write.
  const existing = await client.query<TenantRow>(
    "select id, loomit_publisher_id, name, daily_budget_usd, retention_days from tenant where loomit_publisher_id = $1",
    [loomitPublisherId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await client.query<TenantRow>(
    `insert into tenant (loomit_publisher_id, name) values ($1, $2)
     on conflict (loomit_publisher_id) do update set loomit_publisher_id = excluded.loomit_publisher_id
     returning id, loomit_publisher_id, name, daily_budget_usd, retention_days`,
    [loomitPublisherId, name ?? loomitPublisherId],
  );
  return rows[0];
}

export async function getTenant(client: Client, tenantId: string): Promise<TenantRow | null> {
  const { rows } = await client.query<TenantRow>(
    "select id, loomit_publisher_id, name, daily_budget_usd, retention_days from tenant where id = $1",
    [tenantId],
  );
  return rows[0] ?? null;
}

export async function audit(
  client: Client,
  entry: { tenantId: string | null; actor: string; action: string; target?: string; details?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    "insert into audit_log (tenant_id, actor, action, target, details) values ($1, $2, $3, $4, $5)",
    [entry.tenantId, entry.actor, entry.action, entry.target ?? null, entry.details ?? {}],
  );
}
