import { SYSTEM, withScope, type Pool } from "@/server/db/pool";
import { metrics } from "@/server/metrics";

/** Refreshes fleet-wide gauges used by the SLO alerts (runs every 5 minutes). */
export async function refreshGauges(pool: Pool): Promise<void> {
  await withScope(pool, SYSTEM, async (client) => {
    const connections = await client.query<{ store: string; status: string; count: number; stale: number }>(
      `select store, status, count(*)::int as count,
         count(*) filter (where status = 'active' and (last_synced_at is null or last_synced_at < now() - interval '6 hours'))::int as stale
       from store_connection group by store, status`,
    );
    metrics.connections.reset();
    metrics.connectionsStale.reset();
    const stale = new Map<string, number>();
    for (const row of connections.rows) {
      metrics.connections.set({ store: row.store, status: row.status }, row.count);
      stale.set(row.store, (stale.get(row.store) ?? 0) + row.stale);
    }
    for (const store of ["google_play", "apple_app_store"]) {
      metrics.connectionsStale.set({ store }, stale.get(store) ?? 0);
    }

    const coverage = await client.query<{ status: string; count: number }>(
      `select status, count(*)::int as count from coverage_day
       where day >= (now() at time zone 'UTC')::date - 30 group by status`,
    );
    metrics.coverageDays.reset();
    for (const status of ["complete", "partial"]) {
      metrics.coverageDays.set({ status }, coverage.rows.find((row) => row.status === status)?.count ?? 0);
    }
  });
}
