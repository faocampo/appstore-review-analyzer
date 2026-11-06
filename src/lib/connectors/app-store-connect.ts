import { z } from "zod";

import { getAppStoreConnectToken } from "@/lib/credentials/apple";
import { envInteger } from "@/lib/env";
import { upstreamError } from "@/lib/errors";
import { fetchWithRetry } from "@/lib/connectors/http";
import type { ConnectorResult } from "@/lib/connectors/types";
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

/**
 * Fetches customer reviews newest-first. Pagination stops early once a page
 * reaches reviews older than `startDate`, so page budget is not spent on
 * reviews outside the requested period.
 */
export async function fetchAppleReviews(options: {
  appId: string;
  startDate?: string;
  /** Incremental sync watermark; takes precedence over startDate. */
  since?: Date;
  /** Per-tenant token; defaults to the environment credentials. */
  accessToken?: string;
  maxPages?: number;
}): Promise<ConnectorResult> {
  const accessToken = options.accessToken ?? (await getAppStoreConnectToken());
  const maxPages =
    options.maxPages ?? envInteger("APPLE_MAX_PAGES", 10, { min: 1, max: 50 });
  const since = options.since
    ? options.since.getTime()
    : options.startDate
      ? new Date(`${options.startDate}T00:00:00.000Z`).getTime()
      : undefined;

  const reviews: Review[] = [];
  let nextUrl: string | undefined =
    `https://api.appstoreconnect.apple.com/v1/apps/${encodeURIComponent(options.appId)}/customerReviews?sort=-createdDate&limit=200`;
  let pagesFetched = 0;
  let reachedStart = false;

  while (pagesFetched < maxPages && nextUrl && !reachedStart) {
    const response = await fetchWithRetry(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) throw await upstreamError("App Store Connect", response);

    const payload = appleResponseSchema.parse(await response.json());
    pagesFetched += 1;
    for (const item of payload.data) {
      const createdAt = new Date(item.attributes.createdDate);
      // Strictly older than the start date, or at/before the watermark.
      if (
        since !== undefined &&
        (options.since ? createdAt.getTime() <= since : createdAt.getTime() < since)
      ) {
        reachedStart = true;
        continue;
      }
      if (!item.attributes.body.trim()) continue;
      reviews.push({
        id: item.id,
        store: "apple_app_store",
        platform: "ios",
        rating: item.attributes.rating,
        title: item.attributes.title,
        body: item.attributes.body,
        territory: item.attributes.territory,
        createdAt: createdAt.toISOString(),
        dateSemantics: "created_at",
        source: "api",
      });
    }

    // Only follow pagination links on Apple's API host (the bearer token goes with them).
    const next = payload.links.next ? new URL(payload.links.next) : null;
    nextUrl = next && next.protocol === "https:" && next.hostname === "api.appstoreconnect.apple.com" ? next.toString() : undefined;
  }

  const truncated = Boolean(nextUrl) && !reachedStart;

  return {
    reviews,
    coverage: {
      source: "app_store_connect_api",
      label: "App Store Connect API",
      status: truncated ? "partial" : "complete",
      reviewsFetched: reviews.length,
      pagesFetched,
      truncated,
      dateSemantics: "created_at",
      note: truncated
        ? `Stopped at the ${maxPages}-page limit before reaching the start of the period; older reviews in the period are missing.`
        : undefined,
    },
  };
}
