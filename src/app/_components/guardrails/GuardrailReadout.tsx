"use client";

import { type ReactElement, useState } from "react";

import { TestControlChart } from "@/app/_components/charts/TestControlChart";
import { LoadingCard, NavLink, PanelTopbar, Pill, RequestProblem, SampleTag } from "@/app/_components/ui";
import { panelClient } from "@/app/_lib/api-client";
import { GUARDRAIL_STATUS_COPY } from "@/app/_lib/copy";
import { formatDateTime, formatShortDate } from "@/app/_lib/dates";
import { formatCount, formatFixed, formatPoints, formatPValue, formatShare, formatSigned } from "@/app/_lib/numbers";
import { useResource } from "@/app/_lib/use-resource";
import type { Confounder, GuardrailMetricResult, GuardrailResponse, GuardrailStatus } from "@/server/api/contracts";

// ---------------------------------------------------------------------------
// Copy and formatting
// ---------------------------------------------------------------------------

/** Values, deltas and thresholds share the metric's unit. */
const UNIT_FORMAT: Record<GuardrailMetricResult["unit"], { value: (v: number) => string; delta: (v: number) => string }> = {
  share: { value: (v) => formatShare(v, 1), delta: (v) => formatPoints(v) },
  points: { value: (v) => formatFixed(v), delta: (v) => formatSigned(v) },
  stars: { value: (v) => `${formatFixed(v)} stars`, delta: (v) => `${formatSigned(v)} stars` },
  relative: { value: (v) => `${formatSigned(v * 100, 1)}%`, delta: (v) => `${formatSigned(v * 100, 1)}%` },
  per100k: { value: (v) => `${formatFixed(v, 1)} per 100k`, delta: (v) => formatSigned(v, 1) },
};

const DIMENSION_COPY: Record<NonNullable<GuardrailResponse["dimension"]>, string> = {
  app_version: "app version",
  territory: "territory",
  store: "store",
};

/** A threshold magnitude as a signed delta in the harmful direction. */
function harmful(metric: GuardrailMetricResult, magnitude: number): number {
  return metric.harm === "increase" ? Math.abs(magnitude) : -Math.abs(magnitude);
}

const CONFOUNDER_COPY: Record<Confounder["kind"], string> = {
  release: "Release",
  coverage: "Coverage",
  model_change: "Model change",
};

const STATUS_ORDER: GuardrailStatus[] = ["breach", "warn", "ok", "insufficient"];

function armLabels(mode: GuardrailResponse["attributionMode"]): { test: string; control: string } {
  return mode === "dimension" ? { test: "Test arm", control: "Control arm" } : { test: "Test window", control: "Baseline" };
}

function StatusPill({ status }: { status: GuardrailStatus }): ReactElement {
  const copy = GUARDRAIL_STATUS_COPY[status];
  return <Pill tone={copy.tone}>{copy.label}</Pill>;
}

function thresholdText(metric: GuardrailMetricResult): string {
  const format = UNIT_FORMAT[metric.unit].delta;
  const op = metric.harm === "increase" ? "≥" : "≤";
  return `Harm is ${metric.harm === "increase" ? "an increase" : "a decrease"} · warn at Δ ${op} ${format(harmful(metric, metric.thresholds.warn))} · breach at Δ ${op} ${format(harmful(metric, metric.thresholds.breach))} · min n ${metric.thresholds.minN}`;
}

