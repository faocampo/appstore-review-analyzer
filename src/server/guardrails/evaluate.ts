import type {
  Confounder,
  GuardrailMetric,
  GuardrailMetricResult,
  GuardrailResponse,
  GuardrailStatus,
  LinkExperimentRequest,
} from "@/server/api/contracts";
import type { Client } from "@/server/db/pool";
import {
  poissonRateTest,
  twoProportionTest,
  welchTest,
  type TestResult,
} from "@/server/guardrails/stats";
import { daysBetween } from "@/server/repo/coverage";
import { currentModelVersion } from "@/server/repo/rollups";

export interface RuleThresholds {
  warn: number;
  breach: number;
  minN: number;
}

/**
 * Default thresholds, in each metric's unit, as magnitudes in the harmful
 * direction. They are starting points to be calibrated by the backtest
 * (plan §3.4) and can be overridden per tenant or app in guardrail_rule.
 */
export const DEFAULT_RULES: Record<
  GuardrailMetric,
  RuleThresholds & {
    label: string;
    harm: GuardrailMetricResult["harm"];
    unit: GuardrailMetricResult["unit"];
    valueUnit: GuardrailMetricResult["valueUnit"];
  }
> = {
  G1: { label: "Ad complaints among negative reviews", harm: "increase", unit: "share", valueUnit: "share", warn: 0.05, breach: 0.1, minN: 20 },
  G2: { label: "Average sentiment (0–4)", harm: "decrease", unit: "points", valueUnit: "points", warn: 0.15, breach: 0.3, minN: 20 },
  G3: { label: "Ad-complaint reviews per 100k DAU", harm: "increase", unit: "relative", valueUnit: "per100k", warn: 0.25, breach: 0.5, minN: 10 },
  G4: { label: "Written-review rating (1–5)", harm: "decrease", unit: "stars", valueUnit: "stars", warn: 0.15, breach: 0.3, minN: 20 },
};

const P_BREACH = 0.05;
const P_WARN = 0.1;

export interface ExperimentRow {
  id: string;
  tenant_id: string;
  app_id: string;
  loomit_experiment_id: string;
  name: string;
  attribution_mode: "dimension" | "pre_post";
  dimension: "app_version" | "territory" | "store" | null;
  arms: LinkExperimentRequest["arms"];
  start_at: Date;
  end_at: Date | null;
  baseline_start: Date | null;
  baseline_end: Date | null;
  status: "active" | "closed";
}

interface ArmTotals {
  n: number;
  sumEv: number;
  sumEv2: number;
  sumRating: number;
  sumRating2: number;
  negative: number;
  adsNegative: number;
  days: number;
  dau: number | null;
  daily: Map<string, { negative: number; adsNegative: number }>;
}

function emptyTotals(): ArmTotals {
  return { n: 0, sumEv: 0, sumEv2: 0, sumRating: 0, sumRating2: 0, negative: 0, adsNegative: 0, days: 0, dau: null, daily: new Map() };
}

interface RollupRow {
  day: string;
  store: string;
  app_version: string;
  territory: string;
  n: number;
  sum_ev: number;
  sum_ev2: number;
  sum_rating: number;
  sum_rating2: number;
  negative: number;
  ads_negative: number;
}

