# ReviewSignal service level objectives

Status: proposed for GA (milestone M5). Targets come from the productization
plan (§1 non-functional requirements, §3.6 SLOs). Where this document adds a
number the plan does not state, it is marked *proposed*.

All SLIs are computed in Prometheus from the metrics the service exports.
Recording and alerting rules: [`deploy/prometheus/alerts.yaml`](../../deploy/prometheus/alerts.yaml).
Responses to each alert: [`runbooks.md`](runbooks.md).

## Summary

| SLO | SLI | Target | Window | Alerts |
| --- | --- | --- | --- | --- |
| API availability | Share of `/v1` responses that are not 5xx | 99.5% | 30 days rolling | `ReviewSignalApiAvailabilityFastBurn`, `…SlowBurn`, `ReviewSignalApiDown` |
| API latency | Share of `GET /v1` reads (admin excluded) served in under 500 ms | ≥ 95% (p95 < 500 ms) | 30 days rolling; alert on 5-minute p95 | `ReviewSignalApiLatencyHigh` |
| Ingestion freshness | Share of active store connections with a completed sync in the last 6 h | ≥ 95% at any time | Compliance: 99% of 5-minute samples over 30 days (*proposed*) | `ReviewSignalIngestionStale`, `ReviewSignalIngestionStalled` |

The plan also requires that the SLOs hold for 4 consecutive weeks before the
deployment stage counts as successful (plan §5).

## API availability

**SLI.** Measured at the API process:

```
good  = requests to /v1/* with status not 5xx
valid = all requests to /v1/*
```

Source: `reviewsignal_http_requests_total{route,method,status}`. Recording
rules `reviewsignal:api_v1_error_ratio:rate{5m,30m,1h,2h,6h,1d,3d}`.

- 4xx responses, including 401, 403 and 429, count as good: they are correct
  answers to bad, unauthorized or over-limit requests. A surge of 429s has its
  own alert.
- `/healthz`, `/readyz` and `/metrics` are not part of the SLI.
- Requests that never reach the process (pods down, mesh failures) are
  invisible to this SLI. `ReviewSignalApiDown` covers total outages. Istio
  gateway metrics (`istio_requests_total` with `reporter="source"` at the
  console gateway) give a client-side view; add them to the dashboard and
  compare during incidents.

**Target and budget.** 99.5% over 30 days: an error budget of 0.5% of
requests, equivalent to about 3 h 36 min of total unavailability per 30 days.

**Alerting.** Multi-window, multi-burn-rate (Google SRE Workbook, ch. 5):

| Alert | Long window | Short window | Burn rate | Budget spent at alert | Severity |
| --- | --- | --- | --- | --- | --- |
| FastBurn | 1 h | 5 min | 14.4× | 2% | critical |
| FastBurn | 6 h | 30 min | 6× | 5% | critical |
| SlowBurn | 1 d | 2 h | 3× | 10% | warning |
| SlowBurn | 3 d | 6 h | 1× | 10% | warning |

*Known limitation:* at low traffic a handful of errors produces a high ratio.
If early production traffic makes FastBurn noisy, add a minimum request-rate
condition rather than raising the burn rates.

## API latency

**SLI.** Share of `GET /v1/*` requests (excluding `/v1/admin/*`) completed in
under 500 ms, from the histogram `reviewsignal_http_request_duration_seconds`.
This requires a bucket boundary at exactly 0.5 s.

- `reviewsignal:api_v1_read_fast_ratio:rate5m`: share under 500 ms.
- `reviewsignal:api_v1_read_latency_seconds:p95_5m` and `…_by_route`: p95.

Writes (`PUT` connections, `POST` experiment links, uploads) and admin reads
are excluded: they call external systems or scan across tenants and are not
on the panel's critical path.

**Target.** At least 95% of reads under 500 ms over 30 days, which is the
plan's "p95 under 500 ms" stated as a ratio. The panel reads pre-aggregated
rollups, so this is achievable only while queries stay on rollups.

