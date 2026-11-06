# Classifier evaluation harness

This folder holds the evaluation harness for plan milestone M1
([`docs/productization-plan.md`](../docs/productization-plan.md) §3.2,
"Evaluation harness"). The harness answers one question: is a classifier
(Jev, an OpenRouter model, or a new prompt version) good enough and cheap
enough to ship? It does this by scoring the classifier against
human-labeled reviews.

```
eval/
  README.md                  this guide
  .gitignore                 ignores reports/
  datasets/
    README.md
    sample.jsonl             SYNTHETIC smoke-test data (42 rows), not a benchmark
    sample-agreement.jsonl   SYNTHETIC double-annotated smoke test (10 ids × 2)
  reports/                   CLI output (git-ignored)
scripts/eval.ts              evaluation CLI
scripts/eval-agreement.ts    inter-annotator agreement CLI
src/lib/eval/                metrics, dataset loader, runner, report rendering (unit-tested)
```

> The datasets in `eval/datasets/` are **synthetic** and exist only to
> smoke-test the tooling. Their numbers are not a quality signal. The real
> labeled set is built as described in [Building the labeled set](#building-the-labeled-set).

## Quick start

```bash
# Smoke test: no network, no keys.
npx tsx scripts/eval.ts --dataset eval/datasets/sample.jsonl --provider mock

# Agreement between two annotators, and the gate thresholds derived from it.
npx tsx scripts/eval-agreement.ts --dataset eval/datasets/sample-agreement.jsonl

# Real providers. Keys come from the environment or from --env-file.
npx tsx scripts/eval.ts --dataset eval/datasets/reviews-v1.jsonl --provider jev \
  --env-file .env.local --out eval/reports
npx tsx scripts/eval.ts --dataset eval/datasets/reviews-v1.jsonl --provider openrouter \
  --model <pinned-model-id> --env-file .env.local \
  --baseline eval/reports/<jev-run>.json \
  --gate maxReasonMacroF1DropVsBaseline=0 --gate maxCostPer1k=<target> \
  --gate minReasonMacroF1=<from agreement> --gate minQwk=<from agreement> \
  --gate maxUnclassifiedRate=0.01
```

`scripts/eval.ts` sets `CLASSIFIER_PROVIDER` (and `OPENROUTER_MODEL`, or
`TYPESAFE_MODEL` for Jev, when you pass `--model`). It then builds the
classifier through `getClassifier()`, the same path production uses. It
always ignores `CLASSIFIER_FALLBACK_PROVIDER`, because a fallback would mix
another model's answers into the results. The report also lists the
provider/model pairs that actually answered (`modelsObserved`) and warns if
they differ from the one under test.

Each run writes `<timestamp>_<provider>-<model>.md` and `.json` to `--out`
(default `eval/reports/`) and prints a summary. Exit codes:

- `0`: the run finished and any gate passed.
- `1`: a `--gate` check failed.
- `2`: a usage error, an invalid dataset, or no review classified at all
  (for example, a missing API key).

The JSON report is the full `EvalReport`. It includes every row's label,
prediction and error, so you can analyze errors and pass the file back
later as `--baseline`. Reports are git-ignored. To keep a run as a
reference baseline, copy its JSON to a tracked location such as
`eval/baselines/`.

Other options: `--split <name>` evaluates only rows with that `split`,
`--batch-size`, `--concurrency` (default 1, see below), `--bootstrap <n>`
and `--seed <n>` for the confidence interval, and `--help`.

## Dataset format

The dataset is JSONL: one review per line, validated by
`src/lib/eval/dataset.ts`. Errors are reported with line numbers.

```json
{"id":"gp-123","store":"google_play","language":"es","rating":1,"title":"Anuncios","body":"Un anuncio después de cada nivel.","label":{"sentiment":0,"primaryReason":"ads","secondaryReason":null,"adSubreason":"ad_frequency"},"annotator":"ana","split":"test"}
```

| Field | Rules |
| --- | --- |
| `id` | Non-empty and unique in the file. In agreement files, `(id, annotator)` must be unique instead. |
| `store` | `google_play` or `apple_app_store` |
| `language` | BCP 47 tag (`en`, `es`, `pt-BR`). Normalized to lower case. |
| `rating` | Integer 1–5 (the stars) |
| `title`, `body` | Original text, untranslated. `title` may be empty or missing. |
| `label.sentiment` | Integer 0–4 (scale below) |
| `label.primaryReason` | A key of `REASON_DEFINITIONS` (`src/lib/types.ts`) |
| `label.secondaryReason` | Another reason key, or `null`. It must differ from the primary. |
| `label.adSubreason` | A key of `AD_SUBREASON_DEFINITIONS` when the primary or secondary reason is `ads`, otherwise `null` |
| `annotator` | Optional, but required in agreement files |
| `split` | Optional free text, for example `dev` or `test` |

The taxonomy is `reasons-v2`. If the taxonomy changes, relabel the set and
bump its file version. Reports from different taxonomies or datasets are
flagged as not comparable, because each report records the dataset's
sha256.

## Metrics

All metrics live in `src/lib/eval/metrics.ts` and are pure and unit-tested.
When a metric cannot be computed (empty input, or an undefined statistic
such as kappa when both raters used one identical label), it returns
`null` and the report shows `—`.

| Metric | Definition |
| --- | --- |
| Reason macro-F1 | Unweighted mean of per-class F1 over the 15 reasons, counting only classes present in the labels or the predictions. Unclassified reviews count as misses. |
| Macro-F1 95% CI | Percentile bootstrap: 1,000 resamples of rows, seeded (mulberry32, seed 42), so the CI is deterministic. |
| Reason accuracy / lenient | Share where the predicted primary equals the true primary. The lenient version also accepts the true secondary reason. |
| Ad sub-reason macro-F1 | Over rows whose label or prediction has an ad sub-reason. A missing sub-reason on either side counts as `none`. |
| Sentiment MAE | Mean \|predicted − true\| on the 0–4 scale, over classified reviews. |
| Sentiment QWK | Quadratic weighted kappa on the 0–4 scale. 1 means perfect agreement, 0 means chance level. Distant errors cost more than adjacent ones. |
| Unclassified rate | Share of reviews for which the provider returned an error or no result. |
| Cost per 1,000 reviews | Sum of the provider-reported `costUsd` ÷ reviews × 1,000. Also reports the share of reviews whose cost was known. `null` when the provider reports no cost. |
| Latency p50/p95 | Duration of one `classify` call, which covers one batch. |
| By language | Reason macro-F1, accuracy, sentiment MAE and unclassified rate per language. |

Inter-annotator agreement (`scripts/eval-agreement.ts`) reports these:

- Cohen's kappa for the primary reason;
- QWK, exact agreement, within-±1 agreement and MAE for sentiment;
- Cohen's kappa for the ad sub-reason;
- the human-versus-human macro-F1, averaged over both directions;
- a list of every disagreement.

## Building the labeled set

Target: **400–500 reviews** from the publishers' apps, in at least **ES, EN and PT**.

1. **Sample.** Export recent reviews (for example, the last 90 days) for the
   pilot publishers' apps from both stores. Remove exact duplicates and
   reviews with no text. Scrub personal data such as emails, phone numbers
   and full names. Do not use reviews you have used to write or tune
   prompts.
2. **Stratify** by language × store × star rating. Suggested quotas:
   - **Language:** about 35% ES, 35% EN, 30% PT, plus any other main
     language with at least 50 reviews. Below that, its per-language
     numbers are noise.
   - **Store:** both stores, each in proportion to its volume, but at
     least 30% per store.
   - **Rating:** sample the 1–2★, 3★ and 4–5★ bands about equally.
     Negative reviews carry most reasons, and a natural sample is mostly
     5★ praise.
   - **Ads:** oversample review texts that mention ads (keyword prefilter
     in each language) until each ad sub-reason has at least 15 examples
     in total. Ads are the reason Loomit cares about most.
   - Keep the quota table and the random seed you used next to the
     dataset.
3. **Split.** Mark about 30% as `split: "dev"` and use them for prompt
   iteration. Report gate decisions on `split: "test"` only
   (`--split test`).
4. **Annotate.** Two or more annotators who are fluent in the review's
   language label each review blind: they see the stars and the text, but
   no model output. Follow the guidelines below. A spreadsheet with one
   column per label field, converted to JSONL, is enough.
5. **Double-annotate at least 20%** (at least 100 reviews), stratified like
   the full set. Each annotator labels independently. Export one line per
   (id, annotator) to `reviews-vN-agreement.jsonl` and run the agreement
   CLI.
6. **Adjudicate.** A third person resolves every disagreement in the
   double-annotated subset. The adjudicated label goes into the gold file,
   which has one line per id. Collect recurring disagreements and turn them
   into guideline clarifications.
7. **Freeze.** Record the dataset sha256, the date and the guideline
   version. Changing labels creates a new file version, and baselines must
   be re-run on it.

### Annotation guidelines

**Sentiment (0–4)** is about the text's attitude toward the app as a whole.
The stars do not set it, but use them to break ties when the text is
ambiguous.

| Score | Meaning | Example |
| --- | --- | --- |
| 0 | Highly negative: anger, abandonment, harm, "uninstalling" | "Scam. Charged me twice. Uninstalled." |
| 1 | Negative: a clear complaint or a poor experience | "Too many ads lately, getting annoying." |
| 2 | Neutral or mixed: factual, ambiguous, or balanced | "Great game but way too many ads." / "ok" |
| 3 | Positive: satisfied, possibly with a small wish | "Works well, would love a dark mode." |
| 4 | Highly positive: enthusiastic, recommends it | "Best app ever, recommend to everyone!" |

**Primary reason** is the single topic that drives the review. When a review
has several topics, pick the one the user spends most words on or names as
the cause of the rating. Add a **secondary reason** only when a second
distinct topic is clearly present. Otherwise use `null`. Do not use praise
as a secondary reason for a complaint unless the praise is explicit.

| Reason | Use when the review is mainly about… | Example |
| --- | --- | --- |
| `ads` | Ads or interruptions by ads (set a sub-reason) | "An ad after every level." |
| `stability` | Crashes, freezes or bugs not tied to an update or a device | "Crashes on launch." |
| `performance` | Speed, loading, lag, battery or data use | "Consume mucha batería." |
| `login_account` | Signing in, account access, verification or deletion | "Não consigo entrar na minha conta." |
| `payments_subscriptions` | Charges, billing, refunds, subscriptions or purchase failures | "Charged twice for the subscription." |
| `features_functionality` | Missing, broken or requested features | "Falta modo escuro." |
| `usability_navigation` | Ease of use, design, finding things, onboarding | "Hard to find the settings." |
| `content_quality` | Quality or quantity of the content (levels, articles, catalog) | "Poucos filmes no catálogo." |
| `support` | Customer support responsiveness or quality, good or bad | "Support never replies." |
| `privacy_security` | Permissions, tracking, data use or account security | "Why does a flashlight need my location?" |
| `pricing_value` | Price level or value for money (not billing errors) | "Muy caro para lo que ofrece." |
| `update_regression` | Something got worse after an update, as the user states | "Since the last update my saves are gone." |
| `compatibility` | A specific device, OS version or tablet does not work | "No funciona en Android 15." |
| `praise_general` | General satisfaction with no specific topic | "Love it!" |
| `other_unclear` | Nothing above fits, or the text is unintelligible | "My cousin installed it." |

Boundary rules:

- **Crash or freeze caused by an ad:** use `ads` with `ad_breaks_app` when
  the user blames the ad. When the crash is the main complaint and the ad
  is incidental, use `stability` as primary, `ads` as secondary and
  `ad_breaks_app`.
- **Paid to remove ads but still sees ads:** use `payments_subscriptions`
  as primary, `ads` as secondary, and the sub-reason that fits (often
  `ad_other`).
- **Update vs. stability:** use `update_regression` only when the user
  links the problem to an update. Otherwise use `stability` or
  `performance`.
- **Specific praise:** praise for one aspect gets that aspect's reason, for
  example `support` for "support fixed it in an hour". Use
  `praise_general` only for general praise.
- **`other_unclear`** is the last resort. Do not use it for short but clear
  reviews like "too many ads".

**Ad sub-reason** is required whenever the primary or secondary reason is
`ads`, and must be `null` otherwise. If an ad review fits several
sub-reasons, pick the one the user complains about most.

| Sub-reason | Use when… | Example |
| --- | --- | --- |
| `ad_frequency` | There are too many ads, or they come too often | "Uno cada 30 segundos." |
| `ad_intrusive` | Ads are full-screen, unskippable, hard to close, or have fake close buttons | "Anúncio em tela cheia que não fecha." |
| `ad_inappropriate` | Ad content is offensive, sexual, scammy or unsuitable for children | "Anuncios para adultos y mi hijo juega." |
| `ad_audio` | Ads play unexpected or loud sound | "Ads blast music on silent." |
| `ad_reward_failure` | A rewarded ad was watched but the reward was not granted | "Assisti e não ganhei as moedas." |
| `ad_breaks_app` | An ad crashes, freezes or black-screens the app, or loses progress | "Black screen after every video ad." |
| `ad_other` | Any other ad complaint (language, relevance, "paid but still see ads") | "Ads in another language." |

## Agreement and setting the gate

The plan's gate says: *the default OpenRouter model must match or beat Jev
at or below the target cost per 1,000 reviews; the threshold is set after
measuring inter-annotator agreement.*

1. **Measure agreement** on the double-annotated subset:
   ```bash
   npx tsx scripts/eval-agreement.ts --dataset eval/datasets/reviews-v1-agreement.jsonl --out eval/reports
   ```
   If the primary-reason kappa is below **0.6**, the task is not defined
   well enough to gate on. Revise the guidelines, re-annotate, and measure
   again. On the Landis & Koch scale, 0.6–0.8 is "substantial" and above
   0.8 is "almost perfect".
2. **Read the suggested gate.** The CLI prints `--gate` flags:
   - `maxReasonMacroF1DropVsBaseline=0`: match or beat the baseline. This
     is the plan's rule.
   - `minReasonMacroF1` and `minQwk`: 0.9 × the human-versus-human value
     (`--fraction` changes the 0.9).
   - `maxSentimentMae`: the human MAE + 0.2 (`--mae-margin` changes the
     0.2).

   These absolute floors are a starting point. A model is scored against
   adjudicated gold, so it can legitimately beat the agreement between two
   single annotators. Record the thresholds you choose, and the reason,
   with the dataset version.
3. **Run Jev** on the test split and keep its JSON report as the baseline.
4. **Run the OpenRouter candidate** on the same file and split, with
   `--baseline <jev.json>`. Use the suggested flags plus
   `--gate maxCostPer1k=<target>` and `--gate maxUnclassifiedRate=0.01`.
   The CLI exits 1 if any check fails, so the same command can run in CI.

Mind the noise. With about 450 reviews and 15 classes, the 95% CI on
macro-F1 is several points wide; the report prints it. A candidate that
beats the baseline by 0.01 is a tie, not a win. If you need a strict "beats", use a small
negative tolerance (for example `maxReasonMacroF1DropVsBaseline=0.01`) for
"no worse than", or add a paired bootstrap. Also check the per-language and
per-class tables: a model can win on average and lose badly on PT or on
`ad_reward_failure`.

## Cost and latency notes

- **OpenRouter** cost comes from the response's `usage.cost`, split evenly
  across the reviews in the batch. Calls that failed and were retried are
  not counted, so the reported cost is a lower bound when retries happen.
  Check `costKnownRate`, which should be 100%.
- **Jev** reports no cost, so `costPer1k` is `null` for Jev runs and any
  `maxCostPer1k` gate on Jev fails as "could not be computed". Compute
  Jev's cost from the contract price per call (one call per review) and
  compare it by hand.
- **Latency** is measured per `classify` call: one review for Jev, one
  batch (default 20) for OpenRouter. The two p95 values are therefore not
  directly comparable. Compare wall time per review, or rerun OpenRouter
  with `--batch-size 1` if per-review latency matters. The CLI runs one
  call at a time by default (`--concurrency 1`) so that rate limiting and
  contention do not inflate latency. Raise the concurrency only to speed
  up large runs, and then do not read the latency numbers.
- A 450-review run makes about 23 OpenRouter calls or 450 Jev calls. Retry
  behaviour follows `CLASSIFIER_MAX_RETRIES` and `CLASSIFIER_RETRY_BASE_MS`,
  as in production.
- The mock provider costs nothing and needs no keys. Use it to check the
  wiring, never as a quality reference.
