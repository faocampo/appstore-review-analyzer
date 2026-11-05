# ReviewSignal User Guide

This guide explains how to install, configure, operate, and interpret the
ReviewSignal MVP. ReviewSignal analyzes written reviews for Android and iOS
apps that you own, using official store APIs or private store exports.

## 1. What the system does

For a selected app and inclusive UTC date range, ReviewSignal provides:

- average sentiment on a `0.00` to `4.00` scale;
- average rating for written reviews on a `1.00` to `5.00` scale;
- the main reasons behind positive, neutral/mixed, and negative feedback;
- sentiment distribution and classifier confidence;
- Android and iOS written-review counts;
- a latest-N map with review text, store, rating, sentiment, reason, and
  confidence.

ReviewSignal supports three data sources:

1. **Demo dataset** — synthetic reviews; no store credentials required.
2. **Official store APIs** — Google Play Android Publisher API and Apple App
   Store Connect API for apps available to your developer accounts.
3. **Store exports** — private CSV files exported from the developer stores.

The system intentionally does not scrape public store pages or analyze
competitor apps.

## 2. Important data and privacy behavior

- API credentials are read by server-side modules and are not sent to the
  browser.
- Review text, ratings, dates, store metadata, and classification results are
  returned to the browser and displayed in the latest-review table.
- With `CLASSIFIER_PROVIDER=openrouter`, reviews are sent from the server to
  OpenRouter in batches. Requests always set `provider.data_collection: "deny"`
  and, unless `OPENROUTER_ZDR=false`, route only to zero-data-retention
  providers. Reviewer nicknames are never sent.
- With `CLASSIFIER_PROVIDER=jev`, each written review is sent from the server
  to the TypeSafe System One API for classification.
- With `CLASSIFIER_PROVIDER=mock`, classification is performed locally with
  deterministic keyword and rating rules.
- `/api/analyze` requires `Authorization: Bearer <ANALYZE_API_TOKEN>` when the
  token is set, and refuses every request in production when it is not.
- Store and classifier error bodies are logged on the server only; the browser
  receives short, safe messages.
- CSV content is uploaded to the application server when analysis is run.
- Do not commit `.env.local`, service-account JSON, Apple `.p8` files, access
  tokens, or API keys. The repository ignores local environment files.
- Use a secret manager for deployed environments and grant the minimum store
  permissions required to read reviews.

## 3. System requirements

- Node.js 24
- npm 10 or newer
- Access to the repository
- Store and TypeSafe credentials only when their respective features are used

If Node is installed through NVM:

```bash
source "$HOME/.nvm/nvm.sh"
```

## 4. Install and start the application

From the repository root:

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

After changing an environment variable, restart the development server.

For a credential-free first run, keep:

```dotenv
CLASSIFIER_PROVIDER=mock
```

The dashboard automatically loads the synthetic demo dataset.

## 5. Configuration reference

Store credentials are minted on the server from long-lived keys. Static
short-lived tokens remain as a manual fallback.

