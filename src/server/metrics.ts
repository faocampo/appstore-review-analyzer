import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** One registry per process; metric names are part of docs/service-contract.md and the alert rules. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "reviewsignal_process_" });

export const metrics = {
  httpRequests: new Counter({
    name: "reviewsignal_http_requests_total",
    help: "HTTP requests by route, method and status.",
    labelNames: ["route", "method", "status"] as const,
    registers: [registry],
  }),
  httpDuration: new Histogram({
    name: "reviewsignal_http_request_duration_seconds",
    help: "HTTP request duration.",
    labelNames: ["route", "method"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  ingestionRuns: new Counter({
    name: "reviewsignal_ingestion_runs_total",
    help: "Ingestion runs by store and outcome.",
    labelNames: ["store", "status"] as const,
    registers: [registry],
  }),
  ingestionPages: new Counter({
    name: "reviewsignal_ingestion_pages_total",
    help: "Store API pages fetched.",
    labelNames: ["store"] as const,
    registers: [registry],
  }),
  ingestionRateLimited: new Counter({
    name: "reviewsignal_ingestion_rate_limited_total",
    help: "Ingestion runs that ended on a 429 from the store.",
    labelNames: ["store"] as const,
    registers: [registry],
  }),
  connections: new Gauge({
    name: "reviewsignal_connections",
    help: "Store connections by status.",
    labelNames: ["store", "status"] as const,
    registers: [registry],
  }),
  connectionsStale: new Gauge({
    name: "reviewsignal_connections_stale",
    help: "Active connections not synced in the last 6 hours.",
    labelNames: ["store"] as const,
    registers: [registry],
  }),
  coverageDays: new Gauge({
    name: "reviewsignal_coverage_days",
    help: "Coverage days in the last 30 days across tenants, by status.",
    labelNames: ["status"] as const,
    registers: [registry],
  }),
  classifierRequests: new Counter({
    name: "reviewsignal_classifier_requests_total",
    help: "Reviews sent to the classifier, by provider and outcome.",
    labelNames: ["provider", "outcome"] as const,
    registers: [registry],
  }),
  classifierLatency: new Histogram({
    name: "reviewsignal_classifier_latency_seconds",
    help: "Classifier batch latency.",
    labelNames: ["provider"] as const,
    buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 40, 60],
    registers: [registry],
  }),
  classifierCost: new Counter({
    name: "reviewsignal_classifier_cost_usd_total",
    help: "Provider-reported classification cost in USD.",
    labelNames: ["provider"] as const,
    registers: [registry],
  }),
  budgetExhausted: new Counter({
    name: "reviewsignal_classifier_budget_exhausted_total",
    help: "Classification runs stopped because a tenant's daily budget was spent.",
    registers: [registry],
  }),
  jobs: new Counter({
    name: "reviewsignal_jobs_total",
    help: "Background jobs by queue and outcome.",
    labelNames: ["queue", "outcome"] as const,
    registers: [registry],
  }),
  queueDepth: new Gauge({
    name: "reviewsignal_queue_depth",
    help: "Queued jobs per queue.",
    labelNames: ["queue"] as const,
    registers: [registry],
  }),
  guardrailEvaluations: new Counter({
    name: "reviewsignal_guardrail_evaluations_total",
    help: "Guardrail evaluations by overall status.",
    labelNames: ["status"] as const,
    registers: [registry],
  }),
  alertDeliveries: new Counter({
    name: "reviewsignal_alert_deliveries_total",
    help: "Alert webhook deliveries by outcome.",
    labelNames: ["outcome"] as const,
    registers: [registry],
  }),
};
