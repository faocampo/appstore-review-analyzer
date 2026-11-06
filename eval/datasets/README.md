# Evaluation datasets

> **The files in this folder are synthetic smoke-test data, not a benchmark.**
> Every review in `sample.jsonl` and `sample-agreement.jsonl` was written by
> hand for this repository. None comes from a real store. The numbers they
> produce say nothing about classifier quality. Use them only to check that
> the harness, the CLIs and a provider's wiring work end to end.

| File | Rows | Purpose |
| --- | --- | --- |
| `sample.jsonl` | 42 (17 EN, 12 ES, 13 PT) | Smoke test for `scripts/eval.ts`. Covers all 15 reasons and all 7 ad sub-reasons, plus a few rows with a secondary reason. |
| `sample-agreement.jsonl` | 10 ids × 2 annotators | Smoke test for `scripts/eval-agreement.ts`. Contains a few deliberate disagreements. |

The synthetic rows are short and unambiguous, and their sentiment follows the
star rating closely. That makes them much easier than real reviews. For
example, the mock classifier's sentiment looks very good here only because
it derives sentiment from the star rating.

The real labeled set (400–500 reviews) is built as described in
[`../README.md`](../README.md#building-the-labeled-set). Name it after its
version, for example `reviews-v1.jsonl` with `reviews-v1-agreement.jsonl` for
the double-annotated subset, and record its sha256 next to any baseline
report. Only commit it here if every review is public and scrubbed of PII.
