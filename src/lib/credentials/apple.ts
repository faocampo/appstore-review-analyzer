import { SignJWT, importPKCS8 } from "jose";

import { isConfigured } from "@/lib/env";
import { PublicError } from "@/lib/errors";

/** Apple accepts at most 20 minutes; stay well inside it. */
const TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_MARGIN_SECONDS = 60;

let cached: { key: string; token: string; expiresAt: number } | undefined;

function privateKeyPem(raw: string): string {
  const value = raw.includes("BEGIN")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  return value.replace(/\\n/g, "\n").trim();
}

/**
 * Returns an App Store Connect bearer token. When the issuer ID, key ID and
 * .p8 private key are configured, an ES256 JWT is signed server-side and
 * cached until shortly before expiry. A pre-signed
 * APPLE_APP_STORE_CONNECT_TOKEN remains as a manual fallback.
 */
export async function getAppStoreConnectToken(
  now: () => number = Date.now,
): Promise<string> {
  const issuerId = process.env.APPLE_ISSUER_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY;

  if (issuerId && keyId && privateKey) {
    const cacheKey = `${issuerId}:${keyId}`;
    const nowSeconds = Math.floor(now() / 1000);
    if (
      cached?.key === cacheKey &&
      cached.expiresAt - REFRESH_MARGIN_SECONDS > nowSeconds
    ) {
      return cached.token;
    }

    let key: CryptoKey;
    try {
      key = await importPKCS8(privateKeyPem(privateKey), "ES256");
    } catch {
      throw new PublicError(
        "APPLE_PRIVATE_KEY is not a valid PKCS#8 (.p8) ES256 key.",
      );
    }

    const expiresAt = nowSeconds + TOKEN_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
      .setIssuer(issuerId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAt)
      .setAudience("appstoreconnect-v1")
      .sign(key);

    cached = { key: cacheKey, token, expiresAt };
    return token;
  }

  const staticToken = process.env.APPLE_APP_STORE_CONNECT_TOKEN;
  if (isConfigured(staticToken)) return staticToken;

  throw new PublicError(
    "App Store Connect is selected but no credentials are configured. Set APPLE_ISSUER_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (recommended) or APPLE_APP_STORE_CONNECT_TOKEN.",
  );
}

/** Signs a short-lived App Store Connect JWT from a tenant's API key. */
export async function signAppStoreConnectToken(
  credentials: { issuerId: string; keyId: string; privateKey: string },
  now: () => number = Date.now,
): Promise<string> {
  let key: CryptoKey;
  try {
    key = await importPKCS8(privateKeyPem(credentials.privateKey), "ES256");
  } catch {
    throw new PublicError("The App Store Connect private key is not a valid .p8 ES256 key.", 400);
  }
  const issuedAt = Math.floor(now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
    .setIssuer(credentials.issuerId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + TOKEN_TTL_SECONDS)
    .setAudience("appstoreconnect-v1")
    .sign(key);
}

export function resetAppleTokenCache(): void {
  cached = undefined;
}
