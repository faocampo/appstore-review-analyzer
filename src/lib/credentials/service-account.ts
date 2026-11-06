/**
 * Google service-account key validation, with no Node-only dependencies so
 * the API contracts (also used by the browser panels) can import it.
 */
import { z } from "zod";

import { PublicError } from "@/lib/errors";

function decodeBase64(value: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "base64").toString("utf8");
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

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
  const text = raw.trim().startsWith("{") ? raw : decodeBase64(raw.trim());
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

