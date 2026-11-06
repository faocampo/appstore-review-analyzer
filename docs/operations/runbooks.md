# ReviewSignal runbooks

One section per alert in [`deploy/prometheus/alerts.yaml`](../../deploy/prometheus/alerts.yaml).
Each alert's `runbook_url` points at the section with its name. SLO
definitions are in [`slo.md`](slo.md); the runtime contract (processes, ports,
variables) is in [`../service-contract.md`](../service-contract.md).

Contents: [Conventions](#conventions) · [Common procedures](#common-procedures) ·
API: [FastBurn](#reviewsignalapiavailabilityfastburn), [SlowBurn](#reviewsignalapiavailabilityslowburn),
[LatencyHigh](#reviewsignalapilatencyhigh), [ClientRateLimited](#reviewsignalapiclientratelimited),
[ApiDown](#reviewsignalapidown) ·
Ingestion: [IngestionStale](#reviewsignalingestionstale), [IngestionStalled](#reviewsignalingestionstalled),
[IngestionRunsFailing](#reviewsignalingestionrunsfailing), [StoreRateLimited](#reviewsignalstoreratelimited),
[ConnectionsInError](#reviewsignalconnectionsinerror), [CoverageDegraded](#reviewsignalcoveragedegraded) ·
Classifier: [FailureRateHigh](#reviewsignalclassifierfailureratehigh), [LatencyHigh](#reviewsignalclassifierlatencyhigh),
[BudgetExhausted](#reviewsignalclassifierbudgetexhausted) ·
Jobs: [QueueBacklog](#reviewsignalqueuebacklog), [JobsFailing](#reviewsignaljobsfailing),
[WorkerDown](#reviewsignalworkerdown), [MigrationFailed](#reviewsignalmigrationfailed) ·
Guardrails: [AlertDeliveryFailing](#reviewsignalalertdeliveryfailing), [GuardrailBreachRateHigh](#reviewsignalguardrailbreachratehigh)

## Conventions

**Severity.** `critical` pages the ReviewSignal on-call. `warning` opens a
ticket for the next business day. `info` is dashboard-only. Three alerts
(`ReviewSignalIngestionStale`, `ReviewSignalClassifierFailureRateHigh`,
`ReviewSignalAlertDeliveryFailing`) exist at both `warning` and `critical`;
configure Alertmanager to inhibit the warning while the critical fires.
*Assumption:* paging routes and on-call hours are agreed with Loomit
operations before GA (see [`ga-checklist.md`](ga-checklist.md)).

**Roles used for escalation.**

| Role | Owns |
| --- | --- |
| ReviewSignal on-call | The service, its code, alerts and runbooks |
| Loomit platform on-call | EKS, Istio, Argo CD, External Secrets, RDS, Prometheus |
| Loomit identity/console team | OIDC issuer, console gateway, console embedding |
| Loomit backend team | Experiment linking, readout, notification webhook |
| X3M CSM | Communication with affected publishers |
| Security | Credential exposure, suspected data access across tenants |

**Environment.** Namespace `reviewsignal` in the staging and production EKS
clusters. Deployments `reviewsignal-api` and `reviewsignal-worker`;
migrations job `reviewsignal-migrate`. Every alert carries a `namespace`
label. Queries below run in the cluster's Prometheus or Grafana Explore; add
`{namespace="reviewsignal"}` where several environments share one Prometheus.

*Dashboards:* a Grafana dashboard is a GA checklist item. Until it exists,
use the queries listed in each section.

## Common procedures

**Logs.**

```bash
kubectl -n reviewsignal logs deploy/reviewsignal-api --since=30m
kubectl -n reviewsignal logs deploy/reviewsignal-worker --since=30m
kubectl -n reviewsignal logs job/reviewsignal-migrate
```

Upstream error bodies (stores, classifier providers) are logged server-side
only; search the logs, not API responses.

**Roll back a release.** Production: in Argo CD, open
`reviewsignal-production` → History and rollback, or revert the image-tag
commit in `values-production.yaml` and sync. Staging self-heals to `main`, so
revert the commit. A rollback across a schema migration is only safe when the
migration was backward-compatible (expand/contract); check the migration
before rolling back.

**Restart.** `kubectl -n reviewsignal rollout restart deploy/reviewsignal-worker`
(or `-api`). The worker drains in-flight jobs for up to
`terminationGracePeriodSeconds` (120 s); pg-boss retries interrupted jobs.

**Database access.** Use the approved Loomit path to RDS (bastion or SSM),
read-only unless the step says otherwise. Connect as an operator role, not as
the service role. Tables are defined in `src/server/db/migrations/`
(overview in [productization plan §2](../productization-plan.md#data-model-postgres)).
Queries across tenants need `SET app.bypass_rls = 'on'` in the session; every
such session must be noted in the incident ticket.

**Job queues (pg-boss).** Queues: `sync`, `schedule-syncs`, `classify`,
`rollup`, `import-upload`, `import-play-reports`, `evaluate`,
`schedule-evaluations`, `deliver-alert`, `export`, `refresh-gauges`,
`retention`. The fleet gauges (connections, staleness, coverage) are
refreshed by the `refresh-gauges` job every 5 minutes.

```sql
SELECT name, state, count(*) FROM pgboss.job GROUP BY 1, 2 ORDER BY 1, 2;
```

**Secrets.** Runtime secrets come from Secrets Manager
(`reviewsignal-runtime/<environment>`) through External Secrets. Force a
refresh after rotating one:

```bash
kubectl -n reviewsignal annotate externalsecret reviewsignal-env force-sync="$(date +%s)" --overwrite
kubectl -n reviewsignal rollout restart deploy/reviewsignal-api deploy/reviewsignal-worker
```

---

## ReviewSignalApiAvailabilityFastBurn

**Severity:** critical. **SLO:** API availability 99.5%.

**Symptoms.** More than 7.2% of `/v1` responses are 5xx over the last hour
(14.4× burn), or more than 3% over 6 hours (6×). The panel and the experiment
readout show errors; the Loomit backend may get failures linking experiments.

**Queries.**

- `reviewsignal:api_v1_error_ratio:rate5m`
- `sum by (route, status) (rate(reviewsignal_http_requests_total{route=~"/v1/.*", status=~"5.."}[5m]))`
- `kube_deployment_status_replicas_available{deployment="reviewsignal-api"}`
- RDS CPU, connections and storage in CloudWatch.

**Likely causes.**

1. Postgres unreachable or saturated (connections exhausted, failover in progress).
2. A bad release: errors start with a new image tag.
3. A schema mismatch after a failed or skipped migration.
4. OIDC JWKS endpoint unreachable, making token validation fail with 5xx instead of 401.
5. One route failing on specific data (a single route dominates the 5xx breakdown).

**Steps.**

1. Find which routes fail (second query). One route points to a code or data
   bug; all routes point to a dependency.
2. Check `kubectl -n reviewsignal get pods` and recent events. Pods failing
   `/readyz` mean Postgres is unreachable or migrations are behind.
3. Compare the start of the errors with the last Argo CD sync. If they line
   up, roll back (see [Common procedures](#common-procedures)).
4. Check RDS: connections near `max_connections` means too many pods ×
   `DATABASE_POOL_MAX`. Lower the HPA maximum or the pool size, or scale the
   instance.
5. Check the logs for upstream errors from the identity provider.

**Escalation.** Loomit platform on-call for RDS, Istio or cluster problems.
Loomit identity team for JWKS/issuer outages. X3M CSM if publishers report
errors for more than 30 minutes.

## ReviewSignalApiAvailabilitySlowBurn

**Severity:** warning. **SLO:** API availability 99.5%.

**Symptoms.** A sustained 5xx ratio above 1.5% over a day, or above 0.5% over
3 days. At this pace the 30-day error budget runs out before the window ends.

**Queries.** Same as [FastBurn](#reviewsignalapiavailabilityfastburn), over
`[1d]` and `[3d]`; also `reviewsignal:api_v1_error_ratio:rate1d`.

**Likely causes.** An intermittent dependency failure (RDS failovers,
connection resets), a route that fails for some tenants' data, timeouts on
heavy queries (wide date ranges without rollups), or pods killed for memory.

**Steps.**

1. Break errors down by route and status over 1 day; look for one dominant route.
2. Check for `OOMKilled` restarts: `kubectl -n reviewsignal get pods` and
   `kube_pod_container_status_last_terminated_reason`.
3. Correlate with RDS events (failover, maintenance).
4. File a ticket with the breakdown; fix in the next release. Apply the error
   budget policy in [`slo.md`](slo.md#error-budget-policy) if the budget is
   below 25%.

**Escalation.** ReviewSignal on-call (business hours).

## ReviewSignalApiLatencyHigh

**Severity:** warning. **SLO:** p95 of `/v1` reads below 500 ms.

**Symptoms.** p95 latency of `GET /v1/*` (admin excluded) above 500 ms for 15
minutes. The panel feels slow.

**Queries.**

- `reviewsignal:api_v1_read_latency_seconds:p95_5m_by_route`
- `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="reviewsignal", container="api"}[5m]))`
- `kube_horizontalpodautoscaler_status_current_replicas{horizontalpodautoscaler="reviewsignal-api"}`
- RDS read latency, CPU and `DatabaseConnections` in CloudWatch; Performance Insights top SQL.

**Likely causes.**

1. A query reading raw reviews instead of rollups, or a missing index, usually
   on `/reviews` with wide ranges or filters.
2. CPU saturation with the HPA at its maximum.
3. Pool exhaustion: requests wait for a connection (`DATABASE_POOL_MAX`).
4. RDS under load from a backfill or reclassification job running at the same time.

**Steps.**

1. Identify the slow route.
2. If the HPA is at `maxReplicas` and CPU is high, raise `api.autoscaling.maxReplicas`
   in the values file (check RDS connections first).
3. If RDS is the bottleneck, find the top statements in Performance Insights.
   Pause heavy batch work if one is running (backfill, reclassification) and
   resume it off-peak.
4. File a ticket for the query or index fix.

**Escalation.** Loomit platform on-call for RDS capacity.

## ReviewSignalApiClientRateLimited

**Severity:** warning.

**Symptoms.** More than 5% of `/v1` requests return 429 for 15 minutes.

**Queries.**

- `sum by (route) (rate(reviewsignal_http_requests_total{status="429"}[5m]))`
- API logs filtered on 429 to find the tenant or client.

**Likely causes.**

1. A client in a retry loop (console bug, Loomit backend retrying without backoff).
2. A load test against the environment.
3. Per-tenant limits set too low for a large publisher.

**Steps.**

1. Find the tenant or client identity in the logs.
2. Load test: confirm with whoever runs it; no action.
3. Retry loop: contact the owning team (Loomit console or backend) with the
   route and timestamps.
4. Legitimate traffic: raise that tenant's limit and record the change.

**Escalation.** Loomit identity/console team or Loomit backend team,
depending on the caller.

## ReviewSignalApiDown

**Severity:** critical.

**Symptoms.** Prometheus cannot scrape any API pod for 5 minutes. The API is
probably unavailable, and availability SLO alerts cannot fire because no
metrics arrive.

**Queries.**

- `up{job="reviewsignal-api"}`
- `kubectl -n reviewsignal get deploy,pods -l app.kubernetes.io/component=api`
- `kubectl -n reviewsignal describe pod <pod>`

**Likely causes.**

1. Pods crash-looping: bad configuration (a missing secret key, an invalid
   `OIDC_*` value) or a startup bug.
2. Image pull failure (wrong tag, ECR permissions).
3. The External Secrets sync failed, so the `reviewsignal-env` Secret is missing.
4. Scraping broken while the API still serves traffic: Istio certificates for
   Prometheus, or the AuthorizationPolicy no longer allowing the Prometheus
   principal. Check with the console: is the panel working?

**Steps.**

1. `kubectl get pods`: `CrashLoopBackOff` → read the previous container's logs
   (`kubectl logs --previous`). `CreateContainerConfigError` → check
   `kubectl get externalsecret` status. `ImagePullBackOff` → check the tag.
2. If the latest sync caused it, roll back.
3. If only scraping is broken, fix the ServiceMonitor or policy and lower the
   priority; the SLO is unaffected.

**Escalation.** Loomit platform on-call for ESO, Istio or ECR.

## ReviewSignalIngestionStale

**Severity:** warning below 98%, critical below 95%. **SLO:** ingestion freshness.

**Symptoms.** Fewer than 95% (critical) or 98% (warning) of active store
connections completed a sync in the last 6 hours. Panels show older data;
guardrail evaluations use stale reviews.

**Queries.**

- `reviewsignal:ingestion_freshness:ratio`
- `max by (store) (reviewsignal_connections_stale)`
- `sum by (store, status) (rate(reviewsignal_ingestion_runs_total[1h]))`
- `max by (queue) (reviewsignal_queue_depth)`

**Likely causes.**

1. The worker is down or the sync queue is backed up (see
   [WorkerDown](#reviewsignalworkerdown), [QueueBacklog](#reviewsignalqueuebacklog)).
2. One store failing for everyone (API outage, 429s): stale connections
   concentrate on one `store`.
3. Many connections with revoked credentials still marked active.
4. The sync schedule (`SYNC_CRON`) changed or stopped.

**Steps.**

1. Check which store is stale. One store → check its status page and
   [IngestionRunsFailing](#reviewsignalingestionrunsfailing) /
   [StoreRateLimited](#reviewsignalstoreratelimited).
2. Both stores → check worker health and queue depth.
3. List the stale connections (DB, `store_connection` joined with the last
   `ingestion_run`) to see whether a few large tenants or many small ones are
   affected.
4. Once the cause is fixed, syncs catch up on the next schedule. The Google
   Play API only returns about 7 days of reviews: an outage longer than that
   leaves gaps that only the Play reports bucket or a CSV import can fill.
   Days affected are marked `partial`, never shown as complete.

**Escalation.** X3M CSM if the outage exceeds 24 hours for a publisher (their
panel shows stale data). Loomit platform on-call for infrastructure causes.

## ReviewSignalIngestionStalled

**Severity:** critical.

**Symptoms.** No ingestion run recorded in 4 hours while connections are
active. The sync schedule is not running.

**Queries.**

- `sum by (store, status) (increase(reviewsignal_ingestion_runs_total[4h]))`
- `up{job="reviewsignal-worker"}`
- `SELECT name, state, count(*) FROM pgboss.job WHERE name LIKE '%sync%' GROUP BY 1, 2;`

**Likely causes.**

1. The worker is running but pg-boss scheduling is stopped (lost connection,
   schedule removed, `SYNC_CRON` invalid).
2. Sync jobs are stuck `active` past their expiry.
3. All workers are restarting before they complete a run.

**Steps.**

1. Read worker logs for scheduler errors at startup.
2. Check the pg-boss schedule table (`pgboss.schedule`) contains the sync schedule.
3. Restart the worker; confirm a run starts (`reviewsignal_ingestion_runs_total` increases).
4. If `SYNC_CRON` was changed, revert it.

**Escalation.** ReviewSignal on-call.

## ReviewSignalIngestionRunsFailing

**Severity:** warning.

**Symptoms.** More than 20% of ingestion runs for one store fail over an hour.

**Queries.**

- `sum by (store, status) (rate(reviewsignal_ingestion_runs_total[1h]))`
- `SELECT status, error, count(*) FROM ingestion_run WHERE started_at > now() - interval '2 hours' GROUP BY 1, 2 ORDER BY 3 DESC;`
- Worker logs for the store's upstream errors.

**Likely causes.**

1. Store API outage or change (Google Play Developer API, App Store Connect API).
2. Credential problems spreading (keys revoked by publishers; the X3M Google
   service account disabled or its key rotated).
3. A parsing bug after a store response format change.
4. Secrets Manager or KMS permission errors when reading credentials.

**Steps.**

1. Group errors by message. One tenant → their credentials; many tenants →
   platform or store.
2. Store outage: check the Google Cloud and Apple developer status pages. Wait;
   runs retry on schedule.
3. `AccessDenied` from Secrets Manager or KMS: check the IRSA role policy and
   the key policy.
4. Parsing errors: capture a sample response from the logs (no review text in
   tickets), fix and release.

**Escalation.** Loomit platform on-call for IAM. Security if the X3M Google
service account key is suspected compromised.

## ReviewSignalStoreRateLimited

**Severity:** warning.

**Symptoms.** More than 10% of one store's ingestion runs ended on a 429
over 2 hours (at least 3 runs). Those connections fall behind until a later
run succeeds.

**Queries.**

- `sum by (store) (increase(reviewsignal_ingestion_rate_limited_total[2h]))`
- `sum by (store, status) (increase(reviewsignal_ingestion_runs_total[2h]))`
- `sum by (store) (increase(reviewsignal_ingestion_pages_total[2h]))` (load on the store)

**Likely causes.**

1. Backfills running alongside incremental syncs.
2. Too many concurrent syncs against one developer account (App Store Connect
   limits are per key; Google quotas are per Cloud project).
3. A retry loop that ignores `Retry-After`.
4. Google Play Developer API daily quota for the X3M Cloud project reached
   (all Google tenants share it).

**Steps.**

1. Pause or slow backfill jobs and let incremental syncs proceed.
2. Check that the worker honors `Retry-After` (logs show the delay).
3. Google: check quota usage for the Android Publisher API in the Google
   Cloud console of the X3M project; request a quota increase if needed.
4. Persistent: lower sync concurrency or lengthen `SYNC_CRON`, keeping the
   freshness SLO in mind.

**Escalation.** ReviewSignal on-call. The Google Cloud project owner for quota increases.

## ReviewSignalConnectionsInError

**Severity:** warning.

**Symptoms.** More than 10% of a store's connections have status `error` for 2 hours.

**Queries.**

- `max by (store, status) (reviewsignal_connections)`
- `SELECT s.store, s.last_error, count(*) FROM store_connection s WHERE s.status = 'error' GROUP BY 1, 2 ORDER BY 3 DESC;`

**Likely causes.**

1. Publishers revoked access (removed the X3M service account in Play Console,
   revoked the App Store Connect key).
2. An Apple key's role was downgraded below what reviews need.
3. A platform-side problem marking healthy connections as errors (same error
   for many tenants).

**Steps.**

1. Same error across many tenants → treat as platform-side; see
   [IngestionRunsFailing](#reviewsignalingestionrunsfailing).
2. Per-tenant errors → the connect screen already shows the publisher the
   status. Send the list of affected publishers to the X3M CSM with the
   onboarding instructions ([`../publisher/onboarding.md`](../publisher/onboarding.md)).

**Escalation.** X3M CSM.

## ReviewSignalCoverageDegraded

**Severity:** info. *The threshold (80%) is an initial value; calibrate it
with the coverage measured in M2.*

**Symptoms.** Fewer than 80% of connection-days in the last 30 days have
`complete` coverage. Panels show more `partial` or `unknown` days.

**Queries.**

- `max by (status) (reviewsignal_coverage_days)`
- `SELECT store, status, count(*) FROM coverage_day WHERE day > current_date - 30 GROUP BY 1, 2;`

**Likely causes.**

1. Expected: Google Play apps without a reports bucket have `unknown` coverage
   beyond the API's ~7-day window.
2. Truncated runs (page limits reached) marking days `partial`.
3. A past ingestion outage.

**Steps.** Compare with the previous week. A sudden drop follows an
incident: check truncation and failures. A slow drift usually means new
Google connections without history; the CSM can encourage publishers to add
the reports bucket.

**Escalation.** None; review weekly.

## ReviewSignalClassifierFailureRateHigh

**Severity:** warning above 10%, critical above 50% (at least 20 reviews in
15 minutes).

**Symptoms.** Reviews sent to a provider fail classification
(`reviewsignal_classifier_requests_total` counts reviews, by outcome
`ok`/`failed`). Failed reviews are stored as `unclassified`, excluded from
averages and counted in notices. They are retried on later runs.

**Queries.**

- `reviewsignal:classifier_failure_ratio:rate15m`
- `sum by (provider, outcome) (rate(reviewsignal_classifier_requests_total[15m]))`
- Worker logs for the provider's error bodies.

**Likely causes.**

1. Provider outage or degradation (OpenRouter or the upstream model provider).
2. The pinned `OPENROUTER_MODEL` unavailable among zero-data-retention
   providers (routing returns no eligible provider).
3. Invalid or exhausted API key (401/402).
4. Model output failing schema validation after a model or prompt change.
5. Timeouts (`CLASSIFIER_TIMEOUT_MS`) too low for the batch size.

**Steps.**

1. Read the dominant `outcome` and error messages.
2. 401/402: check the OpenRouter key and account credit; rotate the key in
   Secrets Manager and force an External Secrets refresh.
3. No eligible provider: confirm the model is still served with ZDR. Do not
   disable `OPENROUTER_ZDR` to restore service; that changes the data policy
   (Legal sign-off required). Switch to the configured fallback instead.
4. Validation errors after a change: roll back the model or prompt version.
5. If a fallback provider is configured (`CLASSIFIER_FALLBACK_PROVIDER`),
   confirm the circuit breaker opened and fallback traffic succeeds. Fallback
   classifications carry a different `model_version`; guardrails compare only
   within one `model_version`, so expect more `insufficient` results until the
   primary recovers.

**Escalation.** ReviewSignal on-call. OpenRouter support for provider-side
incidents.

## ReviewSignalClassifierLatencyHigh

**Severity:** warning. *Threshold (60 s p95 per request) is an initial value
for batched LLM calls; tune after M1 latency data.*

**Symptoms.** Classifier batches are slow (`reviewsignal_classifier_latency_seconds`
measures one batch call); classification lags behind ingestion.

**Queries.**

- `reviewsignal:classifier_latency_seconds:p95_15m`
- `max by (queue) (reviewsignal_queue_depth)` (classification queue)

**Likely causes.** Provider congestion, a larger `OPENROUTER_BATCH_SIZE`,
long reviews, or routing to a slower provider.

**Steps.** Check the provider status. If the classification queue grows,
reduce the batch size or raise `CLASSIFIER_CONCURRENCY` within budget. Note
that latency matters only through freshness of classified data, not through
the API.

**Escalation.** None unless it causes [QueueBacklog](#reviewsignalqueuebacklog).

## ReviewSignalClassifierBudgetExhausted

**Severity:** warning.

**Symptoms.** At least one tenant reached its daily classification budget.
New reviews for that tenant wait for the next budget window; their panel
shows the reviews as not yet classified.

**Queries.**

- `increase(reviewsignal_classifier_budget_exhausted_total[1h])`
- `reviewsignal:classifier_cost_usd:increase1d` and
  `reviewsignal:classifier_cost_usd_per_1k_reviews:1d`
- Admin tenant-health view (`/v1/admin/*`): spend today vs. budget per tenant.

**Likely causes.**

1. A backfill or reclassification for a large app.
2. A review spike (release, featuring, review bombing).
3. A budget set too low for the tenant's normal volume.
4. A cost regression: more tokens per review after a prompt or model change.

**Steps.**

1. Identify the tenant in the admin view.
2. Backfill or spike: usually no action; the backlog clears in the next windows.
3. Recurring: adjust the tenant's budget according to the packaging decision
   ([`../business/packaging-options.md`](../business/packaging-options.md)) and record it.
4. Cost regression: compare cost per 1,000 reviews before and after the change.

**Escalation.** X3M CSM if the publisher is affected for more than a day.

## ReviewSignalQueueBacklog

**Severity:** warning. *Threshold (1,000 jobs) is an initial value; tune per
queue.*

**Symptoms.** A queue has more than 1,000 jobs waiting and is not draining
for 30 minutes.

**Queries.**

- `max by (queue) (reviewsignal_queue_depth)`
- `sum by (queue, outcome) (rate(reviewsignal_jobs_total[15m]))`
- `SELECT name, state, count(*) FROM pgboss.job GROUP BY 1, 2;`

**Likely causes.**

1. Workers down or too few (`worker.replicas`).
2. A slow dependency: classifier latency, store 429s, slow database.
3. A large backfill or reclassification enqueued at once.
4. Jobs failing and retrying, inflating the queue.

**Steps.**

1. Check the queue and outcome breakdown. Failures → [JobsFailing](#reviewsignaljobsfailing).
2. No failures and a slow dependency → address it.
3. Healthy but slow → scale `worker.replicas` (pg-boss is safe with several
   workers). Watch RDS connections.
4. Expected backfill → note in the ticket and let it drain.

**Escalation.** ReviewSignal on-call.

## ReviewSignalJobsFailing

**Severity:** warning.

**Symptoms.** More than 10% of a queue's jobs fail over 30 minutes (at least 10 jobs).

**Queries.**

- `sum by (queue, outcome) (rate(reviewsignal_jobs_total[30m]))`
- `SELECT name, output FROM pgboss.job WHERE state = 'failed' ORDER BY completed_on DESC LIMIT 20;`

**Likely causes.** A code bug on specific data, a dependency outage (store,
classifier, Loomit webhook), or database errors (constraint violations,
deadlocks, statement timeouts).

**Steps.** Group the failure messages, identify the job type, and follow the
matching runbook (ingestion, classifier, delivery). For code bugs, fix and
release; pg-boss retries jobs within their retry limit, and jobs past it can
be re-enqueued after the fix.

**Escalation.** ReviewSignal on-call.

## ReviewSignalWorkerDown

**Severity:** critical.

**Symptoms.** No worker pod can be scraped for 10 minutes. Ingestion,
classification, rollups, guardrail evaluation and alert delivery are all
stopped. The API keeps serving existing data.

**Queries.**

- `up{job="reviewsignal-worker"}`
- `kubectl -n reviewsignal get pods -l app.kubernetes.io/component=worker`

**Likely causes.** The same as [ApiDown](#reviewsignalapidown): crash loop,
missing secret, image pull failure, or scraping broken. Also `OOMKilled` on
large batches.

**Steps.**

1. Follow the ApiDown steps for the worker.
2. `OOMKilled`: raise `worker.resources.limits.memory` and look for the job
   that loads too much at once.
3. After recovery, watch [IngestionStale](#reviewsignalingestionstale) and
   [QueueBacklog](#reviewsignalqueuebacklog) until they clear.

**Escalation.** Loomit platform on-call for cluster causes.

## ReviewSignalMigrationFailed

**Severity:** critical. Requires kube-state-metrics.

**Symptoms.** The `reviewsignal-migrate` job failed. The Argo CD sync stopped
at the PreSync hook: the previous API and worker versions keep running on the
previous schema, so service usually continues.

**Queries.**

- `kubectl -n reviewsignal logs job/reviewsignal-migrate`
- Argo CD → `reviewsignal-<env>` → sync status and hook events.

**Likely causes.**

1. Database unreachable from the job (it runs without an Istio sidecar;
   check security groups and the `reviewsignal-migrate` Secret).
2. A migration that fails on production data (constraint, long lock, timeout).
3. Advisory lock held by another migration run.
4. Insufficient privileges for DDL in the role used by the job.

**Steps.**

1. Read the job log. It stays until the next sync (hook delete policy
   `BeforeHookCreation`).
2. Transient (connection, lock): re-sync in Argo CD; the job is idempotent.
3. A failing migration: do not edit the database by hand to make it pass.
   Fix the migration in a new commit, test it against a production-sized
   staging snapshot, and sync again.
4. Partially applied migration: migrations run in transactions where possible;
   if one is not transactional (for example `CREATE INDEX CONCURRENTLY`),
   check its state before re-running.

**Escalation.** Loomit platform on-call for RDS access.

## ReviewSignalAlertDeliveryFailing

**Severity:** warning (3 or more failed or unconfigured deliveries in 30
minutes); critical (no successful delivery in an hour while some failed).

**Symptoms.** Guardrail notifications to the Loomit notification webhook
fail (`outcome="failed"`) or are skipped because no webhook is configured
(`outcome="not_configured"`). Publishers and X3M CSMs are not told about
breaches. The readout panel still shows the guardrail status.

**Queries.**

- `sum by (outcome) (increase(reviewsignal_alert_deliveries_total[1h]))`
- Worker logs for the webhook response status.

**Likely causes.**

1. Loomit notification service down or returning 5xx.
2. HMAC signature rejected: `LOOMIT_NOTIFY_SECRET` rotated on one side only.
3. `LOOMIT_NOTIFY_URL` missing (`not_configured`) or wrong after a Loomit change.
4. Mesh or egress policy blocking the call.

**Steps.**

1. Read the status codes. 401/403 → compare secrets with the Loomit backend
   team and rotate both together. 5xx → Loomit side. Connection errors →
   network or URL.
2. Failed deliveries are retried with deduplication and cool-down. After the
   fix, confirm the backlog drains and that no alert was dropped past its
   retry limit; send any dropped breach notifications manually to the CSM.

**Escalation.** Loomit backend team. X3M CSM for breaches that were not delivered.

## ReviewSignalGuardrailBreachRateHigh

**Severity:** info.

**Symptoms.** More than 30% of conclusive guardrail evaluations (excluding
`insufficient`) are breaches over 24 hours, with at least 20 evaluations.

**Queries.**

- `sum by (status) (increase(reviewsignal_guardrail_evaluations_total[1d]))`

**Likely causes.**

1. Thresholds too tight: the backtest false-positive rate (plan §3.4) is not
   holding in production.
2. A classifier or model change shifting sentiment between baseline and test
   windows. Guardrails compare a single `model_version`, but a reclassified
   baseline can still differ.
3. A real event: a release or an ad change affecting many apps at once.

**Steps.** Review a sample of breaches with their confounders (releases,
coverage changes). If thresholds are the cause, recalibrate with the backtest
and record the change in the rule history. No alerts are auto-suppressed and
no automated actions exist (guardrails v1 only alert).

**Escalation.** ReviewSignal on-call and the product owner, business hours.
