# ReviewSignal security review (GA)

Checklist for the M5 security review. Every item needs evidence (a test, a
CI run, a configuration link or a screenshot) before it is ticked. Owners are
roles; see [`ga-checklist.md`](ga-checklist.md) for who signs off.

Scope: the API, the worker and the migrations job (one image), their
Postgres database, AWS Secrets Manager and S3 usage, egress to the store APIs
and classifier providers, the Loomit notification webhook, and the embedded
panels. Out of scope: the Loomit console and backend themselves.

Status legend: `[ ]` open · `[x]` done with evidence linked.

## 1. Threat model summary

### Assets

| Asset | Why it matters |
| --- | --- |
| Publisher store credentials (App Store Connect `.p8` keys, Google access via the X3M service account) | Read access to the publisher's store data; Apple team keys cover every app in the account |
| The X3M Google service account key | One credential that reaches every publisher who invited it |
| Reviews and classifications per tenant | Publisher data under the DPA; review text can contain personal data |
| Experiment links and guardrail results | Commercially sensitive (monetization experiments, DAU) |
| Runtime secrets (`DATABASE_URL`, `OPENROUTER_API_KEY`, `LOOMIT_NOTIFY_SECRET`, `TYPESAFE_API_KEY`) | Database access, provider spend, the ability to forge notifications |

### Trust boundaries and data flow

```text
Publisher browser ──(Loomit JWT)──► Loomit console gateway ──mTLS──► reviewsignal-api ──► Postgres (RLS)
Loomit backend (Kotlin) ──mTLS + service JWT──► reviewsignal-api
reviewsignal-api / worker ──IRSA──► Secrets Manager (reviewsignal/<env>/*), S3 uploads/exports
reviewsignal-worker ──HTTPS──► Google Play Developer API, App Store Connect API, Play reports bucket (GCS)
reviewsignal-worker ──HTTPS──► OpenRouter (review title/body/rating/language/territory/store) or TypeSafe Jev
reviewsignal-worker ──HTTPS + HMAC──► Loomit notification webhook
```

### STRIDE

| Threat | Example | Mitigations | Verify |
| --- | --- | --- | --- |
| **Spoofing** | Forged or replayed JWT; a pod in the mesh impersonating the Loomit backend | OIDC JWT validated against the Loomit JWKS (issuer, audience, expiry); `AUTH_MODE=dev` refused when `NODE_ENV=production` (chart and service); Istio mTLS STRICT and AuthorizationPolicy limited to two principals | §2.1, §3 API2 |
| **Tampering** | A publisher altering another tenant's connection or experiment link; forged notifications to Loomit | Tenant taken from the token, never from the request; RLS on every tenant table; HMAC-signed webhook with `LOOMIT_NOTIFY_SECRET`; migrations only from the CI-built image | §2.1, §2.4 |
| **Repudiation** | "Who changed this credential or guardrail rule?" | `audit_log` for credential access and rule changes, with actor (token subject) and tenant | §2.2 |
| **Information disclosure** | Cross-tenant reads (BOLA); credentials returned by the API; review text leaking through logs or the LLM provider | RLS with FORCE; write-only credential endpoints; upstream error bodies logged server-side only; reviewer nicknames never sent to the classifier; OpenRouter `data_collection: deny` and ZDR routing | §2.1, §2.3, §2.6 |
| **Denial of service** | Expensive panel queries; classifier cost exhaustion through review floods; CSV uploads | Per-tenant rate limit; rollup-only panel queries; bounded `limit`/date ranges in Zod schemas; per-tenant daily classification budget; 50 MB upload cap with presigned S3 | §3 API4, API6 |
| **Elevation of privilege** | A publisher token reaching `/v1/admin/*`; code path setting `app.bypass_rls` from a request | Role check (`x3m_admin`, `service`) on admin and service routes; bypass set only in worker and admin code; database role without SUPERUSER or BYPASSRLS; non-root, read-only container | §2.1, §3 API5, §2.7 |

