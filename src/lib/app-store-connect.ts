import { z } from "zod";

import type { Review } from "@/lib/types";

const appleReviewSchema = z.object({
  id: z.string(),
  attributes: z.object({
    rating: z.number().min(1).max(5),
    title: z.string().default(""),
    body: z.string().default(""),
    reviewerNickname: z.string().optional(),
    createdDate: z.string(),
    territory: z.string().optional(),
  }),
});

const appleResponseSchema = z.object({
  data: z.array(appleReviewSchema),
  links: z.object({
    next: z.string().nullable().optional(),
  }),
});

function maxPages(): number {
  const parsed = Number.parseInt(process.env.APPLE_MAX_PAGES ?? "10", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 10;
}

export async function fetchAppleReviews(appId: string): Promise<Review[]> {
  const accessToken = process.env.APPLE_APP_STORE_CONNECT_TOKEN;
  if (!accessToken || accessToken.endsWith("_placeholder")) {
    throw new Error(
      "App Store Connect is selected but APPLE_APP_STORE_CONNECT_TOKEN is not configured.",
    );
  }

  const reviews: Review[] = [];
  let nextUrl: string | undefined =
    `https://api.appstoreconnect.apple.com/v1/apps/${encodeURIComponent(appId)}/customerReviews?sort=-createdDate&limit=200`;

  for (let page = 0; page < maxPages() && nextUrl; page += 1) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `App Store Connect returned ${response.status}: ${detail.slice(0, 300)}`,
      );
    }

    const payload = appleResponseSchema.parse(await response.json());
    for (const item of payload.data) {
      if (!item.attributes.body.trim()) continue;
      reviews.push({
        id: item.id,
        store: "apple_app_store",
        platform: "ios",
        rating: item.attributes.rating,
        title: item.attributes.title,
        body: item.attributes.body,
        territory: item.attributes.territory,
        createdAt: new Date(item.attributes.createdDate).toISOString(),
        dateSemantics: "created_at",
        source: "api",
      });
    }

    nextUrl = payload.links.next ?? undefined;
  }

  return reviews;
}
