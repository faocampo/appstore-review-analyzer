import type { CoverageDayStatus } from "@/server/api/contracts";
import type { Client } from "@/server/db/pool";

/** UTC calendar days from `from` to `to`, inclusive, as YYYY-MM-DD. */
export function daysBetween(from: Date | string, to: Date | string): string[] {
  const start = new Date(typeof from === "string" ? `${from.slice(0, 10)}T00:00:00Z` : from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(typeof to === "string" ? `${to.slice(0, 10)}T00:00:00Z` : to);
  end.setUTCHours(0, 0, 0, 0);
  const days: string[] = [];
  for (let day = start; day <= end; day = new Date(day.getTime() + 86_400_000)) {
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Records coverage. A day never moves down in quality: once a day is known
 * complete, a later truncated run does not mark it partial.
 */
export async function recordCoverage(
  client: Client,
  input: { tenantId: string; appId: string; store: string; days: string[]; status: Exclude<CoverageDayStatus, "unknown">; source: string },
): Promise<void> {
  if (!input.days.length) return;
  await client.query(
    `insert into coverage_day (tenant_id, app_id, store, day, status, source)
     select $1, $2, $3, d::date, $5, $6 from unnest($4::text[]) as d
     on conflict (app_id, store, day) do update set
       status = case when coverage_day.status = 'complete' then 'complete' else excluded.status end,
       source = case when coverage_day.status = 'complete' then coverage_day.source else excluded.source end,
       updated_at = now()`,
    [input.tenantId, input.appId, input.store, input.days, input.status, input.source],
  );
}

export async function coverageDays(
  client: Client,
  appId: string,
  from: string,
  to: string,
): Promise<Array<{ day: string; store: string; status: CoverageDayStatus }>> {
  const { rows } = await client.query<{ day: string; store: string; status: CoverageDayStatus }>(
    `select to_char(day, 'YYYY-MM-DD') as day, store, status from coverage_day
     where app_id = $1 and day between $2::date and $3::date order by day, store`,
    [appId, from, to],
  );
  return rows;
}
