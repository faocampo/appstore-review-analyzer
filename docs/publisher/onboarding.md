# Getting started with ReviewSignal

ReviewSignal brings your app-store reviews into Loomit. It shows how reviews
of your apps evolve over time and adds reviews as a user-experience guardrail
to your Loomit monetization experiments, next to revenue, ARPDAU and
impressions.

This guide covers connecting your stores, what the panels show, and how your
data is handled.

**Contents**

1. [Before you start](#before-you-start)
2. [Connect Google Play](#connect-google-play)
3. [Import Google Play review history (optional)](#import-google-play-review-history-optional)
4. [Connect the App Store](#connect-the-app-store)
5. [Import a CSV export instead](#import-a-csv-export-instead)
6. [The evolution panel](#the-evolution-panel)
7. [Review guardrails in experiments](#review-guardrails-in-experiments)
8. [Data coverage](#data-coverage)
9. [What data ReviewSignal processes, and where](#what-data-reviewsignal-processes-and-where)
10. [Disconnecting and troubleshooting](#disconnecting-and-troubleshooting)

## Before you start

You need:

- Access to ReviewSignal in the Loomit console for your publisher account.
- For **Google Play**: a Play Console user who can invite users and manage
  permissions (an account owner or admin).
- For the **App Store**: the App Store Connect Account Holder or an Admin,
  who can create API keys.
- The identifiers of each app: the Android **package name** (for example
  `com.company.game`) and the numeric **Apple ID** (for example
  `1234567890`, found under App Information in App Store Connect; not the
  bundle ID).

ReviewSignal only reads reviews of apps you own and connect. It never
writes to your store accounts, never replies to reviews and never reads
financial or user data.

You can connect one store or both. Each app is connected separately.

## Connect Google Play

ReviewSignal reads Google Play reviews through an X3M service account that
you invite to your Play Console with read-only access.

1. In the Loomit console, open **ReviewSignal → Connect**, choose the app
   and select **Google Play**. Copy the service account email shown on the
   screen.
2. In [Play Console](https://play.google.com/console), go to
   **Users and permissions** and click **Invite new users**.
3. Paste the service account email.
4. Under **App permissions**, click **Add app** and select the apps you want
   ReviewSignal to analyze.
5. Grant only **View app information and download bulk reports (read-only)**.
   Leave every other permission off, including financial data, release
   management and **Reply to reviews**.
6. Click **Invite user** and confirm.
7. Back in ReviewSignal, click **Verify connection**.

Google can take some time to apply new permissions. If verification fails
right after you send the invitation, wait and try again later; the
connection shows **Pending** until verification succeeds.

Once connected, ReviewSignal checks for new and updated reviews every few
hours.

## Import Google Play review history (optional)

The Google Play reviews API only returns reviews from about the last 7 days.
For older reviews, ReviewSignal can import the monthly review reports that
Play Console keeps in a Google Cloud Storage bucket for your developer
account.

1. In Play Console, open **Download reports → Reviews**.
2. Click **Copy Cloud Storage URI**. It looks like
   `gs://pubsite_prod_rev_01234567890123456789/reviews/`.
3. In ReviewSignal, open the app's Google Play connection and enter the
   bucket name, the part that starts with `pubsite_prod_` (in the example,
   `pubsite_prod_rev_01234567890123456789`).
4. Reading the reports bucket requires the **View app information and
   download bulk reports (read-only)** permission at **account level**, not
   only for selected apps. If the import reports that it cannot read the
   bucket, open the service account in **Users and permissions** and grant
   that permission under **Account permissions**.

The bucket holds reports for every app in your developer account.
ReviewSignal imports only the apps you connected.

## Connect the App Store

ReviewSignal reads App Store reviews with an App Store Connect API key that
you create with the least-privileged role that can see customer reviews.

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com) as the
   Account Holder or an Admin.
2. Open **Users and Access → Integrations → App Store Connect API**. If API
   access has never been enabled, the Account Holder clicks
   **Request Access** first.
3. Under **Team Keys**, click **Generate API Key** (or **+**).
4. Name the key `ReviewSignal` and set **Access** to **Customer Support**.
5. Click **Generate**.
6. Note the **Issuer ID** (shown above the list of keys) and the key's
   **Key ID**.
7. Click **Download API Key** to get the `.p8` file. Apple lets you download
   it only once; keep it until you have uploaded it to ReviewSignal.
8. In the Loomit console, open **ReviewSignal → Connect**, choose the app,
   select **App Store**, enter the Issuer ID and Key ID, upload the `.p8`
   file and click **Verify connection**.

After the upload, you can delete your local copy of the `.p8` file.
ReviewSignal stores the key encrypted and never displays it again.

Team keys give access to every app in your App Store Connect account.
ReviewSignal reads reviews only for the apps you connect. To revoke access,
click **Revoke** next to the key in App Store Connect.

## Import a CSV export instead

If you prefer not to connect a store, or to add history, you can upload
review exports.

- **Google Play**: the monthly reviews report from **Download reports →
  Reviews** (Play Console exports are UTF-16; ReviewSignal handles this).
- **App Store** or other sources: a CSV with one row per review.

Accepted files are CSV, UTF-8 or UTF-16, up to 50 MB each. ReviewSignal
recognizes common column names, including:

| Field | Accepted column names |
| --- | --- |
| Review ID | `Review ID`, `id` |
| Date | `Review Submit Date and Time`, `Review Submit Date`, `createdDate`, `Created At`, `Date` |
| Star rating (1–5) | `Star Rating`, `Rating`, `Stars` |
| Review text | `Review Text`, `Body`, `Text`, `Comment` |
| Title | `Review Title`, `Title` |
| Language | `Reviewer Language`, `Language` |
| Country | `Country`, `Territory` |
| App version | `App Version Name`, `App Version`, `Version` |

Rows without review text, a readable date or a rating from 1 to 5 are
skipped, and the import summary tells you how many. Use ISO 8601 dates
(`2026-09-20T14:30:00Z`) to avoid ambiguity. Reviews are matched by store
and review ID, so importing the same file twice does not create duplicates.

## The evolution panel

The evolution panel shows how reviews of an app change over time, by day or
week, with release markers for each app version.

- **Average sentiment.** Each review is classified on a five-level scale
  from very negative (0) to very positive (4). The panel shows the average
  with its confidence interval.
- **Written-review rating.** The average star rating of reviews **that
  include text**. Both stores exclude star-only ratings from their review
  feeds, so this is not the store's overall rating and is usually lower.
- **Negative share and reasons.** The share of negative reviews, and the
  main reasons behind them (for example ads, performance, pricing), including
  ad-specific reasons such as ads that are too frequent, cannot be closed, or
  rewarded ads that did not grant the reward.
- **Versions.** How each app version compares with the previous one, to
  spot regressions after a release.
- **Breakdowns** by store, app version and country.
- **Review drill-down.** The individual reviews behind any number, with
  their classification.

Reviews are classified in their original language; no translation is
involved.

When a period has too few reviews to be meaningful (fewer than 20 by
default), the panel shows **Insufficient data** instead of a number. It never
fills gaps with estimates.

## Review guardrails in experiments

When you run a monetization experiment in Loomit, the experiment readout
includes a review guardrail. It answers one question: did user sentiment in
reviews get worse where the experiment ran?

Reviews do not identify the user who wrote them, so they cannot be tied to an
experiment group directly. The readout always states which comparison was
possible:

- **Dimension-attributable.** The test and control groups differ by app
  version, country or store, so reviews can be compared group against group.
- **Pre/post with baseline.** The experiment covers the whole app. The
  experiment window is compared with a baseline period before it. Releases
  and data-coverage changes during the window are flagged as possible
  confounders.
- **Insufficient.** Not enough reviews to draw a conclusion. No verdict is
  shown.

Guardrail metrics:

| Metric | What it compares |
| --- | --- |
| Ad complaints | Share of negative reviews whose reason is ads |
| Sentiment | Average sentiment |
| Ad complaints per 100k DAU | Ad-related negative reviews relative to daily active users |
| Written-review rating | Average star rating of written reviews |

Each metric gets a status: **OK**, **Warning**, **Breach** or
**Insufficient**. When a guardrail reaches warning or breach, you and your
X3M customer success manager are notified. Guardrails never change or stop
an experiment on their own: they are one input to your decision, alongside
revenue, ARPDAU and the other readout metrics.

For experiments where the review signal matters most, consider splitting
the test by country or app version: that makes the comparison
dimension-attributable and much more reliable.

## Data coverage

Every day of data carries a coverage status, shown on the panel:

| Status | Meaning |
| --- | --- |
| **Complete** | All reviews for that day were retrieved. |
| **Partial** | Some reviews may be missing, for example because a sync was interrupted or a store limit was reached. |
| **Unknown** | ReviewSignal cannot tell, typically for Google Play days older than the API's ~7-day window when no report history was imported. |

Partial or unknown days are never presented as complete. Importing Google
Play report history or a CSV export usually turns older unknown days into
complete ones.

For Google Play reviews read through the API, the date shown is the date the
review was last modified, because that is the only date the API provides. An
edited review therefore appears on the day of its latest edit. Reviews
imported from Play Console reports use their original submission date.

## What data ReviewSignal processes, and where

**What is read.** For each connected app: the review text and title, star
rating, dates, language, country, app version and the store's review ID.
ReviewSignal does not store reviewer names and does not read any other data
from your store accounts.

**Credentials.** App Store Connect keys and other store credentials are
encrypted and kept in a dedicated secrets store, used only to read reviews,
and never shown again after upload. Access to them is logged. You can revoke
access at any time from your store account.

**Classification.** To determine sentiment and reasons, the review title and
text, rating, language, country and store are sent to a large-language-model
provider through OpenRouter. Requests are configured so that providers may
not collect or train on the data, and are routed only to providers that do
not retain it. Reviewer names are never sent.

**Combination with Loomit data.** Guardrails combine review metrics with
your Loomit experiment data, such as daily active users, inside X3M's
systems.

**Where.** ReviewSignal runs in X3M's infrastructure on Amazon Web Services.
The hosting region, the list of sub-processors and the data retention
periods are set out in your data processing agreement with X3M.

**Isolation.** Your data is stored separately from other publishers' data
at the database level and is visible only to your Loomit account and to
authorized X3M staff.

## Disconnecting and troubleshooting

**Disconnect a store.** In **ReviewSignal → Connect**, choose the app and
click **Disconnect**. ReviewSignal stops reading reviews and deletes the
stored credentials for that store. Then remove the access on the store side
as well: remove the X3M service account in Play Console's **Users and
permissions**, or revoke the API key in App Store Connect.

**Connection shows Error.** The most common causes:

| Message or symptom | What to check |
| --- | --- |
| Google Play: permission denied | The service account is invited, has access to this app, and has **View app information and download bulk reports (read-only)**. New permissions can take time to apply. |
| Google Play: app not found | The package name matches the app in Play Console exactly. |
| Google Play history: cannot read bucket | The bucket name starts with `pubsite_prod_`, and the permission is granted at account level. |
| App Store: unauthorized | The Issuer ID, Key ID and `.p8` file belong to the same key, and the key has not been revoked. |
| App Store: forbidden | The key's access role is **Customer Support** (or another role that can see customer reviews). |
| App Store: app not found | You entered the numeric Apple ID, not the bundle ID. |

**Numbers look low or missing.** Check the coverage status for the period,
and remember that only written reviews are counted. Periods with fewer than
the minimum number of reviews show **Insufficient data** by design.

For anything else, contact your X3M customer success manager.
