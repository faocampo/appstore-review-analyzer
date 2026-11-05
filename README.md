# ReviewSignal

Review intelligence for Loomit publishers. ReviewSignal ingests written
reviews of apps the publisher owns, through the official Google Play and App
Store Connect APIs or private store exports. It classifies each review's
sentiment and primary reason and reports deterministic period metrics with an
explicit statement of data coverage.

It is being productized as a Loomit plugin. The plugin will show how a
publisher's reviews evolve, and will add reviews as a UX guardrail in Loomit
monetization experiments. The full plan is in
[`docs/productization-plan.md`](docs/productization-plan.md). This repository
currently holds the standalone service and dashboard: milestones M0–M1, plus
the server-side credential work from M2.

## What it provides

- **Sources**
  - Google Play `reviews.list` and App Store Connect `customerReviews`, for owned apps only.
  - Google Play and App Store CSV exports. UTF-16 Play Console reports are decoded on the server.
- **Classification** through a pluggable classifier layer:
  - **OpenRouter**, the production default, using strict structured outputs with no data collection and zero-data-retention routing;
  - **TypeSafe Jev**;
  - a transparent **rule-based mock** for local work.
- **Five-level sentiment and a controlled reason taxonomy**, both versioned by provider, model, prompt and taxonomy.
- **Data-coverage reporting** for each source:
  - pages fetched;
  - truncation at the page limit;
  - the ~7-day window of the Google Reviews API;
  - date semantics.

  Partial data is never presented as complete.
- **Resilience:**
  - retries with backoff for 429 and 5xx responses;
  - per-review failures are counted and excluded instead of aborting the run;
  - duplicate reviews are removed.
- **Security:**
  - bearer-token access control that fails closed in production;
  - per-client rate limits;
  - upstream error bodies are logged on the server and never returned to clients.
- **A dashboard built on the Loomit design system ("Calm Glass")**:
  - generated tokens;
  - self-hosted Red Hat Display and JetBrains Mono;
  - glass cards;
  - point-stating titles;
  - a SAMPLE DATA tag for demo data.

## Quick start

Requirements: Node.js 24 and npm 10+.

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. With `CLASSIFIER_PROVIDER=mock` (the local
default), the synthetic demo runs without any credentials.

## Configuration

All secrets are read only by server-side modules. See `.env.example` for
every variable.

| Area | Variables | Notes |
| --- | --- | --- |
| Access | `ANALYZE_API_TOKEN`, `ANALYZE_RATE_LIMIT_PER_MINUTE` | **Required in production.** Without the token, `/api/analyze` returns 503 when `NODE_ENV=production`. This is an interim measure until Loomit OIDC is in place. |
| Classifier | `CLASSIFIER_PROVIDER` = `openrouter` \| `jev` \| `mock` | Default is `openrouter` in production and `mock` elsewhere. The legacy `ANALYSIS_MODE=jev\|mock` is still honored. |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BATCH_SIZE`, `OPENROUTER_ZDR` | The model must be pinned explicitly. Requests always send `provider.data_collection: "deny"`. Zero-data-retention routing is on unless `OPENROUTER_ZDR=false`. |
| Jev | `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | One request per review. |
| Google Play | `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (raw or base64) or `GOOGLE_APPLICATION_CREDENTIALS` | Tokens are minted and refreshed on the server with `google-auth-library`. `GOOGLE_PLAY_ACCESS_TOKEN` is a manual fallback. |
| App Store Connect | `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (`.p8` PEM or base64) | An ES256 JWT with a 15-minute TTL is signed on the server with `jose` and cached. `APPLE_APP_STORE_CONNECT_TOKEN` is a manual fallback. |
| Limits | `GOOGLE_PLAY_MAX_PAGES`, `APPLE_MAX_PAGES` (max 50); `CLASSIFIER_CONCURRENCY`, `CLASSIFIER_MAX_RETRIES`, `CLASSIFIER_TIMEOUT_MS` | |

