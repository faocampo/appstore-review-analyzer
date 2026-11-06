# ReviewSignal: questions for Legal (DPA, store terms, sub-processors)

**Purpose.** Questions Legal needs to answer before ReviewSignal processes
production publisher data (plan §4: the Legal gate closes before M3 goes to
production) and before GA. This document asks; it does not answer. Facts
about the current implementation are stated so the questions can be answered
against what the system actually does; anything not yet verified is marked.

Owner: Legal counsel. Contributors: product owner, ReviewSignal developer,
security reviewer. Record each answer, its source (contract clause, terms
section, vendor confirmation) and the date next to the question.

## Background: what the system does

- **Data in.** For apps a publisher connects: written reviews from the
  Google Play Developer API (`reviews.list`, about the last 7 days) and the
  App Store Connect API (`customerReviews`), optional history from the
  publisher's Play Console reports bucket (Google Cloud Storage), and CSV
  exports the publisher uploads. Fields: review text, title, rating, dates,
  language, country, app version, store review ID. Apple's API also returns
  the reviewer nickname; it is not stored and not sent to classifiers.
- **Credentials.** Publishers give X3M read access: an App Store Connect
  API key (Customer Support role) uploaded by the publisher, and for Google
  either an invitation of an X3M service account (the target design) or a
  publisher-created service account key (the current implementation). Keys
  are stored in AWS Secrets Manager, encrypted with KMS.
- **Classification.** Review title, text, rating, language, country and
  store are sent to a large-language-model provider through **OpenRouter**
  (production default) with `data_collection: "deny"` and zero-data-retention
  (ZDR) routing, or to **TypeSafe (Jev)**, one review per request.
- **Storage and use.** Postgres (AWS RDS) per tenant with row-level
  isolation; metrics shown to the publisher in the Loomit console; guardrail
  alerts sent to the publisher and to the X3M customer success manager; a
  Parquet export to S3 for joining with Loomit metrics (ARPDAU, DAU) in
  Databricks or Druid.
- **Hosting region.** Not decided. The Helm overlays currently assume
  `us-east-1` as a placeholder.

## 1. Roles and legal basis

1. Is X3M a processor acting for the publisher (controller) for review data,
   or a controller in its own right for any part (for example, the internal
   analytics export or model evaluation)?
2. Do reviews constitute personal data in this context? Review text is
   written by end users and can contain names, emails or other identifiers;
   Apple's feed includes reviewer nicknames.
3. Does the existing Loomit DPA cover ReviewSignal processing, or is an
   addendum or a separate DPA needed? Does it need publisher opt-in (for
   example, an order form or click-through at connection time)?
4. May X3M use publisher review data, in aggregate or not, for purposes
   beyond the publisher's own panel and guardrails, such as improving the
   taxonomy, the evaluation set, or cross-publisher benchmarks?

## 2. Store API terms

### Google Play

5. Do the Google Play Developer API terms and the Play Console terms allow a
   third party (X3M), authorized by the developer, to retrieve and store the
   developer's reviews through the API and through the reports bucket?
6. Do they allow sending review content to third-party processors,
   including LLM providers, for classification?
7. Is storing reviews beyond the API's ~7-day window, and combining them
   with other data (monetization metrics), permitted?
8. Does Google require anything specific for a service account owned by one
   company (X3M) acting across many developer accounts?

### Apple

9. Do the Apple Developer Program License Agreement and the App Store
   Connect API terms allow a third party, given an API key by the developer,
   to retrieve, store and process customer reviews?
10. Is sending review content to LLM providers for classification permitted?
11. Are there restrictions on retention or on combining reviews with other
    data?
12. Is holding a publisher's App Store Connect team key (which covers all of
    the publisher's apps) acceptable, and what liability does X3M take on as
    its custodian?

## 3. Sub-processors

### OpenRouter

13. Is OpenRouter's DPA in place or acceptable, and does it cover the
    upstream model providers it routes to?
14. Do OpenRouter's ZDR routing and `data_collection: "deny"` give
    contractual guarantees (no retention, no training) or only best-effort
    routing? What does OpenRouter itself log or retain (prompts, completions,
    metadata), and for how long?
15. Which upstream providers can serve the shortlisted models under ZDR,
    where do they process data, and must each be listed as a sub-processor?
16. What transfer mechanism applies for EU publishers' data (SCCs, Data
    Privacy Framework), for OpenRouter and for the upstream providers?
17. What notice is required when the model or upstream provider changes?

### TypeSafe (Jev)

18. Is there a contract and DPA with TypeSafe covering production use?
19. Does TypeSafe retain review content or use it for training? Where is it
    processed?
20. If Jev stays only as a fallback, does it still need to be disclosed as a
    sub-processor?

### Others

21. AWS (hosting, RDS, S3, Secrets Manager): covered by the existing X3M AWS
    agreement and DPA?
22. Databricks or Druid, for the analytics export: are they sub-processors
    for this data, and is the export within the DPA's purposes?

## 4. Retention and deletion

23. What retention period should apply by default to reviews,
    classifications and rollups? Should publishers be able to configure it
    (the implementation supports a per-tenant retention in days)?
24. How long should the audit log of credential access and admin actions be
    kept?
25. Do backups (RDS automated backups and snapshots) need a maximum
    retention, and is "deleted from backups when they expire" acceptable?
26. When a reviewer deletes or edits a review in the store, must ReviewSignal
    delete or update its copy? Within what time?

## 5. Offboarding

27. When a publisher stops using ReviewSignal or leaves Loomit, what must be
    deleted, by when, and what confirmation is owed to the publisher?
28. Store credentials: delete immediately, or keep through Secrets Manager's
    recovery window (7–30 days)?
29. Data already exported to the analytics platform (Databricks/Druid): must
    it be deleted on offboarding, and who owns that process?
30. Must X3M remind publishers to revoke its access on the store side (remove
    the service account, revoke the API key)?

## 6. Regions and transfers

31. In which AWS region(s) must data be hosted? Are EU publishers' data
    subject to EU residency requirements in their contracts?
32. Is processing by LLM providers outside the hosting region (for example,
    in the US) acceptable, and under which mechanism?
33. Do any publishers' contracts restrict sub-processors or locations in a
    way that ReviewSignal must support per tenant (for example, disabling LLM
    classification)?

## 7. Customer-facing materials

34. Review and approve the publisher onboarding guide
    ([`docs/publisher/onboarding.md`](../publisher/onboarding.md)), in
    particular the section "What data ReviewSignal processes, and where".
35. Is consent or notice language needed in the console when a publisher
    connects a store?
36. What security-incident notification obligations apply for credential
    or review-data exposure, and to whom?

## Sign-off

| Area | Answered by | Date | Notes |
| --- | --- | --- | --- |
| 1. Roles and legal basis | | | |
| 2. Store API terms | | | |
| 3. Sub-processors | | | |
| 4. Retention and deletion | | | |
| 5. Offboarding | | | |
| 6. Regions and transfers | | | |
| 7. Customer-facing materials | | | |