| Variable | Required when | Description |
| --- | --- | --- |
| `ANALYZE_API_TOKEN` | Production | Shared bearer token for `/api/analyze`. Interim access control until Loomit OIDC. |
| `ANALYZE_RATE_LIMIT_PER_MINUTE` | Optional | Requests per client per minute. Defaults to `20`. |
| `CLASSIFIER_PROVIDER` | Optional | `openrouter`, `jev` or `mock`. Defaults to `openrouter` in production and `mock` elsewhere. The legacy `ANALYSIS_MODE=jev\|mock` is still honored. |
| `OPENROUTER_API_KEY` | OpenRouter selected | OpenRouter API key. |
| `OPENROUTER_MODEL` | OpenRouter selected | Pinned model id. There is no default; changing it changes `classifier.model` in results. |
| `OPENROUTER_BATCH_SIZE` | Optional | Reviews per request. Defaults to `20` (max `50`). |
| `OPENROUTER_ZDR` | Optional | `false` disables zero-data-retention routing. Data collection is always denied. |
| `TYPESAFE_API_KEY` | Jev selected | TypeSafe API key sent as a bearer token to System One. |
| `TYPESAFE_MODEL` | Optional | Jev model identifier. Defaults to `jev-1.13.0`. |
| `CLASSIFIER_CONCURRENCY`, `CLASSIFIER_MAX_RETRIES`, `CLASSIFIER_TIMEOUT_MS` | Optional | Parallel classifier calls, retries for 429/5xx/invalid output, and per-call timeout. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Play API selected (recommended) | Service-account JSON, raw or base64. Access tokens are minted and refreshed automatically. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Alternative | Path to a service-account key file. |
| `GOOGLE_PLAY_ACCESS_TOKEN` | Fallback | Manually minted short-lived OAuth token. |
| `GOOGLE_PLAY_MAX_PAGES` | Optional | Defaults to `10`; capped at `50`. Each page requests up to 100 reviews. |
| `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | App Store Connect API selected (recommended) | API key material. The `.p8` PEM may use `\n` escapes or be base64-encoded. An ES256 JWT (15-minute TTL) is signed per request window. |
| `APPLE_APP_STORE_CONNECT_TOKEN` | Fallback | Manually signed short-lived JWT. |
| `APPLE_MAX_PAGES` | Optional | Defaults to `10`; capped at `50`. Each page requests up to 200 reviews. |

Example production configuration:

```dotenv
ANALYZE_API_TOKEN=replace_with_a_long_random_token
CLASSIFIER_PROVIDER=openrouter
OPENROUTER_API_KEY=replace_with_openrouter_key
OPENROUTER_MODEL=replace_with_pinned_model_id

GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=replace_with_base64_service_account_json
APPLE_ISSUER_ID=replace_with_issuer_id
APPLE_KEY_ID=replace_with_key_id
APPLE_PRIVATE_KEY=replace_with_base64_p8
```

Placeholders ending in `_placeholder` are rejected.

### Classifier and data source are independent

- Any data source (demo, CSV, live APIs) can use any classifier.
- Store credentials are only needed for the official-store API source.
- A classifier key is only needed for the selected classifier.

## 6. Classifier setup

### OpenRouter (production default)

1. Create a dedicated OpenRouter API key for ReviewSignal and store it as
   `OPENROUTER_API_KEY`.
2. Choose and pin a model that supports structured outputs, and set
   `OPENROUTER_MODEL` to its exact id. Re-run the evaluation set before
   changing it: metrics are only comparable within one model and prompt
   version.
3. Confirm that the zero-data-retention routing and data-collection denial
   meet your DPA before sending publisher data.
4. Set `CLASSIFIER_PROVIDER=openrouter` and run a demo analysis first.

Each request asks for a strict JSON schema with, per review, a sentiment score
(0–4), a self-reported confidence, and one reason from the taxonomy. Reviews the
model skips are retried; reviews that still fail are counted as unclassified
and excluded from the metrics.

### TypeSafe / Jev

1. Sign in to the
   [TypeSafe API Keys console](https://console.typesafe.ai/keys).
2. Create a dedicated API key for ReviewSignal.
3. Copy the key into your secret manager or local `.env.local` as
   `TYPESAFE_API_KEY`.
4. Set `CLASSIFIER_PROVIDER=jev`.
5. Keep `TYPESAFE_MODEL=jev-1.13.0`, or deliberately select another supported
   System One model.
6. Restart the application and run a demo analysis before connecting store
   data.

Jev classifies two typed questions for every review:

- a five-level sentiment score;
- one primary reason from the controlled reason taxonomy.

Dates, counts, averages, filtering, and ordering are calculated by application
code, not by Jev.

Reference:
[TypeSafe System One API](https://docs.typesafe.ai/api.md).

## 7. Google Play access

### Required values

- Secret: `GOOGLE_PLAY_ACCESS_TOKEN`
- Dashboard identifier: Android package name, for example
  `com.company.product`

The token must authorize the Android Publisher scope:

```text
https://www.googleapis.com/auth/androidpublisher
```

### Create least-privileged service-account access

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or
   select a project dedicated to the integration.
2. Open the
   [Google Play Android Developer API](https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com)
   and click **Enable**.
3. Go to
   [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts).
4. Click **Create service account** and use a recognizable name such as
   `reviewsignal-reader`.
5. Google Cloud project roles are normally unnecessary for this integration;
   Play Console controls access to Play data. Do not grant broad Cloud IAM
   roles without another requirement.
6. Open the new service account, select **Keys**, then **Add key → Create new
   key → JSON**.
7. Download the JSON key and store it securely. Do not commit or share it in
   chat.
8. Copy the JSON file's `client_email`.
9. Open
   [Play Console → Users and permissions](https://play.google.com/console/users-and-permissions).
10. Click **Invite new users** and enter the service-account email.
11. Limit app access to the owned app or apps that ReviewSignal will analyze.
12. Grant only the minimum read access needed to view app information, ratings,
    and reviews. Leave financial, order, subscription, release-management, and
    administrator permissions disabled.
13. Leave **Reply to reviews** disabled unless the same identity must also
    publish replies. Google documents that users without this permission can
    still view ratings and reviews.
14. Accept/save the invitation and allow permission changes time to propagate.

Store the downloaded JSON in your secret manager and expose it as
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (raw JSON or base64), or mount it as a file
and set `GOOGLE_APPLICATION_CREDENTIALS`. ReviewSignal mints and refreshes
short-lived Android Publisher tokens automatically.

### Find the Android package name

1. Open the app in Google Play Console.
2. Copy the package name displayed with the app details, for example
   `com.company.product`.
3. Enter it in **Android package** in ReviewSignal's **Official store APIs**
   mode.

References:

- [Google Play Developer API setup](https://developers.google.com/android-publisher/getting_started)
- [Play Console user permissions](https://support.google.com/googleplay/android-developer/answer/9844686)
- [Reviews list endpoint](https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/list)

## 8. Apple App Store Connect access

### Required values

- Secrets: `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` (the
  downloaded `.p8` private key)
- Dashboard identifier: numeric App Store Connect Apple ID, for example
  `1234567890`

The Issuer ID and Key ID identify the signing key; the `.p8` contents are the
sensitive private key. Treat the generated JWT as sensitive as well.

### Enable App Store Connect API access

If API access has never been enabled:

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com/).
2. The Account Holder opens **Users and Access → Integrations → App Store
   Connect API**.
3. Click **Request Access**, accept the terms, and submit.

### Generate a team API key

1. An Account Holder or Admin opens **Users and Access → Integrations → App
   Store Connect API → Team Keys**.
2. Click **Generate API Key**, or click the add (`+`) button.
3. Name the key `ReviewSignal Reader`.
4. Select the least-privileged role that can view ratings and reviews. Prefer
   **Customer Support**; Apple also documents **Developer** as having review
   visibility.
5. Click **Generate**.
6. Record the displayed **Issuer ID** and the generated **Key ID**.
7. Download the `.p8` private key immediately. Apple permits a key to be
   downloaded only once.
8. Store the private key in a secret manager. Revoke it immediately if it is
   lost or exposed.

Team keys apply across all apps in the account. If that scope is too broad,
create a dedicated App Store Connect user limited to the target apps and use an
individual API key for that user.

### Short-lived JWT generation

ReviewSignal signs the App Store Connect JWT on the server with ES256 from the
three secrets above: `kid` is the Key ID, `iss` the Issuer ID, `aud`
`appstoreconnect-v1`, and the token lives 15 minutes (Apple allows at most 20).
It is cached and re-signed shortly before expiry.

`APPLE_PRIVATE_KEY` accepts the PEM contents with real or `\n`-escaped
newlines, or the base64 of the whole file. A manually signed token in
`APPLE_APP_STORE_CONNECT_TOKEN` is still accepted as a fallback.

### Find the numeric Apple ID

1. Open **My Apps** in App Store Connect.
2. Select the app.
3. Open **App Information**.
4. Copy the numeric **Apple ID**. Do not use the bundle ID.
5. Enter it in **App Store Connect ID** in ReviewSignal's **Official store
   APIs** mode.

References:

- [App Store Connect API access and keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
- [Ratings and reviews access roles](https://developer.apple.com/help/app-store-connect/monitor-ratings-and-reviews/view-ratings-and-reviews)
- [Apple JWT example](https://developer.apple.com/documentation/appstoreconnectapi/app_store/app_metadata/uploading_app_previews)

## 9. Using the dashboard

### Common inputs

1. Enter an **Analysis name**. This is a display label and does not select a
   store app.
2. Select a data source.
3. Choose the inclusive **From** and **To** dates.
4. Choose how many latest reviews to display. The dashboard supports 5 to 50
   in increments of 5; the API accepts 1 to 200.
5. Click **Run sentiment analysis**.

Date filtering uses complete UTC days:

- start: `00:00:00.000Z`;
- end: `23:59:59.999Z`.

### Demo dataset

1. Select **Demo dataset**.
2. Choose a date range that includes the synthetic review dates.
3. Run the analysis.

Demo mode verifies the complete dashboard without store credentials. With mock
classification it also avoids TypeSafe API usage.

### Official store APIs

1. Configure the required server environment variables.
2. Select **Official store APIs**.
3. Enter at least one of:
   - Android package name;
   - numeric App Store Connect ID.
4. Enter both identifiers to combine both stores.
5. Run the analysis.

If both stores are selected and one fails, ReviewSignal still analyzes results
from the successful source and displays the other source's error as a notice.
If every selected source fails or returns no usable reviews, the request fails.

### Store-export CSV files

1. Select **Store exports**.
2. Choose a Google Play CSV, an App Store CSV, or both.
3. The dashboard accepts one selected file per platform.
4. Select the review period and run the analysis.

Each uploaded file must be non-empty and no larger than 8 MB. The API accepts
up to six file objects per request, although the current dashboard exposes one
file picker per platform.

Rows are skipped when they lack any of:

- written review text;
- a parseable date;
- a numeric rating from 1 through 5.

Skipped-row counts appear in the analysis notices.

## 10. CSV formats

Column names are normalized to lowercase and punctuation is converted to
underscores, so common export heading variants are accepted.

### Google Play example

```csv
Review ID,Review Submit Date and Time,Star Rating,Review Title,Review Text,Reviewer Language,App Version Name
gp-1,2026-09-20T14:30:00Z,2,Too many ads,"An ad appears after every action.",en,4.2.0
```

Recognized Android aliases include:

- ID: `Review ID`, `id`
- date: `Review Submit Date and Time`, `Review Submit Date`, `Created Date`,
  `Created At`, `Date`
- rating: `Star Rating`, `Rating`, `Stars`
- body: `Review Text`, `Body`, `Text`, `Comment`
- title: `Review Title`, `Title`
- language: `Reviewer Language`, `Language`
- app version: `App Version Name`, `App Version`
- territory: `Country`, `Territory`

### App Store example

```csv
id,createdDate,rating,title,body,territory,appVersion
ios-1,2026-09-20T14:30:00Z,5,Excellent,"Fast and easy to use.",US,4.2.0
```

Recognized iOS aliases include:

- ID: `id`, `Review ID`
- date: `createdDate`, `Created At`, `Review Date`, `Date`
- rating: `Rating`, `Star Rating`, `Stars`
- body: `Body`, `Review Text`, `Text`, `Comment`
- title: `Title`, `Review Title`
- territory: `Territory`, `Country`
- app version: `App Version`, `Version`

Dates should use ISO 8601 whenever possible to avoid locale-dependent parsing.

## 11. Understanding the results

### Average sentiment

Sentiment uses this ordered scale:

| Score | Label |
| ---: | --- |
| 0 | Highly negative |
| 1 | Negative |
| 2 | Neutral / mixed |
| 3 | Positive |
| 4 | Highly positive |

ReviewSignal computes each review's expected sentiment, then averages those
values across the period:

- when the classifier returns a valid five-level probability distribution
  (the mock classifier, and Jev when its distribution is complete and sums to
  1), the expected value is probability-weighted:
  `sum(score × score_probability)`;
- otherwise (OpenRouter, or an incomplete Jev distribution), it is the
  classifier's own score.

The estimator used is shown under the average sentiment and returned as
`metrics.sentimentEstimator` (`probability_weighted`, `provider_score` or
`mixed`). Compare averages only between runs that use the same estimator,
model and prompt version (`classifier` in the response).

The dashboard describes aggregate values using these ranges:

- below `0.80`: highly negative;
- `0.80` to below `1.60`: negative;
- `1.60` to below `2.40`: neutral/mixed;
- `2.40` to below `3.20`: positive;
- `3.20` and above: highly positive.

### Written-review rating

This is the arithmetic mean of ratings attached to written reviews in the
selected period. It is not the app's all-user store rating.

Both store review APIs exclude star-only ratings from the analyzed review
population. A true all-rating average requires a separate official ratings
report or export.

### Average confidence

This is the mean sentiment confidence returned by Jev or the mock classifier.
Confidence describes classifier certainty, not sample completeness or
statistical significance.

### Reason summaries

Each review receives one primary reason. The dashboard groups the top five
reasons separately for negative, neutral/mixed, and positive reviews.

The controlled taxonomy is:

- Ads and interruptions
- Crashes and reliability
- Speed and performance
- Login and account access
- Payments and subscriptions
- Features and functionality
- Usability and navigation
- Content quality
- Customer support
- Privacy and security
- Pricing and value
- Update regression
- Device and OS compatibility
- General satisfaction
- Other or unclear

### Latest classified reviews

The table is sorted newest first and limited by the latest-N setting. It shows
the full review body, review date, source store, rating, selected sentiment,
sentiment confidence, and primary reason.

## 12. API usage

The dashboard calls:

```text
POST /api/analyze
Content-Type: application/json
```

Example:

```json
{
  "appName": "My mobile app",
  "sourceMode": "live_api",
  "startDate": "2026-09-01",
  "endDate": "2026-09-30",
  "lastN": 20,
  "androidPackage": "com.company.product",
  "appleAppId": "1234567890",
}
```

Send `Authorization: Bearer <ANALYZE_API_TOKEN>` when the server has a token
configured. `translationLanguage` is still accepted but ignored: reviews are
classified in their original language.

CSV files are sent as `{ "name", "platform", "encoding", "content" }`, where
`encoding` is `"text"` (default) or `"base64"` (raw file bytes; required for
UTF-16 Play Console reports).

Input constraints:

- `appName`: 1 to 120 characters;
- ISO calendar dates with start less than or equal to end;
- `lastN`: integer from 1 through 200;
- at least one store identifier for `live_api`;
- at least one file for `csv`;
- no more than six CSV file objects;
- no more than 11,000,000 characters per CSV content field (about 8 MB of
  file bytes in base64).

Error statuses: `400` invalid input or JSON, `401` missing or wrong token,
`422` no reviews in the period, `429` rate limited (see `Retry-After`), `502`
store or classifier failure, `503` access control not configured in
production, `500` unexpected internal error (details are in the server logs).

The response includes `coverage[]` with one entry per source: `status`
(`complete`, `partial`, `failed`), `reviewsFetched`, `pagesFetched`,
`truncated`, `dateSemantics`, and an explanatory `note`.

## 13. Store limitations

### Google Play

- Access is limited to apps available to the authorized Play developer
  account.
- `reviews.list` returns written/commented reviews, not star-only ratings.
- Google's Review API is a recent or recently modified feed, rather than a
  complete historical review archive.
- The API exposes a last-modified timestamp where a reliable original
  creation timestamp is unavailable. ReviewSignal marks and uses this fallback
  as the review date for filtering and ordering, and reports it as
  `period.membership`.
- Periods that start more than about 7 days ago are reported as `partial`
  coverage for the Google Play API source.
- Historical review and ratings reports are separate export paths.

### App Store Connect

- Access is limited to apps available to the API key or user.
- Reviews are fetched newest first through JSON:API pagination.
- Pagination stops early once reviews are older than the period start, or at
  `APPLE_MAX_PAGES`; hitting the limit first is reported as `partial`,
  truncated coverage.
- App Store Connect can return `429` when rate limits are exceeded.
- The customer-review endpoint does not provide a period-specific all-rating
  average alongside the written reviews.
- Historical depth should be validated against the real account's data.

## 14. Common errors and fixes

### `A valid access token is required` (401) or `Access control is not configured` (503)

- 401: enter the access token in the dashboard (the field appears after the
  first 401) or send `Authorization: Bearer <token>` from API clients.
- 503: set `ANALYZE_API_TOKEN` on the server; production refuses all requests
  without it.

### `The … classifier is selected but … is not configured`

- Set the key for the selected classifier (`OPENROUTER_API_KEY` and a pinned
  `OPENROUTER_MODEL`, or `TYPESAFE_API_KEY`), or select `CLASSIFIER_PROVIDER=mock`.
- Confirm the environment variable is available to the server process and
  restart the server.

### `Classification failed for every review`

- Check the server logs for the classifier's HTTP status and body.
- Typical causes: invalid key, a model that does not support structured
  outputs, or no provider available under zero-data-retention routing.

### `Google Play is selected but no credentials are configured`

- Set `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (or `GOOGLE_APPLICATION_CREDENTIALS`).
- `Could not mint a Google Play access token` means the service account was
  found but Google rejected it; check the key and Play Console permissions.

