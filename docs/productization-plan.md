# ReviewSignal → Loomit plugin: productization plan

> ## Implementation scope of the first PR
>
> The full plan (below) spans about 15 weeks and depends on Loomit repositories, infrastructure and teams outside this repository: Postgres/EKS, the console embed, the Kotlin readout and historical experiments. This PR therefore delivers everything that can be built **and verified locally** inside the existing Next.js app, without breaking the current `/api/analyze` contract. It covers the M0 hardening, the M1 classifier layer, the M2 credential work and the §3.7 look & feel.
>
> **1. Hardening and metric honesty (M0)**
> - Bearer-token gate on `/api/analyze`, controlled by `ANALYZE_API_TOKEN`. This is an interim measure until Loomit OIDC is in place.
> - In-memory per-IP rate limit.
> - Upstream error bodies are logged server-side only; clients get generic messages.
> - Response adds per-store `coverage` with `pagesFetched`, `truncated` and `dateSemantics`, and the UI shows it.
> - `period.membership` reflects last-modified semantics when Google is the source.
> - A notice appears when the requested range exceeds the ~7-day Google API window.
> - Apple pagination stops early once reviews are older than `startDate`.
> - Reviews are deduplicated by `(store, id)`.
> - CSV files are decoded as UTF-16 or UTF-8 (BOM detection) from base64 or text.
> - Translation is used for display only (`translationLanguage` is no longer sent for classification).
> - The README and USER-GUIDE sentiment formula is aligned with the code.
>
> **2. Classifier layer (M1)**
> - New `src/lib/classifiers/`:
>   - `provider.ts` holds the `ClassifierProvider` interface with versions.
>   - `mock.ts` wraps the existing mock.
>   - `jev.ts` is the existing code with label-based mapping, probability length/sum validation, and per-batch `classify`.
>   - `openrouter.ts` uses structured outputs with a JSON schema built from the taxonomy, batches of about 20, Zod validation, retry/backoff and timeout, and provider preferences for no data collection.
>   - `index.ts` selects the provider via `CLASSIFIER_PROVIDER` (`openrouter` | `jev` | `mock`; legacy `ANALYSIS_MODE` still honored).
> - A per-review failure marks the review `unclassified` (excluded from averages, counted in a notice). It never aborts the run.
> - `OPENROUTER_MODEL` is required and pinned (no hard-coded default model).
> - The OpenRouter request shape was verified against the current OpenRouter docs:
>   - `POST https://openrouter.ai/api/v1/chat/completions`
>   - `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`
>   - `provider: { data_collection: "deny", zdr: true }`, configurable through `OPENROUTER_ZDR` (default `true`).
>   - The output is read from `choices[0].message.content` (a JSON string) and validated with Zod.
> - Taxonomy v2 (ad sub-reasons) and the eval harness are deferred to the next PR.
>
> **3. Server-side credentials (part of M2)**
> - Google: mint OAuth tokens from service-account JSON (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`) with `google-auth-library`.
> - Apple: sign an ES256 JWT per request from `APPLE_ISSUER_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` with `jose`.
> - Static tokens remain a fallback.
> - Remove `tools/google-play-token-minter.py`.
>
> **4. Look & feel (§3.7)**
> - Generate `src/app/loomit-tokens.css` from the design system's `project/tokens.json` (light only).
> - Self-host Red Hat Display and JetBrains Mono from the design-system artifact's `project/fonts` (SIL OFL) under `public/fonts`.
> - Rebuild `globals.css` and `page.tsx` on glass cards, the chart and status mapping, sentence-case point titles, mono eyebrows, the SAMPLE DATA tag for demo, and most icons removed.
> - Screenshots with Playwright at 2x for review.
>
> **5. CI**
> - `.github/workflows/ci.yml`: lint, typecheck, test with coverage (90% gate), build.
>
> **Out of scope for this PR (tracked in the plan):** Postgres/worker/Fastify split, ingestion scheduling, rollups, guardrails G1–G4, Loomit OIDC/console embed, Helm/ArgoCD, eval set, taxonomy v2.
>
> **Verification:** `npm run lint`, `npm run typecheck`, `npm run test:coverage` (≥ 90%), `npm run build`; new unit tests for every adapter (mocked fetch), auth/rate-limit, coverage/truncation, dedup, UTF-16 CSV and JWT signing; run the dev server in demo/mock mode and capture Playwright screenshots of the restyled dashboard. Then commit, push, open a draft PR and subscribe to its activity.

## Context

ReviewSignal is currently a standalone Next.js MVP. Each query fetches reviews on demand (store APIs or CSV), classifies them with TypeSafe Jev or a mock classifier, and aggregates deterministically. Nothing is persisted.

The earlier analysis found four groups of problems:

- **Deployment blockers.** `/api/analyze` has no auth or rate limit. Store tokens are pasted in by hand and expire within minutes to an hour.
- **Overstated completeness.** Google results are filtered by `lastModified` but labeled `created_at`, and the Google API only covers about 7 days. Page-limit truncation is silent. The documented sentiment formula differs from the one in the code. Translation applies to Android only, and reviews are not deduplicated.
- **Robustness.** All work runs in one synchronous request with no retries, and a single Jev error aborts the whole analysis.
- **CI.** Only CodeQL runs. Lint, typecheck and tests do not run in CI.

**Product goal:** turn it into a Loomit plugin that gives publishers:

1. **How their reviews evolve** over time, by period, app version, store and country.
2. **Reviews as a UX guardrail** for Loomit monetization experiments, alongside ARPDAU, IMPDAU, revenue and request volume.

**Decisions already made:**

- **Stack:** a TypeScript service on EKS with Postgres. The UI is embedded in the Loomit console.
- **Classifier:** a provider abstraction layer with three adapters:
  - Jev, built from the existing code.
  - **OpenRouter, the production default.**
  - Mock.
- **Guardrails v1:** alerts plus a panel in the experiment readout. **No automated actions.**
- **Capacity:** 1 full-time developer, with occasional help from frontend, Kotlin backend, infra and RevOps.

---

## 1. Requirements

**Functional**
- **F1.** A publisher connects Google Play and/or the App Store for their Loomit apps through guided onboarding.
- **F2.** Continuous incremental ingestion plus a historical backfill:
  - Apple through its API.
  - Google through Play's GCS review reports, with CSV as a fallback.
- **F3.** Classification of 5-level sentiment and of the review's reason, using a v2 taxonomy with ad sub-reasons. Each classification records the provider, model and prompt version.
- **F4.** An evolution panel showing:
  - sentiment and written-review rating over time;
  - release markers (`appVersion`);
  - reason trends;
  - breakdowns by store, version and country;
  - a drill-down to individual reviews;
  - a data-coverage indicator.
- **F5.** Review guardrails in every Loomit experiment readout, plus degradation alerts to the publisher and to X3M.
- **F6.** An internal X3M admin view: ingestion health per tenant, costs, reprocessing.

**Non-functional**
- Strict tenant (publisher) isolation.
- Ingestion lag under 6 h (p95).
- Panel API under 500 ms (p95), reading pre-aggregated data.
- Classification cost capped per tenant, with a budget and an alert.
- Data is never presented as complete when it isn't: every day carries a coverage status (`complete`, `partial` or `unknown`).
- Publisher credentials encrypted (AWS Secrets Manager + KMS) and audited.
- Compliance with the publisher DPA and the store API terms. **Legal must verify both.**

**Key methodological constraint for guardrails**

Reviews carry no user identifier, so they cannot be attributed to an experiment arm. The guardrail is therefore **observational**, unless the arms differ along a dimension that reviews do carry. The readout must label which mode was used:

- **Dimension-attributable:** the arms differ by app version, country or platform. Compare the arms directly.
- **Pre/post with controls:** the experiment covers the whole app. Compare the experiment window against a baseline and against control apps or countries, and flag confounders such as releases, seasonality and UA campaigns.
- **Insufficient:** below the minimum sample size. Show "insufficient data" and give no verdict.

---

## 2. Target architecture (C4 container level)

```
 Publisher ──► Loomit Console (Phantom) ──embed──► ReviewSignal UI (React package)
                     │ Loomit OIDC/JWT                         │
                     ▼                                         ▼
          Loomit backend (Kotlin) ◄──REST (OpenAPI)──► reviewsignal-api (TS, Fastify)
          - experiments, apps, DAU                          │        │
          - readout + notifications                         │        ▼
                     ▲                                      │   Postgres (tenant-scoped, RLS)
                     │ guardrail results / webhook          │        ▲
                     └──────────────────────────────────────┘        │
                                                         reviewsignal-worker (TS, pg-boss)
                                                          ├─ connectors: Google Play API / GCS reports, ASC API, CSV
                                                          ├─ classifier: ClassifierProvider → OpenRouter | Jev | Mock
                                                          ├─ daily rollups
                                                          └─ guardrail evaluator
                                                                   │
                         AWS Secrets Manager/KMS ◄─────────────────┘   S3 Parquet export → Databricks/Druid
```

**Design decisions and trade-offs**

- **One image, two deployables (`api` and `worker`), one repo.**
  - Gains: all of `src/lib` is reused, and ingestion scales separately from the API.
  - Cost: no repo per service, which a team of one doesn't need.
- **Postgres job queue (pg-boss), not BullMQ or SQS.**
  - Gains: jobs are transactional with the data, and no new infrastructure is needed.
  - The throughput ceiling is far above expected review volume. Revisit above about 10M jobs/day.
- **Fastify for the API; Next.js kept only as a dev/demo harness.**
  - The consumers are the Loomit console and the Kotlin backend, and an OpenAPI contract is more stable for them than Next route handlers.
  - **This depends on how the Loomit console embeds third-party UI** (micro-frontend or iframe with SSO). Confirm in M0.
- **Pre-computed daily rollups** per app, store, date, version and country. The panel reads aggregates and never recomputes from raw reviews. The rollups reuse the logic in `src/lib/aggregate.ts`.
- **S3 Parquet export**, so reviews can be joined with ARPDAU, IMPDAU and DAU in Databricks or Druid without coupling ReviewSignal to those systems.

### Data model (Postgres)

| Table | Content / keys |
|---|---|
| `tenant` | `loomit_publisher_id` |
| `app` | `tenant_id`, `loomit_app_id`, `android_package`, `apple_app_id` |
| `store_connection` | `app_id`, `store`, `secret_ref` (ARN), `status`, `last_verified_at` |
| `review` | PK `(store, store_review_id)`, `app_id`, `created_at`, `last_modified_at`, `date_semantics`, `rating`, `title`, `body`, `language`, `territory`, `app_version`, `text_hash`, `source`, `first_seen_at` |
| `classification` | `review_id`, `text_hash`, `provider`, `model`, `prompt_version`, `taxonomy_version`, `sentiment_score`, `sentiment_ev`, `sentiment_probs` (nullable), `primary_reason`, `secondary_reason`, `reason_probs` (nullable), `confidence`, `cost_usd`; UNIQUE `(review_id, text_hash, model, prompt_version)` |
| `ingestion_run` | `app_id`, `store`, `window`, `pages`, `truncated`, `status`, `error`, `rate_limited` |
| `coverage_day` | `app_id`, `store`, `date`, `status` (`complete` / `partial` / `unknown`) |
| `review_daily_rollup` | `app_id`, `store`, `date`, `app_version`, `territory`, `n`, `sum_ev`, `sum_rating`, `reason_counts` (jsonb), `model_version` |
| `guardrail_rule` / `guardrail_evaluation` / `alert` | rule, threshold, minimum N, attribution mode; result per experiment and window |
| `audit_log` | credential access, rule changes |

Row-level security (RLS) by `tenant_id`, with mandatory tenant-isolation tests.

### Sequence: guardrail evaluation

```
Loomit (Kotlin)          reviewsignal-api                worker
   │ POST /v1/experiments/{id}/link  (arms, dimension, start/end, baseline window)
   │──────────────────────────────►│ persist link
   │                                │ enqueue evaluate(exp)  ──────►│ (hourly cron + on window close)
   │                                │                               │ read rollups (same model_version)
   │                                │                               │ check coverage_day + minimum N
   │                                │                               │ compute metrics + statistical test
   │                                │◄──────── guardrail_evaluation │
   │◄── webhook / GET /v1/experiments/{id}/guardrails (status: ok | warn | breach | insufficient)
   │ readout panel + notification (publisher + X3M CSM)
```

---

## 3. Component deep dive

### 3.1 Connectors and ingestion
This refactors `src/lib/google-play.ts`, `src/lib/app-store-connect.ts` and `src/lib/csv.ts`.

**Common interface.** `ReviewConnector.sync({ app, watermark }) → { reviews, newWatermark, truncated, coverage }`.
- Connectors stop filtering by period. They sync incrementally from a watermark.
- Writes are idempotent upserts keyed by store review ID.
- A `text_hash` change triggers reclassification.

**Google Play**
- One **X3M service account**. The publisher invites it in Play Console with read-only app-info and reviews access.
- The OAuth token is minted server-side with `google-auth-library`. This replaces `tools/google-play-token-minter.py`.
- Poll every 1–3 h, because the API window is only about 7 days.
- Backfill from the `pubsite_prod_*` reports bucket. *Verify two things: that this permission grants bucket access, and that reports are UTF-16 encoded.*
- Set `date_semantics = last_modified_fallback` when applicable, and expose it in the API and UI.

**App Store Connect**
- The publisher creates a least-privilege API key (Customer Support role) and uploads it with the issuer ID and key ID. The key is stored in Secrets Manager.
- The ES256 JWT is minted per request with `jose`, with a TTL of 15 minutes or less.
- Pages are read newest-first, **stopping at the watermark or the requested date**.
- 429 responses are handled with `Retry-After` and a per-key request budget.
- Full backfill uses the same API.

**CSV.** Kept as a fallback and as a manual backfill path. Changes:
- encoding detection (UTF-16, and UTF-8 with BOM);
- dedup by store review ID;
- upload through an S3 presigned URL instead of an 8 MB string in the JSON body.

**Coverage.** Every run writes `coverage_day`:
- `partial` when the run was truncated or a store failed;
- `unknown` when the day is outside the API window and there is no backfill.

**Translation.** Classify the **original text** with a multilingual model. `translationLanguage` is used for display only, never for classification. This removes the cross-store bias.

### 3.2 Classification layer (`ClassifierProvider`)
```ts
interface ClassifierProvider {
  id: string;                       // "openrouter" | "jev" | "mock"
  model: string; promptVersion: string; taxonomyVersion: string;
  capabilities: { probabilities: boolean; maxBatch: number };
  classify(batch: ReviewForClassification[]): Promise<ClassificationResult[]>; // per item: ok | error
}
```

**`MockAdapter`.** Wraps `src/lib/mock-classifier.ts` without changing its behavior.

**`JevAdapter`.** Built from `src/lib/jev.ts`, with these fixes:
- validate the probability array's length and that it sums to about 1;
- map probabilities by label instead of by position;
- after confirming the contract with TypeSafe, document that `sentiment_ev` is the provider's `score`.

**`OpenRouterAdapter` (production default)**
- Structured outputs with a JSON schema generated from the taxonomy's Zod schemas.
- Batches of about 20 reviews per call, returned keyed by review ID, validated with Zod, retried per item.
- The model is pinned and set through configuration.
- OpenRouter data policy: data collection denied and zero-retention providers only. *Verify the exact OpenRouter options and DPA fit.*
- `sentiment_probs` is null when the model has no reliable distribution. In that case `sentiment_ev` is the integer score, and the aggregate states which estimator it used.

**Routing and resilience**
- Timeout, retry with backoff, and a circuit breaker.
- A configurable fallback to a second OpenRouter model or to Jev.
- Failures are per item: a failed review is marked `unclassified` and **never aborts the batch**.
- A daily budget per tenant, with a soft cutoff and an alert.

**Cache.** The unique key `(review_id, text_hash, model, prompt_version)` means reviews are never reclassified on read.

**Versioning and baselines**
- A model or prompt change produces a new `model_version` in the rollups.
- Guardrails only compare rollups that share the same `model_version`.
- When the default model changes, a job reclassifies the baseline window.

**Taxonomy v2.** Split `ads` into sub-reasons that matter to Loomit:
- excessive frequency;
- intrusive or non-closable;
- inappropriate content (links to Ad Quality);
- ads with audio;
- rewarded ad did not grant the reward;
- ad breaks gameplay (crash or freeze).

Also add an optional `secondary_reason`, and version the taxonomy.

**Evaluation harness** (`eval/`)
- A labeled set of 400–500 reviews in the publishers' main languages (at least ES, EN and PT). A double-annotated subset measures inter-annotator agreement.
- Metrics:
  - reason macro-F1, including the ad sub-reasons;
  - sentiment MAE and quadratic weighted kappa (QWK);
  - cost per 1,000 reviews;
  - p95 latency.
- **Gate:** the default OpenRouter model must match or beat Jev at or below the target cost per 1,000 reviews. The threshold is set after measuring inter-annotator agreement.

### 3.3 Panel metrics (evolution)
- Average sentiment (EV) and written-review rating by day, week and version, with confidence intervals (bootstrap or Wilson, depending on the metric).
- The share of each reason within negative reviews.
- **Ad-related negative reviews per 100k DAU.** DAU comes from the Loomit analytics API or from Druid. *Confirm the source.*
- The change from the previous app version, to catch post-release regressions.
- Every series shows coverage and N. Below the minimum N it shows "insufficient" instead of a number.

### 3.4 Guardrails v1 (alerts + readout, no automated actions)

**Metrics per experiment**

| ID | Metric | Comparison and test |
|---|---|---|
| G1 | Share of negative reviews whose reason is ads | Experiment arm or window vs. control or baseline; two-proportion or beta-binomial test with minimum N |
| G2 | Sentiment EV | Change vs. control or baseline |
| G3 | Ad-related negative reviews per 100k DAU | Change vs. control or baseline |
| G4 | Written-review rating | Change vs. control or baseline |

**Statuses.** `ok`, `warn`, `breach` or `insufficient`.
- The attribution mode (see §1) is always shown.
- Confounders are flagged automatically: releases inside the window and coverage changes.

**Calibration.** Before alerts are enabled, backtest the default thresholds on historical Loomit experiments to measure the false-positive rate. Thresholds can be set per publisher.

**Readout decision rule.** Net benefit (revenue, ARPDAU, IMPDAU) **subject to request-volume and UX guardrails**. Reviews add a UX guardrail; they don't replace the others.

**Alerts.** Delivered through Loomit's notification system (a Kotlin dependency), with cool-down and deduplication. They go to the publisher and to the X3M CSM.

### 3.5 API and security

**OpenAPI v1 endpoints**
- `/v1/apps/{id}/connections`
- `/v1/apps/{id}/timeseries`
- `/v1/apps/{id}/reasons`
- `/v1/apps/{id}/reviews` (paginated)
- `/v1/apps/{id}/coverage`
- `/v1/experiments/{id}/link`
- `/v1/experiments/{id}/guardrails`
- `/v1/admin/*`

**Security**
- Authentication with the Loomit JWT/OIDC. Tenant and app scope come from the token claims.
- Service-to-service traffic uses Istio mTLS with an AuthorizationPolicy.
- Rate limit per tenant.
- Upstream errors are logged and **never returned to the client**.
- An `audit_log` of credential access, plus key rotation.
- Data and secrets are deleted when a tenant offboards.
- Configurable data retention, and a DPA. *Legal must verify the Google and Apple API terms on third-party (LLM) processing.*

### 3.6 Platform
- **Deployment:** multi-stage Dockerfile, a Helm chart with `api` and `worker`, delivered through ArgoCD. External Secrets syncs from Secrets Manager.
- **CI:** lint, typecheck, tests with the 90% coverage gate, image build, dependency scan and CodeQL. *Decide whether the repo stays on GitHub or moves to GitLab like the rest of Loomit.*
- **Prometheus metrics:**
  - ingestion lag, pages per run, 429s, and days marked `partial` or `unknown`;
  - classifier latency, errors and cost;
  - queue depth;
  - API p95.

  Alerts ship with runbooks.
- **SLOs:**
  - ingestion freshness under 6 h for 95% of connected apps;
  - API availability of 99.5%.

### 3.7 Look & feel: Loomit design system ("Calm Glass")

All ReviewSignal UI follows the Loomit design system. This covers the evolution panel, the experiment-readout guardrail panel, onboarding and admin.

**Sources**
- **Tokens and brand:** the org's **loomit** Design System artifact (https://claude.ai/artifact/TAwXTMrnXQWgJuxLxhK2Rd).
  - `project/tokens.json`: colors, type, radius, shadows, gradients.
  - `project/README.md`: content and visual rules.
  - `project/fonts/*`: the static font files.
- **Product-UI rules:** the **Loomit · Visual proposal** artifact (https://claude.ai/artifact/GosLjReB99We9LfHuWtA3j). It applies the same Calm Glass tokens to the product console: side menu, cards, 13 chart variants, tables, status badges, and dark mode built on the same tokens.

**What carries over to the product UI**

*Color.* Use the semantic tokens only.
- Text tokens: `fg`/`fg-2`/`fg-3` (ink #013240 / #3F5056 / #5E7076).
- Brand: `brand` #024A5E for hero numbers and the highlighted series.
- Background: `paper` #F7F9F9.
- Accents: mint #00FFB6 and lime #DDEF30, **on dark surfaces only and never as text on light**. Lime is reserved for the one key number on a dark surface and for markers.
- **No other colors.**

*Typography*
- **Red Hat Display** for all UI text.
- **JetBrains Mono** for eyebrows, labels, pills, table numbers and copyable IDs (review IDs, package names, Apple IDs).
- Big numbers use ExtraBold with tabular figures.

*Surfaces.* Glass cards are the only surface. Use the system's card variants:
- glass;
- one `brand` highlight card per view, used for the headline KPI;
- `chip` for small items.

No custom fills, accent bars, thick borders or decorative lines.

*Charts*

| Element | Token / style |
|---|---|
| Main series (sentiment EV, or the test arm) | `chart-blue` #00789A |
| Control or baseline | `chart-grey` #AEBBC0, dashed |
| Additional reason series in share bars | `chart-olive`, `chart-cobalt` |
| Non-top bars in rankings | `bar-grey` |
| Gridlines | `grid` |
| Experiment start and release markers | Lime pill with a dashed `start-line` (this is the system's TEST START marker) |
| Labels | Values at the end of the line |

*States*
- Guardrail statuses map to pills: `ok` is `positive` on `positive-bg`; `breach` is `negative` on `negative-bg`, mono pills only. `warn` and `insufficient` use a neutral pill.
- Ingestion and connection status use the status dots: `dot-strong` for syncing or optimizing, `dot-on` for active, `dot-off` for paused or incomplete.
- **The status word is always shown.** Color only reinforces it.

*Content rules*
- English copy in sentence case.
- Titles state the point. For example, "Ad complaints rose after v4.2", not "Reason trends".
- Eyebrows give context, for example "Reviews · last 30 days" or "Test vs. control · ad complaints".
- One message per card.
- **Never invent numbers.** Missing or insufficient data shows as a visible gap, consistent with the `insufficient` and coverage states in §1.
- Demo data carries the **SAMPLE DATA** tag.

**What does not carry over**
The deck-only rules: the 960×540 canvas, slide coordinates (title-y, content-bottom and so on) and the slide patterns themselves. They inform layout but are not reused literally:
- `LineCalloutSlide` becomes the guardrail chart in the readout.
- `KpiCardsSlide` and `KpiTrioSlide` become the panel KPI row.
- `TableSlide` becomes the review drill-down table.
- `TimelineSlide` becomes the onboarding steps.

**Conflicts to resolve with the design-system owner in M0**

| Topic | Design System artifact (decks) | Visual proposal (product UI) | Plan default |
|---|---|---|---|
| Card radius | 32px | 16px, with a 24px blur | Visual proposal |
| Medium (500) weight | Used | Never used (400/600/700 only) | Visual proposal |
| Icons | None at all | Not stated | Minimal: drop most `lucide-react` usage from the current `page.tsx` |

**Implementation**
- A `@loomit/tokens` CSS-variables file is generated from `project/tokens.json`, so the values are never retyped.
- Fonts are self-hosted from the design system's static files.
- The ReviewSignal UI ships as a React package that consumes the console's own components and tokens when embedded. In standalone or dev-harness mode it uses the generated CSS.
- `src/app/globals.css` and `src/app/page.tsx` are rebuilt on these tokens and patterns.
- Light mode ships first. Dark mode follows the Visual proposal: it changes token values only, never components.

---

## 4. Milestones (1 full-time dev, about 15 weeks to GA)

Dates are tentative and assume a start on Monday 2026-11-16. They are not commitments and depend on the actual staffing decision.

| # | Weeks | Deliverables | Environment | Exit gate |
|---|---|---|---|---|
| **M0 Foundations** | 1–2 (Nov 16–27) | Restructure into `core`, `connectors`, `classifiers`, `api` and `worker`, reusing `src/lib`; Postgres schema and migrations; docker-compose; full CI. Fixes from the analysis: no upstream error echo, `date_semantics` and `truncated` in the response, docs aligned with the code's sentiment formula. ADRs for console embedding, CI platform and DAU source | Local | CI green; ADRs approved |
| **M1 Classification** | 3–5 (Nov 30–Dec 18) | `ClassifierProvider` with Mock, Jev and OpenRouter adapters; batching, retries and cache; taxonomy v2; eval harness and labeled set (about 3 RevOps days) | Local + staging (real keys) | **Default model decision**, based on eval and cost data |
| **M2 Ingestion** | 5–8 (Dec 14–Jan 15) | Server-side credentials (Google service account, Apple JWT); incremental connectors with watermarks; Apple and GCS backfill; CSV through S3; `coverage_day`; pg-boss; Prometheus metrics | Staging, 2 design-partner apps | 14 days of ingestion with no manual intervention; coverage measured |
| **M3 API + panel** | 8–11 (Jan 11–Feb 5) | OpenAPI v1; Loomit auth and RLS; rollups; evolution panel embedded in the console (about 1.5 weeks of Loomit frontend) and built on the Loomit design system (§3.7): generated tokens, self-hosted fonts, glass cards, the chart and status mapping | Staging, then prod (closed beta) | Design review signed off against the Loomit design system; 2–3 beta publishers using the panel weekly |
| **M4 Guardrails** | 11–14 (Feb 1–26) | Experiment linking; attribution modes; G1–G4; backtest and calibration; alerts; readout panel (about 1 week of Kotlin backend) | Staging + historical backtest | Backtest false-positive rate below the agreed target; readout live on beta experiments |
| **M5 GA** | 14–15 (Feb 22–Mar 5) | Load test; security review; runbooks; SLOs; self-serve onboarding; publisher docs; DPA; packaging and pricing decision | Prod | GA checklist closed |

The overlaps are intentional. M2 starts while the M1 evaluation runs, and the M4 backtest can begin on staging data.

**Dependencies outside the assigned developer (estimates)**
- Loomit frontend: about 1.5 weeks.
- Kotlin backend (experiment linking, readout, notifications): about 1 week.
- Infra/DevOps (Helm, ArgoCD, secrets, Istio): 3–4 days.
- RevOps or support labeling: about 3 days.
- Legal (DPA, store terms, OpenRouter): asynchronous, and must close before M3 goes to prod.

**Opportunity cost.** About 3.5 dev-months plus roughly 3 weeks spread across other teams. The current roadmap was not verified when this plan was written. A decision is still needed on **which initiative slips** (for example Phantom, Pricefloor Engine or another), depending on where the developer comes from.

---

## 5. Success metrics

Each stage is measured separately: implementation, deployment, adoption and impact.

**Deployment**
- Ingestion and API SLOs met for 4 consecutive weeks.

**Adoption**
- % of active Loomit publishers with at least one store connected.
- % of active experiments whose review guardrail is not `insufficient`.
- Weekly panel viewers.

**Quality**
- Reason macro-F1 and sentiment QWK above the gate threshold.
- % of days with `complete` coverage.
- Cost per 1,000 reviews.

**Impact**
- Number of experiments where the guardrail changed the decision, as documented in the readout.
- Time to detect a post-release degradation, compared with today's baseline (manual or none).

---

## 6. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Low review volume leaves guardrails underpowered | Minimum N, pooled windows, normalization by DAU, explicit `insufficient` status |
| Reviews can't be attributed to experiment arms | Labeled attribution modes; recommend country- or version-split experiments when the review guardrail is critical |
| Apple onboarding friction (an Admin must create the key) | Guided onboarding; Google first (it only needs a service-account invite); CSV fallback |
| A model or provider change breaks baselines | Pinned model, `model_version` in rollups, baseline reclassification |
| Dependency on OpenRouter | Fallback to another model or to Jev through the same interface |
| Store terms or DPA on LLM processing | Legal gate before prod; OpenRouter data policy; reviewer nickname never sent (already true today) |
| LLM cost | Cache, batching, per-tenant budget, cost per 1,000 reviews metric |

---

## 7. Critical files and reuse

| Current file | Change |
|---|---|
| `src/lib/types.ts` | Extend `Classification` with provider, model, prompt and taxonomy versions, and make probabilities optional; add coverage types |
| `src/lib/aggregate.ts` | Basis for rollups and panel metrics; reuse the rounding and distribution logic |
| `src/lib/jev.ts` | Becomes `classifiers/jev.ts`, with the mapping and validation fixes |
| `src/lib/mock-classifier.ts` | Becomes `classifiers/mock.ts` |
| `src/lib/google-play.ts`, `src/lib/app-store-connect.ts` | Become `connectors/*`: incremental with watermarks, 429 handling, server-side token minting |
| `src/lib/csv.ts` | Becomes `connectors/csv.ts`, with encoding detection and dedup |
| `src/lib/schema.ts` | Its Zod patterns are reused for the v1 API DTOs |
| `src/app/api/analyze/route.ts` | Deprecated and replaced by the Fastify API; the Next page stays as a demo harness |
| `tools/google-play-token-minter.py` | Removed once tokens are minted server-side |
| `src/app/page.tsx`, `src/app/globals.css` | Rebuilt on Loomit design-system tokens and patterns (§3.7); most `lucide-react` icons removed |

New: `migrations/`, `eval/`, `deploy/helm/`, and `.github/workflows/ci.yml` (or `.gitlab-ci.yml`).

---

## 8. End-to-end verification

- **Unit:** vitest, keeping the 90% coverage gate, plus tenant-isolation tests against RLS.
- **Contract:** recorded fixtures for Google, Apple, Jev and OpenRouter, plus msw fake servers for 429s, pagination, truncation and UTF-16.
- **Eval:** `npm run eval -- --provider openrouter --model <m>` against the labeled set, producing a comparison report.
- **Local:** `docker compose up` (Postgres, api, worker, fake stores), plus the panel in the Next harness.
- **Staging:** 2 design-partner apps with 14 days of ingestion. Spot-check counts against Play Console and App Store Connect.
- **Guardrails:** backtest on historical Loomit experiments to measure false-positive and alert rates.
- **Look & feel:** Playwright screenshots of every panel state: data, insufficient, partial coverage, breach and SAMPLE DATA, in light mode and later dark. Reviewed against the design-system artifact. An automated contrast check covers every text/background token pair used.
- **Prod:** closed beta behind a per-publisher flag. Prometheus dashboards and alerts are validated with injected failures.

---

## 9. Open decisions to close in M0

1. How the Loomit console (Phantom) embeds the UI: micro-frontend or iframe with SSO.
2. Repo and CI: GitHub Actions or GitLab CI.
3. DAU source for normalization: Loomit API, Druid or Databricks.
4. OpenRouter model shortlist and data policy.
5. Packaging: included in Loomit or sold as an add-on.
6. Who is the assigned developer, and which initiative slips.
7. Design-system conflicts (§3.7): card radius, the 500 weight, icon policy. Also whether the console exposes its components to embedded plugins or ReviewSignal ships its own token-based implementation.
