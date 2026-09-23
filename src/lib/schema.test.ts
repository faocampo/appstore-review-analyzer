import { describe, expect, it } from "vitest";

import { analyzeInputSchema } from "@/lib/schema";

const baseInput = {
  appName: "Test app",
  sourceMode: "demo" as const,
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  lastN: 10,
};

describe("analyzeInputSchema", () => {
  it.each([
    baseInput,
    {
      ...baseInput,
      sourceMode: "live_api",
      androidPackage: "com.example.app",
    },
    {
      ...baseInput,
      sourceMode: "live_api",
      appleAppId: "123456789",
    },
    {
      ...baseInput,
      sourceMode: "csv",
      csvFiles: [
        {
          name: "reviews.csv",
          platform: "android",
          content: "rating,body,date\n5,Great,2026-09-10",
        },
      ],
    },
  ])("accepts a valid analysis request", (input) => {
    expect(analyzeInputSchema.safeParse(input).success).toBe(true);
  });

  it("reports cross-field validation failures", () => {
    const result = analyzeInputSchema.safeParse({
      ...baseInput,
      sourceMode: "live_api",
      startDate: "2026-10-01",
      endDate: "2026-09-01",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "Start date must be before or equal to end date.",
          "Provide an Android package or App Store Connect app ID.",
        ]),
      );
    }
  });

  it("requires CSV files and validates scalar bounds", () => {
    expect(
      analyzeInputSchema.safeParse({
        ...baseInput,
        sourceMode: "csv",
        appName: "",
        lastN: 201,
      }).success,
    ).toBe(false);
  });
});
