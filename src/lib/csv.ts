import Papa from "papaparse";

import type { Platform, Review } from "@/lib/types";

type CsvRow = Record<string, string>;

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function normalizeRow(row: CsvRow): CsvRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      normalizeKey(key),
      value?.trim() ?? "",
    ]),
  );
}

function first(row: CsvRow, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value) return value;
  }
  return "";
}

function parseRating(value: string): number | null {
  const rating = Number.parseFloat(value);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return null;
  return rating;
}

function parseDate(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseAndroidRow(row: CsvRow, index: number, fileName: string): Review | null {
  const rating = parseRating(first(row, ["star_rating", "rating", "stars"]));
  const createdAt = parseDate(
    first(row, [
      "review_submit_date_and_time",
      "review_submit_date",
      "created_date",
      "created_at",
      "date",
    ]),
  );
  const body = first(row, ["review_text", "body", "text", "comment"]);

  if (!rating || !createdAt || !body) return null;

  const updatedAt = parseDate(
    first(row, [
      "review_last_update_date_and_time",
      "review_last_update_date",
      "updated_at",
    ]),
  );

  return {
    id:
      first(row, ["review_id", "id"]) ||
      `${fileName}-android-${index}-${createdAt}`,
    store: "google_play",
    platform: "android",
    rating,
    title: first(row, ["review_title", "title"]),
    body,
    language: first(row, ["reviewer_language", "language"]) || undefined,
    territory: first(row, ["country", "territory"]) || undefined,
    appVersion: first(row, ["app_version_name", "app_version"]) || undefined,
    createdAt,
    updatedAt: updatedAt ?? undefined,
    dateSemantics: "created_at",
    source: "csv",
  };
}

function parseIosRow(row: CsvRow, index: number, fileName: string): Review | null {
  const rating = parseRating(first(row, ["rating", "star_rating", "stars"]));
  const createdAt = parseDate(
    first(row, ["created_date", "created_at", "review_date", "date"]),
  );
  const body = first(row, ["body", "review_text", "text", "comment"]);

  if (!rating || !createdAt || !body) return null;

  return {
    id:
      first(row, ["id", "review_id"]) ||
      `${fileName}-ios-${index}-${createdAt}`,
    store: "apple_app_store",
    platform: "ios",
    rating,
    title: first(row, ["title", "review_title"]),
    body,
    language: first(row, ["language"]) || undefined,
    territory: first(row, ["territory", "country"]) || undefined,
    appVersion: first(row, ["app_version", "version"]) || undefined,
    createdAt,
    dateSemantics: "created_at",
    source: "csv",
  };
}

export function parseReviewCsv(options: {
  content: string;
  platform: Platform;
  fileName: string;
}): { reviews: Review[]; skippedRows: number } {
  const parsed = Papa.parse<CsvRow>(options.content, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normalizeKey,
  });

  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(
      `Could not parse ${options.fileName}: ${parsed.errors[0]?.message ?? "invalid CSV"}.`,
    );
  }

  const reviews: Review[] = [];
  let skippedRows = 0;

  parsed.data.forEach((rawRow, index) => {
    const row = normalizeRow(rawRow);
    const review =
      options.platform === "android"
        ? parseAndroidRow(row, index, options.fileName)
        : parseIosRow(row, index, options.fileName);

    if (review) reviews.push(review);
    else skippedRows += 1;
  });

  return { reviews, skippedRows };
}
