-- Local development only (docker-compose.yml). Runs once, on first start of
-- an empty data volume.
--
-- The services connect as `reviewsignal`, a role that is neither superuser
-- nor BYPASSRLS. Superusers always bypass row-level security, so connecting
-- as the image's `postgres` superuser would hide RLS bugs locally. The role
-- owns the database; FORCE ROW LEVEL SECURITY (ADR 0006) makes the policies
-- apply to the table owner as well.
CREATE ROLE reviewsignal
  LOGIN
  PASSWORD 'reviewsignal-local'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

CREATE DATABASE reviewsignal OWNER reviewsignal;
