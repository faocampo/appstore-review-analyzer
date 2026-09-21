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
});
