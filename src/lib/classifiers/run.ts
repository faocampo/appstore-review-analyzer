import type { ClassifierProvider } from "@/lib/classifiers/provider";
import { PublicError } from "@/lib/errors";
import type { AnalyzedReview, Review } from "@/lib/types";

export interface ClassificationRun {
  analyzed: AnalyzedReview[];
  failed: number;
}

/**
 * Classifies reviews in provider-sized batches with bounded concurrency.
 * Per-review failures are counted, not thrown; the run only fails when no
 * review could be classified at all.
 */
export async function classifyAll(
  provider: ClassifierProvider,
  reviews: Review[],
): Promise<ClassificationRun> {
  const batches: Review[][] = [];
  for (let index = 0; index < reviews.length; index += provider.maxBatch) {
    batches.push(reviews.slice(index, index + provider.maxBatch));
  }

  const analyzed: AnalyzedReview[] = [];
  const errors: string[] = [];

  for (let index = 0; index < batches.length; index += provider.concurrency) {
    const wave = batches.slice(index, index + provider.concurrency);
    const results = await Promise.all(wave.map((batch) => provider.classify(batch)));

    wave.forEach((batch, batchIndex) => {
      batch.forEach((review, reviewIndex) => {
        const outcome = results[batchIndex][reviewIndex];
        if (outcome?.ok) {
          analyzed.push({ ...review, analysis: outcome.classification });
        } else {
          errors.push(outcome?.error ?? "no result returned");
        }
      });
    });
  }

  if (reviews.length && !analyzed.length) {
    console.error(`[reviewsignal] every classification failed: ${errors[0]}`);
    throw new PublicError(
      `Classification failed for every review (${provider.info.provider}). Check the classifier configuration and server logs.`,
      502,
    );
  }

  if (errors.length) {
    console.error(
      `[reviewsignal] ${errors.length} reviews could not be classified; first error: ${errors[0]}`,
    );
  }

  return { analyzed, failed: errors.length };
}
