# ReviewSignal service contract

The runtime contract that packaging (Docker, Helm, ArgoCD), operations and the
UI rely on. Code in `src/server` implements it; change both together.

## Processes

All server processes are built with `npm run build:server` (tsup) into
`dist/server/` and run on Node.js 24.

| Process | Command | Port | Endpoints | Notes |
| --- | --- | --- | --- | --- |
| API | `node dist/server/api.js` | `PORT` (default `8080`) | `/healthz`, `/readyz`, `/metrics`, `/v1/*`, `/v1/openapi.json` | Stateless; scale horizontally. |
| Worker | `node dist/server/worker.js` | `METRICS_PORT` (default `9464`) | `/healthz`, `/readyz`, `/metrics` | Runs pg-boss jobs and schedules. Safe to run 1–N replicas. |
| Migrations | `node dist/server/migrate.js` | — | — | Idempotent; takes an advisory lock. Run as a pre-sync job before API/worker roll out. Exit code 0 on success. |
| Web (panels) | `next start` | `3000` | `/`, `/apps/[appId]`, `/experiments/[experimentId]`, `/connect` | Dev/demo harness and standalone panels. Calls the API at `NEXT_PUBLIC_API_URL`. |

- `/healthz` is liveness and never touches dependencies.
- `/readyz` checks Postgres. It returns 503 while the database is unreachable or migrations are behind.
- `/metrics` is Prometheus text format.

## Environment

| Variable | Used by | Required | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | api, worker, migrate | yes | Postgres connection string. |
| `DATABASE_POOL_MAX` | api, worker | no | Pool size (default 10). |
| `PORT` / `METRICS_PORT` | api / worker | no | Listen ports. |
| `AUTH_MODE` | api | yes | `oidc` (production) or `dev` (shared HS256 secret, local only). |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` | api | when `oidc` | Loomit identity provider. |
| `AUTH_TENANT_CLAIM` | api | no | Claim with the Loomit publisher id (default `loomit_publisher_id`). |
| `AUTH_ROLES_CLAIM` | api | no | Claim with roles (default `roles`). Roles: `publisher`, `x3m_admin`, `service`. |
| `DEV_JWT_SECRET` | api | when `dev` | HS256 secret for local tokens (`npm run dev:token`). |
| `CORS_ORIGINS` | api | no | Comma-separated origins allowed to call the API (Loomit console, panels). |
| `SECRET_STORE` | api, worker | yes | `aws` (Secrets Manager) or `database` (AES-256-GCM in Postgres, non-production). |
| `SECRETS_ENCRYPTION_KEY` | api, worker | when `database` | 32-byte key, base64. |
| `AWS_REGION` | api, worker | when AWS used | Region for Secrets Manager and S3. |
| `SECRETS_PREFIX` | api, worker | no | Secrets Manager name prefix (default `reviewsignal/`). |
| `UPLOADS_BUCKET` | api, worker | for CSV uploads | S3 bucket for presigned CSV uploads. |
| `EXPORT_BUCKET` | worker | for exports | S3 bucket for the Parquet/JSONL export to Databricks/Druid. |
| `LOOMIT_NOTIFY_URL`, `LOOMIT_NOTIFY_SECRET` | worker | for alerts | Loomit notification webhook and HMAC secret. |
| `SYNC_CRON` | worker | no | Schedule for incremental syncs (default every 2 h). |
| `EVALUATE_CRON` | worker | no | Schedule for guardrail evaluation (default hourly). |
| `MIN_N` | api, worker | no | Minimum reviews per bucket or arm before a value is shown (default 20). |
| `TENANT_RATE_LIMIT_PER_MINUTE` | api | no | Requests per publisher per minute, per pod (default 600). |
| `DAILY_REVIEW_CAP` | worker | no | Reviews classified per publisher per UTC day (default 20000), on top of the USD budget. |
| `TYPESAFE_COST_PER_REVIEW_USD` | worker | with Jev | Contract price per review, so the USD budget applies to Jev (which reports no cost). |
| `X3M_GOOGLE_SERVICE_ACCOUNT_JSON` | api, worker | for Google Play | X3M's Google service account (JSON or base64). Publishers invite its email in Play Console and connect with `{ "useX3mServiceAccount": true }`. Secret. |
| Classifier variables | worker | yes | `CLASSIFIER_PROVIDER`, `OPENROUTER_*`, `TYPESAFE_*`, `CLASSIFIER_FALLBACK_PROVIDER`, `CLASSIFIER_*` (see README). |
| `NEXT_PUBLIC_API_URL` | web | yes | Base URL of the API for the panels. |

Store credentials are **not** environment variables in the service: they are
per publisher, entered through `PUT /v1/apps/{appId}/connections/{store}` and
kept in the secret store. The environment variables in the standalone
analyzer (`GOOGLE_PLAY_*`, `APPLE_*`) only apply to `/api/analyze`.

## Data and security boundaries

- Every tenant-owned table has row-level security keyed on `tenant_id`. The
  API sets `app.tenant_id` per transaction from the verified token. The worker
  and admin endpoints set `app.bypass_rls` explicitly.
- Store credentials live only in the secret store. The database keeps a
  reference (`secret_ref`).
- Review text leaves the service only to the configured classifier provider.
