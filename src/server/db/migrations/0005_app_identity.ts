/**
 * Trusted app identity (security review H1). X3M's shared Google service
 * account may only read apps whose package and Play reports bucket were set
 * by Loomit (service role) or an X3M admin, never by a publisher alone, and
 * each verified package or bucket can belong to one app only. Otherwise one
 * publisher could register another's package and pull its reviews through
 * the access that publisher granted to X3M.
 */
export const name = "0005_app_identity";

export const sql = `
alter table app add column identity_verified boolean not null default false;
create unique index app_verified_android_package_idx on app (android_package)
  where identity_verified and android_package is not null;
create unique index app_verified_play_bucket_idx on app (play_reports_bucket)
  where identity_verified and play_reports_bucket is not null;
`;
