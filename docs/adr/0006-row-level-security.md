# ADR 0006: Tenant isolation with Postgres row-level security

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** ReviewSignal developer, security reviewer
- **Related:** productization plan §1 (strict tenant isolation), §3.5, §8;
  `src/server/db/migrations/0001_init.ts`, `src/server/db/pool.ts`;
  [security review §2.1](../operations/security-review.md#21-tenancy-and-row-level-security)

## Context

Every Loomit publisher is a tenant. Reviews, classifications, rollups,
connections, experiments and guardrail results are tenant-owned. One
shared database serves all tenants. A single missing `WHERE tenant_id = …`
in application code must not expose another publisher's data, and there is
one developer to review every query.

The API knows the tenant from the verified Loomit JWT. The worker and admin
endpoints legitimately work across tenants (scheduled syncs, fleet gauges,
retention, the X3M admin view).

Options considered: application-level filtering only; a schema or database
per tenant; Postgres row-level security (RLS).

## Decision

Use **RLS on every tenant-owned table, keyed on `tenant_id`, with FORCE**.

- Each tenant table has `tenant_id uuid not null` and:
  ```sql
  alter table <t> enable row level security;
  alter table <t> force row level security;
  create policy <t>_tenant_isolation on <t>
    using (
      current_setting('app.bypass_rls', true) = 'on'
      or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
    with check ( /* same expression */ );
  ```
- **Per-transaction scope.** `withScope` opens a transaction and calls
  `set_config('app.tenant_id', $1, true)` (transaction-local, the
  equivalent of `SET LOCAL`) from the verified token, or
  `set_config('app.bypass_rls', 'on', true)` for trusted jobs and admin
  endpoints. Nothing leaks to the next use of a pooled connection.
- **Fail closed.** With neither setting, `nullif(…, '')::uuid` is null, so
  no row matches: reads return nothing and writes are rejected.
- **FORCE** makes the policies apply to the table owner too. The service
  connects as a role that owns the schema but is `NOSUPERUSER NOBYPASSRLS`;
  superusers and `BYPASSRLS` roles skip RLS even when forced, so neither the
  RDS master user nor a superuser is ever the service's role. The local
  compose stack follows the same rule (`deploy/local/postgres-init.sql`).
- Application queries still filter by tenant where it helps the planner;
  RLS is the safety net, not the only filter.

## Consequences

**Positive**

- A forgotten tenant filter returns no foreign rows; cross-tenant writes fail
  on `WITH CHECK`.
- Isolation is testable directly against the database (security review §2.1).
- One schema and one migration path for all tenants.

**Negative and mitigations**

- `app.bypass_rls` is a plain setting: any code holding a connection can set
  it. RLS protects against mistakes, not against malicious code in the
  service. Mitigation: bypass only through the `SYSTEM` scope in worker and
  admin code paths, a CI check that fails on other uses (to be added before
  GA), and `audit_log` entries for admin cross-tenant access.
- Policy expressions run on every row access. Mitigation: indexes lead with
  `tenant_id` or `app_id`; panel reads hit small rollup tables; the load test
  verifies p95 latency.
- Operators querying across tenants must set the bypass explicitly, which is
  deliberate friction (see [runbooks](../operations/runbooks.md#common-procedures)).
- Every new tenant table must add the policy. Mitigation: the migrations
  apply it through one shared helper, and a test (security review §2.1)
  fails if any table with a `tenant_id` column lacks enabled and forced RLS.
