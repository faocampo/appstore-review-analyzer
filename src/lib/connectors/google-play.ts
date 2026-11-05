import { z } from "zod";

import { getGooglePlayAccessToken } from "@/lib/credentials/google";
import { envInteger } from "@/lib/env";
import { upstreamError } from "@/lib/errors";
import type { ConnectorResult } from "@/lib/connectors/types";
import type { Review } from "@/lib/types";

/** Google documents the Reviews API as covering roughly the last week. */
export const GOOGLE_REVIEW_API_WINDOW_DAYS = 7;

const timestampSchema = z.object({
  seconds: z.union([z.string(), z.number()]),
});

const userCommentSchema = z.object({
  text: z.string().default(""),
  starRating: z.number().min(1).max(5),
  reviewerLanguage: z.string().optional(),
  appVersionName: z.string().optional(),
  lastModified: timestampSchema,
});

const googleReviewSchema = z.object({
  reviewId: z.string(),
  comments: z.array(
    z.object({
      userComment: userCommentSchema.optional(),
    }),
  ),
});

const googleResponseSchema = z.object({
  reviews: z.array(googleReviewSchema).optional(),
  tokenPagination: z
    .object({
      nextPageToken: z.string().optional(),
    })
    .optional(),
});

function googleTimestamp(value: z.infer<typeof timestampSchema>): string {
  return new Date(Number(value.seconds) * 1000).toISOString();
}

/**
 * Fetches commented reviews from the Google Play Reviews API.
 *
 * Reviews are always fetched in their original language: classification
 * must not depend on machine translation, which only one store offers.
 * The API exposes a last-modified timestamp, so period membership uses it.
 */
export async function fetchGooglePlayReviews(options: {
  packageName: string;
  startDate?: string;
  now?: number;
}): Promise<ConnectorResult> {
  const accessToken = await getGooglePlayAccessToken();
  const maxPages = envInteger("GOOGLE_PLAY_MAX_PAGES", 10, { min: 1, max: 50 });

  const reviews: Review[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}/reviews`,
    );
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("token", pageToken);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) throw await upstreamError("Google Play", response);

    const payload = googleResponseSchema.parse(await response.json());
    pagesFetched += 1;
    for (const item of payload.reviews ?? []) {
      const comment = item.comments
        .map((entry) => entry.userComment)
        .find((entry) => Boolean(entry?.text));
      if (!comment) continue;

      const lastModified = googleTimestamp(comment.lastModified);
      reviews.push({
        id: item.reviewId,
        store: "google_play",
        platform: "android",
        rating: comment.starRating,
        title: "",
        body: comment.text,
        language: comment.reviewerLanguage,
        appVersion: comment.appVersionName,
        createdAt: lastModified,
        updatedAt: lastModified,
        dateSemantics: "last_modified_fallback",
        source: "api",
      });
    }

    pageToken = payload.tokenPagination?.nextPageToken;
    if (!pageToken) break;
  }

  const truncated = Boolean(pageToken);
  const windowStart =
    (options.now ?? Date.now()) - GOOGLE_REVIEW_API_WINDOW_DAYS * 86_400_000;
  const beforeWindow = options.startDate
    ? new Date(`${options.startDate}T00:00:00.000Z`).getTime() < windowStart
    : false;

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Stopped at the ${maxPages}-page limit with more reviews available.`,
    );
  }
  if (beforeWindow) {
    notes.push(
      `The Reviews API only covers about the last ${GOOGLE_REVIEW_API_WINDOW_DAYS} days; earlier days in this period are not covered. Import a Play Console reviews report for history.`,
    );
  }

  return {
    reviews,
    coverage: {
      source: "google_play_api",
      label: "Google Play API",
      status: truncated || beforeWindow ? "partial" : "complete",
      reviewsFetched: reviews.length,
      pagesFetched,
      truncated,
      dateSemantics: "last_modified_fallback",
      note: notes.join(" ") || undefined,
    },
  };
}
