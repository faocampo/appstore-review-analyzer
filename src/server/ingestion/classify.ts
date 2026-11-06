import type { ClassifierProvider } from "@/lib/classifiers/provider";
import { SYSTEM, withScope, type Pool } from "@/server/db/pool";
import { metrics } from "@/server/metrics";
import { addSpend, rebuildRollups, remainingBudget } from "@/server/repo/rollups";
import {
  insertClassifications,
  modelVersionOf,
  pendingReviews,
  type PendingReview,
} from "@/server/repo/reviews";
import type { Classification } from "@/lib/types";

export interface ClassifyDeps {
  pool: Pool;
  classifier: () => ClassifierProvider;
}

export interface ClassifyResult {
  appId: string;
  modelVersion: string;
  classified: number;
  failed: number;
  costUsd: number;
  budgetExhausted: boolean;
  days: string[];
}

/**
 * Classifies an app's reviews that have no classification for the current
 * model version, in chunks, stopping when the tenant's daily budget is
 * spent. Classifications are cached by (review, text hash, model version),
 * so reading the panel never triggers classification.
 */
export async function classifyApp(
  deps: ClassifyDeps,
  input: { appId: string; tenantId: string; maxReviews?: number; chunkSize?: number },
): Promise<ClassifyResult> {
  const provider = deps.classifier();
  const modelVersion = modelVersionOf(provider.info);
  const chunkSize = input.chunkSize ?? 100;
  const maxReviews = input.maxReviews ?? 2_000;
  const days = new Set<string>();
  let classified = 0;
  let failed = 0;
  let costUsd = 0;
  let budgetExhausted = false;
  const attempted = new Set<string>();

  while (classified + failed < maxReviews) {
    const remaining = await withScope(deps.pool, SYSTEM, (client) => remainingBudget(client, input.tenantId));
    if (remaining <= 0) {
      budgetExhausted = true;
      metrics.budgetExhausted.inc();
      break;
    }

    const pending = (
      await withScope(deps.pool, SYSTEM, (client) =>
        pendingReviews(client, input.appId, modelVersion, chunkSize + attempted.size),
      )
    ).filter((review) => !attempted.has(review.reviewUuid)).slice(0, chunkSize);
    if (!pending.length) break;
    pending.forEach((review) => attempted.add(review.reviewUuid));

    const successes: Array<{ review: PendingReview; classification: Classification }> = [];
    for (let index = 0; index < pending.length; index += provider.maxBatch) {
      const batch = pending.slice(index, index + provider.maxBatch);
      const stop = metrics.classifierLatency.startTimer({ provider: provider.info.provider });
      let outcomes;
      try {
        outcomes = await provider.classify(batch);
      } catch (error) {
        stop();
        // Configuration errors (missing key) abort the run for every review.
        throw error;
      }
      stop();
      batch.forEach((review, position) => {
        const outcome = outcomes[position];
        if (outcome?.ok) {
          successes.push({ review, classification: outcome.classification });
        } else {
          failed += 1;
        }
      });
    }

    const chunkCost = successes.reduce((sum, item) => sum + (item.classification.costUsd ?? 0), 0);
    costUsd += chunkCost;
    classified += successes.length;
    metrics.classifierRequests.inc({ provider: provider.info.provider, outcome: "ok" }, successes.length);
    metrics.classifierRequests.inc(
      { provider: provider.info.provider, outcome: "failed" },
      pending.length - successes.length,
    );
    if (chunkCost) metrics.classifierCost.inc({ provider: provider.info.provider }, chunkCost);

    await withScope(deps.pool, SYSTEM, async (client) => {
      const touched = await insertClassifications(client, modelVersion, successes);
      touched.forEach((day) => days.add(day));
      await addSpend(client, { tenantId: input.tenantId, costUsd: chunkCost, reviews: successes.length });
    });
  }

  if (days.size) {
    await withScope(deps.pool, SYSTEM, (client) =>
      rebuildRollups(client, { appId: input.appId, modelVersion, days: [...days] }),
    );
  }

  return {
    appId: input.appId,
    modelVersion,
    classified,
    failed,
    costUsd,
    budgetExhausted,
    days: [...days].sort(),
  };
}
