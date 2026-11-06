# ADR 0005: Classifier provider abstraction

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** ReviewSignal developer, product owner
- **Related:** productization plan §3.2, §6; `src/lib/classifiers/`; [security review §2.6](../operations/security-review.md#26-llm-data-flow)

## Context

Each review gets a five-level sentiment and a primary (and optional
secondary) reason from a controlled taxonomy. The MVP called TypeSafe Jev
directly, one request per review, and aborted the whole analysis on a single
error. For the plugin, classification must be:

- replaceable without touching ingestion, rollups or guardrails;
- reproducible: every result records what produced it, so rollups and
  guardrails never mix model versions;
- resilient: one failed review must not abort a batch;
- cost-capped per tenant;
- compliant with the data policy (no training on publisher data, no
  retention by the provider where avoidable).

## Decision

1. **A `ClassifierProvider` interface** (`src/lib/classifiers/provider.ts`)
   with an id, model, prompt version, taxonomy version, capabilities
   (`probabilities`, `maxBatch`) and a per-item `classify(batch)` result
   (`ok` or `error` per review).
2. **Three adapters:**
   - **OpenRouter, the production default.** Strict structured outputs with a
     JSON schema generated from the taxonomy, batches of about 20
     (`OPENROUTER_BATCH_SIZE`), Zod validation of every item, retries with
     backoff and timeouts. Requests always send
     `provider.data_collection: "deny"`; zero-data-retention routing is on
     unless `OPENROUTER_ZDR=false`. The model is pinned through
     `OPENROUTER_MODEL`; there is no default model in code.
   - **Jev (TypeSafe System One).** One request per review; probabilities
     validated for length and sum and mapped by label.
   - **Mock.** Deterministic keyword and rating rules for local work and
     tests; the default outside production.
3. **Selection by configuration:** `CLASSIFIER_PROVIDER`
   (`openrouter` | `jev` | `mock`), defaulting to `openrouter` when
   `NODE_ENV=production` and `mock` otherwise.
4. **Fallback with a circuit breaker:** `CLASSIFIER_FALLBACK_PROVIDER` names
   a second provider; after `CLASSIFIER_CIRCUIT_FAILURES` consecutive
   failures (default 3) the primary is skipped for
   `CLASSIFIER_CIRCUIT_COOLDOWN_MS` (default 5 minutes).
5. **Versioning:** each classification stores provider, model, prompt
   version and taxonomy version. Rollups carry a `model_version`; guardrails
   compare only rollups with the same `model_version`. Changing the default
   model requires reclassifying the baseline window of active experiments.
6. **Failure semantics:** a review that fails classification is stored as
   `unclassified`, excluded from averages and counted in notices; it never
   aborts the batch and is retried later.
7. **Cache:** the unique key `(review_id, text_hash, model, prompt_version)`
   prevents reclassifying unchanged reviews.
8. **Budget:** a daily cost budget per tenant with a soft cut-off and the
   `ReviewSignalClassifierBudgetExhausted` alert.

The application, not the model, computes every count, average and
distribution.

## Consequences

**Positive**

- The default model can change after the M1 evaluation, or later, through
  configuration plus a baseline reclassification, without code changes.
- A provider outage degrades to the fallback or to `unclassified` reviews,
  never to a failed sync.
- The mock keeps local development and CI free of credentials and cost.

**Negative and mitigations**

- Two external dependencies (OpenRouter and the upstream model providers it
  routes to). Mitigation: fallback provider, alerts on failure ratio and
  latency, pinned model.
- ZDR routing narrows the set of eligible upstream providers; a pinned model
  can become unavailable under ZDR. Mitigation: shortlist models with
  several ZDR providers (plan §9 item 4); disabling ZDR requires Legal sign-off.
- Fallback results carry a different `model_version`, so guardrails may show
  `insufficient` while the fallback is active. This is preferred over mixing
  model outputs in one comparison.
- OpenRouter returns an integer score without a reliable distribution, so the
  sentiment estimator differs from Jev's probability-weighted one; the
  response states which estimator was used.
- Review text leaves the service only to the configured provider; the
  sub-processor list and DPA must name it ([DPA checklist](../legal/dpa-checklist.md)).
