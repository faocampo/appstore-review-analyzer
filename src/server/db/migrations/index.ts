import * as init from "@/server/db/migrations/0001_init";
import * as secrets from "@/server/db/migrations/0002_secrets";
import * as readPath from "@/server/db/migrations/0003_read_path";
import * as keyset from "@/server/db/migrations/0004_review_keyset_index";

export interface Migration {
  name: string;
  sql: string;
}

/** Ordered list of migrations. Append only; never edit an applied migration. */
export const migrations: Migration[] = [init, secrets, readPath, keyset];
