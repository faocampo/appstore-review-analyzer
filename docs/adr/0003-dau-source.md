# ADR 0003: Source of DAU for per-user normalization

- **Status:** Proposed
- **Date:** 2026-11-06
- **Deciders:** Product owner, Loomit backend lead, data platform owner, ReviewSignal developer
- **Related:** productization plan §3.3, §3.4 (G3), §9 item 3

## Context

Two metrics need daily active users (DAU):

- **Panel:** ad-related negative reviews per 100k DAU, per app and day (§3.3).
- **Guardrail G3:** ad-related negative reviews per 100k DAU, test vs.
  control or baseline (§3.4).

DAU must use the same definition as the ARPDAU and IMPDAU that the Loomit
readout already shows, or the guardrail and the revenue metrics will
disagree.

**Current implementation.** The experiment link payload
(`POST /v1/experiments/{id}/link`) accepts an optional `dau` per arm: the
arm's average daily active users over the window, sent by the Loomit backend.
G3 uses it when present and reports `insufficient` when it is missing. The
evolution panel has no DAU source yet, so the per-DAU series is not shown.

Candidate sources:

### A. Loomit analytics API (whatever the readout uses)

ReviewSignal receives DAU from Loomit: pushed with the experiment link (as
today) and, for the panel, pulled daily per app from an analytics endpoint,
or pushed by the Loomit backend on a schedule.

- **Pros.** Same definition and filters as ARPDAU in the readout by
  construction; no direct coupling to storage schemas; access control stays
  in Loomit.
- **Cons.** Needs an endpoint or job owned by the Kotlin backend team (time
  outside the ReviewSignal developer); availability of DAU depends on that
  service.

### B. Druid directly

ReviewSignal queries the Druid datasource that holds DAU.

- **Pros.** Low-latency, fine-grained (day, country, platform); no new
  Loomit endpoint.
- **Cons.** Couples ReviewSignal to a datasource schema owned elsewhere;
  needs credentials and network access to Druid; risk of a different DAU
  definition from the readout's; more for the security review.
  *Unverified:* that Druid is the store behind the console's ARPDAU.

### C. Databricks

DAU computed in Databricks; ReviewSignal reads a published table or receives
an export.

- **Pros.** The S3 Parquet export already lands review data there; good for
  backtests and offline analysis.
- **Cons.** Batch latency (hours); not suited to request-time reads; a
  second pipeline to operate for an operational metric.

## Recommendation

**Option A.** Keep the push model for guardrails (DAU in the experiment link,
already implemented) and add a daily DAU feed per app from the same Loomit
analytics source the readout uses, owned by the Loomit backend. Use
Databricks only for offline work (backtests, analysis on the S3 export). Do
not query Druid directly from ReviewSignal.

Before deciding, confirm with the Loomit backend and data teams which system
computes the readout's DAU and whether a per-app daily series by country and
platform is available.

## Consequences

- The Kotlin backend estimate (about 1 week) must include the DAU feed or
  endpoint, or the panel metric moves after GA.
- Until then: the panel omits per-DAU series (no invented numbers); G3 uses
  the `dau` sent with the link and reports `insufficient` without it.
- Storing a daily DAU per app adds a small table and must be covered by RLS
  and retention like other tenant data.
