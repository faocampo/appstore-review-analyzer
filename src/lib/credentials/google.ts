import { GoogleAuth } from "google-auth-library";

import { isConfigured } from "@/lib/env";
import { PublicError } from "@/lib/errors";

export const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";

let cachedAuth: { key: string; auth: GoogleAuth } | undefined;

function serviceAccountCredentials(): Record<string, unknown> | undefined {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return undefined;

  const json = raw.startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new PublicError(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON (raw or base64).",
    );
  }
}

function googleAuth(): GoogleAuth | undefined {
  const credentials = serviceAccountCredentials();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentials && !keyFile) return undefined;

  const cacheKey = credentials ? JSON.stringify(credentials) : `file:${keyFile}`;
  if (cachedAuth?.key !== cacheKey) {
    cachedAuth = {
      key: cacheKey,
      auth: new GoogleAuth({
        ...(credentials ? { credentials } : { keyFile }),
        scopes: [ANDROID_PUBLISHER_SCOPE],
      }),
    };
  }
  return cachedAuth.auth;
}

/**
 * Returns an Android Publisher access token. Service-account credentials
 * (inline JSON or a key file) are preferred: google-auth-library mints and
 * refreshes short-lived tokens automatically. A static
 * GOOGLE_PLAY_ACCESS_TOKEN remains as a manual fallback.
 */
export async function getGooglePlayAccessToken(): Promise<string> {
  const auth = googleAuth();
  if (auth) {
    try {
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();
      if (token) return token;
    } catch (error) {
      console.error("[reviewsignal] Google token minting failed", error);
    }
    throw new PublicError(
      "Could not mint a Google Play access token from the service account. Check the credentials and Play Console permissions.",
      502,
    );
  }

  const staticToken = process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  if (isConfigured(staticToken)) return staticToken;

  throw new PublicError(
    "Google Play is selected but no credentials are configured. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (recommended) or GOOGLE_PLAY_ACCESS_TOKEN.",
  );
}

export function resetGoogleAuthCache(): void {
  cachedAuth = undefined;
}
