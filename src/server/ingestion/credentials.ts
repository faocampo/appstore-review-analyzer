import { z } from "zod";

import { signAppStoreConnectToken } from "@/lib/credentials/apple";
import { mintGoogleAccessToken } from "@/lib/credentials/google";
import { PublicError } from "@/lib/errors";
import { appleCredentialsSchema, googleCredentialsSchema } from "@/server/api/contracts";
import type { ConnectionRow } from "@/server/repo/apps";
import type { SecretStore } from "@/server/secrets/store";

export const GCS_READ_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

async function readSecret<T>(
  secrets: SecretStore,
  connection: ConnectionRow,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!connection.secret_ref) throw new PublicError("The connection has no stored credentials.", 409);
  const value = await secrets.get(connection.tenant_id, connection.secret_ref);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PublicError("The stored credentials are missing or malformed. Reconnect the store.", 409);
  return parsed.data;
}

/** Mints a short-lived store token from the tenant's stored credentials. */
export async function tokenForConnection(
  secrets: SecretStore,
  connection: ConnectionRow,
  options: { scopes?: string[] } = {},
): Promise<string> {
  if (connection.store === "google_play") {
    const { serviceAccountJson } = await readSecret(secrets, connection, googleCredentialsSchema);
    return mintGoogleAccessToken(serviceAccountJson, options.scopes);
  }
  const credentials = await readSecret(secrets, connection, appleCredentialsSchema);
  return signAppStoreConnectToken(credentials);
}
