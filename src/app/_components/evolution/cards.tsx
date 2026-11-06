import type { ReactElement } from "react";

import { sentimentWord } from "@/app/format";
import { LineChart, type ChartShade } from "@/app/_components/charts/LineChart";
import { RankingBars } from "@/app/_components/RankingBars";
import { KpiValue, Pill } from "@/app/_components/ui";
import { STORE_COPY } from "@/app/_lib/copy";
import { formatShortDate } from "@/app/_lib/dates";
import { formatCount, formatFixed, formatShare, formatSigned } from "@/app/_lib/numbers";
import type {
  CoverageResponse,
  ReasonsResponse,
  TimeseriesResponse,
  TimeseriesTotals,
  VersionsResponse,
} from "@/server/api/contracts";

import { bucketGeometry, sentimentDomain, sortedVersions } from "./summary";

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

export function KpiRow({ totals, minN }: { totals: TimeseriesTotals; minN: number }): ReactElement {
  const enough = totals.n >= minN;
  const shortfall = `Fewer than ${minN} reviews in this selection`;
  const n = `n = ${formatCount(totals.n)}`;
  return (
    <div className="kpi-row">
      <article className="card card--brand kpi">
        <p className="label">Average sentiment</p>
        <KpiValue value={totals.averageSentiment === null ? null : formatFixed(totals.averageSentiment)} unit="/ 4" />
        <p className="kpi__note">
          {totals.averageSentiment === null
            ? shortfall
            : `${sentimentWord(totals.averageSentiment)}${
                totals.sentimentCi ? ` · 95% CI ${formatFixed(totals.sentimentCi[0])}–${formatFixed(totals.sentimentCi[1])}` : ""
              }`}
        </p>
        <p className="kpi__note mono-note">{n} · whole range</p>
      </article>

      <article className="card kpi">
        <p className="label">Written-review rating</p>
        <KpiValue value={totals.averageRating === null ? null : formatFixed(totals.averageRating)} unit="/ 5" />
        <p className="kpi__note">{totals.averageRating === null ? shortfall : "Excludes star-only ratings"}</p>
        <p className="kpi__note mono-note">{n}</p>
      </article>

      <article className="card kpi">
        <p className="label">Negative reviews</p>
        <KpiValue value={totals.negativeShare === null ? null : formatShare(totals.negativeShare)} />
        <p className="kpi__note">{totals.negativeShare === null ? shortfall : "Share of written reviews"}</p>
        <p className="kpi__note mono-note">{n}</p>
      </article>

      <article className="card kpi">
        <p className="label">Ad complaints</p>
        <KpiValue value={totals.adsNegativeShare === null ? null : formatShare(totals.adsNegativeShare)} />
        <p className="kpi__note">
          {totals.adsNegativeShare !== null
            ? "Share of negative reviews citing ads"
            : enough
              ? "Too few negative reviews to compute"
              : shortfall}
        </p>
        <p className="kpi__note mono-note">{n}</p>
      </article>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sentiment over time
// ---------------------------------------------------------------------------

export function SentimentChartCard({ data }: { data: TimeseriesResponse }): ReactElement {
  const { points, granularity, minN } = data;
  const unit = granularity === "day" ? "day" : "week";
  const { domain, ticks } = sentimentDomain(points);
  const geometry = points.map((point) => ({ point, ...bucketGeometry(point.period, granularity, data.from, data.to) }));
  const shades: ChartShade[] = geometry
    .filter(({ point }) => point.coverage !== "complete")
    .map(({ point, center, width }) => ({ x: center, widthDays: width, kind: point.coverage === "partial" ? "partial" : "unknown" }));
  const gaps = points.filter((point) => point.averageSentiment === null).length;
  const partial = points.filter((point) => point.coverage === "partial").length;
  const unknown = points.filter((point) => point.coverage === "unknown").length;
  const latest = points.findLast((point) => point.averageSentiment !== null);

  const title = latest?.averageSentiment != null
    ? `Latest ${unit} with enough reviews reads ${sentimentWord(latest.averageSentiment)} at ${formatFixed(latest.averageSentiment)}`
    : `No ${unit} in this range has ${minN} or more reviews`;
  const ariaLabel = `Average sentiment by ${unit}, ${formatShortDate(data.from)} to ${formatShortDate(data.to)}, on a 0 to 4 scale. ${
    latest?.averageSentiment != null ? `Latest value ${formatFixed(latest.averageSentiment)} for ${formatShortDate(latest.period)}.` : ""
  } ${data.releases.length ? `Releases: ${data.releases.map((r) => `v${r.appVersion} on ${formatShortDate(r.firstSeen)}`).join(", ")}.` : ""} ${gaps} ${unit}s have fewer than ${minN} reviews and are shown as gaps.`;

  return (
    <article className="card">
      <p className="eyebrow">
        Average sentiment · by {unit} · 0–4 scale · n ≥ {minN} per point
      </p>
      <h2 className="card-title">{title}</h2>
      <div className="chart-block">
        <LineChart
          ariaLabel={ariaLabel}
          from={data.from}
          to={data.to}
          series={[
            {
              id: "sentiment",
              label: "Average sentiment",
              variant: "main",
              endLabel: true,
              points: geometry.map(({ point, center }) => ({ x: center, y: point.averageSentiment, band: point.sentimentCi })),
            },
          ]}
          yDomain={domain}
          yTicks={ticks}
          formatY={(value) => value.toFixed(1)}
          formatValue={(value) => formatFixed(value)}
          markers={data.releases.map((release) => ({ x: release.firstSeen, label: `v${release.appVersion}` }))}
          shades={shades}
          table={{
            caption: `Average sentiment by ${unit}`,
            columns: [granularity === "day" ? "Day" : "Week of", "Reviews", "Average sentiment", "95% CI", "Coverage"],
            rows: points.map((point) => [
              point.period,
              String(point.n),
              point.averageSentiment === null ? "Insufficient" : formatFixed(point.averageSentiment),
              point.sentimentCi ? `${formatFixed(point.sentimentCi[0])}–${formatFixed(point.sentimentCi[1])}` : "—",
              point.coverage,
            ]),
          }}
        />
      </div>
      <ul className="chart-legend">
        <li>
          <span className="swatch-line swatch-line--main" aria-hidden="true" />
          Average sentiment
        </li>
        <li>
          <span className="swatch-band" aria-hidden="true" />
          95% interval
        </li>
        {data.releases.length > 0 && (
          <li>
            <span className="swatch-marker" aria-hidden="true">v</span>
            Release first seen
          </li>
        )}
        {gaps > 0 && (
          <li>
            <span className="swatch-gap" aria-hidden="true" />
            Gap: under {minN} reviews ({gaps} {gaps === 1 ? unit : `${unit}s`})
          </li>
        )}
        {partial > 0 && (
          <li>
            <span className="swatch-shade swatch-shade--partial" aria-hidden="true" />
            Partial coverage ({partial})
          </li>
        )}
        {unknown > 0 && (
          <li>
            <span className="swatch-shade swatch-shade--unknown" aria-hidden="true" />
            Unknown coverage ({unknown})
          </li>
        )}
      </ul>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

export function ReasonsCard({ data }: { data: ReasonsResponse }): ReactElement {
  const { minN } = data;
  const top = data.reasons[0];
  const enough = data.total >= minN;
  return (
    <article className="card">
      <p className="eyebrow">Reasons · negative reviews · n = {formatCount(data.total)}</p>
      <h2 className="card-title">
        {!enough
          ? `Fewer than ${minN} negative reviews in this range`
          : top
            ? `Top complaint: ${top.label.toLowerCase()} (${formatShare(top.share)})`
            : "No negative reviews in this range"}
      </h2>
      <div className="card-body">
        {enough ? (
          <RankingBars
            items={data.reasons.slice(0, 8).map((item) => ({ key: item.reason, label: item.label, count: item.count, share: item.share }))}
            emptyCopy="No negative reviews."
          />
        ) : (
          <p className="body muted">Shares appear once there are at least {minN} negative reviews.</p>
        )}
      </div>
    </article>
  );
}

export function AdSubreasonsCard({ data }: { data: ReasonsResponse }): ReactElement {
  const { minN } = data;
  const total = data.adSubreasons.reduce((sum, item) => sum + item.count, 0);
  const top = data.adSubreasons[0];
  const enough = total >= minN;
  return (
    <article className="card">
      <p className="eyebrow">Ad complaints by type · n = {formatCount(total)}</p>
      <h2 className="card-title">
        {!enough
          ? `Fewer than ${minN} ad complaints in this range`
          : `Most ad complaints: ${top.label.toLowerCase()} (${formatShare(top.share)})`}
      </h2>
      <div className="card-body">
        {enough ? (
          <RankingBars
            items={data.adSubreasons.map((item) => ({ key: item.subreason, label: item.label, count: item.count, share: item.share }))}
            emptyCopy="No ad complaints."
          />
        ) : (
          <p className="body muted">The breakdown appears once there are at least {minN} ad complaints.</p>
        )}
        <p className="fineprint">These map to levers in Loomit: frequency caps, formats, rewarded delivery and ad quality.</p>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export function VersionsCard({ data }: { data: VersionsResponse }): ReactElement {
  const rows = sortedVersions(data.versions).reverse();
  const insufficient = rows.filter((row) => row.status === "insufficient").length;
  return (
    <article className="card">
      <p className="eyebrow">By app version · n ≥ {data.minN} to compare</p>
      <h2 className="card-title">
        {rows.length
          ? `${rows.length} ${rows.length === 1 ? "version" : "versions"} with reviews in this range${insufficient ? `, ${insufficient} without enough data` : ""}`
          : "No versions with reviews in this range"}
      </h2>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table table--grid">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">First seen</th>
                <th scope="col" className="num">Reviews</th>
                <th scope="col" className="num">Sentiment</th>
                <th scope="col">Vs. previous</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.appVersion}>
                  <td className="mono version-cell">v{row.appVersion}</td>
                  <td data-label="First seen">{formatShortDate(row.firstSeen)}</td>
                  <td data-label="Reviews" className="num mono">
                    {formatCount(row.n)}
                  </td>
                  <td data-label="Sentiment" className="num mono">
                    {row.averageSentiment === null ? <span className="muted">Insufficient</span> : formatFixed(row.averageSentiment)}
                  </td>
                  <td data-label="Vs. previous">
                    {row.deltaSentiment === null ? (
                      <span className="muted mono">—</span>
                    ) : (
                      <Pill tone={row.deltaSentiment > 0 ? "positive" : row.deltaSentiment < 0 ? "negative" : "neutral"}>
                        {formatSigned(row.deltaSentiment)}
                      </Pill>
                    )}
                  </td>
                  <td data-label="Status">
                    <Pill tone="neutral">{row.status === "ok" ? "Enough data" : "Insufficient"}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function listDays(days: string[]): string {
  const shown = days.slice(0, 4).map(formatShortDate).join(", ");
  return days.length > 4 ? `${shown} +${days.length - 4} more` : shown;
}

export function CoverageCard({ data }: { data: CoverageResponse }): ReactElement {
  const incomplete = data.summary.filter((item) => item.partial + item.unknown > 0);
  return (
    <article className="card">
      <p className="eyebrow">Data coverage · by store and day</p>
      <h2 className="card-title">
        {data.summary.length === 0
          ? "No connected store in this range"
          : incomplete.length === 0
            ? "Every day in range is complete"
            : `${incomplete.map((item) => STORE_COPY[item.store]).join(" and ")} ${incomplete.length === 1 ? "has" : "have"} incomplete days`}
      </h2>
      <ul className="coverage">
        {data.summary.map((item) => {
          const total = item.complete + item.partial + item.unknown;
          const own = data.days.filter((day) => day.store === item.store);
          const partialDays = own.filter((day) => day.status === "partial").map((day) => day.day);
          const unknownDays = own.filter((day) => day.status === "unknown").map((day) => day.day);
          const complete = item.partial + item.unknown === 0;
          return (
            <li key={item.store}>
              <div className="coverage__row">
                <span className="coverage__name">{STORE_COPY[item.store]}</span>
                <Pill tone={complete ? "positive" : "neutral"}>{complete ? "Complete" : "Incomplete"}</Pill>
              </div>
              <div className="coverage-bar" role="img" aria-label={`${item.complete} complete, ${item.partial} partial, ${item.unknown} unknown days`}>
                <span className="coverage-bar__seg coverage-bar__seg--complete" style={{ flexGrow: item.complete }} />
                <span className="coverage-bar__seg coverage-bar__seg--partial" style={{ flexGrow: item.partial }} />
                <span className="coverage-bar__seg coverage-bar__seg--unknown" style={{ flexGrow: item.unknown }} />
              </div>
              <p className="coverage__meta mono">
                {item.complete}/{total} complete · {item.partial} partial · {item.unknown} unknown
              </p>
              {partialDays.length > 0 && <p className="body muted">Partial: {listDays(partialDays)}</p>}
              {unknownDays.length > 0 && <p className="body muted">Unknown: {listDays(unknownDays)}</p>}
            </li>
          );
        })}
      </ul>
      <p className="fineprint">
        Partial days are missing some reviews; unknown days have not been reported by the store yet. Both are shaded in the
        chart.
      </p>
    </article>
  );
}