[`USER-GUIDE.md`](USER-GUIDE.md) walks through creating least-privilege store
credentials.

## How analysis works

1. Connectors normalize store records into one written-review model and
   report coverage. Apple pagination stops once it reaches reviews older than
   the start date.
2. Reviews are deduplicated by store and review ID, then filtered to the
   inclusive UTC period. Google API reviews are placed in the period by their
   last-modified date, and the response labels this as `period.membership`.
3. The selected `ClassifierProvider` classifies reviews in batches. Text is
   classified in its original language; no machine translation is applied.
4. Application code computes every count, average, distribution and ordering.
   The LLM is never asked to do arithmetic.

**Average sentiment** is the mean of each review's expected sentiment on the
0–4 scale:

- **Probability-weighted**, `Σ score × probability`, when the provider returns
  a valid five-level distribution. This applies to the mock and to Jev when
  its distribution is complete.
- **The provider's own score** otherwise. This applies to OpenRouter and to
  incomplete Jev distributions.

The estimator used is reported in `metrics.sentimentEstimator`.

## API

`POST /api/analyze` takes the header `Authorization: Bearer <ANALYZE_API_TOKEN>`
and this body:

```json
{
  "appName": "My app",
  "sourceMode": "live_api",
  "startDate": "2026-10-01",
  "endDate": "2026-10-31",
  "lastN": 20,
  "androidPackage": "com.company.app",
  "appleAppId": "123456789"
}
```

- `sourceMode` is `demo`, `live_api` or `csv`.
- CSV files are sent as `{ name, platform, encoding: "text" | "base64", content }`. The dashboard sends `base64`, so UTF-16 Play reports decode correctly.
- The response adds `classifier`, `coverage[]`, `metrics.reviewsUnclassified`, `metrics.sentimentEstimator` and `period.membership` to the original fields.

Errors:

| Status | Meaning |
| --- | --- |
| `400` | Invalid input |
| `401` / `503` | Access control |
| `422` | No reviews in the period |
| `429` | Rate limited |
| `502` | Upstream or classifier failure, with a safe message |
| `500` | Generic internal error |

## Store limitations

- **Google Play.**
  - The Reviews API only returns commented reviews from about the last 7 days, and it exposes only a last-modified timestamp.
  - Periods that start earlier are flagged `partial`. Use Play Console reviews reports for history.
- **App Store Connect.**
  - Reviews are returned newest-first.
  - When the page limit is reached before the period's start date, the source is flagged `partial`.
- **Ratings.** The rating shown is the average of **written reviews only**. Both APIs exclude star-only ratings.

## Design system

The UI is built on the org's **loomit** Design System ("Calm Glass"):

- `design/loomit-tokens.json` is a copy of the design system's token export.
- `npm run tokens` regenerates `src/app/loomit-tokens.css`, and CI fails if the generated file is stale.
- The fonts in `public/fonts` are the design system's static Red Hat Display and JetBrains Mono files, both under the SIL OFL 1.1.
- Product-UI adaptations follow the Loomit visual proposal: 16px card radius and weights 400/600/700, with 800 for big numbers.

## Verification

```bash
npm run lint
npm run typecheck
npm run test:coverage   # ≥ 90% branches, functions, lines, statements
npm run build
```

CI (`.github/workflows/ci.yml`) runs all of these, plus the token-freshness
check, on every pull request.

## Architecture (current service)

```text
Browser dashboard (Loomit design system)
      │  Bearer token
      ▼
POST /api/analyze ── access control + rate limit
      │
      ├─ connectors/google-play        ◄─ credentials/google (service account → OAuth)
      ├─ connectors/app-store-connect  ◄─ credentials/apple (ES256 JWT)
      └─ connectors/csv (UTF-8/UTF-16)
      │
      ▼  normalize → dedupe → period filter
classifiers/run ── ClassifierProvider: openrouter | jev | mock
      │  batched, retried, per-review failures counted
      ▼
aggregate → metrics + coverage + notices
```

This project does not scrape public store pages or analyze competitor apps.
