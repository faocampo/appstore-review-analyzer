import { createJevClassifier } from "@/lib/classifiers/jev";
import { createMockClassifier } from "@/lib/classifiers/mock";
import { createOpenRouterClassifier } from "@/lib/classifiers/openrouter";
import { withFallback } from "@/lib/classifiers/fallback";
import type { ClassifierProvider } from "@/lib/classifiers/provider";
import { envInteger } from "@/lib/env";
import { PublicError } from "@/lib/errors";
import type { ClassifierId } from "@/lib/types";

const FACTORIES: Record<ClassifierId, () => ClassifierProvider> = {
  mock: createMockClassifier,
  jev: createJevClassifier,
  openrouter: createOpenRouterClassifier,
};

/**
 * Resolves the classifier from the environment:
 * 1. `CLASSIFIER_PROVIDER` (`openrouter` | `jev` | `mock`);
 * 2. legacy `ANALYSIS_MODE=jev|mock`;
 * 3. `openrouter` in production, `mock` elsewhere.
 */
export function resolveClassifierId(): ClassifierId {
  const explicit = process.env.CLASSIFIER_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    return parseId("CLASSIFIER_PROVIDER", explicit);
  }

  const legacy = process.env.ANALYSIS_MODE?.trim().toLowerCase();
  if (legacy === "jev" || legacy === "mock") return legacy;

  return process.env.NODE_ENV === "production" ? "openrouter" : "mock";
}

function parseId(name: string, value: string): ClassifierId {
  const normalized = value.trim().toLowerCase();
  if (normalized in FACTORIES) return normalized as ClassifierId;
  throw new PublicError(`Unknown ${name} "${normalized}". Use openrouter, jev or mock.`);
}

/**
 * Returns the configured classifier, wrapped with
 * `CLASSIFIER_FALLBACK_PROVIDER` and a circuit breaker when one is set.
 */
export function getClassifier(): ClassifierProvider {
  const primaryId = resolveClassifierId();
  const primary = FACTORIES[primaryId]();
  const fallbackRaw = process.env.CLASSIFIER_FALLBACK_PROVIDER?.trim();
  if (!fallbackRaw) return primary;

  const fallbackId = parseId("CLASSIFIER_FALLBACK_PROVIDER", fallbackRaw);
  if (fallbackId === primaryId) return primary;
  return withFallback(primary, FACTORIES[fallbackId](), {
    failureThreshold: envInteger("CLASSIFIER_CIRCUIT_FAILURES", 3, { min: 1, max: 100 }),
    cooldownMs: envInteger("CLASSIFIER_CIRCUIT_COOLDOWN_MS", 300_000, {
      min: 1_000,
      max: 3_600_000,
    }),
  });
}
