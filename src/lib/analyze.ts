import { aggregateReviews } from "@/lib/aggregate";
import { getClassifier } from "@/lib/classifiers";
import { classifyAll } from "@/lib/classifiers/run";
import { fetchAppleReviews } from "@/lib/connectors/app-store-connect";
import { parseReviewCsv } from "@/lib/connectors/csv";
import { fetchGooglePlayReviews } from "@/lib/connectors/google-play";
import type { ConnectorResult } from "@/lib/connectors/types";
import { getDemoReviews } from "@/lib/demo";
import { PublicError, publicMessage } from "@/lib/errors";
import type {
  AnalysisResult,
  AnalyzeInput,
  Review,
  SourceCoverage,
} from "@/lib/types";

interface ReviewLoadResult {
  reviews: Review[];
  coverage: SourceCoverage[];
  notices: string[];
}

async function loadLiveReviews(input: AnalyzeInput): Promise<ReviewLoadResult> {
  const requests: Array<{
    name: string;
    source: SourceCoverage["source"];
    dateSemantics: SourceCoverage["dateSemantics"];
    run: () => Promise<ConnectorResult>;
  }> = [];

  if (input.androidPackage) {
    const packageName = input.androidPackage;
    requests.push({
      name: "Google Play",
      source: "google_play_api",
      dateSemantics: "last_modified_fallback",
      run: () =>
        fetchGooglePlayReviews({ packageName, startDate: input.startDate }),
    });
  }

  if (input.appleAppId) {
    const appId = input.appleAppId;
    requests.push({
      name: "App Store Connect",
      source: "app_store_connect_api",
      dateSemantics: "created_at",
      run: () => fetchAppleReviews({ appId, startDate: input.startDate }),
    });
  }

  const outcomes = await Promise.allSettled(requests.map((request) => request.run()));
  const reviews: Review[] = [];
  const coverage: SourceCoverage[] = [];
  const notices: string[] = [];
  const errors: string[] = [];

  outcomes.forEach((outcome, index) => {
    const request = requests[index];
    if (outcome.status === "fulfilled") {
      reviews.push(...outcome.value.reviews);
      coverage.push(outcome.value.coverage);
      return;
    }

    if (!(outcome.reason instanceof PublicError)) {
      console.error(`[reviewsignal] ${request.name} failed`, outcome.reason);
    }
    const message = publicMessage(outcome.reason, "request failed");
    errors.push(`${request.name}: ${message}`);
    coverage.push({
      source: request.source,
      label: `${request.name} API`,
      status: "failed",
      reviewsFetched: 0,
      truncated: false,
      dateSemantics: request.dateSemantics,
      note: message,
    });
  });

  if (!reviews.length && errors.length) {
    throw new PublicError(errors.join(" "), 502);
  }

  notices.push(
    ...errors.map(
      (error) => `${error} The other selected sources were still analyzed.`,
    ),
  );
  return { reviews, coverage, notices };
}

function loadCsvReviews(input: AnalyzeInput): ReviewLoadResult {
  const reviews: Review[] = [];
  const coverage: SourceCoverage[] = [];
  const notices: string[] = [];

  for (const file of input.csvFiles ?? []) {
    const result = parseReviewCsv({
      content: file.content,
      encoding: file.encoding,
      platform: file.platform,
      fileName: file.name,
    });
    reviews.push(...result.reviews);
    coverage.push({
      source: "csv",
      label: `${file.name} (${file.platform === "android" ? "Google Play" : "App Store"} export)`,
      status: "complete",
      reviewsFetched: result.reviews.length,
      truncated: false,
      dateSemantics: "created_at",
      note: result.skippedRows
        ? `Skipped ${result.skippedRows} rows without valid review text, date or rating.`
        : undefined,
    });
    if (result.skippedRows) {
      notices.push(
        `${file.name}: skipped ${result.skippedRows} rows without valid written-review text, date, or rating.`,
      );
    }
  }

  return { reviews, coverage, notices };
}

function loadDemoReviews(): ReviewLoadResult {
  const reviews = getDemoReviews();
  return {
    reviews,
    coverage: [
      {
        source: "demo",
        label: "Synthetic demo dataset",
        status: "complete",
        reviewsFetched: reviews.length,
        truncated: false,
        dateSemantics: "created_at",
      },
    ],
    notices: [
      "Demo mode uses synthetic reviews; no store credentials are used.",
    ],
  };
}

/** Keeps one review per store and id, preferring the most recently updated. */
export function dedupeReviews(reviews: Review[]): {
  reviews: Review[];
  duplicates: number;
} {
  const byKey = new Map<string, Review>();
  for (const review of reviews) {
    const key = `${review.store}:${review.id}`;
    const existing = byKey.get(key);
    const timestamp = (item: Review) =>
      new Date(item.updatedAt ?? item.createdAt).getTime();
    if (!existing || timestamp(review) > timestamp(existing)) {
      byKey.set(key, review);
    }
  }
  return { reviews: [...byKey.values()], duplicates: reviews.length - byKey.size };
}

export async function analyzeReviews(
  input: AnalyzeInput,
): Promise<AnalysisResult> {
  const loaded =
    input.sourceMode === "demo"
      ? loadDemoReviews()
      : input.sourceMode === "csv"
        ? loadCsvReviews(input)
        : await loadLiveReviews(input);

  const { reviews: uniqueReviews, duplicates } = dedupeReviews(loaded.reviews);
  if (duplicates) {
    loaded.notices.push(
      `Removed ${duplicates} duplicate reviews (same store and review id).`,
    );
  }
  if (input.translationLanguage) {
    loaded.notices.push(
      "Reviews are classified in their original language; translation is not applied.",
    );
  }

  const start = new Date(`${input.startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${input.endDate}T23:59:59.999Z`).getTime();
  const periodReviews = uniqueReviews.filter((review) => {
    const time = new Date(review.createdAt).getTime();
    return time >= start && time <= end;
  });

  if (!periodReviews.length) {
    throw new PublicError(
      "No written reviews were found in the selected period.",
      422,
    );
  }

  const classifier = getClassifier();
  const run = await classifyAll(classifier, periodReviews);
  if (run.failed) {
    loaded.notices.push(
      `${run.failed} of ${periodReviews.length} reviews could not be classified and are excluded from the metrics.`,
    );
  }

  return aggregateReviews({
    appName: input.appName,
    sourceMode: input.sourceMode,
    classifier: classifier.info,
    startDate: input.startDate,
    endDate: input.endDate,
    lastN: input.lastN,
    reviews: run.analyzed,
    unclassified: run.failed,
    coverage: loaded.coverage,
    notices: [
      ...loaded.notices,
      ...loaded.coverage
        .filter((item) => item.status === "partial" && item.note)
        .map((item) => `${item.label}: ${item.note}`),
    ],
  });
}
