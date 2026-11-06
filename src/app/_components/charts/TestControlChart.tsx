import type { ReactElement } from "react";

import type { GuardrailResponse } from "@/server/api/contracts";
import { formatShortDate } from "@/app/_lib/dates";
import { formatPoints, formatShare } from "@/app/_lib/numbers";

import { LineChart } from "./LineChart";

/**
 * Test vs. control chart for the guardrail readout, after the design system's
 * LineCalloutSlide: test arm solid chart-blue, control dashed chart-grey, a
 * TEST START marker at the window start, a gap bracket on the latest day with
 * both values, and a brand callout card with that gap.
 */

function niceMax(value: number): number {
  const step = value > 0.3 ? 0.1 : 0.05;
  return Math.max(step * 2, Math.ceil((value + step / 2) / step) * step);
}

/** A day's share, or null (a gap) when withheld or when no negative reviews were behind it. */
function shareOf(value: number | null, n: number): number | null {
  return n > 0 ? value : null;
}

export function latestGap(
  series: GuardrailResponse["series"],
): { day: string; test: number; control: number; delta: number; testN: number; controlN: number } | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const { day, testN, controlN } = series[index];
    const test = shareOf(series[index].test, testN);
    const control = shareOf(series[index].control, controlN);
    if (test !== null && control !== null) return { day, test, control, delta: test - control, testN, controlN };
  }
  return null;
}

export function TestControlChart({
  readout,
  eyebrow,
  title,
  testLabel,
  controlLabel,
}: {
  readout: GuardrailResponse;
  eyebrow: string;
  title: string;
  testLabel: string;
  controlLabel: string;
}): ReactElement {
  const { series } = readout;
  // An insufficient readout gets no headline number, even if one day happens to have both values.
  const gap = readout.status === "insufficient" ? null : latestGap(series);
  const max = niceMax(
    series.reduce((acc, point) => Math.max(acc, point.test ?? 0, point.control ?? 0), 0),
  );
  const step = max > 0.3 ? 0.1 : 0.05;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, index) => Number((index * step).toFixed(2)));
  const from = series[0]?.day ?? readout.window.start;
  const to = series.at(-1)?.day ?? readout.window.end;
  const insideWindow = series.filter((point) => point.day >= readout.window.start);
  const missingTest = insideWindow.filter((point) => shareOf(point.test, point.testN) === null).length;
  const releaseMarkers = readout.confounders
    .filter((item) => item.kind === "release" && item.day)
    .map((item) => ({ x: item.day ?? "", label: item.appVersion ? `v${item.appVersion}` : "Release" }));

  const ariaLabel = gap
    ? `Daily ad-complaint share of negative reviews, ${testLabel.toLowerCase()} vs. ${controlLabel.toLowerCase()}, ${formatShortDate(from)} to ${formatShortDate(to)}. The test started on ${formatShortDate(readout.window.start)}. On ${formatShortDate(gap.day)} the test was ${formatShare(gap.test, 1)} (n = ${gap.testN}) and control ${formatShare(gap.control, 1)} (n = ${gap.controlN}), a gap of ${formatPoints(gap.delta)}.${releaseMarkers.length ? ` Releases in the window: ${releaseMarkers.map((m) => `${m.label} on ${formatShortDate(m.x)}`).join(", ")}.` : ""}`
    : `Daily ad-complaint share of negative reviews, test vs. control. Not enough reviews to report a gap.`;

  return (
    <div className="callout-layout">
      <article className="card">
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="card-title">{title}</h2>
        <div className="chart-block">
          <LineChart
            ariaLabel={ariaLabel}
            from={from}
            to={to}
            series={[
              {
                id: "control",
                label: controlLabel,
                variant: "control",
                endLabel: true,
                points: series.map((point) => ({ x: point.day, y: shareOf(point.control, point.controlN) })),
              },
              {
                id: "test",
                label: testLabel,
                variant: "main",
                endLabel: true,
                points: series.map((point) => ({ x: point.day, y: shareOf(point.test, point.testN) })),
              },
            ]}
            yDomain={[0, max]}
            yTicks={ticks}
            formatY={(value) => formatShare(value)}
            formatValue={(value) => formatShare(value)}
            markers={[{ x: readout.window.start, label: "TEST START" }, ...releaseMarkers]}
            bracket={gap ? { x: gap.day, from: gap.control, to: gap.test, label: formatPoints(gap.delta, 0) } : undefined}
            height={240}
            table={{
              caption: "Daily ad-complaint share of negative reviews by arm",
              columns: ["Day", testLabel, `${testLabel} n`, controlLabel, `${controlLabel} n`],
              rows: series.map((point) => {
                const test = shareOf(point.test, point.testN);
                const control = shareOf(point.control, point.controlN);
                return [
                  point.day,
                  test === null ? "Insufficient" : formatShare(test, 1),
                  String(point.testN),
                  control === null ? "Insufficient" : formatShare(control, 1),
                  String(point.controlN),
                ];
              }),
            }}
          />
        </div>
        <ul className="chart-legend">
          <li>
            <span className="swatch-line swatch-line--main" aria-hidden="true" />
            {testLabel}
          </li>
          <li>
            <span className="swatch-line swatch-line--control" aria-hidden="true" />
            {controlLabel}
          </li>
          <li>
            <span className="swatch-marker" aria-hidden="true">TEST START</span>
            {formatShortDate(readout.window.start)}
          </li>
          {releaseMarkers.length > 0 && (
            <li>
              <span className="swatch-marker" aria-hidden="true">v</span>
              Release inside the window
            </li>
          )}
          {missingTest > 0 && (
            <li>
              <span className="swatch-gap" aria-hidden="true" />
              Gap: fewer than the minimum reviews that day ({missingTest} {missingTest === 1 ? "day" : "days"} in the test arm)
            </li>
          )}
        </ul>
      </article>

      <aside className="card card--brand callout" aria-label="Latest gap">
        <p className="label">{gap ? `Latest gap · ${formatShortDate(gap.day)}` : "Latest gap"}</p>
        {gap ? (
          <>
            <p className="kpi__value callout__value">{formatPoints(gap.delta)}</p>
            <p className="kpi__note">
              {testLabel} {formatShare(gap.test, 1)} (n = {gap.testN}) vs. {controlLabel.toLowerCase()} {formatShare(gap.control, 1)} (n ={" "}
              {gap.controlN}) of negative reviews mention ads.
            </p>
          </>
        ) : (
          <>
            <p className="kpi__value kpi__value--na">Insufficient data</p>
            <p className="kpi__note">
              {readout.status === "insufficient"
                ? "The arms don't have enough reviews yet to compare, so no gap is reported."
                : "No day in the window has enough reviews in both arms yet."}
            </p>
          </>
        )}
        <p className="callout__foot mono">One day is noisy; the G1 card below covers the whole window.</p>
      </aside>
    </div>
  );
}