### Google Play returns `401`

- The service-account key was revoked, or a manual fallback token expired.
- Rotate the key, or remove `GOOGLE_PLAY_ACCESS_TOKEN` and use the service
  account.

### Google Play returns `403`

- Confirm the Android Publisher API is enabled.
- Confirm the token's identity has access to the target Play Console app.
- Confirm the token has the Android Publisher scope.
- Confirm the package name exactly matches the owned app.

### `App Store Connect is selected but no credentials are configured`

- Set `APPLE_ISSUER_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`.
- `APPLE_PRIVATE_KEY is not a valid PKCS#8 (.p8) ES256 key` means the key
  contents were truncated or mis-encoded.

### App Store Connect returns `401`

- Confirm the Key ID and Issuer ID match the `.p8` key, and that the server
  clock is correct.
- Confirm the `.p8` key has not been revoked.

### App Store Connect returns `403`

- Confirm the API key or user can access the app and view ratings and reviews.
- Confirm the numeric Apple ID, not the bundle ID, was entered.

### App Store Connect returns `429`

- Wait before retrying; partial results are reported as `partial` coverage.
- Reduce `APPLE_MAX_PAGES` if repeated broad fetches are unnecessary.

### `Upload at least one store export`

- Select a CSV in the Google Play or App Store upload card before running the
  analysis.