LLM-specific threats are in [§2.6](#26-llm-data-flow).

## 2. Controls checklist

### 2.1 Tenancy and row-level security

Design: [ADR 0006](../adr/0006-row-level-security.md).

- [ ] Every tenant-owned table has RLS **enabled and forced**. Evidence: a test
      that fails when any table with a `tenant_id` column lacks it:
      ```sql
      SELECT c.relname
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
      WHERE c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
      -- expected: zero rows
      ```
- [ ] Runtime and migration database roles are `NOSUPERUSER NOBYPASSRLS`
      (superusers and BYPASSRLS roles skip every policy, even forced ones).
      On RDS, the master user is not used by the service.
- [ ] Integration tests with two tenants (A, B) against a real Postgres,
      connected as the service role:
  - [ ] reads as A never return B's rows, for every `/v1` read endpoint;
  - [ ] writes as A cannot update or delete B's rows (`WITH CHECK` policies), including inserting a row with B's `tenant_id`;
  - [ ] with no `app.tenant_id` set, tenant tables return zero rows and writes fail (fail closed);
  - [ ] `app.tenant_id` is set with `SET LOCAL` inside a transaction, so a pooled connection never carries the previous request's tenant (test: two sequential requests for different tenants on a pool of size 1);
  - [ ] guessing ids across tenants (`appId`, `experimentId`, review cursor) returns 404, not 403, so ids are not confirmed to exist.
- [ ] `app.bypass_rls` is set only in worker jobs and `/v1/admin/*` handlers;
      a lint rule or grep test fails the build on any other use.
- [ ] Cross-tenant admin reads are recorded in `audit_log`.

### 2.2 Authentication, authorization and audit

- [ ] `AUTH_MODE=oidc` in staging and production; the chart refuses `dev` with `NODE_ENV=production`.
- [ ] Tokens validated for signature (JWKS), `iss`, `aud`, `exp`, `nbf`; clock skew ≤ 60 s; algorithms pinned (no `none`, no HS256 in `oidc` mode).
- [ ] Tenant from `AUTH_TENANT_CLAIM`, roles from `AUTH_ROLES_CLAIM`; a token without a tenant claim gets 403 on tenant routes.
- [ ] Route-to-role matrix documented and tested: `publisher` (own tenant), `service` (Loomit backend: experiment link, guardrail reads), `x3m_admin` (admin).
- [ ] `audit_log` entries for: credential create/replace/delete/read-for-sync, guardrail rule changes, admin cross-tenant access. Entries carry actor, tenant, action and time, never secret values.
- [ ] Istio: PeerAuthentication STRICT and AuthorizationPolicy deployed (chart `istio.*`); principals confirmed with the Loomit platform team.
- [ ] *Recommended:* an Istio `RequestAuthentication` on the API as a second JWT check at the mesh.

### 2.3 Secrets handling

- [ ] Store credentials are write-only through the API: `PUT /v1/apps/{appId}/connections/{store}` stores them; no endpoint returns them.
- [ ] Store credentials live only in Secrets Manager under `SECRETS_PREFIX`
      (`reviewsignal/<environment>/`), encrypted with a customer-managed KMS
      key; the database holds `secret_ref` only.
- [ ] Runtime secrets live in a separate secret (`reviewsignal-runtime/<environment>`) read by External Secrets, not by the service's IAM role.
- [ ] IRSA role scoped as below; no wildcard account-wide permissions.
- [ ] `SECRET_STORE=database` is refused in production (chart and service).
- [ ] Secrets never logged: request logging redacts `Authorization`, credential bodies and `DATABASE_URL`; a test posts a credential and asserts it is absent from logs.
- [ ] Rotation procedure documented and rehearsed on staging for `OPENROUTER_API_KEY`, `LOOMIT_NOTIFY_SECRET` and the X3M Google service account key ([runbooks](runbooks.md#common-procedures)).
- [ ] The X3M Google service account: key stored only in Secrets Manager, rotation interval defined, no Cloud IAM roles beyond what the Android Publisher API needs.
- [ ] Development secrets in `docker-compose.yml` are marked dev-only and allow-listed in secret scanning; they are not valid anywhere else.

IRSA policy for the service role (`<…>` values per environment):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublisherStoreCredentials",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:TagResource",
        "secretsmanager:DeleteSecret"
      ],
      "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:reviewsignal/<environment>/*"
    },
    {
      "Sid": "SecretsKmsKeyViaSecretsManager",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<key-id>",
      "Condition": { "StringEquals": { "kms:ViaService": "secretsmanager.<region>.amazonaws.com" } }
    },
    {
      "Sid": "CsvUploads",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<uploads-bucket>/*"
    },
    {
      "Sid": "AnalyticsExport",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::<export-bucket>/*"
    }
  ]
}
```

Buckets: block public access, SSE-KMS, TLS-only bucket policy, lifecycle
expiry on the uploads bucket (*proposed:* 7 days after processing).

### 2.4 Integrations

- [ ] Loomit notification webhook: HMAC-SHA256 over the raw body with a timestamp, rejected by Loomit when older than 5 minutes (replay); confirm the exact scheme with the Loomit backend team.
- [ ] Store API calls use only official endpoints (no scraping), for apps the publisher connected.
- [ ] Apple: guidance asks for the Customer Support role; the service verifies a key can read reviews and nothing is written to App Store Connect.
- [ ] Google: the publisher grants the X3M service account read-only access to the selected apps; the service never calls write endpoints (for example review replies).
- [ ] Outbound TLS verification on for every client; no `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### 2.5 Data retention and offboarding

*The periods below are proposals for Legal to confirm* ([DPA checklist](../legal/dpa-checklist.md)).

| Data | Proposed retention | Deletion on offboarding |
| --- | --- | --- |
| Reviews, classifications, rollups, coverage | Per-tenant `retention_days`, enforced by the daily `retention` job | Deleted (tenant cascade) |
| Store credentials (Secrets Manager) | While the connection exists | Deleted; recovery window to be decided (Secrets Manager allows 7–30 days or immediate deletion) |
| CSV uploads (S3) | 7 days after processing | Deleted |
| Parquet export (S3, Databricks/Druid copies) | Per the analytics platform's policy | Deleted from the export bucket; downstream copies need their own deletion process |
| `audit_log` | 1 year (*proposed*) | Kept for the retention period (legitimate interest), tenant-identifying only |
| RDS automated backups and snapshots | Per RDS retention setting | Expire with the backup window; documented to the customer |
| Logs (review text may appear in upstream error bodies) | Cluster log retention | Expire with the log retention |

- [ ] An offboarding job deletes a tenant's data and secrets end to end, records the deletion in `audit_log`, and is tested on staging.
- [ ] Disconnecting a single store deletes its secret and stops ingestion; already-ingested reviews follow the tenant retention.
- [ ] Review deletions at the store: when a review disappears from the store feed, the service does not keep resurfacing it as current (document the behavior; Legal to confirm whether deletion is required).

### 2.6 LLM data flow

- [ ] Fields sent to the classifier: internal review key, store, rating, language, territory, title, body. Not sent: reviewer nickname, tenant or publisher identity, app name, credentials. Verified by a unit test on the request payload.
- [ ] OpenRouter requests always set `provider.data_collection: "deny"`; ZDR routing on in staging and production (`OPENROUTER_ZDR=true`, enforced by the chart values). Disabling ZDR needs Legal sign-off.
- [ ] Model pinned (`OPENROUTER_MODEL`); provider, model, prompt and taxonomy versions stored with each classification.
- [ ] Prompt injection in review text: the model only returns a schema-constrained JSON object validated with Zod (enumerated labels, numeric ranges); output is never executed, rendered as HTML or used to call tools. A manipulated review can at most mislabel itself. The eval set includes injection-style reviews and their expected labels.
- [ ] Coordinated manipulation (review bombing with crafted text) can shift guardrail metrics: guardrails only alert (no automated actions) and show N and confounders; documented in the publisher docs.
- [ ] Cost abuse: per-tenant daily budget with alert (`ReviewSignalClassifierBudgetExhausted`); classifications cached by `(review_id, text_hash, model, prompt_version)`.
- [ ] Jev (TypeSafe) receives one request per review with the same fields; its retention and location are open Legal questions.
- [ ] Sub-processor list (OpenRouter and its ZDR upstream providers, TypeSafe, AWS) matches the DPA.

### 2.7 Platform and container

- [ ] Image runs as uid 1000, `runAsNonRoot`, `readOnlyRootFilesystem` with an emptyDir `/tmp`, all capabilities dropped, `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault` (Pod Security Standards "restricted").
- [ ] `automountServiceAccountToken: false` on all pods.
- [ ] Base image pinned by digest in CI; rebuilt at least monthly for OS patches.
- [ ] *Recommended:* a Kubernetes NetworkPolicy limiting egress to RDS, AWS endpoints and HTTPS, as defense in depth next to Istio.
- [ ] CORS: `CORS_ORIGINS` lists only the Loomit console origins; no wildcard with credentials.
- [ ] If the panels are embedded by iframe ([ADR 0001](../adr/0001-console-embedding.md)): CSP `frame-ancestors` limited to the console origin.
- [ ] `/metrics` reachable only by Prometheus (AuthorizationPolicy); metrics carry no tenant identifiers or review text.

## 3. OWASP API Security Top 10 (2023)

| Risk | ReviewSignal exposure | Control | Status |
| --- | --- | --- | --- |
| **API1 Broken object level authorization** | `appId`, `experimentId`, review cursors in paths and queries | Tenant from token + RLS; cross-tenant tests (§2.1) | [ ] |
| **API2 Broken authentication** | Loomit JWTs; service tokens from the Loomit backend | JWKS validation, pinned algorithms, dev mode refused in prod (§2.2) | [ ] |
| **API3 Broken object property level authorization** | Credential fields; admin-only fields in DTOs | Credentials write-only; response DTOs are explicit interfaces (`src/server/api/contracts.ts`), no entity passthrough; Zod rejects unknown write fields or strips them | [ ] |
| **API4 Unrestricted resource consumption** | Wide date ranges, large `limit`, CSV size, classification spend | Zod bounds (`limit` ≤ 200, upload ≤ 50 MB); per-tenant rate limit; rollup-only reads; per-tenant budget; HPA max | [ ] |
| **API5 Broken function level authorization** | `/v1/admin/*`, experiment link (service-only) | Role matrix tests for every route (§2.2) | [ ] |
| **API6 Unrestricted access to sensitive business flows** | Connection verification calls used to probe arbitrary credentials; mass CSV imports | Rate limit on connection endpoints; audit log; upload quotas per tenant | [ ] |
| **API7 Server-side request forgery** | Any user-supplied value that becomes a URL | No user-supplied URLs: store endpoints are fixed; the Play bucket name is validated (`pubsite_prod_*`); webhook URL is configuration only | [ ] |
| **API8 Security misconfiguration** | CORS, error detail, debug modes, TLS | Generic error messages (upstream bodies logged only); strict CORS; chart validation of auth and secret-store modes; security headers on panel responses | [ ] |
| **API9 Improper inventory management** | Legacy `/api/analyze` in the Next app; OpenAPI drift | `/api/analyze` disabled or removed in deployed environments (the chart does not deploy the Next harness); `/v1/openapi.json` generated from the Zod contracts and versioned | [ ] |
| **API10 Unsafe consumption of APIs** | Store and LLM responses | Zod validation of store and classifier responses; timeouts, retries with backoff, circuit breaker; LLM output schema-constrained (§2.6) | [ ] |

## 4. Dependency and supply-chain scanning

- [ ] CI runs `npm audit --omit=dev --audit-level=high` and fails on unresolved high/critical issues (documented exceptions only).
- [ ] Automated dependency updates (Dependabot or Renovate, or the GitLab equivalent per [ADR 0002](../adr/0002-ci-platform.md)), grouped weekly.
- [ ] CodeQL (already configured on GitHub) or GitLab SAST on every merge request.
- [ ] Container image scan (Amazon ECR enhanced scanning / Inspector, or Trivy in CI) with no unresolved critical OS or library findings at release.
- [ ] SBOM generated per image (`npm sbom` or Syft) and stored with the build.
- [ ] Secret scanning on the repository (GitHub secret scanning or gitleaks), with the dev-only compose values allow-listed.
- [ ] Images are built only in CI, tagged with the git SHA, immutable tags in ECR; Argo CD deploys tags from the values files only.
- [ ] License review of production dependencies (no copyleft obligations triggered for the hosted service).

## 4a. Code review, 2026-11-06

A read-only code review of the service (tenancy, authentication, secrets,
outbound requests, input handling, webhooks and the chart) found the issues
below. Each confirmed issue was reproduced before it was fixed, and each fix
has a regression test. This is an internal code review; it does not replace
the sign-off below.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| C1 | Critical | A publisher-supplied Google "service account" of another credential type (`external_account`, impersonated, authorized user) made google-auth-library read pod files or call attacker URLs, exfiltrating secrets and the IRSA token. | **Fixed.** Only `type: service_account` keys with Google's token endpoint are accepted (validated on write and on use); tokens are minted with the JWT client from email and key only. |
| H1 | High | With X3M's shared Google account, a publisher could register another publisher's package or reports bucket and import its reviews. | **Fixed.** App identity is trusted only when set by Loomit (service role) or an X3M admin; the shared account refuses unverified apps; verified packages and buckets are unique across tenants; a publisher's change to them drops verification. **Recommended next step:** one Google service account per publisher. |
| M1 | Medium | Unbounded date ranges could exhaust API memory. | **Fixed.** Ranges start after 2008 and span at most 1,100 days; experiment and baseline windows at most 366 days. |
| M2 | Medium | Upload size was not enforced; a huge CSV could exhaust worker memory. | **Fixed.** Size is checked (HEAD) before reading; limit 50 MB. |
| M3 | Medium | The daily budget did not apply to Jev (no cost reported); OpenRouter cost depended on usage being returned. | **Fixed.** Jev uses `TYPESAFE_COST_PER_REVIEW_USD`; OpenRouter requests usage accounting; a daily review cap (`DAILY_REVIEW_CAP`) bounds spend for every provider. |
| M4 | Medium | Percent-encoded paths skipped the authentication hook (failed closed today). | **Fixed.** Authentication keys off the matched route; tenant handlers return 401 without a principal. |
| L1 | Low | OIDC accepted any algorithm and tokens without `exp`. | **Fixed.** Algorithms pinned (RS256/ES256/PS256); `exp` and `sub` required; 24 h max age. |
| L2 | Low | A review in a batch can try to steer labels of others in the same batch (prompt injection). | **Accepted for now.** Output is schema-validated and batch-local; cannot cross tenants. Follow-up: flag sentiment that contradicts the star rating; consider single-review calls for guardrail-critical apps. |
| L3 | Low | RLS bypass is a session setting; the runtime role owns the tables. | **Follow-up.** Run system work under a dedicated BYPASSRLS role and keep the runtime role from owning tables (needs a migration with role privileges on RDS). |
| L4 | Low | The publisher header for service/admin tokens was not validated; the limiter map was unbounded. | **Fixed.** Format validated; expired limiter windows evicted. |
| L5 | Low | Malformed cursors and ids returned 500. | **Fixed.** Validated; return 400 or are ignored. |
| L6 | Low | Offboarding left uploaded CSVs in S3. | **Fixed.** The tenant's upload prefix is deleted. Exports hold aggregates only. |
| L7 | Low | The standalone `/api/analyze` uses one shared token and a spoofable rate-limit key. | **Accepted.** Demo and support tool only; not deployed by the Helm chart. |
| L8 | Low | `trustProxy` ignored `TRUST_PROXY`. | **Fixed.** |
| Info | — | AWS secret refs not tied to the tenant; Apple pagination followed any host; GCS listing ignored paging; webhook URL could be http; X3M key missing from the overlays. | **Fixed.** |
| Info | — | Base image tag not pinned to a digest; panels send no CSP headers. | **Follow-up** before GA. |

## 5. Sign-off

| Area | Reviewer role | Date | Result |
| --- | --- | --- | --- |
| Threat model and STRIDE | Security reviewer | | |
| Tenancy and RLS tests | ReviewSignal developer + Security reviewer | | |
| Secrets, IAM, KMS | Loomit platform engineer | | |
| LLM data flow and retention | Legal + Security reviewer | | |
| Dependency and image scanning | ReviewSignal developer | | |
