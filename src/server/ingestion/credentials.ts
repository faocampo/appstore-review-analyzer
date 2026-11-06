import { z } from "zod";

import { signAppStoreConnectToken } from "@/lib/credentials/apple";
import { mintGoogleAccessToken } from "@/lib/credentials/google";
import { PublicError } from "@/lib/errors";
import { appleCredentialsSchema, googleCredentialsSchema } from "@/server/api/contracts";
import type { AppRow, ConnectionRow } from "@/server/repo/apps";

export const UNVERIFIED_APP =
  "X3M's Google account can only be used for apps registered by Loomit. Ask your Loomit contact to register the app, or connect your own service-account key.";
import type { SecretStore } from "@/server/secrets/store";

export const GCS_READ_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

/** X3M's own Google service account, which publishers invite in Play Console. */
function x3mServiceAccountJson(): string | null {
  const raw = process.env.X3M_GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  return raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
}

export function x3mServiceAccountEmail(): string | null {
  const json = x3mServiceAccountJson();
  if (!json) return null;
  try {
    const email = (JSON.parse(json) as { client_email?: unknown }).client_email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

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
  app: Pick<AppRow, "identity_verified">,
  options: { scopes?: string[] } = {},
): Promise<string> {
  if (connection.store === "google_play") {
    const credentials = await readSecret(secrets, connection, googleCredentialsSchema);
    if ("useX3mServiceAccount" in credentials) {
      // X3M's account can read every app whose owner invited it; only use it
      // for identities Loomit vouched for (security review H1).
      if (!app.identity_verified) throw new PublicError(UNVERIFIED_APP, 409);
      const json = x3mServiceAccountJson();
      if (!json) throw new PublicError("X3M's Google service account is not configured on the server.", 503);
      return mintGoogleAccessToken(json, options.scopes);
    }
    return mintGoogleAccessToken(credentials.serviceAccountJson, options.scopes);
  }
  const credentials = await readSecret(secrets, connection, appleCredentialsSchema);
  return signAppStoreConnectToken(credentials);
}
