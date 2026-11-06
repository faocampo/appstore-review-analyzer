# Load test: evolution panel API

`k6-panel.js` simulates publishers opening the evolution panel. Each
iteration is one panel load:

- `GET /v1/apps/{appId}/timeseries` (day granularity up to 31 days, week beyond),
- `GET /v1/apps/{appId}/reasons?group=negative`,
- `GET /v1/apps/{appId}/reviews?limit=50`, plus a second page on 25% of loads.

The three requests are issued in parallel, as the panel does. Windows of 7,
30 and 90 days are picked at random.

## Pass criteria

These match the API SLOs in [`docs/operations/slo.md`](../docs/operations/slo.md).

| Threshold | Target |
| --- | --- |
| p95 latency per endpoint (`timeseries`, `reasons`, `reviews`) | < 500 ms |
| Failed requests (any status ≥ 400, timeouts) | < 0.5% (the test aborts early if it is breached after the first minute) |
| Checks (status and response shape) | > 99.5% |
| Dropped iterations (load generator saturated) | 0 |

k6 exits non-zero when a threshold fails, so the run can gate a pipeline.

## Profiles

| `PROFILE` | Panel loads/s | Requests/s (approx.) | Steady duration |
| --- | --- | --- | --- |
| `smoke` | 1 | 3 | 1 min |
| `load` (default) | 20 | 65 | 10 min |
| `stress` | 60 | 195 | 10 min |

Each profile ramps up for 1 minute and down for 30 seconds. `RATE` and
`DURATION` override the profile.

*Assumption:* expected production traffic is not known yet. The `load`
profile is a deliberately generous starting point (20 panel loads per second
is far above what a few hundred publishers generate). Revisit it with the
weekly panel-viewer numbers from the closed beta (plan §5).

## Prerequisites

1. **k6** v0.50 or later (`brew install k6`, or the `grafana/k6` container image).
2. **A load-test tenant on staging** with at least one app holding realistic
   data: 30 to 90 days of reviews, classified, with rollups computed. Use a
   design-partner app already ingesting on staging, or import a synthetic
   store-export CSV for a dedicated test app through the connect flow. Testing
   against an empty app measures nothing useful.
3. **A bearer token** for a user of that tenant with the `publisher` role,
   issued by the staging Loomit identity provider. Ask the Loomit platform team
   for a dedicated load-test client; do not use a real publisher's account.
   Tokens are short-lived: request one right before the run.
4. **A route that the mesh allows.** In staging the API accepts traffic only
   from the Loomit console gateway and the Loomit backend (Istio
   AuthorizationPolicy). Point `BASE_URL` at the console gateway's ReviewSignal
   route, not at the pod or Service directly. Run from outside the cluster, or
   from a pod whose identity is on the allow list.

## Run against staging

```bash
export BASE_URL="https://<console-gateway-host>"   # serves /v1/* for ReviewSignal
export API_TOKEN="<publisher token for the load-test tenant>"
export APP_IDS="<appId>,<appId>"                   # ReviewSignal app ids of that tenant

# 1. Smoke: checks the token, the app ids and the response shapes.
PROFILE=smoke k6 run loadtest/k6-panel.js

# 2. Load: the run that counts for the GA checklist.
PROFILE=load k6 run --summary-export=loadtest-summary.json loadtest/k6-panel.js
```

With Docker instead of a local k6:

```bash
docker run --rm -i \
  -e BASE_URL -e API_TOKEN -e APP_IDS -e PROFILE=load \
  grafana/k6 run - < loadtest/k6-panel.js
```

The script refuses plain `http://` except for `localhost`, and checks every
app id with one request before generating load.

## Run locally

Against `docker compose up` (see the repository root), with a token from the
local dev signer. `DEV_JWT_SECRET` must be the value in `docker-compose.yml`:

```bash
export DEV_JWT_SECRET="<DEV_JWT_SECRET from docker-compose.yml>"
BASE_URL=http://localhost:8080 \
API_TOKEN="$(npm run --silent dev:token -- --publisher <loomit publisher id>)" \
APP_IDS=<local appId> \
PROFILE=smoke k6 run loadtest/k6-panel.js
```

Local numbers do not count toward the SLO: the database and the API share one
machine.

## While the test runs

Watch the service, not only the k6 output:

- API p95 and error ratio:
  `reviewsignal:api_v1_read_latency_seconds:p95_5m_by_route` and
  `reviewsignal:api_v1_error_ratio:rate5m`.
- HPA: `kubectl -n reviewsignal get hpa -w`. The API should scale out before
  latency degrades.
- RDS: CPU, connections and read IOPS in CloudWatch. With `DATABASE_POOL_MAX`
  at 10, each API pod opens up to 10 connections; check that
  `maxReplicas × DATABASE_POOL_MAX` plus the worker stays below the
  instance's `max_connections`.
- Rate limiting: per-tenant limits apply to the load-test tenant. A wave of
  429 responses means the test is measuring the limiter; raise the tenant's
  limit for the run or lower `RATE`.

Tell the staging channel before a `load` or `stress` run: it can fire
ReviewSignal alerts (latency, 429s) for the duration.

## Recording results

For the GA checklist, keep:

- the `loadtest-summary.json` export and the k6 console summary,
- the image tag tested and the HPA min/max at the time,
- the RDS instance class,
- screenshots or links of the API latency and RDS panels for the run window.