function headline(readout: GuardrailResponse): { title: string; subtitle: string } {
  const counts = STATUS_ORDER.map((status) => ({ status, count: readout.metrics.filter((m) => m.status === status).length }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.count} ${GUARDRAIL_STATUS_COPY[item.status].label.toLowerCase()}`)
    .join(" · ");
  const where = readout.attributionMode === "dimension" ? "test arm" : "test window";

  if (readout.status === "insufficient") {
    return {
      title: "Not enough reviews yet to judge this experiment",
      subtitle: `No review guardrail can be evaluated with confidence. Metrics: ${counts}.`,
    };
  }
  const worst = readout.metrics.find((m) => m.status === "breach") ?? readout.metrics.find((m) => m.status === "warn");
  if (worst && worst.delta !== null) {
    const format = UNIT_FORMAT[worst.unit].delta;
    const p = worst.pValue !== null ? `, ${formatPValue(worst.pValue)}` : "";
    const limit = harmful(worst, worst.status === "breach" ? worst.thresholds.breach : worst.thresholds.warn);
    return {
      title: `${worst.label} ${worst.delta > 0 ? "rose" : "fell"} in the ${where}`,
      subtitle: `${worst.metric} is at ${GUARDRAIL_STATUS_COPY[worst.status].label.toLowerCase()}: ${format(worst.delta)} vs. ${
        readout.attributionMode === "dimension" ? "control" : "baseline"
      }${p}, past the ${format(limit)} ${worst.status} threshold. Metrics: ${counts}.`,
    };
  }
  return {
    title: "All review guardrails are within thresholds",
    subtitle: `Metrics: ${counts}.`,
  };
}

function attribution(readout: GuardrailResponse): { label: string; explanation: string } {
  if (readout.status === "insufficient") {
    return {
      label: "Insufficient for attribution",
      explanation: `Too few attributable reviews to compare ${readout.attributionMode === "dimension" ? "the arms" : "the windows"} yet, so no conclusion is drawn. Values appear once each side reaches the minimum N. Configured mode: ${readout.attributionLabel}.`,
    };
  }
  if (readout.attributionMode === "dimension") {
    const dimension = readout.dimension ? `its ${DIMENSION_COPY[readout.dimension]}` : "a dimension the experiment varies";
    return {
      label: readout.attributionLabel,
      explanation: `Each review is assigned to an arm by ${dimension}, so test and control are compared over the same days. Changes that reach both arms, like a release, largely cancel out.`,
    };
  }
  const baseline = readout.baseline ? ` (${formatShortDate(readout.baseline.start)} – ${formatShortDate(readout.baseline.end)})` : "";
  return {
    label: readout.attributionLabel,
    explanation: `Reviews can't be tied to arms, so the test window is compared with a baseline window${baseline}, adjusted with control apps or territories. Read differences as indicative, not causal.`,
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function MetricCard({ metric, labels }: { metric: GuardrailMetricResult; labels: { test: string; control: string } }): ReactElement {
  const format = UNIT_FORMAT[metric.unit];
  const value = (v: number | null) => (v === null ? <span className="muted">Insufficient</span> : format.value(v));
  return (
    <article className="card metric">
      <div className="metric__head">
        <p className="label">{metric.metric}</p>
        <StatusPill status={metric.status} />
      </div>
      <h3 className="card-title">{metric.label}</h3>
      <dl className="metric__grid">
        <div>
          <dt className="label">{labels.test}</dt>
          <dd className="metric__value">{value(metric.test.value)}</dd>
          <dd className="mono muted">n = {metric.test.n}</dd>
        </div>
        <div>
          <dt className="label">{labels.control}</dt>
          <dd className="metric__value">{value(metric.control.value)}</dd>
          <dd className="mono muted">n = {metric.control.n}</dd>
        </div>
        <div>
          <dt className="label">Δ test − {labels.control === "Baseline" ? "baseline" : "control"}</dt>
          <dd className="metric__value">{metric.delta === null ? <span className="muted">—</span> : format.delta(metric.delta)}</dd>
        </div>
        <div>
          <dt className="label">Significance</dt>
          <dd className="metric__value metric__value--mono">{metric.pValue === null ? <span className="muted">—</span> : formatPValue(metric.pValue)}</dd>
        </div>
      </dl>
      <p className="metric__thresholds mono">{thresholdText(metric)}</p>
      {metric.note && <p className="body muted metric__note">{metric.note}</p>}
    </article>
  );
}

function ArmsList({ readout }: { readout: GuardrailResponse }): ReactElement {
  const dimension = readout.dimension ? DIMENSION_COPY[readout.dimension] : null;
  return (
    <ul className="arms" aria-label="Arms">
      {readout.arms.map((arm) => (
        <li key={arm.key}>
          <Pill tone="neutral">{arm.role === "test" ? "Test" : "Control"}</Pill>
          <span className="arms__key mono">{arm.key}</span>
          <span className="arms__values">
            {arm.values.length
              ? `${dimension ? `${dimension[0].toUpperCase()}${dimension.slice(1)}: ` : ""}${arm.values.join(", ")}`
              : readout.attributionMode === "pre_post"
                ? arm.role === "test"
                  ? "This app, test window vs. baseline"
                  : "Control apps"
                : "No values"}
          </span>
          <span className="arms__dau mono">{arm.dau === null ? "DAU not reported" : `DAU ${formatCount(arm.dau)}`}</span>
        </li>
      ))}
    </ul>
  );
}

function ConfoundersCard({ confounders }: { confounders: Confounder[] }): ReactElement {
  return (
    <article className="card">
      <p className="eyebrow">Confounders · flagged automatically</p>
      <h2 className="card-title">
        {confounders.length
          ? `${confounders.length} ${confounders.length === 1 ? "event" : "events"} in the window could also move reviews`
          : "No releases, coverage gaps or model changes in the window"}
      </h2>
      {confounders.length > 0 && (
        <ul className="confounders">
          {confounders.map((item) => (
            <li key={`${item.kind}-${item.detail}`}>
              <Pill tone="neutral">{CONFOUNDER_COPY[item.kind]}</Pill>
              <span className="body">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function GuardrailReadout({ experimentId, fixture }: { experimentId: string; fixture: boolean }): ReactElement {
  const client = panelClient(fixture);
  const [attempt, setAttempt] = useState(0);
  const readout = useResource(`gr:${experimentId}:${attempt}`, () => client.getGuardrails(experimentId));
  const retry = () => setAttempt((value) => value + 1);
  const data = readout.error ? null : readout.data;

  return (
    <>
      <PanelTopbar context="Experiment readout">
        {fixture && <NavLink href="/apps/demo-app?fixture=1">Evolution panel</NavLink>}
      </PanelTopbar>

      <main className="panel" aria-busy={readout.loading}>
        {readout.error ? (
          <>
            <header className="panel__header">
              <div>
                <p className="eyebrow">Reviews guardrail · {experimentId}</p>
                <h1 className="page-title">The guardrail readout could not be loaded</h1>
              </div>
            </header>
            <RequestProblem error={readout.error} onRetry={retry} />
          </>
        ) : !data ? (
          <LoadingCard eyebrow="Working" title="Loading the guardrail readout…" />
        ) : (
          <ReadoutBody readout={data} fixture={fixture} />
        )}
      </main>
    </>
  );
}

function ReadoutBody({ readout, fixture }: { readout: GuardrailResponse; fixture: boolean }): ReactElement {
  const summary = headline(readout);
  const mode = attribution(readout);
  const labels = armLabels(readout.attributionMode);
  const g1 = readout.metrics.find((metric) => metric.metric === "G1");

  return (
    <>
      <header className="panel__header">
        <div>
          <p className="eyebrow">
            Reviews guardrail · {readout.name} · {formatShortDate(readout.window.start)} – {formatShortDate(readout.window.end)}
          </p>
          <div className="title-row">
            <h1 className="page-title">{summary.title}</h1>
            <span className="title-row__status">
              <span className="visually-hidden">Overall status: </span>
              <StatusPill status={readout.status} />
            </span>
          </div>
          <p className="subtitle">{summary.subtitle}</p>
          <p className="panel__ids mono">
            <span>Loomit experiment {readout.loomitExperimentId}</span>
          </p>
        </div>
        {fixture && <SampleTag />}
      </header>

      <section className="card card--chip attribution" aria-label="Attribution mode">
        <div className="attribution__mode">
          <span className="label">Attribution</span>
          <strong className="attribution__label">{mode.label}</strong>
        </div>
        <div className="attribution__body">
          <p className="body">{mode.explanation}</p>
          {readout.arms.length > 0 && <ArmsList readout={readout} />}
        </div>
      </section>

      <TestControlChart
        readout={readout}
        eyebrow="Test vs. control · ad complaints · daily share of negative reviews"
        title={
          g1?.delta != null
            ? `Ad complaints ${g1.delta > 0 ? "ran higher" : g1.delta < 0 ? "ran lower" : "matched control"} in the ${
                readout.attributionMode === "dimension" ? "test arm" : "test window"
              } after the start`
            : "Ad complaints in test and control"
        }
        testLabel={readout.attributionMode === "dimension" ? "Test" : "Test window"}
        controlLabel={readout.attributionMode === "dimension" ? "Control" : "Controls"}
      />

      <section aria-label="Guardrail metrics" className="metric-grid">
        {readout.metrics.map((metric) => (
          <MetricCard key={metric.metric} metric={metric} labels={labels} />
        ))}
      </section>

      <ConfoundersCard confounders={readout.confounders} />

      <footer className="card card--chip guardrail-footer">
        <p className="body">
          Reviews are a UX guardrail. Read them next to the revenue, ARPDAU, IMPDAU and request-volume guardrails in the Loomit
          readout: the decision is net benefit on revenue, ARPDAU and IMPDAU, subject to request-volume and UX guardrails.
          Reviews add to those signals; they don&apos;t replace them.
        </p>
        <p className="mono muted guardrail-footer__meta">
          {readout.evaluatedAt ? `Evaluated ${formatDateTime(readout.evaluatedAt)}` : "Not evaluated yet"}
          {readout.modelVersion && ` · classifier ${readout.modelVersion}`}
        </p>
      </footer>
    </>
  );
}
