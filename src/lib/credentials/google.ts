import { readFileSync } from "node:fs";

import { JWT } from "google-auth-library";
import { z } from "zod";

import { isConfigured } from "@/lib/env";
import { PublicError } from "@/lib/errors";

export const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/**
 * Only plain service-account keys are accepted. Other credential types that
 * google-auth-library understands (external_account, impersonated accounts,
 * authorized users) make the library read local files or call URLs taken
 * from the JSON, which would let a tenant exfiltrate pod secrets. Tokens are
 * always minted with the JWT client from the email and private key alone.
 */
const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().regex(/^[^@\s]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/i, "must be a Google service-account email"),
  private_key: z.string().startsWith("-----BEGIN PRIVATE KEY-----"),
  token_uri: z.literal(GOOGLE_TOKEN_URI).optional(),
  universe_domain: z.literal("googleapis.com").optional(),
});

export interface ServiceAccountKey {
  email: string;
  privateKey: string;
}

/** Parses and validates a service-account key (raw JSON or base64 of it). */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw.trim(), "base64").toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PublicError("The Google service-account key is not valid JSON.", 400);
  }
  const parsed = serviceAccountSchema.safeParse(value);
  if (!parsed.success) {
    throw new PublicError(
      "Only Google service-account keys (type \"service_account\") with Google's default token endpoint are accepted.",
      400,
    );
  }
  return { email: parsed.data.client_email, privateKey: parsed.data.private_key };
}

/** True when `raw` is an acceptable service-account key; used by request validation. */
export function isValidServiceAccountKey(raw: string): boolean {
  try {
    parseServiceAccountKey(raw);
    return true;
  } catch {
    return false;
  }
}

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
