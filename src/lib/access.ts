import { timingSafeEqual } from "node:crypto";

import { envInteger } from "@/lib/env";

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 503; error: string };

/**
 * Constant-time comparison for equal-length inputs. Only the token length can
 * leak through timing, which is acceptable for a long random shared token.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Interim access control for `/api/analyze` until Loomit OIDC is wired in.
 *
 * - With `ANALYZE_API_TOKEN` set, requests must send
 *   `Authorization: Bearer <token>`.
 * - Without it, the endpoint is open only outside production, so a deployed
 *   instance never exposes server-held store and classifier credentials.
 */
export function authorizeRequest(request: Request): AccessDecision {
  const expected = process.env.ANALYZE_API_TOKEN?.trim();

  if (!expected) {
    return process.env.NODE_ENV === "production"
      ? {
          allowed: false,
          status: 503,
          error:
            "Access control is not configured. Set ANALYZE_API_TOKEN on the server.",
        }
      : { allowed: true };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match && tokensMatch(match[1].trim(), expected)) {
    return { allowed: true };
  }

  return { allowed: false, status: 401, error: "A valid access token is required." };
}

const windows = new Map<string, { start: number; count: number }>();
const WINDOW_MS = 60_000;

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Fixed-window, in-memory rate limit per client. Per-pod only: the shared,
 * per-tenant limit belongs in the gateway or Redis once multi-replica.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const limit = envInteger("ANALYZE_RATE_LIMIT_PER_MINUTE", 20, {
    min: 1,
    max: 10_000,
  });
  const current = windows.get(key);

  if (!current || now - current.start >= WINDOW_MS) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [entryKey, entry] of windows) {
        if (now - entry.start >= WINDOW_MS) windows.delete(entryKey);
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  current.count += 1;
  return {
    allowed: current.count <= limit,
    retryAfterSeconds: Math.ceil((current.start + WINDOW_MS - now) / 1000),
  };
}

export function resetRateLimits(): void {
  windows.clear();
}