async function loadRollups(client: Client, appId: string, modelVersion: string, from: Date, to: Date): Promise<RollupRow[]> {
  const { rows } = await client.query<RollupRow>(
    `select to_char(day, 'YYYY-MM-DD') as day, store, app_version, territory, n, sum_ev, sum_ev2,
       sum_rating, sum_rating2, negative, ads_negative
     from review_daily_rollup
     where app_id = $1 and model_version = $2 and day between $3::date and $4::date`,
    [appId, modelVersion, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
  );
  return rows;
}

function addRow(totals: ArmTotals, row: RollupRow): void {
  totals.n += row.n;
  totals.sumEv += row.sum_ev;
  totals.sumEv2 += row.sum_ev2;
  totals.sumRating += row.sum_rating;
  totals.sumRating2 += row.sum_rating2;
  totals.negative += row.negative;
  totals.adsNegative += row.ads_negative;
  const day = totals.daily.get(row.day) ?? { negative: 0, adsNegative: 0 };
  day.negative += row.negative;
  day.adsNegative += row.ads_negative;
  totals.daily.set(row.day, day);
}

function sumDau(arms: LinkExperimentRequest["arms"], role: "test" | "control"): number | null {
  const values = arms.filter((arm) => arm.role === role).map((arm) => arm.dau);
  if (!values.length || values.some((value) => value === undefined)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function statusFor(result: TestResult, harm: "increase" | "decrease", rule: RuleThresholds): GuardrailStatus {
  const harmful = harm === "increase" ? result.delta : -result.delta;
  if (harmful >= rule.breach && result.pValue < P_BREACH) return "breach";
  if (harmful >= rule.warn && result.pValue < P_WARN) return "warn";
  return "ok";
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function evaluateMetrics(
  test: ArmTotals,
  control: ArmTotals,
  rules: Record<GuardrailMetric, RuleThresholds>,
): GuardrailMetricResult[] {
  const results: GuardrailMetricResult[] = [];
  const insufficient = (
    metric: GuardrailMetric,
    note: string,
    values: { test: { n: number; value: number | null }; control: { n: number; value: number | null } },
  ): GuardrailMetricResult => ({
    metric,
    label: DEFAULT_RULES[metric].label,
    harm: DEFAULT_RULES[metric].harm,
    unit: DEFAULT_RULES[metric].unit,
    valueUnit: DEFAULT_RULES[metric].valueUnit,
    status: "insufficient",
    ...values,
    delta: null,
    pValue: null,
    thresholds: rules[metric],
    note,
  });
  const done = (
    metric: GuardrailMetric,
    result: TestResult,
    values: { test: { n: number; value: number | null }; control: { n: number; value: number | null } },
    note: string | null = null,
  ): GuardrailMetricResult => ({
    metric,
    label: DEFAULT_RULES[metric].label,
    harm: DEFAULT_RULES[metric].harm,
    unit: DEFAULT_RULES[metric].unit,
    valueUnit: DEFAULT_RULES[metric].valueUnit,
    status: statusFor(result, DEFAULT_RULES[metric].harm, rules[metric]),
    ...values,
    delta: round(result.delta),
    pValue: round(result.pValue, 6),
    thresholds: rules[metric],
    note,
  });

  // G1: share of negative reviews that complain about ads.
  {
    const values = {
      test: { n: test.negative, value: test.negative ? round(test.adsNegative / test.negative) : null },
      control: { n: control.negative, value: control.negative ? round(control.adsNegative / control.negative) : null },
    };
    const minN = rules.G1.minN;
    results.push(
      test.negative < minN || control.negative < minN
        ? insufficient("G1", `Needs at least ${minN} negative reviews per arm.`, values)
        : done("G1", twoProportionTest(test.adsNegative, test.negative, control.adsNegative, control.negative), values),
    );
  }

  // G2 and G4: means with Welch's t-test.
  for (const [metric, pick] of [
    ["G2", (totals: ArmTotals) => ({ n: totals.n, sum: totals.sumEv, sumSquares: totals.sumEv2 })],
    ["G4", (totals: ArmTotals) => ({ n: totals.n, sum: totals.sumRating, sumSquares: totals.sumRating2 })],
  ] as const) {
    const t = pick(test);
    const c = pick(control);
    const values = {
      test: { n: t.n, value: t.n ? round(t.sum / t.n) : null },
      control: { n: c.n, value: c.n ? round(c.sum / c.n) : null },
    };
    const minN = rules[metric].minN;
    results.push(
      t.n < minN || c.n < minN
        ? insufficient(metric, `Needs at least ${minN} reviews per arm.`, values)
        : done(metric, welchTest(t, c), values),
    );
  }

  // G3: ad-complaint reviews per 100k DAU (needs DAU for both arms).
  {
    const exposure = (totals: ArmTotals) => (totals.dau && totals.days ? totals.dau * totals.days : null);
    const testExposure = exposure(test);
    const controlExposure = exposure(control);
    const per100k = (count: number, value: number | null) => (value ? round((count / value) * 100_000) : null);
    const values = {
      test: { n: test.adsNegative, value: per100k(test.adsNegative, testExposure) },
      control: { n: control.adsNegative, value: per100k(control.adsNegative, controlExposure) },
    };
    if (!testExposure || !controlExposure) {
      results.push(insufficient("G3", "DAU was not provided for both arms.", values));
    } else if (test.adsNegative + control.adsNegative < rules.G3.minN) {
      results.push(insufficient("G3", `Needs at least ${rules.G3.minN} ad-complaint reviews across arms.`, values));
    } else {
      results.push(done("G3", poissonRateTest(test.adsNegative, testExposure, control.adsNegative, controlExposure), values, "Delta is the relative change in rate (ratio − 1)."));
    }
  }

  return results.sort((left, right) => left.metric.localeCompare(right.metric));
}

export function overallStatus(results: GuardrailMetricResult[]): GuardrailStatus {
  const decided = results.filter((result) => result.status !== "insufficient");
  if (!decided.length) return "insufficient";
  if (decided.some((result) => result.status === "breach")) return "breach";
  if (decided.some((result) => result.status === "warn")) return "warn";
  return "ok";
}

async function loadRules(client: Client, tenantId: string, appId: string): Promise<Record<GuardrailMetric, RuleThresholds>> {
  const { rows } = await client.query<{ metric: GuardrailMetric; warn_threshold: number; breach_threshold: number; min_n: number; app_id: string | null }>(
    `select metric, warn_threshold, breach_threshold, min_n, app_id from guardrail_rule
     where tenant_id = $1 and (app_id = $2 or app_id is null) and enabled
     order by app_id nulls first`,
    [tenantId, appId],
  );
  const rules = Object.fromEntries(
    (Object.keys(DEFAULT_RULES) as GuardrailMetric[]).map((metric) => [
      metric,
      { warn: DEFAULT_RULES[metric].warn, breach: DEFAULT_RULES[metric].breach, minN: DEFAULT_RULES[metric].minN },
    ]),
  ) as Record<GuardrailMetric, RuleThresholds>;
  // App-specific rules come last and win over tenant-wide ones.
  for (const row of rows) {
    rules[row.metric] = { warn: row.warn_threshold, breach: row.breach_threshold, minN: row.min_n };
  }
  return rules;
}

async function findConfounders(
  client: Client,
  experiment: ExperimentRow,
  windows: Array<{ start: Date; end: Date }>,
  stores: string[],
): Promise<Confounder[]> {
  const confounders: Confounder[] = [];
  if (experiment.dimension !== "app_version") {
    const { rows } = await client.query<{ app_version: string; first_seen: Date }>(
      `select app_version, first_seen from app_version_seen
       where app_id = $1 and first_seen between $2 and $3 order by first_seen`,
      [experiment.app_id, new Date(windows[0].start.getTime() - 86_400_000), windows[0].end],
    );
    for (const row of rows) {
      confounders.push({
        kind: "release",
        detail: `Version ${row.app_version} first appeared in reviews on ${row.first_seen.toISOString().slice(0, 10)}, inside the experiment window.`,
        day: row.first_seen.toISOString().slice(0, 10),
        appVersion: row.app_version,
      });
    }
  }

  for (const window of windows) {
    const days = daysBetween(window.start, window.end);
    const { rows } = await client.query<{ store: string; complete: string }>(
      `select store, count(*) filter (where status = 'complete') as complete from coverage_day
       where app_id = $1 and day = any($2::date[]) and store = any($3::text[]) group by store`,
      [experiment.app_id, days, stores],
    );
    for (const store of stores) {
      const complete = Number(rows.find((row) => row.store === store)?.complete ?? 0);
      if (complete < days.length) {
        confounders.push({
          kind: "coverage",
          detail: `${store === "google_play" ? "Google Play" : "App Store"} coverage is complete for ${complete} of ${days.length} days between ${days[0]} and ${days.at(-1)}.`,
        });
      }
    }
  }
  return confounders;
}

const ATTRIBUTION_LABELS: Record<"dimension" | "pre_post", string> = {
  dimension:
    "Dimension-attributable: arms differ by a dimension reviews carry, so test and control reviews are compared directly.",
  pre_post:
    "Pre/post with baseline: reviews cannot be assigned to arms, so the experiment window is compared with a baseline window. Treat as observational.",
};

export interface EvaluationOutcome {
  evaluationId: string;
  status: GuardrailStatus;
  results: GuardrailMetricResult[];
  newAlerts: string[];
}

/**
 * Evaluates an experiment's review guardrails from rollups of the current
 * model version, stores the evaluation, and creates alerts for metrics that
 * moved into warn/breach (deduplicated with a cool-down).
 */
export async function evaluateExperiment(
  client: Client,
  experimentId: string,
  options: { now?: Date; alertCooldownHours?: number } = {},
): Promise<EvaluationOutcome | null> {
  const now = options.now ?? new Date();
  const { rows } = await client.query<ExperimentRow>("select * from experiment where id = $1", [experimentId]);
  const experiment = rows[0];
  if (!experiment) return null;

  const end = experiment.end_at && experiment.end_at < now ? experiment.end_at : now;
  const window = { start: experiment.start_at, end };
  const modelVersion = await currentModelVersion(client, experiment.app_id);
  const rules = await loadRules(client, experiment.tenant_id, experiment.app_id);
  const test = emptyTotals();
  const control = emptyTotals();
  test.dau = sumDau(experiment.arms, "test");
  control.dau = sumDau(experiment.arms, "control");
  let baseline: { start: Date; end: Date } | null = null;
  const stores = new Set<string>();

  if (modelVersion) {
    if (experiment.attribution_mode === "dimension" && experiment.dimension) {
      const column = experiment.dimension;
      const testValues = new Set(experiment.arms.filter((arm) => arm.role === "test").flatMap((arm) => arm.values ?? []));
      const controlValues = new Set(experiment.arms.filter((arm) => arm.role === "control").flatMap((arm) => arm.values ?? []));
      for (const row of await loadRollups(client, experiment.app_id, modelVersion, window.start, window.end)) {
        const value = row[column];
        if (testValues.has(value)) addRow(test, row);
        else if (controlValues.has(value)) addRow(control, row);
        else continue;
        stores.add(row.store);
      }
      test.days = control.days = daysBetween(window.start, window.end).length;
    } else if (experiment.baseline_start && experiment.baseline_end) {
      baseline = { start: experiment.baseline_start, end: experiment.baseline_end };
      for (const row of await loadRollups(client, experiment.app_id, modelVersion, window.start, window.end)) {
        addRow(test, row);
        stores.add(row.store);
      }
      for (const row of await loadRollups(client, experiment.app_id, modelVersion, baseline.start, baseline.end)) {
        addRow(control, row);
        stores.add(row.store);
      }
      test.days = daysBetween(window.start, window.end).length;
      control.days = daysBetween(baseline.start, baseline.end).length;
    }
  }

  const results = evaluateMetrics(test, control, rules);
  const status = overallStatus(results);
  const confounders = await findConfounders(
    client,
    experiment,
    baseline ? [window, baseline] : [window],
    [...stores],
  );
  if (!modelVersion) {
    confounders.push({ kind: "model_change", detail: "No classified reviews yet for this app." });
  }
  const seriesDays = daysBetween(baseline?.start ?? window.start, window.end);
  const share = (totals: ArmTotals, day: string) => {
    const value = totals.daily.get(day);
    return value && value.negative ? round(value.adsNegative / value.negative) : null;
  };
  const series = seriesDays.map((day) => ({
    day,
    test: share(test, day),
    control: share(control, day),
    testN: test.daily.get(day)?.negative ?? 0,
    controlN: control.daily.get(day)?.negative ?? 0,
  }));

  const { rows: inserted } = await client.query<{ id: string }>(
    `insert into guardrail_evaluation (tenant_id, experiment_id, model_version, status, window_start, window_end, results, confounders, series)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      experiment.tenant_id, experiment.id, modelVersion, status, window.start, window.end,
      JSON.stringify(results), JSON.stringify(confounders), JSON.stringify(series),
    ],
  );
  const evaluationId = inserted[0].id;

  const newAlerts: string[] = [];
  const cooldownHours = options.alertCooldownHours ?? 24;
  for (const result of results) {
    if (result.status !== "warn" && result.status !== "breach") continue;
    const dedupKey = `${experiment.id}:${result.metric}:${result.status}`;
    const { rows: recent } = await client.query(
      "select 1 from alert where dedup_key = $1 and created_at > $2::timestamptz - make_interval(hours => $3)",
      [dedupKey, now, cooldownHours],
    );
    if (recent.length) continue;
    const { rows: alert } = await client.query<{ id: string }>(
      `insert into alert (tenant_id, experiment_id, evaluation_id, metric, status, dedup_key, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [experiment.tenant_id, experiment.id, evaluationId, result.metric, result.status, dedupKey, now],
    );
    newAlerts.push(alert[0].id);
  }

  return { evaluationId, status, results, newAlerts };
}

/** Builds the API view from the experiment and its latest evaluation. */
export async function guardrailView(client: Client, loomitExperimentId: string): Promise<GuardrailResponse | null> {
  const { rows } = await client.query<ExperimentRow>(
    "select * from experiment where loomit_experiment_id = $1",
    [loomitExperimentId],
  );
  const experiment = rows[0];
  if (!experiment) return null;
  const { rows: evaluations } = await client.query<{
    evaluated_at: Date; status: GuardrailStatus; model_version: string | null; window_start: Date; window_end: Date;
    results: GuardrailMetricResult[]; confounders: Confounder[]; series: GuardrailResponse["series"];
  }>(
    "select * from guardrail_evaluation where experiment_id = $1 order by evaluated_at desc limit 1",
    [experiment.id],
  );
  const latest = evaluations[0];
  return {
    experimentId: experiment.id,
    loomitExperimentId: experiment.loomit_experiment_id,
    name: experiment.name,
    evaluatedAt: latest?.evaluated_at.toISOString() ?? null,
    status: latest?.status ?? "insufficient",
    attributionMode: experiment.attribution_mode,
    attributionLabel: ATTRIBUTION_LABELS[experiment.attribution_mode],
    dimension: experiment.dimension,
    arms: experiment.arms.map((arm) => ({ key: arm.key, role: arm.role, values: arm.values ?? [], dau: arm.dau ?? null })),
    modelVersion: latest?.model_version ?? null,
    window: {
      start: (latest?.window_start ?? experiment.start_at).toISOString(),
      end: (latest?.window_end ?? experiment.end_at ?? experiment.start_at).toISOString(),
    },
    baseline:
      experiment.baseline_start && experiment.baseline_end
        ? { start: experiment.baseline_start.toISOString(), end: experiment.baseline_end.toISOString() }
        : null,
    metrics: latest?.results ?? [],
    confounders: latest?.confounders ?? [],
    series: latest?.series ?? [],
  };
}

/** Creates or updates an experiment link from Loomit. */
export async function linkExperiment(
  client: Client,
  input: { tenantId: string; appId: string; loomitExperimentId: string; body: LinkExperimentRequest },
): Promise<ExperimentRow> {
  const { rows } = await client.query<ExperimentRow>(
    `insert into experiment (tenant_id, app_id, loomit_experiment_id, name, attribution_mode, dimension, arms,
       start_at, end_at, baseline_start, baseline_end, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, case when $9::timestamptz < now() then 'closed' else 'active' end)
     on conflict (tenant_id, loomit_experiment_id) do update set
       app_id = excluded.app_id, name = excluded.name, attribution_mode = excluded.attribution_mode,
       dimension = excluded.dimension, arms = excluded.arms, start_at = excluded.start_at, end_at = excluded.end_at,
       baseline_start = excluded.baseline_start, baseline_end = excluded.baseline_end,
       status = excluded.status, updated_at = now()
     returning *`,
    [
      input.tenantId, input.appId, input.loomitExperimentId, input.body.name, input.body.attributionMode,
      input.body.dimension ?? null, JSON.stringify(input.body.arms), input.body.startAt, input.body.endAt ?? null,
      input.body.baselineStart ?? null, input.body.baselineEnd ?? null,
    ],
  );
  return rows[0];
}
