# ReviewSignal packaging options

**Status: proposal for discussion, not a decision.** Plan §9 item 5 leaves
open whether ReviewSignal is included in Loomit or sold as an add-on; the
decision belongs to milestone M5 ([GA checklist](../operations/ga-checklist.md), items B1–B3).
Cost figures below are illustrative and rest on stated assumptions; replace
them with measured values from the M1 evaluation and the closed beta before
deciding.

Decision owners: business owner and product owner, with input from the
ReviewSignal developer (costs) and X3M customer success (publisher feedback).

## What is being packaged

1. **Evolution panel:** how an app's reviews evolve (sentiment, written-review
   rating, reasons including ad sub-reasons, versions, countries) with a
   review drill-down.
2. **Review guardrails:** a UX guardrail in every Loomit experiment readout,
   with alerts to the publisher and the X3M CSM.
3. **History import:** Play Console report history and CSV imports.

The guardrail strengthens Loomit's own product (better experiment decisions);
the panel is closer to a standalone review-analytics tool, a category other
vendors sell separately.

## Cost drivers

### Classification (variable, the main driver)

Cost per 1,000 reviews depends on the model chosen at the M1 gate. Model:

```
cost per 1,000 reviews ≈ 1,000 × (input tokens per review × input price
                                  + output tokens per review × output price)
                         × (1 + retry overhead)
```

*Assumptions (unverified; measure in M1):*

- Input per review ≈ 170 tokens: about 70 for title and text, 25 for
  metadata, 75 for the shared prompt and schema spread over a batch of 20.
- Output per review ≈ 50 tokens of structured JSON.
- Retry overhead ≈ 10%.

| Model price class (USD per 1M tokens, input / output) | Approx. cost per 1,000 reviews |
| --- | --- |
| Small: 0.10 / 0.40 | ≈ $0.04 |
| Mid: 0.50 / 2.00 | ≈ $0.20 |
| Large: 3.00 / 15.00 | ≈ $1.40 |

Prices are examples of price classes, not quotes; OpenRouter prices change
and zero-data-retention routing can restrict the cheaper providers. Once
running, the service reports the actual figure
(`reviewsignal:classifier_cost_usd_per_1k_reviews:1d`).

Other variable effects:

- **Caching:** an unchanged review is never reclassified, so steady-state
  cost follows *new or edited* reviews, not stored reviews.
- **Backfills:** a one-off cost when a publisher imports history.
- **Model changes:** reclassifying the baseline windows of active
  experiments is a one-off cost per change, borne by X3M.

### Review volume (unknown, measure in beta)

Written-review volume varies by orders of magnitude between apps. As
illustration only:

| App profile (assumed) | New written reviews / month | Classification cost / month at $0.04 · $0.20 · $1.40 per 1k |
| --- | --- | --- |
| Small | 300 | $0.01 · $0.06 · $0.42 |
| Mid | 3,000 | $0.12 · $0.60 · $4.20 |
| Large | 30,000 | $1.20 · $6.00 · $42.00 |

### Storage (small)

About 1–1.5 KB per review including classification and indexes, so roughly
1.5 GB per million reviews, plus small daily rollups. At typical RDS storage
prices this is cents per million reviews per month. *Assumption:* verify
against the production schema and the RDS price in the chosen region.

### Fixed platform cost (shared)

API (2–3 small pods), worker (1–2 pods) and a Postgres instance, plus
monitoring. Likely a few hundred USD per month regardless of the number of
publishers, depending on whether ReviewSignal gets a dedicated RDS instance
or shares one. *Assumption:* confirm with the Loomit platform team.

### People cost (largest, not usage-driven)

Operation and on-call, publisher support for store connections (Apple key
creation is the main friction), CSM time for guardrail alerts, and taxonomy
and model upkeep.

**Implication.** At small or mid model prices, variable cost per publisher
is low enough that pricing is a positioning choice more than a cost-recovery
one. At large-model prices, or with very high-volume apps, a per-tenant
budget or usage component matters.

## Options

### A. Included in every Loomit tier

All publishers get the panel and guardrails. Costs are controlled by the
per-tenant daily classification budget (fair use).

- **For:** maximum adoption (plan §5 adoption metrics); every experiment
  readout carries the UX guardrail, which is where the product's
  differentiation lies; simplest to sell and bill; no entitlement logic.
- **Against:** no direct revenue; X3M absorbs cost growth; harder to charge
  later once included ("taking away" perception); budget cut-offs may be
  felt as degraded service by high-volume publishers.

### B. Guardrails included, evolution panel as a paid add-on

The guardrail in experiment readouts is part of Loomit; the full evolution
panel (history, breakdowns, drill-down, history import) is an add-on.

- **For:** keeps the guardrail universal (it improves Loomit decisions and
  protects long-run monetization); monetizes the part comparable to
  standalone review-analytics tools; cost of the add-on scales with paying
  users.
- **Against:** two entitlements to build and explain; ingestion runs for all
  publishers anyway (guardrails need the data), so the add-on gates UI, not
  cost; a smaller panel audience slows feedback.

### C. Whole plugin as a paid add-on (flat fee per app or per publisher)

- **For:** direct revenue; predictable billing; self-selects engaged
  publishers, easing support load early on.
- **Against:** low adoption limits the guardrail's reach and the plan's
  impact metrics (experiments where the guardrail changed the decision);
  flat fees ignore large volume differences between apps; a sales motion
  is needed.

### D. Usage-based (per 1,000 reviews classified, or per connected app)

- **For:** revenue tracks cost; fair across small and large apps.
- **Against:** unpredictable bills for publishers (review bursts after a bad
  release are exactly when the tool matters); needs metering and billing
  support in Loomit; publishers may disconnect apps to save money, weakening
  guardrails.

### Comparison

| Criterion | A. Included | B. Guardrails incl. + panel add-on | C. Flat add-on | D. Usage-based |
| --- | --- | --- | --- | --- |
| Adoption / guardrail coverage | Highest | High (guardrail) / medium (panel) | Low–medium | Medium |
| Direct revenue | None | Some | Yes | Yes |
| Cost exposure for X3M | Highest (capped by budgets) | Medium | Low | Lowest |
| Billing / entitlement complexity | None | Medium | Low–medium | High |
| Predictability for publishers | High | High | High | Low |

## Proposed direction (for discussion)

Option **B** fits best on current information: the guardrail is most
valuable when it is present in every experiment, and the panel is the part
publishers already pay other vendors for. Keep per-tenant classification
budgets in every option as a cost safety net.

What would change this view:

- If Loomit's commercial model gains directly from publishers' long-term
  monetization health (for example a revenue share), the case for **A**
  strengthens. *Unverified; depends on Loomit's pricing model.*
- If the M1 model decision lands in the large price class, or beta volumes
  are far above the illustrations, a usage component (**D** for history
  imports or very large apps) becomes necessary.
- If Loomit billing cannot support add-on entitlements in time for GA, start
  with **A** for the closed beta and early GA and decide on B after measured
  usage.

## Inputs needed before deciding

1. Cost per 1,000 reviews for the chosen model (M1 evaluation).
2. Review volume distribution across beta apps (M2–M3).
3. Loomit's pricing model and what its billing system supports (add-ons,
   usage metering).
4. Beta publishers' feedback on willingness to pay for the panel.
5. Competitive positioning of review-analytics tools publishers already use.
6. Support effort observed during the closed beta (connections, alerts).
