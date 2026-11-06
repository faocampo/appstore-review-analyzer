# Load test results (local)

Measured on 2026-11-06 against a local single-node setup. These are
indicative numbers for the query design, not a substitute for the staging
run with `loadtest/k6-panel.js` (M5 exit gate).

## Setup

- Postgres 16 and one API process (Node 22) on the same machine.
- One tenant and one app with 54,000 classified reviews over 180 days
  (about 300 a day), 6 app versions and 5 territories, rollups built.
- 90-day range, 20 concurrent connections for 10 s per endpoint
  (`autocannon`), rate limit raised so every response was 2xx.
- Requests run as the tenant (row-level security enforced).

## Results

| Endpoint | p50 | p97.5 | p99 |
| --- | ---: | ---: | ---: |
| `GET /timeseries` (daily) | 39 ms | 64 ms | 74 ms |
| `GET /reasons` | 31 ms | 45 ms | 50 ms |
| `GET /reviews` (page of 50) | 32 ms | 55 ms | 63 ms |
| `GET /reviews` (negative + ads filter) | 226 ms | 325 ms | 341 ms |
| `GET /versions` | 17 ms | 27 ms | 33 ms |
| `GET /coverage` | 18 ms | 27 ms | 32 ms |

All endpoints are within the p95 < 500 ms target.

## What changed to get there

The first run missed the target: timeseries p50 594 ms, reasons p50 1.9 s,
reviews p50 657 ms. Three fixes, all in this release:

1. **No scans of every review per request.** `app.current_model_version` and
   `app_version_seen` are maintained by triggers (migration 0003), so the
   current model version and release markers are single-row or tiny lookups.
2. **Reasons read rollups only.** Rollups now carry per-group reason counts.
3. **Index usable under row-level security.** Comparing `timestamptz` with a
   `date` uses a cross-type operator that is not leakproof, so Postgres would
   not use the index ahead of the RLS predicate and fell back to a sequential
   scan. Bounds are now UTC `timestamptz`, and a `(app_id, created_at, id)`
   index (migration 0004) serves keyset pagination directly: 35 ms → 0.3 ms
   per query.

Also fixed while measuring: tenant lookup no longer writes on every request,
and the per-tenant rate limit is configurable (`TENANT_RATE_LIMIT_PER_MINUTE`).

## Still to do in staging

- Run `loadtest/k6-panel.js` against staging with production-like volumes and
  several tenants, with the Istio sidecar in the path.
- Watch the filtered review drill-down: it scans more rows when the filter is
  rare. If staging shows p95 above target, add a partial index on
  classifications by reason for the current model version.
