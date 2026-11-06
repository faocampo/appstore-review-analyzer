import { delay } from "@/lib/classifiers/provider";
import { envInteger } from "@/lib/env";

/**
 * fetch with bounded retries for store APIs: retries 429 and 5xx, honoring
 * `Retry-After` (seconds or HTTP date, capped at 60 s) and otherwise backing
 * off exponentially. The final response is returned as-is so callers report
 * the real status.
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  options: { retries?: number; baseDelayMs?: number; now?: () => number } = {},
): Promise<Response> {
  const retries = options.retries ?? envInteger("STORE_MAX_RETRIES", 2, { min: 0, max: 5 });
  const baseDelay =
    options.baseDelayMs ?? envInteger("STORE_RETRY_BASE_MS", 1000, { min: 0, max: 30_000 });
  const now = options.now ?? Date.now;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(input, init);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retries) return response;

    await response.body?.cancel();
    await delay(retryAfterMs(response.headers.get("retry-after"), now) ?? baseDelay * 2 ** attempt);
  }
}

export function retryAfterMs(header: string | null, now: () => number = Date.now): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 60_000) : null;
}
