/**
 * Inter-annotator agreement CLI (plan §3.2).
 *
 *   npx tsx scripts/eval-agreement.ts --dataset eval/datasets/sample-agreement.jsonl
 *
 * Reads a double-annotated JSONL file (one line per id and annotator) and
 * reports Cohen's kappa for the primary reason, quadratic weighted kappa
 * for sentiment, ad sub-reason agreement, every disagreement, and the gate
 * thresholds derived from that agreement. See eval/README.md.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  computeAgreement,
  pairAnnotations,
  renderAgreement,
  suggestGate,
} from "@/lib/eval/agreement";
import { loadDataset } from "@/lib/eval/dataset";

const USAGE = `Usage: npx tsx scripts/eval-agreement.ts --dataset <double-annotated.jsonl> [options]

Options:
  --out <dir>          Also write agreement .md and .json files to this directory
  --fraction <x>       Share of human macro-F1 / QWK the model must reach (default: 0.9)
  --mae-margin <x>     Sentiment MAE allowed above the human MAE (default: 0.2)
  -h, --help           Show this help`;

class UsageError extends Error {}

function number(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new UsageError(`--${name} must be a number between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      out: { type: "string" },
      fraction: { type: "string" },
      "mae-margin": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.dataset) throw new UsageError("--dataset is required.");
  const fraction = number("fraction", values.fraction, 0.01, 1);
  const maeMargin = number("mae-margin", values["mae-margin"], 0, 4);

  const dataset = await loadDataset(values.dataset, { multiAnnotator: true });
  const { pairs, warnings } = pairAnnotations(dataset.rows);
  if (!pairs.length) {
    throw new UsageError(`${values.dataset} has no id annotated by two annotators.`);
  }

  const agreement = computeAgreement(pairs);
  const suggestion = suggestGate(agreement, { fraction, maeMargin });
  const markdown = renderAgreement(agreement, suggestion, warnings);
  console.log(markdown);

  if (values.out) {
    const outDir = resolve(values.out);
    await mkdir(outDir, { recursive: true });
    const stem = `agreement_${dataset.name.replace(/\.jsonl$/, "")}`;
    const markdownPath = join(outDir, `${stem}.md`);
    const jsonPath = join(outDir, `${stem}.json`);
    await writeFile(markdownPath, markdown);
    await writeFile(
      jsonPath,
      `${JSON.stringify({ dataset: { name: dataset.name, sha256: dataset.sha256 }, warnings, agreement, suggestion }, null, 2)}\n`,
    );
    console.log(`Wrote ${markdownPath}\nWrote ${jsonPath}`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string })?.code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`\n${USAGE}`);
    }
    process.exitCode = 2;
  },
);
