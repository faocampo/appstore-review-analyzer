"use client";

import { type ReactElement, useId, useState } from "react";

import { SENTIMENT_COPY, sentimentTone } from "@/app/format";
import { ErrorNotice, Pill } from "@/app/_components/ui";
import { errorMessage, type PanelClient, type RangeParams, type ReviewsParams } from "@/app/_lib/api-client";
import { STORE_COPY } from "@/app/_lib/copy";
import { formatShortDate } from "@/app/_lib/dates";
import { formatShare } from "@/app/_lib/numbers";
import { useResource } from "@/app/_lib/use-resource";
import { AD_SUBREASON_DEFINITIONS, REASON_DEFINITIONS, type ReasonKey } from "@/lib/types";
import type { ReviewDto } from "@/server/api/contracts";

const PAGE_SIZE = 20;

type SentimentFilter = "" | NonNullable<ReviewsParams["sentiment"]>;

const SENTIMENT_OPTIONS: Array<{ value: SentimentFilter; label: string }> = [
  { value: "", label: "All sentiment" },
  { value: "negative", label: "Negative" },
  { value: "neutral", label: "Mixed" },
  { value: "positive", label: "Positive" },
];

const REASON_OPTIONS = Object.entries(REASON_DEFINITIONS) as Array<[ReasonKey, string]>;

interface MorePages {
  key: string;
  items: ReviewDto[];
  cursor: string | null;
  loading: boolean;
  error: unknown;
}

export function ReviewsDrilldown({
  appId,
  client,
  range,
  attempt,
  onRetry,
}: {
  appId: string;
  client: PanelClient;
  range: RangeParams;
  attempt: number;
  onRetry: () => void;
}): ReactElement {
  const sentimentId = useId();
  const reasonId = useId();
  const [sentiment, setSentiment] = useState<SentimentFilter>("");
  const [reason, setReason] = useState("");
  const [more, setMore] = useState<MorePages | null>(null);

  const params: ReviewsParams = {
    ...range,
    sentiment: sentiment || undefined,
    reason: reason || undefined,
    limit: PAGE_SIZE,
  };
  const key = JSON.stringify([appId, params, attempt]);
  const first = useResource(key, () => client.getReviews(appId, params));

  const extra = more?.key === key ? more : null;
  const firstItems = first.stale ? [] : (first.data?.items ?? []);
  const items = [...firstItems, ...(extra?.items ?? [])];
  const cursor = extra ? extra.cursor : first.stale ? null : (first.data?.nextCursor ?? null);

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    const loaded = extra?.items ?? [];
    setMore({ key, items: loaded, cursor, loading: true, error: null });
    try {
      const page = await client.getReviews(appId, { ...params, cursor });
      setMore((current) =>
        current?.key === key ? { key, items: [...loaded, ...page.items], cursor: page.nextCursor, loading: false, error: null } : current,
      );
    } catch (error) {
      setMore((current) => (current?.key === key ? { key, items: loaded, cursor, loading: false, error } : current));
    }
  }

  const filtered = Boolean(sentiment || reason);

  return (
    <article className="card">
      <div className="card-heading card-heading--wrap">
        <div>
          <p className="eyebrow">Drill-down · newest first</p>
          <h2 className="card-title">
            {first.loading && !items.length
              ? "Loading reviews…"
              : items.length
                ? `Showing ${items.length} ${filtered ? "matching " : ""}review${items.length === 1 ? "" : "s"}${cursor ? ", more available" : ""}`
                : filtered
                  ? "No reviews match these filters"
                  : "No written reviews in this range"}
          </h2>
        </div>
        <div className="drill-filters">
          <div className="filter">
            <label className="label" htmlFor={sentimentId}>
              Sentiment
            </label>
            <select id={sentimentId} value={sentiment} onChange={(event) => setSentiment(event.target.value as SentimentFilter)}>
              {SENTIMENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="filter">
            <label className="label" htmlFor={reasonId}>
              Reason
            </label>
            <select id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)}>
              <option value="">All reasons</option>
              {REASON_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {first.error ? (
        <div className="card-body">
          <ErrorNotice error={first.error} onRetry={onRetry} />
        </div>
      ) : (
        items.length > 0 && (
          <div className={first.loading ? "table-wrap is-stale" : "table-wrap"} aria-busy={first.loading}>
            <table className="table table--grid">
              <thead>
                <tr>
                  <th scope="col">Review</th>
                  <th scope="col">Store</th>
                  <th scope="col" className="num">
                    Rating
                  </th>
                  <th scope="col">Sentiment</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {items.map((review) => (
                  <ReviewRow key={review.id} review={review} />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {extra?.error ? (
        <p className="body muted load-more__error" role="alert">
          {errorMessage(extra.error)}
        </p>
      ) : null}
      {cursor && !first.error && (
        <div className="load-more">
          <button type="button" className="button-secondary" onClick={() => void loadMore()} disabled={extra?.loading}>
            {extra?.loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </article>
  );
}

function ReviewRow({ review }: { review: ReviewDto }): ReactElement {
  const classification = review.classification;
  return (
    <tr>
      <td className="table__review">
        <strong>{review.title || "Untitled review"}</strong>
        <p>{review.body}</p>
        <span className="mono table__meta">
          {formatShortDate(review.createdAt)}
          {review.dateSemantics === "last_modified_fallback" && " (last modified)"}
          {review.appVersion && ` · v${review.appVersion}`}
          {review.territory && ` · ${review.territory}`}
          {review.language && ` · ${review.language}`}
        </span>
        <span className="mono table__meta table__id" title="Store review ID">
          {review.storeReviewId}
        </span>
      </td>
      <td data-label="Store">{STORE_COPY[review.store]}</td>
      <td data-label="Rating" className="num mono">
        {review.rating}/5
      </td>
      <td data-label="Sentiment">
        {classification ? (
          <>
            <Pill tone={sentimentTone(classification.sentimentLabel)}>{SENTIMENT_COPY[classification.sentimentLabel].label}</Pill>
            <span className="mono table__meta">{formatShare(classification.sentimentConfidence)} conf.</span>
          </>
        ) : (
          <Pill tone="neutral">Not classified yet</Pill>
        )}
      </td>
      <td data-label="Reason">
        {classification ? (
          <>
            {REASON_DEFINITIONS[classification.primaryReason]}
            {classification.adSubreason && (
              <span className="table__meta">{AD_SUBREASON_DEFINITIONS[classification.adSubreason]}</span>
            )}
            {classification.secondaryReason && (
              <span className="table__meta">Also: {REASON_DEFINITIONS[classification.secondaryReason].toLowerCase()}</span>
            )}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}
