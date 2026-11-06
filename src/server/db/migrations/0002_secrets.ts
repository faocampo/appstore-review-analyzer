/**
 * Encrypted secret storage for non-production environments
 * (SECRET_STORE=database). Production uses AWS Secrets Manager and leaves
 * this table empty. Values are AES-256-GCM ciphertext; the key never touches
 * the database.
 */
export const name = "0002_secrets";

export const sql = `
create table secret (
  ref text primary key,
  tenant_id uuid not null references tenant (id) on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  updated_at timestamptz not null default now()
);
alter table secret enable row level security;
alter table secret force row level security;
create policy secret_tenant_isolation on secret
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );
`;
