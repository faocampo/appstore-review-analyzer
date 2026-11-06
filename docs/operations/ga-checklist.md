# ReviewSignal GA checklist (M5)

Milestone M5 in the [productization plan](../productization-plan.md#4-milestones-1-full-time-dev-about-15-weeks-to-ga)
delivers: load test, security review, runbooks, SLOs, self-serve onboarding,
publisher docs, DPA, and the packaging and pricing decision. **Exit gate: this
checklist closed.** Production runs as a closed beta behind a per-publisher
flag until then.

Owners are roles, not people. Each item links its evidence when ticked.

| Role | Abbreviation |
| --- | --- |
| ReviewSignal developer (assigned full-time developer) | DEV |
| Product owner for ReviewSignal in Loomit | PO |
| Loomit platform / infra engineer | INFRA |
| Loomit frontend engineer | FE |
| Loomit backend (Kotlin) engineer | BE |
| Security reviewer | SEC |
| Legal counsel | LEGAL |
| X3M customer success lead | CSM |
| RevOps / support lead | REVOPS |
| Business owner (packaging and pricing) | BIZ |

## 1. Prerequisites from earlier milestones

| # | Item | Gate source | Owner | Evidence | Done |
| --- | --- | --- | --- | --- | --- |
| P1 | CI green on the main branch (lint, typecheck, tests ≥ 90% coverage, build, image build) | M0 | DEV | | [ ] |
| P2 | ADRs 0001–0003 decided (console embedding, CI platform, DAU source) | M0 | PO, INFRA, FE | [`docs/adr/`](../adr/) | [ ] |
| P3 | Default classifier model chosen from eval and cost data; `OPENROUTER_MODEL` pinned in both overlays | M1 | DEV, PO | Eval report | [ ] |
| P4 | 14 days of ingestion on staging for 2 design-partner apps without manual intervention; coverage measured | M2 | DEV | | [ ] |
| P5 | Design review signed off against the Loomit design system; 2–3 beta publishers using the panel weekly | M3 | PO, FE | | [ ] |
| P6 | Guardrail backtest false-positive rate below the agreed target; readout live on beta experiments | M4 | DEV, BE, PO | Backtest report | [ ] |
| P7 | Legal gate passed before production data (store terms, DPA, OpenRouter) | §4 dependencies (before M3 prod) | LEGAL | [`dpa-checklist.md`](../legal/dpa-checklist.md) | [ ] |

## 2. M5 exit criteria

### Load test

| # | Item | Owner | Evidence | Done |
| --- | --- | --- | --- | --- |
| L1 | `PROFILE=load` run of [`loadtest/k6-panel.js`](../../loadtest/README.md) against staging passes every threshold (p95 < 500 ms per endpoint, < 0.5% failures) on production-like data volume | DEV | k6 summary, dashboards | [ ] |
| L2 | `PROFILE=stress` run documents the breaking point and the first bottleneck (API CPU, pool, RDS) | DEV, INFRA | | [ ] |
| L3 | HPA limits, `DATABASE_POOL_MAX` and RDS `max_connections` checked together; production overlay updated | DEV, INFRA | | [ ] |

### Security review

| # | Item | Owner | Evidence | Done |
| --- | --- | --- | --- | --- |
| S1 | [`security-review.md`](security-review.md) checklist complete, including the RLS tenant-isolation tests | DEV, SEC | | [ ] |
| S2 | No open critical or high findings (dependency audit, image scan, CodeQL/SAST) | DEV | | [ ] |
| S3 | IRSA, KMS and Secrets Manager setup reviewed in production | INFRA, SEC | | [ ] |
| S4 | Istio PeerAuthentication STRICT and AuthorizationPolicy principals confirmed in production | INFRA | | [ ] |
| S5 | Offboarding deletion tested end to end on staging | DEV | | [ ] |

### Runbooks and alerting

| # | Item | Owner | Evidence | Done |
| --- | --- | --- | --- | --- |
| R1 | Every alert in [`alerts.yaml`](../../deploy/prometheus/alerts.yaml) has a runbook section ([`runbooks.md`](runbooks.md)) | DEV | | [ ] |
| R2 | Alerts validated with injected failures on staging: API 5xx, worker down, classifier failure, webhook failure, migration failure (plan §8) | DEV, INFRA | | [ ] |
| R3 | Alertmanager routing agreed: who is paged for `critical`, where `warning` tickets go, inhibition of warning by critical | INFRA, PO | | [ ] |
| R4 | Grafana dashboard for API, ingestion, classifier, queues and guardrails, linked from the runbooks | DEV | | [ ] |
| R5 | `promtool check rules` and `deploy/scripts/sync-alerts.sh --check` run in CI | DEV | | [ ] |
| R6 | Rollback rehearsed on staging, including a release with a migration | DEV, INFRA | | [ ] |

### SLOs

| # | Item | Owner | Evidence | Done |
| --- | --- | --- | --- | --- |
| O1 | SLOs in [`slo.md`](slo.md) agreed (including the *proposed* freshness compliance target and error budget policy) | PO, DEV | | [ ] |
| O2 | SLIs visible on the dashboard with 30-day error budget remaining | DEV | | [ ] |
| O3 | SLOs met on the closed beta for 4 consecutive weeks (plan §5, deployment) | DEV | | [ ] |

### Self-serve onboarding and publisher docs

| # | Item | Owner | Evidence | Done |
| --- | --- | --- | --- | --- |
| D1 | A publisher connects Google Play and the App Store from the console without X3M help (tested with one publisher not in the beta) | PO, FE, DEV | | [ ] |
| D2 | Connection errors shown with actionable messages (missing permission, wrong role, revoked key) | DEV, FE | | [ ] |
| D3 | [Publisher onboarding guide](../publisher/onboarding.md) reviewed by PO, CSM and LEGAL, and published where Loomit publishes customer docs | PO, CSM, LEGAL | | [ ] |
| D4 | Google reports-bucket access and UTF-16 report encoding verified with a real publisher account (plan §3.1) and the guide adjusted if needed | DEV | | [ ] |
| D5 | CSM briefing: what the panel and guardrails show, `insufficient` and coverage states, how to escalate | CSM, PO | | [ ] |
| D6 | Support process for connection problems and data questions (owner, response times) | REVOPS, CSM | | [ ] |

### DPA

| # | Item | Owner | Evidence | Done |
| --- | --- | --- | --- | --- |
| A1 | Every question in [`dpa-checklist.md`](../legal/dpa-checklist.md) answered | LEGAL | | [ ] |
| A2 | DPA or DPA addendum covering ReviewSignal processing and sub-processors available for publishers | LEGAL | | [ ] |
| A3 | Retention periods and offboarding behavior configured to match the DPA | DEV, LEGAL | | [ ] |
| A4 | Hosting region confirmed and reflected in the Helm overlays | INFRA, LEGAL | | [ ] |

### Packaging and pricing

| # | Item | Owner | Evidence | Done |
| --- | --- | --- | --- | --- |
| B1 | Decision taken among the [packaging options](../business/packaging-options.md) | BIZ, PO | Decision record | [ ] |
| B2 | Cost per 1,000 reviews and per-tenant budget defaults set from production data | DEV, BIZ | | [ ] |
| B3 | Entitlement enforced (per-publisher flag or plan check) and budgets configured accordingly | DEV, BE | | [ ] |

## 3. Production readiness

| # | Item | Owner | Done |
| --- | --- | --- | --- |
| X1 | Production overlay has no placeholder values left (ECR, IRSA role, OIDC, CORS, buckets, webhook URL, Istio principals) | INFRA, DEV | [ ] |
| X2 | RDS: Multi-AZ, automated backups with tested restore, encryption, parameter group reviewed, service role without SUPERUSER/BYPASSRLS | INFRA | [ ] |
| X3 | Argo CD production Application on manual sync; promotion procedure documented | INFRA | [ ] |
| X4 | Success-metric instrumentation in place (plan §5): % publishers connected, % experiments with a conclusive guardrail, weekly panel viewers | DEV, PO | [ ] |
| X5 | Remaining open decisions from plan §9 closed or explicitly deferred with an owner | PO | [ ] |

## 4. GA decision

| Role | Decision | Date |
| --- | --- | --- |
| PO | | |
| INFRA | | |
| SEC | | |
| LEGAL | | |
| BIZ | | |
