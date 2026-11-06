import { readFileSync } from "node:fs";

import { JWT } from "google-auth-library";

import { isConfigured } from "@/lib/env";
import {
  parseServiceAccountKey,
  type ServiceAccountKey,
} from "@/lib/credentials/service-account";
import { PublicError } from "@/lib/errors";

export { isValidServiceAccountKey, parseServiceAccountKey } from "@/lib/credentials/service-account";

export const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";

async function mint(key: ServiceAccountKey, scopes: string[], failure: string): Promise<string> {
  try {
    const client = new JWT({ email: key.email, key: key.privateKey, scopes });
    const { token } = await client.getAccessToken();
    if (token) return token;
  } catch (error) {
    console.error("[reviewsignal] Google token minting failed", error instanceof Error ? error.message : error);
  }
  throw new PublicError(failure, 502);
}

let cachedEnvKey: { source: string; key: ServiceAccountKey } | undefined;

function environmentKey(): ServiceAccountKey | undefined {
  const inline = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!inline && !keyFile) return undefined;
  const source = inline ? `inline:${inline}` : `file:${keyFile}`;
  if (cachedEnvKey?.source !== source) {
    const raw = inline ? inline : readFileSync(keyFile as string, "utf8");
    cachedEnvKey = { source, key: parseServiceAccountKey(raw) };
  }
  return cachedEnvKey.key;
}

/**
 * Returns an Android Publisher access token for the standalone analyzer,
 * from GOOGLE_PLAY_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS, or
 * a static GOOGLE_PLAY_ACCESS_TOKEN as a manual fallback.
 */
export async function getGooglePlayAccessToken(): Promise<string> {
  const key = environmentKey();
  if (key) {
    return mint(
      key,
      [ANDROID_PUBLISHER_SCOPE],
      "Could not mint a Google Play access token from the service account. Check the credentials and Play Console permissions.",
    );
  }

  const staticToken = process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  if (isConfigured(staticToken)) return staticToken;

  throw new PublicError(
    "Google Play is selected but no credentials are configured. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (recommended) or GOOGLE_PLAY_ACCESS_TOKEN.",
  );
}

/** Mints a token from a service-account key (a tenant's, or X3M's). */
export async function mintGoogleAccessToken(
  serviceAccountJson: string,
  scopes: string[] = [ANDROID_PUBLISHER_SCOPE],
): Promise<string> {
  return mint(
    parseServiceAccountKey(serviceAccountJson),
    scopes,
    "Google rejected the service account. Check the key and its Play Console access.",
  );
}

export function resetGoogleAuthCache(): void {
  cachedEnvKey = undefined;
}
