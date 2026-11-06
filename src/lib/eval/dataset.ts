import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { z } from "zod";

import {
  AD_SUBREASON_DEFINITIONS,
  REASON_DEFINITIONS,
  type AdSubreasonKey,
  type ReasonKey,
  type Review,
  type SentimentScore,
} from "@/lib/types";

const reasonKeys = Object.keys(REASON_DEFINITIONS) as [ReasonKey, ...ReasonKey[]];
const adSubreasonKeys = Object.keys(AD_SUBREASON_DEFINITIONS) as [
  AdSubreasonKey,
  ...AdSubreasonKey[],
];

export const labelSchema = z
  .object({
    sentiment: z
      .number()
      .int()
      .min(0)
      .max(4)
      .transform((value) => value as SentimentScore),
    primaryReason: z.enum(reasonKeys),
    secondaryReason: z.enum(reasonKeys).nullable(),
    adSubreason: z.enum(adSubreasonKeys).nullable(),
  })
  .strict()
  .superRefine((label, context) => {
    if (label.secondaryReason !== null && label.secondaryReason === label.primaryReason) {
      context.addIssue({
        code: "custom",
        path: ["secondaryReason"],
        message: "secondaryReason must differ from primaryReason (use null instead)",
      });
    }
    const mentionsAds = label.primaryReason === "ads" || label.secondaryReason === "ads";
    if (mentionsAds && label.adSubreason === null) {
      context.addIssue({
        code: "custom",
        path: ["adSubreason"],
        message: "adSubreason is required when a reason is ads (use ad_other if unsure)",
      });
    }
    if (!mentionsAds && label.adSubreason !== null) {
      context.addIssue({
        code: "custom",
        path: ["adSubreason"],
        message: "adSubreason must be null unless the primary or secondary reason is ads",
      });
    }
  });

export const datasetRowSchema = z
  .object({
    id: z.string().trim().min(1),
    store: z.enum(["google_play", "apple_app_store"]),
    language: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "expected a BCP 47 tag such as en or pt-BR")
      .transform((value) => value.toLowerCase()),
    rating: z.number().int().min(1).max(5),
    title: z.string().default(""),
    body: z.string(),
    label: labelSchema,
    annotator: z.string().trim().min(1).optional(),
    split: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((row) => row.title.trim() || row.body.trim(), {
    message: "title and body cannot both be empty",
    path: ["body"],
  });

export type DatasetLabel = z.infer<typeof labelSchema>;
export type DatasetRow = z.infer<typeof datasetRowSchema>;

export class DatasetError extends Error {
  readonly problems: string[];

  constructor(source: string, problems: string[]) {
    const shown = problems.slice(0, 20);
    const more = problems.length > shown.length ? `\n  … and ${problems.length - shown.length} more` : "";
    super(`Invalid dataset ${source}:\n  ${shown.join("\n  ")}${more}`);
    this.name = "DatasetError";
    this.problems = problems;
  }
}

export interface ParseOptions {
  /** Shown in error messages. */
  source?: string;
  /**
   * Multi-annotator files (agreement studies) repeat each id once per
   * annotator: `annotator` becomes required and (id, annotator) must be
   * unique. Otherwise ids must be unique.
   */
  multiAnnotator?: boolean;
}

/**
 * Parses and validates a JSONL dataset. Blank lines are skipped. Every
 * problem is collected (with its 1-based line number) and thrown together
 * as a `DatasetError`, so a bad file is fixed in one pass.
 */
export function parseDataset(text: string, options: ParseOptions = {}): DatasetRow[] {
  const source = options.source ?? "dataset";
  const rows: DatasetRow[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) return;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      problems.push(`line ${lineNumber}: not valid JSON`);
      return;
    }

    const parsed = datasetRowSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? issue.path.join(".") : "(row)";
        problems.push(`line ${lineNumber}: ${path}: ${issue.message}`);
      }
      return;
    }

    const row = parsed.data;
    if (options.multiAnnotator && !row.annotator) {
      problems.push(`line ${lineNumber}: annotator: required in a multi-annotator file`);
      return;
    }
    const key = options.multiAnnotator ? `${row.id}\u0000${row.annotator}` : row.id;
    const previous = seen.get(key);
    if (previous !== undefined) {
      const what = options.multiAnnotator
        ? `id "${row.id}" with annotator "${row.annotator}"`
        : `id "${row.id}"`;
      problems.push(`line ${lineNumber}: duplicate ${what} (first seen on line ${previous})`);
      return;
    }
    seen.set(key, lineNumber);
    rows.push(row);
  });

  if (problems.length) throw new DatasetError(source, problems);
  return rows;
}

export interface LoadedDataset {
  name: string;
  /** SHA-256 of the file bytes; reports compare it to detect dataset drift. */
  sha256: string;
  rows: DatasetRow[];
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function loadDataset(
  path: string,
  options: Omit<ParseOptions, "source"> = {},
): Promise<LoadedDataset> {
  const text = await readFile(path, "utf8");
  return {
    name: basename(path),
    sha256: fingerprint(text),
    rows: parseDataset(text, { ...options, source: path }),
  };
}

/** Fixed timestamp: eval reviews have no meaningful date. */
const EVAL_CREATED_AT = "2000-01-01T00:00:00.000Z";

/** Converts a dataset row into the `Review` shape classifiers accept. */
export function toReview(row: DatasetRow): Review {
  return {
    id: row.id,
    store: row.store,
    platform: row.store === "google_play" ? "android" : "ios",
    rating: row.rating,
    title: row.title,
    body: row.body,
    language: row.language,
    createdAt: EVAL_CREATED_AT,
    dateSemantics: "created_at",
    // Eval rows are imported from a file, like CSV uploads.
    source: "csv",
  };
}
