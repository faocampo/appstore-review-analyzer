import * as init from "@/server/db/migrations/0001_init";
import * as secrets from "@/server/db/migrations/0002_secrets";

export interface Migration {
  name: string;
  sql: string;
}

/** Ordered list of migrations. Append only; never edit an applied migration. */
export const migrations: Migration[] = [init, secrets];
