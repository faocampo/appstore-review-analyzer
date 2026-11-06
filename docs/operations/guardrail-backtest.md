# Guardrail backtest

Before review alerts are enabled for publishers (plan §3.4, M4 exit gate),
replay the guardrails over historical Loomit experiments to measure how often
they would have alerted, and on which experiments.

## Input

A JSON file exported from Loomit's experiment history:

```json
{
  "rules": { "G1": { "warn": 0.05, "breach": 0.1, "minN": 20 } },
  "experiments": [
    {
      "loomitPublisherId": "pub-123",
      "loomitExperimentId": "exp-456",
      "outcome": "neutral",
      "link": {
        "loomitAppId": "app-789",
        "name": "Interstitial cap 3 → 4",
        "attributionMode": "dimension",
        "dimension": "territory",
        "arms": [
          { "key": "test", "role": "test", "values": ["BR"], "dau": 41000 },
          { "key": "control", "role": "control", "values": ["MX"], "dau": 39500 }
        ],
        "startAt": "2026-09-01T00:00:00Z",
        "endAt": "2026-09-15T00:00:00Z"
      }
    }
  ]
}
```

- `link` is the same payload Loomit sends to `POST /v1/experiments/{id}/link`.
- `outcome` is optional ground truth from the experiment readout: `harmful`
  when the change was rolled back for UX reasons, `neutral` otherwise. Without
  labels the backtest still reports how often each metric would alert.
- `rules` overrides thresholds for the run, which lets you try candidate
  thresholds without touching production rules.

## Run

```bash
DATABASE_URL=postgres://... npm run backtest -- --file experiments.json
```

Run it against a read replica or staging copy that has the publishers'
reviews ingested and classified. Each experiment is linked and evaluated
inside a transaction that is rolled back, so nothing is written.

## Output and decision

The script prints each experiment's overall and per-metric status, then:

- the **false-positive rate**: the share of `neutral` experiments that would
  have raised warn or breach;
- the **true-positive rate**: the share of `harmful` experiments that would
  have alerted;
- how many experiments were `insufficient` (too few reviews to decide).

Agree the acceptable false-positive rate with Ad Monetization before tuning.
Raise thresholds or minimum N until that target is met, then store the result
in `guardrail_rule` (per tenant, or per app where an app behaves differently).
A high `insufficient` share means the review volume cannot support that
guardrail for those publishers; say so in the readout rather than lowering
minimum N.
