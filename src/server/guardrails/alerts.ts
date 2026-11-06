import { createHmac } from "node:crypto";

import type { GuardrailMetricResult } from "@/server/api/contracts";
import type { Client } from "@/server/db/pool";
import { metrics } from "@/server/metrics";

export interface AlertTarget {
  url?: string;
  secret?: string;
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Delivers one alert to Loomit's notification webhook. The body is signed
 * with HMAC-SHA256 over "<timestamp>.<body>" so Loomit can verify origin and
 * reject replays. Throws on failure so the job queue retries with backoff.
 */
export async function deliverAlert(
  client: Client,
  alertId: string,
  target: AlertTarget,
  now: () => Date = () => new Date(),
): Promise<"delivered" | "skipped"> {
  const { rows } = await client.query<{
    id: string; metric: string; status: string; created_at: Date; delivered_at: Date | null;
    loomit_experiment_id: string; experiment_name: string; loomit_publisher_id: string;
    attribution_mode: string; results: GuardrailMetricResult[]; evaluated_at: Date;
  }>(
    `select a.id, a.metric, a.status, a.created_at, a.delivered_at, e.loomit_experiment_id,
       e.name as experiment_name, t.loomit_publisher_id, e.attribution_mode, g.results, g.evaluated_at
     from alert a
     join experiment e on e.id = a.experiment_id
     join tenant t on t.id = a.tenant_id
     join guardrail_evaluation g on g.id = a.evaluation_id
     where a.id = $1`,
    [alertId],
  );
  const alert = rows[0];
  if (!alert || alert.delivered_at) return "skipped";
  if (!target.url || !target.secret) {
    metrics.alertDeliveries.inc({ outcome: "not_configured" });
    return "skipped";
  }

  const result = alert.results.find((item) => item.metric === alert.metric);
  const body = JSON.stringify({
    type: "reviewsignal.guardrail_alert",
    alertId: alert.id,
    loomitPublisherId: alert.loomit_publisher_id,
    loomitExperimentId: alert.loomit_experiment_id,
    experimentName: alert.experiment_name,
    metric: alert.metric,
    metricLabel: result?.label ?? alert.metric,
    status: alert.status,
    delta: result?.delta ?? null,
    pValue: result?.pValue ?? null,
    attributionMode: alert.attribution_mode,
    evaluatedAt: alert.evaluated_at.toISOString(),
  });
  const timestamp = String(Math.floor(now().getTime() / 1000));

  let error: string | null = null;
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ReviewSignal-Timestamp": timestamp,
        "X-ReviewSignal-Signature": signPayload(target.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) error = `Loomit notification endpoint returned HTTP ${response.status}.`;
    await response.body?.cancel();
  } catch (caught) {
    error = `Loomit notification request failed: ${caught instanceof Error ? caught.message : String(caught)}`;
  }

  await client.query(
    `update alert set delivery_attempts = delivery_attempts + 1, last_delivery_error = $2,
       delivered_at = case when $2::text is null then now() else delivered_at end
     where id = $1`,
    [alertId, error],
  );
  metrics.alertDeliveries.inc({ outcome: error ? "failed" : "delivered" });
  if (error) throw new Error(error);
  return "delivered";
}