**Alerting.** `ReviewSignalApiLatencyHigh` when the 5-minute p95 exceeds
500 ms for 15 minutes (warning). It is a ticket, not a page: the panel is
slow, not down.

**Verification before GA.** The k6 test in [`loadtest/`](../../loadtest/README.md)
applies the same threshold per endpoint against staging.

## Ingestion freshness

**SLI.** At each evaluation:

```
freshness = 1 − stale / active
active    = connections with status "active"   (reviewsignal_connections{status="active"})
stale     = active connections whose last completed sync is older than 6 h
            (reviewsignal_connections_stale)
```

Recording rule: `reviewsignal:ingestion_freshness:ratio`. Both gauges are
computed by the service from the database, so they reflect state, not
scrape-time events.

- "Completed sync" means a sync finished, including a sync that found no new
  reviews. It does not mean every review is available: the Google Play API
  only returns about 7 days of reviews, and its coverage limits are reported
  separately through `coverage_day` (`complete`, `partial`, `unknown`).
- Connections in `error`, `pending` or `disabled` are excluded: a publisher
  who revoked access is not a freshness failure. `ReviewSignalConnectionsInError`
  watches for many of them at once.

**Target.** At any moment, at least 95% of active connections synced within 6
hours (plan: "ingestion freshness under 6 h for 95% of connected apps";
"ingestion lag under 6 h (p95)").

**Compliance over time (*proposed*).** The objective holds in at least 99% of
5-minute samples over 30 days, so about 7 h 12 min of non-compliance per 30
days:

```
avg_over_time((reviewsignal:ingestion_freshness:ratio >= bool 0.95)[30d:5m])
```

**Alerting.** `ReviewSignalIngestionStale`: warning below 98% for 1 hour,
critical below 95% for 30 minutes. `ReviewSignalIngestionStalled`: no run at
all in 4 hours while connections are active.

## Supporting indicators (not SLOs)

Tracked on the dashboard and in the plan's success metrics (§5), without
error budgets:

| Indicator | Source | Initial expectation |
| --- | --- | --- |
| Classifier failure ratio | `reviewsignal:classifier_failure_ratio:rate15m` | < 2% (*proposed*); alerts at 10% and 50% |
| Classification cost per 1,000 reviews | `reviewsignal:classifier_cost_usd_per_1k_reviews:1d` (provider-reported cost ÷ reviews classified); `classification.cost_usd` in the database for per-tenant detail | Set at the M1 model decision |
| Share of `complete` coverage days | `reviewsignal:coverage_complete:ratio30d` | Measured in M2; alert below 80% (info) |
| Alert delivery success | `reviewsignal_alert_deliveries_total{outcome}` | ≥ 99% (*proposed*) |
| Guardrail breach share | `reviewsignal_guardrail_evaluations_total{status}` | Consistent with the backtest false-positive rate (M4) |

## Error budget policy

*Proposed;* to be agreed with the product owner and Loomit operations before GA.

| Budget remaining (30 days) | Action |
| --- | --- |
| > 50% | Normal releases. |
| 25–50% | Releases continue; the next sprint includes the top reliability fix from recent incidents. |
| < 25% | Feature releases pause for the affected service; only reliability fixes and security patches ship. |
| Exhausted | Freeze except fixes; a postmortem is required for each incident that consumed more than 20% of the budget. |

Budgets are per SLO. Exhausting the ingestion freshness budget does not
freeze API work, and vice versa, unless one change caused both.

Excluded from budget accounting: announced maintenance windows, outages of a
store API (Google, Apple) or of the classifier provider that ReviewSignal
handled as designed (retries, `partial` coverage, `unclassified` reviews),
and load tests on staging.

## Review

Review targets and thresholds at the end of the closed beta and quarterly
after GA, using real traffic and incident history. Record each change in
this file with its date and reason.
