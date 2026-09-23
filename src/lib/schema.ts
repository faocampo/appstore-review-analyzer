import { z } from "zod";

export const analyzeInputSchema = z
  .object({
    appName: z.string().trim().min(1).max(120),
    sourceMode: z.enum(["demo", "live_api", "csv"]),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    lastN: z.number().int().min(1).max(200),
    androidPackage: z.string().trim().max(200).optional(),
    appleAppId: z.string().trim().max(200).optional(),
    translationLanguage: z.string().trim().max(12).optional(),
    csvFiles: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(255),
          platform: z.enum(["android", "ios"]),
          content: z.string().min(1).max(8_000_000),
        }),
      )
      .max(6)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.startDate > value.endDate) {
      context.addIssue({
        code: "custom",
        message: "Start date must be before or equal to end date.",
        path: ["startDate"],
      });
    }

    if (
      value.sourceMode === "live_api" &&
      !value.androidPackage &&
      !value.appleAppId
    ) {
      context.addIssue({
        code: "custom",
        message: "Provide an Android package or App Store Connect app ID.",
        path: ["sourceMode"],
      });
    }

    if (value.sourceMode === "csv" && !value.csvFiles?.length) {
      context.addIssue({
        code: "custom",
        message: "Upload at least one store export.",
        path: ["csvFiles"],
      });
    }
  });
