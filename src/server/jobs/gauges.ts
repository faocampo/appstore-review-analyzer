import type { PgBoss } from "pg-boss";

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

/** Sets reviewsignal_queue_depth from pg-boss queue statistics. */
export async function refreshQueueDepth(boss: Pick<PgBoss, "getQueues">): Promise<void> {
  const queues = await boss.getQueues();
  for (const queue of queues) {
    metrics.queueDepth.set({ queue: queue.name }, queue.queuedCount ?? 0);
  }
}

/**
 * Refreshes fleet gauges on a timer in every worker replica, so each
 * replica exports current values (a single scheduled job would leave the
 * other replicas exporting stale ones). Returns a stop function.
 */
export function startGaugeLoop(
  pool: Pool,
  boss: Pick<PgBoss, "getQueues">,
  intervalMs = 60_000,
): () => void {
  const tick = () =>
    Promise.all([refreshGauges(pool), refreshQueueDepth(boss)]).catch((error) =>
      console.error("[reviewsignal] gauge refresh failed", error),
    );
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
