import { REASON_KEYS } from "@/lib/classifiers/provider";
import type { DatasetLabel, DatasetRow } from "@/lib/eval/dataset";
import {
  accuracy,
  cohensKappa,
  macroF1,
  mean,
  meanAbsoluteError,
  quadraticWeightedKappa,
} from "@/lib/eval/metrics";
import { NO_AD_SUBREASON, type GateThresholds } from "@/lib/eval/run";

export interface AnnotationPair {
  id: string;
  language: string;
  firstAnnotator: string;
  secondAnnotator: string;
  first: DatasetLabel;
  second: DatasetLabel;
}

/**
 * Groups a multi-annotator dataset into one pair per id. Annotators are
 * ordered by name so "first" and "second" are stable. Ids with a single
 * annotation are skipped; ids with more than two use the first two names.
 */
function annotatorOf(row: DatasetRow): string {
  return row.annotator ?? "";
}

export function pairAnnotations(rows: readonly DatasetRow[]): {
  pairs: AnnotationPair[];
  warnings: string[];
} {
  const groups = new Map<string, DatasetRow[]>();
  for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);

  const pairs: AnnotationPair[] = [];
  const warnings: string[] = [];
  for (const [id, group] of groups) {
    const sorted = [...group].sort((left, right) =>
      annotatorOf(left).localeCompare(annotatorOf(right)),
    );
    if (sorted.length < 2) {
      warnings.push(`id "${id}" has a single annotation; skipped.`);
      continue;
    }
    if (sorted.length > 2) {
      warnings.push(
        `id "${id}" has ${sorted.length} annotations; using ${sorted[0].annotator} and ${sorted[1].annotator}.`,
      );
    }
    const [first, second] = sorted;
    if (first.title !== second.title || first.body !== second.body) {
      warnings.push(`id "${id}" has different review text per annotator; check the export.`);
    }
    pairs.push({
      id,
      language: first.language,
      firstAnnotator: annotatorOf(first),
      secondAnnotator: annotatorOf(second),
      first: first.label,
      second: second.label,
    });
  }
  return { pairs, warnings };
}

export interface Disagreement {
  id: string;
  language: string;
  fields: string[];
  first: DatasetLabel;
  second: DatasetLabel;
}

export interface AgreementReport {
  n: number;
  annotators: string[];
  primaryReason: {
    kappa: number | null;
    observedAgreement: number | null;
    /** Macro-F1 of one annotator against the other, averaged over both directions. */
    macroF1: number | null;
  };
  sentiment: {
    qwk: number | null;
    exactAgreement: number | null;
    withinOne: number | null;
    mae: number | null;
  };
  adSubreason: {
    n: number;
    kappa: number | null;
    observedAgreement: number | null;
  };
  disagreements: Disagreement[];
}

function symmetricMacroF1(
  first: string[],
  second: string[],
  labels: readonly string[],
): number | null {
  const forward = macroF1(first, second, { labels });
  const backward = macroF1(second, first, { labels });
  return forward === null || backward === null ? null : (forward + backward) / 2;
}

export function computeAgreement(pairs: readonly AnnotationPair[]): AgreementReport {
  const firstReasons = pairs.map((pair) => pair.first.primaryReason as string);
  const secondReasons = pairs.map((pair) => pair.second.primaryReason as string);
  const firstSentiment = pairs.map((pair) => pair.first.sentiment as number);
  const secondSentiment = pairs.map((pair) => pair.second.sentiment as number);

  const adPairs = pairs.filter(
    (pair) => pair.first.adSubreason !== null || pair.second.adSubreason !== null,
  );
  const firstAd = adPairs.map((pair) => pair.first.adSubreason ?? NO_AD_SUBREASON);
  const secondAd = adPairs.map((pair) => pair.second.adSubreason ?? NO_AD_SUBREASON);

  const disagreements: Disagreement[] = [];
  for (const pair of pairs) {
    const fields: string[] = [];
    if (pair.first.primaryReason !== pair.second.primaryReason) fields.push("primaryReason");
    if (pair.first.secondaryReason !== pair.second.secondaryReason) fields.push("secondaryReason");
    if (pair.first.sentiment !== pair.second.sentiment) fields.push("sentiment");
    if (pair.first.adSubreason !== pair.second.adSubreason) fields.push("adSubreason");
    if (fields.length) {
      disagreements.push({
        id: pair.id,
        language: pair.language,
        fields,
        first: pair.first,
        second: pair.second,
      });
    }
  }

  const annotators = [
    ...new Set(pairs.flatMap((pair) => [pair.firstAnnotator, pair.secondAnnotator])),
  ].sort();

  return {
    n: pairs.length,
    annotators,
    primaryReason: {
      kappa: cohensKappa(firstReasons, secondReasons),
      observedAgreement: accuracy(firstReasons, secondReasons),
      macroF1: symmetricMacroF1(firstReasons, secondReasons, REASON_KEYS),
    },
    sentiment: {
      qwk: quadraticWeightedKappa(firstSentiment, secondSentiment, { min: 0, max: 4 }),
      exactAgreement: accuracy(firstSentiment, secondSentiment),
      withinOne: mean(
        firstSentiment.map((value, index) => (Math.abs(value - secondSentiment[index]) <= 1 ? 1 : 0)),
      ),
      mae: meanAbsoluteError(firstSentiment, secondSentiment),
    },
    adSubreason: {
      n: adPairs.length,
      kappa: cohensKappa(firstAd, secondAd),
      observedAgreement: accuracy(firstAd, secondAd),
    },
    disagreements,
  };
}

