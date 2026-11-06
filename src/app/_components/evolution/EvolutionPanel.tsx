"use client";

import { type ReactElement, useId, useState } from "react";

import {
  AccessTokenGate,
  LoadingCard,
  NavLink,
  PanelTopbar,
  RequestProblem,
  SampleTag,
  Segmented,
} from "@/app/_components/ui";
import { isUnauthorized, panelClient, type RangeParams } from "@/app/_lib/api-client";
import { STORE_COPY } from "@/app/_lib/copy";
import { addDays } from "@/app/_lib/dates";
import { useResource } from "@/app/_lib/use-resource";
import type { Store } from "@/lib/types";

import { AdSubreasonsCard, CoverageCard, KpiRow, ReasonsCard, SentimentChartCard, VersionsCard } from "./cards";
import { ReviewsDrilldown } from "./ReviewsDrilldown";
import { evolutionHeadline } from "./summary";

type RangeDays = "30" | "90" | "180";
type StoreFilter = "all" | Store;

interface Filters {
  days: RangeDays;
  granularity: "day" | "week";
  store: StoreFilter;
  territory: string;
  appVersion: string;
}

const RANGE_OPTIONS = [
  { value: "30" as const, label: "30 days" },
  { value: "90" as const, label: "90 days" },
  { value: "180" as const, label: "180 days" },
];
const GRANULARITY_OPTIONS = [
  { value: "day" as const, label: "Day" },
  { value: "week" as const, label: "Week" },
];
const STORE_OPTIONS = [
  { value: "all" as const, label: "All stores" },
  { value: "google_play" as const, label: "Google Play" },
  { value: "apple_app_store" as const, label: "App Store" },
];

/** A select fed by the API's `dimensions`; the current choice stays listed even if the data narrows. */
function DimensionFilter({
  label,
  allLabel,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string;
  options: string[];
  format?: (value: string) => string;
  onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  const choices = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className="filter filter--select">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel}</option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {format ? format(choice) : choice}
          </option>
        ))}
      </select>
    </div>
  );
}

