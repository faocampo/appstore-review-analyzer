import { describe, expect, it } from "vitest";

import { parseReviewCsv } from "@/lib/csv";

describe("parseReviewCsv", () => {
  it("parses a Google Play review export", () => {
    const result = parseReviewCsv({
      platform: "android",
      fileName: "google.csv",
      content: [
        "Review ID,Review Submit Date and Time,Star Rating,Review Title,Review Text,Reviewer Language",
        'abc,2026-09-10T10:00:00Z,2,"Too many ads","Ads appear constantly",en',
      ].join("\n"),
    });

    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]).toMatchObject({
      id: "abc",
      rating: 2,
      platform: "android",
      body: "Ads appear constantly",
    });
  });

  it("skips rows that cannot represent a written review", () => {
    const result = parseReviewCsv({
      platform: "ios",
      fileName: "apple.csv",
      content: [
        "id,createdDate,rating,title,body",
        "1,2026-09-10T10:00:00Z,5,Great,",
      ].join("\n"),
    });

    expect(result.reviews).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
  });

  it("normalizes iOS aliases and generates an ID when one is absent", () => {
    const result = parseReviewCsv({
      platform: "ios",
      fileName: "apple export.csv",
      content: [
        "Created At,Stars,Review Text,Review Title,Country,Version,Language",
        "2026-09-10T10:00:00Z,4,Useful app,Good,ARG,2.0,es",
      ].join("\n"),
    });

    expect(result).toEqual({
      reviews: [
        expect.objectContaining({
          id: expect.stringContaining("apple export.csv-ios-0-"),
          platform: "ios",
          rating: 4,
          title: "Good",
          body: "Useful app",
          territory: "ARG",
          appVersion: "2.0",
          language: "es",
        }),
      ],
      skippedRows: 0,
    });
  });

  it("uses Android update metadata and rejects invalid fields", () => {
    const result = parseReviewCsv({
      platform: "android",
      fileName: "google.csv",
      content: [
        "Date,Updated At,Stars,Comment,Country,App Version",
        "2026-09-10T10:00:00Z,2026-09-11T10:00:00Z,5,Great,USA,3.0",
        "invalid-date,,3,Missing date,,",
        "2026-09-10T10:00:00Z,,8,Invalid rating,,",
      ].join("\n"),
    });

    expect(result.reviews[0]).toMatchObject({
      updatedAt: "2026-09-11T10:00:00.000Z",
      territory: "USA",
      appVersion: "3.0",
    });
    expect(result.skippedRows).toBe(2);
  });
});
