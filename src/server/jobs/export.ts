import { parquetWriteBuffer } from "hyparquet-writer";

import { SYSTEM, withScope, type Pool } from "@/server/db/pool";
import type { ObjectStorage } from "@/server/ingestion/imports";

/**
 * Daily export of the previous UTC day's rollups (aggregates only, no review
 * text) as Parquet, partitioned by day, so Databricks/Druid can join review
 * signals with ARPDAU, IMPDAU and DAU without coupling to this service.
 */
export async function exportRollups(
  pool: Pool,
  storage: ObjectStorage,
  now: Date,
): Promise<{ key: string; rows: number }> {
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const { rows } = await withScope(pool, SYSTEM, (client) =>
    client.query<{
      loomit_publisher_id: string; loomit_app_id: string; store: string; app_version: string; territory: string;
      model_version: string; n: number; sum_ev: number; sum_rating: number; negative: number; neutral: number;
      positive: number; ads_negative: number; negative_reason_counts: object; ad_subreason_counts: object;
    }>(
      `select t.loomit_publisher_id, a.loomit_app_id, r.store, r.app_version, r.territory, r.model_version,
         r.n, r.sum_ev, r.sum_rating, r.negative, r.neutral, r.positive, r.ads_negative,
         r.negative_reason_counts, r.ad_subreason_counts
       from review_daily_rollup r join app a on a.id = r.app_id join tenant t on t.id = r.tenant_id
       where r.day = $1::date order by t.loomit_publisher_id, a.loomit_app_id`,
      [day],
    ),
  );

  const column = <K extends keyof (typeof rows)[number]>(key: K) => rows.map((row) => row[key]);
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: "day", data: rows.map(() => day), type: "STRING" },
      { name: "loomit_publisher_id", data: column("loomit_publisher_id"), type: "STRING" },
      { name: "loomit_app_id", data: column("loomit_app_id"), type: "STRING" },
      { name: "store", data: column("store"), type: "STRING" },
      { name: "app_version", data: column("app_version"), type: "STRING" },
      { name: "territory", data: column("territory"), type: "STRING" },
      { name: "model_version", data: column("model_version"), type: "STRING" },
      { name: "reviews", data: column("n"), type: "INT32" },
      { name: "sum_sentiment_ev", data: column("sum_ev").map(Number), type: "DOUBLE" },
      { name: "sum_rating", data: column("sum_rating").map(Number), type: "DOUBLE" },
      { name: "negative", data: column("negative"), type: "INT32" },
      { name: "neutral", data: column("neutral"), type: "INT32" },
      { name: "positive", data: column("positive"), type: "INT32" },
      { name: "ads_negative", data: column("ads_negative"), type: "INT32" },
      { name: "negative_reason_counts", data: column("negative_reason_counts").map((value) => JSON.stringify(value)), type: "JSON" },
      { name: "ad_subreason_counts", data: column("ad_subreason_counts").map((value) => JSON.stringify(value)), type: "JSON" },
    ],
  });

  const key = `rollups/day=${day}/rollups.parquet`;
  await storage.put(key, new Uint8Array(buffer), "application/vnd.apache.parquet");
  return { key, rows: rows.length };
}