/** Landis & Koch (1977) bands; a convention, not a law. */
export function interpretKappa(kappa: number | null): string {
  if (kappa === null) return "undefined";
  if (kappa < 0) return "poor";
  if (kappa <= 0.2) return "slight";
  if (kappa <= 0.4) return "fair";
  if (kappa <= 0.6) return "moderate";
  if (kappa <= 0.8) return "substantial";
  return "almost perfect";
}

export interface GateSuggestion {
  thresholds: GateThresholds;
  rationale: string[];
}

const floor2 = (value: number) => Math.floor(value * 100) / 100;
const ceil2 = (value: number) => Math.ceil(value * 100 - 1e-9) / 100;

/**
 * Derives absolute gate floors from human agreement: the model must reach
 * `fraction` of the human-vs-human macro-F1 and QWK, and stay within
 * `maeMargin` of the human sentiment MAE. The plan's main gate stays
 * relative (match or beat Jev: maxReasonMacroF1DropVsBaseline=0).
 */
export function suggestGate(
  agreement: AgreementReport,
  { fraction = 0.9, maeMargin = 0.2 }: { fraction?: number; maeMargin?: number } = {},
): GateSuggestion {
  const thresholds: GateThresholds = { maxReasonMacroF1DropVsBaseline: 0 };
  const rationale = [
    "maxReasonMacroF1DropVsBaseline=0: the candidate must match or beat the baseline (plan §3.2).",
  ];

  const humanF1 = agreement.primaryReason.macroF1;
  if (humanF1 === null) {
    rationale.push("minReasonMacroF1: not set (human macro-F1 is undefined).");
  } else {
    thresholds.minReasonMacroF1 = floor2(humanF1 * fraction);
    rationale.push(
      `minReasonMacroF1=${thresholds.minReasonMacroF1}: ${fraction} × human macro-F1 ${humanF1.toFixed(3)}.`,
    );
  }

  const humanQwk = agreement.sentiment.qwk;
  if (humanQwk === null) {
    rationale.push("minQwk: not set (human QWK is undefined).");
  } else {
    thresholds.minQwk = floor2(humanQwk * fraction);
    rationale.push(`minQwk=${thresholds.minQwk}: ${fraction} × human QWK ${humanQwk.toFixed(3)}.`);
  }

  const humanMae = agreement.sentiment.mae;
  if (humanMae === null) {
    rationale.push("maxSentimentMae: not set (no pairs).");
  } else {
    thresholds.maxSentimentMae = ceil2(humanMae + maeMargin);
    rationale.push(
      `maxSentimentMae=${thresholds.maxSentimentMae}: human MAE ${humanMae.toFixed(3)} + ${maeMargin}.`,
    );
  }

  const kappa = agreement.primaryReason.kappa;
  if (kappa === null || kappa < 0.6) {
    rationale.push(
      `Warning: primary-reason kappa is ${kappa === null ? "undefined" : kappa.toFixed(3)} (${interpretKappa(kappa)}). Revise the guidelines and re-annotate before trusting any gate.`,
    );
  }
  return { thresholds, rationale };
}

function fixed(value: number | null, digits = 3): string {
  return value === null ? "—" : value.toFixed(digits);
}

function describeLabel(label: DatasetLabel): string {
  const reasons = label.secondaryReason
    ? `${label.primaryReason}+${label.secondaryReason}`
    : label.primaryReason;
  return `${reasons}${label.adSubreason ? `/${label.adSubreason}` : ""} s${label.sentiment}`;
}

/** Markdown summary of an agreement study, with the suggested gate. */
export function renderAgreement(
  agreement: AgreementReport,
  suggestion: GateSuggestion,
  warnings: readonly string[] = [],
): string {
  const lines = [
    "# Inter-annotator agreement",
    "",
    `- Pairs: ${agreement.n}; annotators: ${agreement.annotators.join(", ") || "—"}`,
    `- Primary reason: Cohen's kappa ${fixed(agreement.primaryReason.kappa)} (${interpretKappa(agreement.primaryReason.kappa)}), observed agreement ${fixed(agreement.primaryReason.observedAgreement)}, macro-F1 ${fixed(agreement.primaryReason.macroF1)}`,
    `- Sentiment: QWK ${fixed(agreement.sentiment.qwk)}, exact ${fixed(agreement.sentiment.exactAgreement)}, within ±1 ${fixed(agreement.sentiment.withinOne)}, MAE ${fixed(agreement.sentiment.mae)}`,
    `- Ad sub-reason (n = ${agreement.adSubreason.n}): Cohen's kappa ${fixed(agreement.adSubreason.kappa)}, observed agreement ${fixed(agreement.adSubreason.observedAgreement)}`,
  ];
  for (const warning of warnings) lines.push(`- Warning: ${warning}`);

  lines.push("", `## Disagreements (${agreement.disagreements.length})`, "");
  if (agreement.disagreements.length) {
    lines.push("| id | lang | fields | first | second |", "| --- | --- | --- | --- | --- |");
    for (const item of agreement.disagreements) {
      lines.push(
        `| ${item.id} | ${item.language} | ${item.fields.join(", ")} | ${describeLabel(item.first)} | ${describeLabel(item.second)} |`,
      );
    }
  } else {
    lines.push("_None._");
  }

  const flags = Object.entries(suggestion.thresholds).map(([key, value]) => `--gate ${key}=${value}`);
  lines.push(
    "",
    "## Suggested gate",
    "",
    ...suggestion.rationale.map((line) => `- ${line}`),
    "",
    "```",
    flags.join(" "),
    "```",
  );
  return `${lines.join("\n")}\n`;
}
