import { z } from "zod";

import type { Review } from "@/lib/types";

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

function maxPages(): number {
  const parsed = Number.parseInt(process.env.GOOGLE_PLAY_MAX_PAGES ?? "10", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 10;
}

function googleTimestamp(value: z.infer<typeof timestampSchema>): string {
  return new Date(Number(value.seconds) * 1000).toISOString();
}

export async function fetchGooglePlayReviews(options: {
  packageName: string;
  translationLanguage?: string;
}): Promise<Review[]> {
  const accessToken = process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  if (!accessToken || accessToken.endsWith("_placeholder")) {
    throw new Error(
      "Google Play is selected but GOOGLE_PLAY_ACCESS_TOKEN is not configured.",
    );
  }

  const reviews: Review[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages(); page += 1) {
    const url = new URL(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}/reviews`,
    );
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("token", pageToken);
    if (options.translationLanguage) {
      url.searchParams.set(
        "translationLanguage",
        options.translationLanguage,
      );
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Google Play returned ${response.status}: ${detail.slice(0, 300)}`,
      );
    }

    const payload = googleResponseSchema.parse(await response.json());
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

  return reviews;
}
