import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

import { PublicError } from "@/lib/errors";
import type { ServerConfig } from "@/server/config";

export type Role = "publisher" | "x3m_admin" | "service";

export interface Principal {
  subject: string;
  roles: Set<Role>;
  /** Loomit publisher id from the token (publisher tokens). */
  publisherId: string | null;
  publisherName: string | null;
}

export type TokenVerifier = (token: string) => Promise<JWTPayload>;

/**
 * Builds the verifier for the configured mode. OIDC verifies Loomit's tokens
 * against its JWKS, issuer and audience. Dev mode uses an HS256 shared
 * secret and is rejected by config in production.
 */
export function createVerifier(
  config: Pick<ServerConfig, "AUTH_MODE" | "OIDC_ISSUER" | "OIDC_AUDIENCE" | "OIDC_JWKS_URL" | "DEV_JWT_SECRET">,
  jwks?: JWTVerifyGetKey,
): TokenVerifier {
  if (config.AUTH_MODE === "oidc") {
    const keySet = jwks ?? createRemoteJWKSet(new URL(config.OIDC_JWKS_URL ?? ""));
    return async (token) =>
      (await jwtVerify(token, keySet, { issuer: config.OIDC_ISSUER, audience: config.OIDC_AUDIENCE })).payload;
  }
  const secret = new TextEncoder().encode(config.DEV_JWT_SECRET ?? "");
  return async (token) =>
    (await jwtVerify(token, secret, { algorithms: ["HS256"], issuer: "reviewsignal-dev", audience: "reviewsignal" })).payload;
}

const ROLES = new Set<Role>(["publisher", "x3m_admin", "service"]);

export async function authenticate(
  header: string | undefined,
  verify: TokenVerifier,
  claims: { tenant: string; roles: string },
): Promise<Principal> {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  if (!match) throw new PublicError("A bearer token is required.", 401);
  let payload: JWTPayload;
  try {
    payload = await verify(match[1]);
  } catch {
    throw new PublicError("The access token is invalid or expired.", 401);
  }
  const rawRoles = payload[claims.roles];
  const roles = new Set<Role>(
    (Array.isArray(rawRoles) ? rawRoles : typeof rawRoles === "string" ? rawRoles.split(/[\s,]+/) : [])
      .filter((role): role is Role => ROLES.has(role as Role)),
  );
  const publisherId = typeof payload[claims.tenant] === "string" ? (payload[claims.tenant] as string) : null;
  if (publisherId && !roles.size) roles.add("publisher");
  if (!roles.size) throw new PublicError("The access token grants no ReviewSignal role.", 403);
  return {
    subject: payload.sub ?? "unknown",
    roles,
    publisherId,
    publisherName: typeof payload.publisher_name === "string" ? payload.publisher_name : null,
  };
}

/**
 * Which Loomit publisher a request acts for. Publishers act for themselves;
 * the Loomit backend (service) and X3M admins name the publisher explicitly.
 */
export function actingPublisher(principal: Principal, headerValue: string | undefined): string {
  if (principal.roles.has("service") || principal.roles.has("x3m_admin")) {
    const value = headerValue?.trim();
    if (value) return value;
    if (principal.publisherId) return principal.publisherId;
    throw new PublicError("Set the X-Loomit-Publisher-Id header.", 400);
  }
  if (!principal.publisherId) throw new PublicError("The token has no publisher.", 403);
  return principal.publisherId;
}
