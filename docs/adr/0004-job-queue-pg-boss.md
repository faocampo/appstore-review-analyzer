# ADR 0004: Background jobs on Postgres with pg-boss

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** ReviewSignal developer, Loomit platform engineer
- **Related:** productization plan §2; `src/server/jobs/queue.ts`

## Context

The worker runs scheduled and on-demand work: incremental store syncs every
1–3 hours, Play report and CSV imports, classification batches, daily
rollups, hourly guardrail evaluation, alert delivery with retries, the S3
export, gauge refreshes and retention. Requirements:

- Jobs must be created atomically with the data that triggers them (a new
  connection enqueues its first sync; an experiment link enqueues an
  evaluation).
- Retries with backoff, singleton schedules across replicas, and safe
  operation with 1–N worker replicas.
- No new infrastructure to operate for a team of one developer.
- Expected volume is modest: thousands to low hundreds of thousands of jobs
  per day across all tenants.

Options considered: BullMQ (Redis), Amazon SQS plus a scheduler
(EventBridge), and pg-boss (Postgres).

## Decision

Use **pg-boss** on the service's existing Postgres database.

- Queues: `sync`, `schedule-syncs`, `classify`, `rollup`, `import-upload`,
  `import-play-reports`, `evaluate`, `schedule-evaluations`, `deliver-alert`,
  `export`, `refresh-gauges`, `retention`.
- Schedules (`boss.schedule`) for fan-out jobs: `SYNC_CRON` (default every
  2 h), `EVALUATE_CRON` (hourly), `EXPORT_CRON` (daily), gauges every 5
  minutes, retention daily. pg-boss runs each schedule once across all
  workers.
- pg-boss keeps its tables in its own `pgboss` schema, created at worker
  start-up. Application migrations stay separate (`dist/server/migrate.js`).
- Workers stop gracefully on SIGTERM (`boss.stop({ graceful: true })`), within
  the pod's termination grace period.

## Consequences

**Positive**

- Enqueuing in the same transaction as the data write: no lost or orphaned jobs.
- No Redis or SQS to provision, secure, monitor or pay for; backups and
  encryption come with RDS.
- Job state is queryable with SQL during incidents.

**Negative and mitigations**

- Queue load shares the database with the API. Mitigation: pg-boss
  maintenance removes finished jobs after their retention, keeping tables small; queue depth and job outcomes
  are exported (`reviewsignal_queue_depth`, `reviewsignal_jobs_total`) and
  alerted on; RDS sizing is part of the load test.
- Throughput ceiling: far above expected volume. Revisit above about 10
  million jobs per day or if job polling shows up in RDS load (plan §2).
- Polling latency of a few seconds; acceptable for background work.
- Coupled to Postgres availability, like the rest of the service.

**Operational notes**

- Fleet-wide gauges are refreshed by one `refresh-gauges` job at a time, on
  whichever worker picks it up. With several worker replicas, the values
  exported by the other replicas would be stale; the server must either
  refresh them in every replica or export them from one place only. The alert
  rules take `max()` across pods, which is correct only when every exporting
  replica holds current values (see the header of
  [`deploy/prometheus/alerts.yaml`](../../deploy/prometheus/alerts.yaml)).