export function EvolutionPanel({
  appId,
  fixture,
  today,
}: {
  appId: string;
  fixture: boolean;
  today: string;
}): ReactElement {
  const client = panelClient(fixture);
  const [filters, setFilters] = useState<Filters>({
    days: "90",
    granularity: "day",
    store: "all",
    territory: "",
    appVersion: "",
  });
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((value) => value + 1);

  const range: RangeParams = {
    from: addDays(today, -(Number(filters.days) - 1)),
    to: today,
    store: filters.store === "all" ? undefined : filters.store,
    territory: filters.territory || undefined,
    appVersion: filters.appVersion || undefined,
  };
  const rangeKey = JSON.stringify([appId, range, attempt]);

  const app = useResource(`app:${appId}:${attempt}`, () => client.getApp(appId));
  const timeseries = useResource(`ts:${rangeKey}:${filters.granularity}`, () =>
    client.getTimeseries(appId, { ...range, granularity: filters.granularity }),
  );
  const reasons = useResource(`rs:${rangeKey}`, () => client.getReasons(appId, { ...range, group: "negative" }));
  const versions = useResource(`vs:${rangeKey}`, () => client.getVersions(appId, range));
  const coverage = useResource(`cv:${rangeKey}`, () => client.getCoverage(appId, range));

  const unauthorized = [app, timeseries, reasons, versions, coverage].some((resource) => isUnauthorized(resource.error));
  const minN = timeseries.data?.minN ?? versions.data?.minN ?? 20;
  const totals = timeseries.data?.totals ?? null;
  const headline =
    totals && (versions.data || versions.error) ? evolutionHeadline(versions.data?.versions ?? [], totals, minN) : null;
  const pendingTitle = unauthorized
    ? "Sign in to see this app"
    : timeseries.error
      ? "Reviews could not be loaded"
      : "Loading reviews…";
  const busy = timeseries.loading || reasons.loading || versions.loading || coverage.loading;
  const dimensions = timeseries.data?.dimensions ?? { territories: [], appVersions: [] };

  const scope = [
    `last ${filters.days} days`,
    filters.store !== "all" ? STORE_COPY[filters.store] : null,
    filters.territory || null,
    filters.appVersion ? `v${filters.appVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const fixtureQuery = fixture ? "?fixture=1" : "";
  const connectHref = `/connect?appId=${encodeURIComponent(appId)}${fixture ? "&fixture=1" : ""}`;

  return (
    <>
      <PanelTopbar context={app.data ? app.data.name : "Evolution panel"}>
        {fixture && <NavLink href={`/experiments/demo-exp${fixtureQuery}`}>Guardrail readout</NavLink>}
        <NavLink href={connectHref}>Connections</NavLink>
      </PanelTopbar>

      <main className="panel" aria-busy={busy}>
        <header className="panel__header">
          <div>
            <p className="eyebrow">Reviews · {scope}</p>
            <h1 className="page-title">{headline?.title ?? pendingTitle}</h1>
            {headline && <p className="subtitle">{headline.subtitle}</p>}
            {app.data && (
              <p className="panel__ids mono">
                {app.data.androidPackage && <span>{app.data.androidPackage}</span>}
                {app.data.appleAppId && <span>Apple ID {app.data.appleAppId}</span>}
              </p>
            )}
          </div>
          {fixture && <SampleTag />}
        </header>

        {unauthorized ? (
          <AccessTokenGate onSaved={retry} />
        ) : (
          <>
            <section className="card card--chip filters" aria-label="Filters">
              <Segmented label="Range" options={RANGE_OPTIONS} value={filters.days} onChange={(days) => setFilters((f) => ({ ...f, days }))} />
              <Segmented
                label="Granularity"
                options={GRANULARITY_OPTIONS}
                value={filters.granularity}
                onChange={(granularity) => setFilters((f) => ({ ...f, granularity }))}
              />
              <Segmented label="Store" options={STORE_OPTIONS} value={filters.store} onChange={(store) => setFilters((f) => ({ ...f, store }))} />
              <DimensionFilter
                label="Territory"
                allLabel="All territories"
                value={filters.territory}
                options={dimensions.territories}
                onChange={(territory) => setFilters((f) => ({ ...f, territory }))}
              />
              <DimensionFilter
                label="App version"
                allLabel="All versions"
                value={filters.appVersion}
                options={dimensions.appVersions}
                format={(version) => `v${version}`}
                onChange={(appVersion) => setFilters((f) => ({ ...f, appVersion }))}
              />
            </section>

            {timeseries.error ? (
              <RequestProblem error={timeseries.error} onRetry={retry} />
            ) : timeseries.data && totals ? (
              <div className={timeseries.stale ? "stack is-stale" : "stack"}>
                <KpiRow totals={totals} minN={minN} />
                <SentimentChartCard data={timeseries.data} />
              </div>
            ) : (
              <LoadingCard eyebrow="Working" title="Loading the review timeline…" />
            )}

            <div className="split">
              {reasons.error ? (
                <RequestProblem error={reasons.error} onRetry={retry} />
              ) : reasons.data ? (
                <>
                  <div className={reasons.stale ? "is-stale" : undefined}>
                    <ReasonsCard data={reasons.data} />
                  </div>
                  <div className={reasons.stale ? "is-stale" : undefined}>
                    <AdSubreasonsCard data={reasons.data} />
                  </div>
                </>
              ) : (
                <LoadingCard eyebrow="Working" title="Loading reasons…" />
              )}
            </div>

            <div className="split split--wide-left">
              {versions.error ? (
                <RequestProblem error={versions.error} onRetry={retry} />
              ) : versions.data ? (
                <div className={versions.stale ? "is-stale" : undefined}>
                  <VersionsCard data={versions.data} />
                </div>
              ) : (
                <LoadingCard eyebrow="Working" title="Loading versions…" />
              )}
              {coverage.error ? (
                <RequestProblem error={coverage.error} onRetry={retry} />
              ) : coverage.data ? (
                <div className={coverage.stale ? "is-stale" : undefined}>
                  <CoverageCard data={coverage.data} />
                </div>
              ) : (
                <LoadingCard eyebrow="Working" title="Loading coverage…" />
              )}
            </div>

            <ReviewsDrilldown appId={appId} client={client} range={range} attempt={attempt} onRetry={retry} />

            <footer className="results__footer mono">
              <span>
                {timeseries.data?.modelVersion ? `Classifier ${timeseries.data.modelVersion}` : "Classifier version not reported"} · min n = {minN}
              </span>
              <span>Official store APIs and exports only · dates in UTC</span>
            </footer>
          </>
        )}
      </main>
    </>
  );
}
