# ReviewSignal

Cross-platform sentiment analysis for reviews of apps you own. The MVP ingests written reviews through official Google Play and App Store Connect APIs or store-export CSV files, classifies each review with TypeSafe Jev (or a credential-free mock classifier), and presents deterministic period metrics.

## What the MVP provides

- Google Play `reviews.list` ingestion for owned production apps
- App Store Connect `customerReviews` ingestion for owned apps
- Google Play and generic App Store review CSV ingestion
- Five-level sentiment classification:
  - highly negative
  - negative
  - neutral / mixed
  - positive
  - highly positive
- Controlled primary-reason taxonomy for ads, stability, performance, account access, billing, features, usability, support, privacy, pricing, update regressions, compatibility, praise, and unclear feedback
- Period average sentiment based on the full Jev probability distribution
- Deterministic written-review average rating
- Positive, neutral, and negative reason summaries
- Latest-N review map with store, date, rating, sentiment, reason, and confidence
- Explicit source, completeness, and written-review-only labels

## Quick start

Requirements:

- Node.js 24
- npm 10+

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The default `ANALYSIS_MODE=mock` loads a synthetic cross-store dataset and does not require credentials.

## Configuration

All credentials are read only in server-side modules.

```dotenv
# "mock" or "jev"
ANALYSIS_MODE=mock
TYPESAFE_API_KEY=typesafe_api_key_placeholder
TYPESAFE_MODEL=jev-1.13.0

# Short-lived OAuth token with Android Publisher access
GOOGLE_PLAY_ACCESS_TOKEN=google_play_access_token_placeholder
GOOGLE_PLAY_MAX_PAGES=10

# Short-lived signed App Store Connect JWT
APPLE_APP_STORE_CONNECT_TOKEN=apple_app_store_connect_jwt_placeholder
APPLE_MAX_PAGES=10
```

Use `ANALYSIS_MODE=jev` only after replacing `TYPESAFE_API_KEY`. Demo data can be classified with either mode. Store API mode also requires the matching store token and app identifier entered in the dashboard.

### Google Play authorization

The token needs the Android Publisher scope:

```text
https://www.googleapis.com/auth/androidpublisher
```

For production, automate OAuth access-token rotation with a dedicated service account rather than keeping a manually generated token.

### App Store Connect authorization

App Store Connect requires a signed JWT generated from an API key created by the Account Holder or an Admin. Tokens are short-lived; production deployments should generate them at request time or refresh them through a secret-management service.

## CSV formats

The importer normalizes headings and accepts common aliases.

Google Play review reports support headings such as:

```csv
Review ID,Review Submit Date and Time,Star Rating,Review Title,Review Text,Reviewer Language,App Version Name
```

App Store review CSVs support:

```csv
id,createdDate,rating,title,body,territory,appVersion
```

Rows without valid review text, a date, or a 1–5 rating are skipped and reported in the result notices.

## How analysis works

1. A connector normalizes store records into one written-review model.
2. Application code applies the inclusive UTC date period.
3. Each review is classified independently:
   - TypeSafe System One `Score` determines sentiment.
   - TypeSafe System One `Choice` determines the primary reason.
   - Mock mode uses transparent deterministic keyword/rating rules.
4. Application code calculates all counts, averages, distributions, and latest-N ordering.

Jev is never asked to calculate dates, counts, or arithmetic. The average sentiment is:

```text
mean(sum(sentiment_score × score_probability))
```

## API

The dashboard calls:

```text
POST /api/analyze
```

Representative request:

```json
{
  "appName": "My app",
  "sourceMode": "live_api",
  "startDate": "2026-09-01",
  "endDate": "2026-09-20",
  "lastN": 20,
  "androidPackage": "com.company.app",
  "appleAppId": "123456789",
  "translationLanguage": "en"
}
```

`sourceMode` can be `demo`, `live_api`, or `csv`.

## Store limitations

### Google Play

- Official review API access is limited to owned production apps.
- `reviews.list` returns only reviews with comments, not star-only ratings.
- The Review API is a recent/modified review feed, documented as covering roughly the previous week.
- API records expose a last-modified timestamp. The MVP marks this as fallback date semantics when a creation timestamp is unavailable.
- Historical review reports can be imported from the developer’s private Cloud Storage bucket.
- Google ratings reports are separate from written-review reports.

### App Store Connect

- Official review access is limited to apps available to the API key.
- Customer reviews are fetched newest-first and paginated through `links.next`.
- The API is rate-limited per key and returns `429` when exceeded.
- The MVP does not claim a period-specific all-rating average because the reviewed official API does not provide one alongside written reviews.
- Historical depth should be validated using the account’s real data and retention behavior.

### Rating semantics

The dashboard’s average rating is always labeled **written-review rating**. It must not be interpreted as the average of all ratings because both review APIs exclude star-only ratings. An all-rating metric requires a separate official ratings report or export.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
```

`npm run test:coverage` enforces at least 90% branch, function, line, and
statement coverage across the server and domain code in `src/lib` and
`src/app/api`.

## Architecture

```text
Browser dashboard
      |
      v
POST /api/analyze
      |
      +-- Google Play reviews.list
      +-- App Store Connect customerReviews
      +-- Store export CSV parser
      |
      v
Normalized written reviews
      |
      +-- TypeSafe Jev classifier
      +-- Mock classifier
      |
      v
Deterministic aggregation and dashboard response
```

This project intentionally does not scrape public store pages or analyze competitor apps.
