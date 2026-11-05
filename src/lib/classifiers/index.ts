import { createJevClassifier } from "@/lib/classifiers/jev";
import { createMockClassifier } from "@/lib/classifiers/mock";
import { createOpenRouterClassifier } from "@/lib/classifiers/openrouter";
import type { ClassifierProvider } from "@/lib/classifiers/provider";
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
    if (explicit in FACTORIES) return explicit as ClassifierId;
    throw new PublicError(
      `Unknown CLASSIFIER_PROVIDER "${explicit}". Use openrouter, jev or mock.`,
    );
  }

  const legacy = process.env.ANALYSIS_MODE?.trim().toLowerCase();
  if (legacy === "jev" || legacy === "mock") return legacy;

  return process.env.NODE_ENV === "production" ? "openrouter" : "mock";
}

export function getClassifier(): ClassifierProvider {
  return FACTORIES[resolveClassifierId()]();
}
