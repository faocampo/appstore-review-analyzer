import type {
  ClassificationOutcome,
  ClassifierProvider,
} from "@/lib/classifiers/provider";

export interface CircuitBreakerOptions {
  /** Consecutive fully failed batches before the primary is skipped. */
  failureThreshold: number;
  /** How long the primary is skipped once the circuit opens. */
  cooldownMs: number;
  now?: () => number;
}

/**
 * Wraps a primary classifier with a fallback and a simple circuit breaker.
 *
 * - Reviews the primary fails on are retried on the fallback.
 * - After `failureThreshold` consecutive batches where the primary returned
 *   no successful result, the primary is skipped for `cooldownMs`, then tried
 *   again (half-open).
 *
 * Results keep the provider that actually produced them, so metrics are
 * never silently mixed: aggregates and guardrails group by model version.
 */
export function withFallback(
  primary: ClassifierProvider,
  fallback: ClassifierProvider,
  options: CircuitBreakerOptions,
): ClassifierProvider & { readonly circuitOpenUntil: number } {
  const now = options.now ?? Date.now;
  let consecutiveFailures = 0;
  let openUntil = 0;

  async function classifyWith(
    provider: ClassifierProvider,
    reviews: Parameters<ClassifierProvider["classify"]>[0],
  ): Promise<ClassificationOutcome[]> {
    try {
      return await provider.classify(reviews);
    } catch (error) {
      const message = error instanceof Error ? error.message : "classification failed";
      return reviews.map(() => ({ ok: false as const, error: message }));
    }
  }

  return {
    info: primary.info,
    maxBatch: Math.min(primary.maxBatch, fallback.maxBatch),
    concurrency: primary.concurrency,
    get circuitOpenUntil() {
      return openUntil;
    },
    async classify(reviews) {
      if (now() < openUntil) return classifyWith(fallback, reviews);

      const outcomes = await classifyWith(primary, reviews);
      const failedIndexes = outcomes
        .map((outcome, index) => (outcome.ok ? -1 : index))
        .filter((index) => index >= 0);

      if (failedIndexes.length === reviews.length && reviews.length) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= options.failureThreshold) {
          openUntil = now() + options.cooldownMs;
          consecutiveFailures = 0;
          console.error(
            `[reviewsignal] ${primary.info.provider} circuit opened for ${options.cooldownMs} ms; using ${fallback.info.provider}`,
          );
        }
      } else {
        consecutiveFailures = 0;
      }

      if (!failedIndexes.length) return outcomes;

      const retried = await classifyWith(
        fallback,
        failedIndexes.map((index) => reviews[index]),
      );
      failedIndexes.forEach((index, position) => {
        if (retried[position]?.ok) outcomes[index] = retried[position];
      });
      return outcomes;
    },
  };
}
