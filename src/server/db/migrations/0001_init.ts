/**
 * Initial schema. Migrations are TypeScript modules exporting SQL so they are
 * bundled into dist/server/migrate.js and never drift from the image.
 *
 * Tenancy: every tenant-owned table carries tenant_id and is protected by a
 * FORCE ROW LEVEL SECURITY policy. Requests set `app.tenant_id` per
 * transaction; trusted jobs set `app.bypass_rls = 'on'`.
 */
export const name = "0001_init";

const tenantTables = [
  "app",
  "store_connection",
  "review",
  "classification",
  "ingestion_run",
  "coverage_day",
  "review_daily_rollup",
  "experiment",
  "guardrail_rule",
  "guardrail_evaluation",
  "alert",
  "classification_spend",
  "upload",
];

const rls = tenantTables
  .map(
    (table) => `
alter table ${table} enable row level security;
alter table ${table} force row level security;
create policy ${table}_tenant_isolation on ${table}
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );`,
  )
  .join("\n");

export const sql = `
create table tenant (
  id uuid primary key default gen_random_uuid(),
  loomit_publisher_id text not null unique,
  name text not null,
  daily_budget_usd numeric(10, 2) not null default 5.00,
  retention_days integer not null default 730 check (retention_days between 30 and 3650),
  created_at timestamptz not null default now()
);

create table app (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  loomit_app_id text not null,
  name text not null,
  android_package text,
  apple_app_id text,
  play_reports_bucket text,
  created_at timestamptz not null default now(),
  unique (tenant_id, loomit_app_id)
);

create table store_connection (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  store text not null check (store in ('google_play', 'apple_app_store')),
  secret_ref text,
  status text not null default 'pending' check (status in ('pending', 'active', 'error', 'disabled')),
  last_verified_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  watermark timestamptz,
  backfilled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (app_id, store)
);

create table review (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  store text not null check (store in ('google_play', 'apple_app_store')),
  store_review_id text not null,
  created_at timestamptz not null,
  last_modified_at timestamptz,
  date_semantics text not null check (date_semantics in ('created_at', 'last_modified_fallback')),
  rating smallint not null check (rating between 1 and 5),
  title text not null default '',
  body text not null,
  language text,
  territory text,
  app_version text,
  text_hash text not null,
  source text not null check (source in ('api', 'csv', 'report')),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id, store, store_review_id)
);
create index review_app_created_idx on review (app_id, created_at desc);
create index review_tenant_idx on review (tenant_id);

create table classification (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  review_id uuid not null references review (id) on delete cascade,
  text_hash text not null,
  model_version text not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  taxonomy_version text not null,
  sentiment_score smallint not null check (sentiment_score between 0 and 4),
  sentiment_ev real not null,
  sentiment_estimator text not null,
  sentiment_probs jsonb,
  sentiment_confidence real not null,
  primary_reason text not null,
  secondary_reason text,
  ad_subreason text,
  reason_probs jsonb,
  reason_confidence real not null,
  cost_usd numeric(14, 8),
  created_at timestamptz not null default now(),
  unique (review_id, text_hash, model_version)
);
create index classification_review_idx on classification (review_id, model_version);

create table ingestion_run (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  store text not null,
  mode text not null check (mode in ('incremental', 'backfill', 'csv', 'report')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  pages integer not null default 0,
  reviews_upserted integer not null default 0,
  truncated boolean not null default false,
  rate_limited boolean not null default false,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  error text
);
create index ingestion_run_app_idx on ingestion_run (app_id, started_at desc);

create table coverage_day (
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  store text not null,
  day date not null,
  status text not null check (status in ('complete', 'partial', 'unknown')),
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (app_id, store, day)
);

create table review_daily_rollup (
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  store text not null,
  day date not null,
  app_version text not null default '',
  territory text not null default '',
  model_version text not null,
  n integer not null,
  sum_ev double precision not null,
  sum_ev2 double precision not null,
  sum_rating double precision not null,
  sum_rating2 double precision not null,
  negative integer not null,
  neutral integer not null,
  positive integer not null,
  ads_negative integer not null,
  reason_counts jsonb not null default '{}',
  negative_reason_counts jsonb not null default '{}',
  ad_subreason_counts jsonb not null default '{}',
  primary key (app_id, store, day, app_version, territory, model_version)
);

create table experiment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  loomit_experiment_id text not null,
  name text not null,
  attribution_mode text not null check (attribution_mode in ('dimension', 'pre_post')),
  dimension text check (dimension in ('app_version', 'territory', 'store')),
  arms jsonb not null,
  start_at timestamptz not null,
  end_at timestamptz,
  baseline_start timestamptz,
  baseline_end timestamptz,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, loomit_experiment_id)
);

create table guardrail_rule (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid references app (id) on delete cascade,
  metric text not null check (metric in ('G1', 'G2', 'G3', 'G4')),
  warn_threshold double precision not null,
  breach_threshold double precision not null,
  min_n integer not null default 20,
  enabled boolean not null default true,
  unique nulls not distinct (tenant_id, app_id, metric)
);

create table guardrail_evaluation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  experiment_id uuid not null references experiment (id) on delete cascade,
  evaluated_at timestamptz not null default now(),
  model_version text,
  status text not null check (status in ('ok', 'warn', 'breach', 'insufficient')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  results jsonb not null,
  confounders jsonb not null default '[]',
  series jsonb not null default '[]'
);
create index guardrail_evaluation_experiment_idx on guardrail_evaluation (experiment_id, evaluated_at desc);

create table alert (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  experiment_id uuid not null references experiment (id) on delete cascade,
  evaluation_id uuid not null references guardrail_evaluation (id) on delete cascade,
  metric text not null,
  status text not null check (status in ('warn', 'breach')),
  dedup_key text not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  delivery_attempts integer not null default 0,
  last_delivery_error text
);
create index alert_dedup_idx on alert (dedup_key, created_at desc);

create table classification_spend (
  tenant_id uuid not null references tenant (id) on delete cascade,
  day date not null,
  cost_usd numeric(14, 6) not null default 0,
  reviews integer not null default 0,
  primary key (tenant_id, day)
);

create table upload (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  object_key text not null,
  file_name text not null,
  platform text not null check (platform in ('android', 'ios')),
  status text not null default 'pending' check (status in ('pending', 'imported', 'failed')),
  created_at timestamptz not null default now(),
  imported_at timestamptz,
  error text
);

create table audit_log (
  id bigserial primary key,
  tenant_id uuid references tenant (id) on delete set null,
  actor text not null,
  action text not null,
  target text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

${rls}
`;