### `No written reviews were found in the selected period`

- Expand the date range.
- Confirm the export dates and timezone.
- Confirm the selected app has written reviews, not only star ratings.
- For Google API data, remember that the available feed is recent/modified and
  its date can represent last modification.

### CSV rows are skipped

- Confirm every row has written text, a parseable date, and a rating from 1 to
  5.
- Prefer ISO 8601 dates.
- Compare the headings with the accepted aliases in this guide.

### One store failed but results are still displayed

This is expected when both stores were selected. ReviewSignal uses successful
sources, marks the failed source as `Failed` in Data coverage, and lists it as a notice. Correct the failed
credential or identifier and rerun to restore complete cross-store coverage.

## 15. Verification and production build

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
```

The coverage command enforces at least 90% branch, function, line, and
statement coverage across the server and domain code.

Start the production build with:

```bash
npm start
```

## 16. Production-readiness checklist

Already handled by the service:

- server-side minting of Google OAuth tokens and Apple JWTs;
- bearer-token access control that fails closed in production, plus per-client
  rate limiting;
- safe error messages, with upstream details kept in server logs;
- per-source coverage, truncation and date-semantics reporting.

Still required before relying on ReviewSignal operationally (see
[`docs/productization-plan.md`](docs/productization-plan.md)):

- replace the shared access token with Loomit OIDC and tenant-scoped
  authorization;
- store credentials per publisher in a managed secret store (AWS Secrets
  Manager + KMS);
- confirm with Legal that sending review text to the chosen classifier
  provider complies with the publisher DPA and store API terms;
- pin the OpenRouter model only after the evaluation set confirms quality and
  cost;
- move from on-demand analysis to scheduled incremental ingestion with
  persistence, so history extends beyond the Google API window;
- add monitoring for store authorization failures, rate limits, classifier
  failures and cost, and unexpectedly empty periods;
- treat the written-review average separately from the stores' all-rating
  metrics;
- rotate and revoke credentials according to your security policy.
