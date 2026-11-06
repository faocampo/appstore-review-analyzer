# Implementation status

Status of the [productization plan](productization-plan.md) as of
2026-11-06. "Built" means implemented in this repository and verified
locally (tests against Postgres 16, a built-process smoke run, Playwright for
the panels). It does not mean deployed, adopted or proven to have business
impact. Each milestone's exit gate still needs the items in its last column,
which depend on people, data or systems outside this repository.

## Summary

| Milestone | Built in this repository | Still needed for the exit gate |
| --- | --- | --- |
| **M0 Foundations** | Server layout (`src/server`), Postgres schema with row-level security, migrator, CI (lint, types, tests with a 90% gate against Postgres, build, process smoke run, chart and image checks), ADRs 0001–0006 | Decide the open ADRs: 0001 console embedding, 0002 CI platform, 0003 DAU source |
| **M1 Classification** | Classifier interface with OpenRouter (default), Jev and mock; taxonomy v2 (ad sub-reasons, secondary reason); per-review cost; per-tenant daily budget; fallback provider with circuit breaker; evaluation harness with gates and annotator agreement | Labeled set of 400–500 real reviews (RevOps), agreement measured, the **default model chosen and pinned** by running the harness, Legal sign-off on sending reviews to the provider |
| **M2 Ingestion** | Server-side Google (X3M service account or the publisher's own) and Apple credentials; incremental sync from a watermark; Apple backfill; Play reports backfill from GCS; CSV import via S3 presigned uploads; per-day coverage; pg-boss jobs and schedules; Prometheus metrics and gauges | Staging with two design-partner apps and real credentials; 14 days of ingestion without manual intervention |
| **M3 API + panel** | API v1 (OIDC/JWKS auth, roles, tenant isolation, OpenAPI 3.1), panel reads tested under load (all within p95 < 500 ms locally), evolution panel, onboarding panel, admin health | Embed in the Loomit console (per ADR 0001), connect Loomit's identity provider, design sign-off against the design system, 2–3 beta publishers using it weekly |
| **M4 Guardrails** | G1–G4 with dimension and pre/post attribution, confounders, per-tenant and per-app thresholds, de-duplicated alerts with HMAC-signed webhook, read-only backtest, guardrail readout panel, experiment link endpoint for Loomit | Loomit backend (Kotlin) calls `POST /v1/experiments/{id}/link` and shows the readout; DAU feed for G3; backtest on historical Loomit experiments with an agreed false-positive target |
| **M5 GA** | Dockerfile, Docker Compose, Helm chart (API, worker, migration hook, ExternalSecrets, ServiceMonitor, PrometheusRule, Istio policies, HPA, PDB), Argo CD applications, alert rules with runbooks, SLOs, k6 load test, GA checklist, publisher onboarding guide, DPA question list, packaging options; **code security review done**, with every confirmed critical, high, medium and fixable low finding fixed and tested ([results](operations/security-review.md#4a-code-review-2026-11-06)) | Real values in the Helm overlays, first staging deploy, staging load test, security sign-off (threat model, IAM/KMS, the remaining follow-ups), DPA, packaging and pricing decision |

## Verified locally

- **Tests:** 265 tests pass, covering 97.8% of statements, 92.2% of branches, 98% of functions and 98.9% of lines. They include tenant isolation under row-level security as a non-superuser role.
- **Ingestion:** the end-to-end pipeline has been exercised with mocked store APIs. That covers backfill, incremental sync from the watermark, the Google window, truncation, failures and rate limits, CSV and Play reports (UTF-16), classification, budget stop and rollups.
- **Guardrails:** guardrail statistics match reference values. Evaluation and alert delivery have been exercised end to end, including the HMAC signature and de-duplication.
- **Processes:** the built processes (`migrate`, `api`, `worker`) start against Postgres, report ready, and serve authenticated requests.
- **CI on the PR (GitHub Actions):** lint, typecheck, tests with the coverage gate against a Postgres service, web and server builds, process smoke run, Helm lint and render for staging and production, `promtool`, alert-rule sync, Docker image build and CodeQL all pass.
- **Performance:** panel endpoints meet the p95 target on 54,000 reviews. See [load test results](operations/load-test-results.md).

## Not verified

- **External APIs:** no call has been made to the real Google Play, App Store Connect, OpenRouter or TypeSafe APIs. Their contracts are covered only by tests with recorded shapes and mocked HTTP.
- **Deployment artifacts:** the image has not been deployed anywhere. It builds, and real `helm lint`/`helm template` (both overlays) and `promtool check rules` pass in CI on GitHub Actions; there is no staging run yet.
- **Classification quality:** the only evaluation numbers come from the synthetic smoke dataset with the mock classifier. They say nothing about quality.

## Decisions waiting on people

1. Console embedding (ADR 0001), CI platform (ADR 0002), DAU source (ADR 0003).
2. OpenRouter model to pin, after the labeled evaluation.
3. Legal: DPA and store terms for LLM processing ([question list](legal/dpa-checklist.md)).
4. Acceptable guardrail false-positive rate, to calibrate thresholds with the backtest.
5. Packaging and pricing ([options](business/packaging-options.md)).
6. Design-system conflicts (plan §3.7): card radius, the 500 weight, icon policy.
