import { aggregateReviews } from "@/lib/aggregate";
import { fetchAppleReviews } from "@/lib/app-store-connect";
import { parseReviewCsv } from "@/lib/csv";
import { getDemoReviews } from "@/lib/demo";
import { fetchGooglePlayReviews } from "@/lib/google-play";
import { classifyWithJev } from "@/lib/jev";
import { classifyMock } from "@/lib/mock-classifier";
import type {
  AnalysisMode,
  AnalysisResult,
  AnalyzeInput,
  AnalyzedReview,
  Review,
} from "@/lib/types";

interface ReviewLoadResult {
  reviews: Review[];
  notices: string[];
}

function getAnalysisMode(): AnalysisMode {
  return process.env.ANALYSIS_MODE === "jev" ? "jev" : "mock";
}

async function loadLiveReviews(input: AnalyzeInput): Promise<ReviewLoadResult> {
  const requests: Array<{
    name: string;
    promise: Promise<Review[]>;
    notice: string;
  }> = [];

  if (input.androidPackage) {
    requests.push({
      name: "Google Play",
      promise: fetchGooglePlayReviews({
        packageName: input.androidPackage,
        translationLanguage: input.translationLanguage,
      }),
      notice:
        "Google Play Review API covers commented reviews created or modified recently; API dates use the last-modified timestamp when creation time is unavailable.",
    });
  }

  if (input.appleAppId) {
    requests.push({
      name: "App Store Connect",
      promise: fetchAppleReviews(input.appleAppId),
      notice:
        "App Store Connect reviews are fetched newest-first and pagination stops at the configured page limit.",
    });
  }

  const outcomes = await Promise.allSettled(
    requests.map((request) => request.promise),
  );
  const reviews: Review[] = [];
  const notices: string[] = [];
  const errors: string[] = [];

  outcomes.forEach((outcome, index) => {
    const request = requests[index];
    if (outcome.status === "fulfilled") {
      reviews.push(...outcome.value);
      notices.push(request.notice);
    } else {
      errors.push(`${request.name}: ${outcome.reason instanceof Error ? outcome.reason.message : "request failed"}`);
    }
  });

  if (!reviews.length && errors.length) {
    throw new Error(errors.join(" "));
  }

  notices.push(...errors.map((error) => `${error} The other selected sources were still analyzed.`));
  return { reviews, notices };
}

function loadCsvReviews(input: AnalyzeInput): ReviewLoadResult {
  const reviews: Review[] = [];
  const notices: string[] = [];

  for (const file of input.csvFiles ?? []) {
    const result = parseReviewCsv({
      content: file.content,
      platform: file.platform,
      fileName: file.name,
    });
    reviews.push(...result.reviews);
    if (result.skippedRows) {
      notices.push(
        `${file.name}: skipped ${result.skippedRows} rows without valid written-review text, date, or rating.`,
      );
    }
  }

  return { reviews, notices };
}

async function classifyReviews(
  reviews: Review[],
  mode: AnalysisMode,
): Promise<AnalyzedReview[]> {
  const analyzed: AnalyzedReview[] = [];
  const concurrency = 6;

  for (let index = 0; index < reviews.length; index += concurrency) {
    const batch = reviews.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (review) => ({
        ...review,
        analysis:
          mode === "jev"
            ? await classifyWithJev(review)
            : classifyMock(review),
      })),
    );
    analyzed.push(...results);
  }

  return analyzed;
}

export async function analyzeReviews(
  input: AnalyzeInput,
): Promise<AnalysisResult> {
  const loaded =
    input.sourceMode === "demo"
      ? {
          reviews: getDemoReviews(),
          notices: [
            "Demo mode uses synthetic reviews and deterministic local classification; no store or TypeSafe credentials are used.",
          ],
        }
      : input.sourceMode === "csv"
        ? loadCsvReviews(input)
        : await loadLiveReviews(input);

  const start = new Date(`${input.startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${input.endDate}T23:59:59.999Z`).getTime();
  const periodReviews = loaded.reviews.filter((review) => {
    const time = new Date(review.createdAt).getTime();
    return time >= start && time <= end;
  });

  if (!periodReviews.length) {
    throw new Error("No written reviews were found in the selected period.");
  }

  const analysisMode = getAnalysisMode();
  const analyzedReviews = await classifyReviews(periodReviews, analysisMode);
  const model = analyzedReviews[0]?.analysis.model ?? "not-run";

  return aggregateReviews({
    appName: input.appName,
    sourceMode: input.sourceMode,
    analysisMode,
    model,
    startDate: input.startDate,
    endDate: input.endDate,
    lastN: input.lastN,
    reviews: analyzedReviews,
    notices: loaded.notices,
  });
}
