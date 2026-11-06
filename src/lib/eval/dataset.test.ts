import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  DatasetError,
  fingerprint,
  loadDataset,
  parseDataset,
  toReview,
} from "@/lib/eval/dataset";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    store: "google_play",
    language: "en",
    rating: 1,
    title: "Ads",
    body: "An ad after every level",
    label: {
      sentiment: 0,
      primaryReason: "ads",
      secondaryReason: null,
      adSubreason: "ad_frequency",
    },
    ...overrides,
  };
}

function jsonl(...rows: unknown[]): string {
  return rows.map((value) => JSON.stringify(value)).join("\n");
}

function problemsOf(text: string, options = {}): string[] {
  try {
    parseDataset(text, options);
  } catch (error) {
    expect(error).toBeInstanceOf(DatasetError);
    return (error as DatasetError).problems;
  }
  throw new Error("expected parseDataset to throw");
}

describe("parseDataset", () => {
  it("parses valid rows, skips blank lines and normalises language", () => {
    const rows = parseDataset(
      `${jsonl(row())}\n\n${jsonl(
        row({
          id: "r2",
          store: "apple_app_store",
          language: "PT-BR",
          rating: 5,
          title: undefined,
          body: "Ótimo app",
          label: {
            sentiment: 4,
            primaryReason: "praise_general",
            secondaryReason: "usability_navigation",
            adSubreason: null,
          },
          annotator: "a1",
          split: "test",
        }),
      )}\r\n`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      language: "pt-br",
      title: "",
      annotator: "a1",
      split: "test",
      label: { secondaryReason: "usability_navigation" },
    });
  });

  it("accepts ads as a secondary reason with a sub-reason", () => {
    const [parsed] = parseDataset(
      jsonl(
        row({
          label: {
            sentiment: 1,
            primaryReason: "stability",
            secondaryReason: "ads",
            adSubreason: "ad_breaks_app",
          },
        }),
      ),
    );
    expect(parsed.label.adSubreason).toBe("ad_breaks_app");
  });

  it("reports invalid JSON and schema problems with line numbers", () => {
    const problems = problemsOf(
      [
        "{not json",
        JSON.stringify(row({ id: "", rating: 6, store: "web" })),
        JSON.stringify(
          row({
            id: "r3",
            label: {
              sentiment: 5,
              primaryReason: "nope",
              secondaryReason: null,
              adSubreason: null,
            },
          }),
        ),
        JSON.stringify(row({ id: "r4", extra: true })),
        JSON.stringify(row({ id: "r5", language: "english!" })),
        JSON.stringify(row({ id: "r6", title: " ", body: "" })),
        JSON.stringify([1, 2]),
      ].join("\n"),
      { source: "x.jsonl" },
    );

    expect(problems[0]).toBe("line 1: not valid JSON");
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^line 2: id:/),
        expect.stringMatching(/^line 2: store:/),
        expect.stringMatching(/^line 2: rating:/),
        expect.stringMatching(/^line 3: label\.sentiment:/),
        expect.stringMatching(/^line 3: label\.primaryReason:/),
        expect.stringMatching(/^line 4: \(row\):/),
        expect.stringMatching(/^line 5: language: expected a BCP 47 tag/),
        expect.stringMatching(/^line 6: body: title and body cannot both be empty/),
        expect.stringMatching(/^line 7: \(row\):/),
      ]),
    );
  });

  it("enforces taxonomy rules on labels", () => {
    const problems = problemsOf(
      jsonl(
        row({
          id: "same",
          label: {
            sentiment: 1,
            primaryReason: "stability",
            secondaryReason: "stability",
            adSubreason: null,
          },
        }),
        row({
          id: "missing-sub",
          label: { sentiment: 1, primaryReason: "ads", secondaryReason: null, adSubreason: null },
        }),
        row({
          id: "stray-sub",
          label: {
            sentiment: 1,
            primaryReason: "stability",
            secondaryReason: null,
            adSubreason: "ad_audio",
          },
        }),
        row({
          id: "bad-sub",
          label: {
            sentiment: 1,
            primaryReason: "ads",
            secondaryReason: null,
            adSubreason: "ad_unknown",
          },
        }),
      ),
    );

    expect(problems).toEqual([
      expect.stringMatching(/^line 1: label\.secondaryReason: secondaryReason must differ/),
      expect.stringMatching(/^line 2: label\.adSubreason: adSubreason is required/),
      expect.stringMatching(/^line 3: label\.adSubreason: adSubreason must be null/),
      expect.stringMatching(/^line 4: label\.adSubreason:/),
    ]);
  });

  it("rejects duplicate ids in single-annotator files", () => {
    expect(problemsOf(jsonl(row(), row()))).toEqual([
      'line 2: duplicate id "r1" (first seen on line 1)',
    ]);
  });

  it("allows one row per annotator in multi-annotator files", () => {
    const rows = parseDataset(
      jsonl(row({ annotator: "a" }), row({ annotator: "b" })),
      { multiAnnotator: true },
    );
    expect(rows.map((value) => value.annotator)).toEqual(["a", "b"]);

    expect(
      problemsOf(jsonl(row({ annotator: "a" }), row({ annotator: "a" }), row()), {
        multiAnnotator: true,
      }),
    ).toEqual([
      'line 2: duplicate id "r1" with annotator "a" (first seen on line 1)',
      "line 3: annotator: required in a multi-annotator file",
    ]);
  });

  it("truncates long problem lists in the error message", () => {
    const text = Array.from({ length: 25 }, () => "nope").join("\n");
    expect(() => parseDataset(text)).toThrow(/Invalid dataset dataset:[\s\S]*… and 5 more/);
  });
});

describe("toReview", () => {
  it("maps a row to a classifier review", () => {
    const [android, ios] = parseDataset(
      jsonl(row(), row({ id: "r2", store: "apple_app_store", language: "es" })),
    );
    expect(toReview(android)).toEqual({
      id: "r1",
      store: "google_play",
      platform: "android",
      rating: 1,
      title: "Ads",
      body: "An ad after every level",
      language: "en",
      createdAt: "2000-01-01T00:00:00.000Z",
      dateSemantics: "created_at",
      source: "csv",
    });
    expect(toReview(ios)).toMatchObject({ platform: "ios", language: "es" });
  });
});

describe("loadDataset", () => {
  const directories: string[] = [];

  afterAll(async () => {
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reads, fingerprints and validates a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-dataset-"));
    directories.push(directory);
    const path = join(directory, "set.jsonl");
    const text = jsonl(row());
    await writeFile(path, text);

    const loaded = await loadDataset(path);
    expect(loaded.name).toBe("set.jsonl");
    expect(loaded.sha256).toBe(fingerprint(text));
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.rows).toHaveLength(1);

    await writeFile(path, "{");
    await expect(loadDataset(path)).rejects.toThrow(`Invalid dataset ${path}`);
  });
});
