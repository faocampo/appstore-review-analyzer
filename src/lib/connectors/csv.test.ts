import { describe, expect, it } from "vitest";

import { decodeCsvContent, parseReviewCsv } from "@/lib/connectors/csv";

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

  it("parses a UTF-16 LE Play Console report sent as base64", () => {
    const csv = [
      "Review Submit Date and Time,Star Rating,Review Text,Review ID",
      "2026-09-10T10:00:00Z,2,Demasiados anuncios,gp-1",
    ].join("\n");
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(csv, "utf16le"),
    ]);

    const result = parseReviewCsv({
      platform: "android",
      fileName: "reviews_202609.csv",
      encoding: "base64",
      content: bytes.toString("base64"),
    });

    expect(result.skippedRows).toBe(0);
    expect(result.reviews[0]).toMatchObject({
      id: "gp-1",
      rating: 2,
      body: "Demasiados anuncios",
    });
  });

  it.each([
    ["UTF-16 BE with BOM", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("ab", "utf16le").swap16()])],
    ["UTF-8 with BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("ab")])],
    ["UTF-16 LE without BOM", Buffer.from("ab", "utf16le")],
    ["plain UTF-8", Buffer.from("ab")],
  ])("decodes %s", (_, bytes) => {
    expect(decodeCsvContent(bytes.toString("base64"), "base64")).toBe("ab");
  });

  it("strips a BOM from text uploads", () => {
    expect(decodeCsvContent("\uFEFFid,body", "text")).toBe("id,body");
    expect(decodeCsvContent("id,body")).toBe("id,body");
  });
});
