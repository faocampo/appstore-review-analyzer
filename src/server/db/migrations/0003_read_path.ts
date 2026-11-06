/**
 * Read-path performance (panel p95 < 500 ms):
 * - app.current_model_version, maintained by a statement trigger on
 *   classification inserts, replaces a join over every review.
 * - app_version_seen, maintained by a row trigger on review writes, gives
 *   release markers and version order without scanning reviews.
 * - Per-group reason counts in rollups let /reasons read rollups only.
 */
export const name = "0003_read_path";

export const sql = `
alter table app add column current_model_version text;

create table app_version_seen (
  tenant_id uuid not null references tenant (id) on delete cascade,
  app_id uuid not null references app (id) on delete cascade,
  app_version text not null,
  first_seen timestamptz not null,
  primary key (app_id, app_version)
);
alter table app_version_seen enable row level security;
alter table app_version_seen force row level security;
create policy app_version_seen_tenant_isolation on app_version_seen
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

create function review_track_version() returns trigger language plpgsql as $$
begin
  if new.app_version is not null then
    insert into app_version_seen (tenant_id, app_id, app_version, first_seen)
    values (new.tenant_id, new.app_id, new.app_version, new.created_at)
    on conflict (app_id, app_version) do update
      set first_seen = least(app_version_seen.first_seen, excluded.first_seen);
  end if;
  return new;
end $$;

create trigger review_track_version after insert or update of app_version, created_at on review
  for each row execute function review_track_version();

create function classification_track_model() returns trigger language plpgsql as $$
begin
  update app set current_model_version = latest.model_version
  from (
    select distinct on (r.app_id) r.app_id, i.model_version
    from inserted i join review r on r.id = i.review_id
    order by r.app_id, i.created_at desc
  ) latest
  where app.id = latest.app_id and app.current_model_version is distinct from latest.model_version;
  return null;
end $$;

create trigger classification_track_model after insert on classification
  referencing new table as inserted
  for each statement execute function classification_track_model();

alter table review_daily_rollup
  add column neutral_reason_counts jsonb not null default '{}',
  add column positive_reason_counts jsonb not null default '{}';

insert into app_version_seen (tenant_id, app_id, app_version, first_seen)
select tenant_id, app_id, app_version, min(created_at) from review
where app_version is not null group by tenant_id, app_id, app_version
on conflict do nothing;

update app set current_model_version = (
  select c.model_version from classification c join review r on r.id = c.review_id
  where r.app_id = app.id order by c.created_at desc limit 1
);
`;
