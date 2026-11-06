/**
 * An error whose message is safe to return to API clients.
 *
 * Anything else thrown on the server is treated as internal: it is logged
 * and replaced with a generic message, so upstream response bodies, stack
 * traces and configuration details never reach the browser.
 */
export class PublicError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

export function publicMessage(error: unknown, fallback: string): string {
  return error instanceof PublicError ? error.message : fallback;
}

/** Logs an upstream failure server-side without exposing its body. */
export async function upstreamError(
  service: string,
  response: Response,
): Promise<PublicError> {
  const detail = await response.text().catch(() => "");
  console.error(
    `[reviewsignal] ${service} returned ${response.status}: ${detail.slice(0, 1000)}`,
  );
  return new PublicError(`${service} returned HTTP ${response.status}.`, 502);
}
