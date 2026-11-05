"use client";

import Image from "next/image";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  useEffect,
  useState,
} from "react";

import {
  CLASSIFIER_COPY,
  COVERAGE_COPY,
  ESTIMATOR_COPY,
  MEMBERSHIP_COPY,
  SENTIMENT_COPY,
  fileToBase64,
  formatDate,
  formatPercent,
  formatRange,
  headline,
  sentimentTone,
  sentimentWord,
} from "@/app/format";
import {
  REASON_DEFINITIONS,
  type AnalysisResult,
  type AnalyzeInput,
  type Platform,
  type ReasonSummary,
  type SourceMode,
} from "@/lib/types";

interface FormState {
  appName: string;
  sourceMode: SourceMode;
  startDate: string;
  endDate: string;
  lastN: number;
  androidPackage: string;
  appleAppId: string;
}

interface CsvSelection {
  file: File;
  platform: Platform;
}

class AnalysisRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TOKEN_STORAGE_KEY = "reviewsignal.accessToken";

function readStoredToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the token stays in memory.
  }
}

async function requestAnalysis(
  state: FormState,
  selectedFiles: CsvSelection[],
  accessToken: string,
): Promise<AnalysisResult> {
  const csvFiles =
    state.sourceMode === "csv"
      ? await Promise.all(
          selectedFiles.map(async ({ file, platform }) => ({
            name: file.name,
            platform,
            encoding: "base64" as const,
            content: await fileToBase64(file),
          })),
        )
      : undefined;
  const payload: AnalyzeInput = {
    ...state,
    androidPackage: state.androidPackage.trim() || undefined,
    appleAppId: state.appleAppId.trim() || undefined,
    csvFiles,
  };
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    let message = "The analysis could not be completed.";
    if (typeof body === "object" && body !== null) {
      if ("error" in body && typeof body.error === "string") message = body.error;
      if (
        "details" in body &&
        Array.isArray(body.details) &&
        body.details.every((detail) => typeof detail === "string")
      ) {
        message = `${message} ${body.details.join(" ")}`;
      }
    }
    throw new AnalysisRequestError(message, response.status);
  }

  return body as AnalysisResult;
}

function dateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultForm(): FormState {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return {
    appName: "Acme Mobile",
    sourceMode: "demo",
    startDate: dateInputValue(start),
    endDate: dateInputValue(end),
    lastN: 10,
    androidPackage: "",
    appleAppId: "",
  };
}

function Pill({
  tone,
  children,
}: {
  tone: "positive" | "negative" | "neutral";
  children: React.ReactNode;
}): ReactElement {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

function RankingBars({
  items,
  emptyCopy,
}: {
  items: ReasonSummary[];
  emptyCopy: string;
}): ReactElement {
  if (!items.length) return <p className="muted">{emptyCopy}</p>;

  return (
    <ol className="ranking">
      {items.map((item, index) => (
        <li key={item.reason}>
          <div className="ranking__label">
            <span>{item.label}</span>
            <span className="mono">
              {item.count} · {formatPercent(item.share)}
            </span>
          </div>
          <div className="ranking__track">
            <span
              className={index === 0 ? "ranking__bar is-top" : "ranking__bar"}
              style={{ width: formatPercent(item.share) }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

const SOURCE_OPTIONS: Array<{ mode: SourceMode; title: string; copy: string }> = [
  { mode: "demo", title: "Demo dataset", copy: "Synthetic reviews" },
  { mode: "live_api", title: "Store APIs", copy: "Owned apps only" },
  { mode: "csv", title: "Store exports", copy: "Historical CSV" },
];

export default function Home(): ReactElement {
  const [form, setForm] = useState<FormState>(defaultForm);
  const [csvFiles, setCsvFiles] = useState<CsvSelection[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [needsToken, setNeedsToken] = useState(false);

  function handleFailure(failure: unknown): void {
    if (failure instanceof AnalysisRequestError && failure.status === 401) {
      setNeedsToken(true);
    }
    setError(
      failure instanceof Error ? failure.message : "The analysis could not be completed.",
    );
  }

  async function runAnalysis(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setResult(await requestAnalysis(form, csvFiles, accessToken));
      storeToken(accessToken);
    } catch (failure) {
      // Never leave a previous result on screen under a new request's error.
      setResult(null);
      handleFailure(failure);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    const token = readStoredToken();
    void requestAnalysis(defaultForm(), [], token)
      .then((initial) => {
        if (active) setResult(initial);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (failure instanceof AnalysisRequestError && failure.status === 401) {
          setNeedsToken(true);
        }
        setError(
          failure instanceof Error ? failure.message : "The demo analysis could not be loaded.",
        );
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        if (token) {
          setAccessToken(token);
          setNeedsToken(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  function updateField<Key extends keyof FormState>(key: Key, value: FormState[Key]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void runAnalysis();
  }

  function addCsvFile(event: ChangeEvent<HTMLInputElement>, platform: Platform): void {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvFiles((current) => [
      ...current.filter((selection) => selection.platform !== platform),
      { file, platform },
    ]);
  }

  const summary = result ? headline(result) : null;
  const isSample = result?.sourceMode === "demo";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <Image
            src="/brand/loomit-logo-teal.png"
            alt="loomit"
            width={84}
            height={22}
            priority
          />
          <span className="topbar__divider" aria-hidden="true" />
          <span className="topbar__product">ReviewSignal</span>
          <span className="eyebrow topbar__eyebrow">Plugin · review intelligence</span>
        </div>
        <div className="topbar__status">
          <span className="status">
            <span className={`dot ${result ? "is-on" : ""}`} aria-hidden="true" />
            {result
              ? `Classifier: ${CLASSIFIER_COPY[result.analysisMode]}`
              : "Classifier: not run yet"}
          </span>
        </div>
      </header>

      <main className="workspace">
        <aside className="card control-panel" aria-label="Analysis settings">
          <p className="eyebrow">New analysis</p>
          <h1 className="panel-title">Analyze app reviews</h1>
          <p className="body muted">
            Combine written reviews from Google Play and the App Store, then
            classify sentiment and the reason behind each one.
          </p>

          <form onSubmit={handleSubmit} className="form">
            <div className="field">
              <label className="label" htmlFor="appName">
                Analysis name
              </label>
              <input
                id="appName"
                value={form.appName}
                onChange={(event) => updateField("appName", event.target.value)}
                placeholder="My mobile app"
                required
              />
            </div>

            <fieldset className="field">
              <legend className="label">Data source</legend>
              <div className="segmented" role="radiogroup" aria-label="Data source">
                {SOURCE_OPTIONS.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    role="radio"
                    aria-checked={form.sourceMode === option.mode}
                    className={
                      form.sourceMode === option.mode
                        ? "segmented__option is-active"
                        : "segmented__option"
                    }
                    onClick={() => updateField("sourceMode", option.mode)}
                  >
                    <strong>{option.title}</strong>
                    <small>{option.copy}</small>
                  </button>
                ))}
              </div>
            </fieldset>

            {form.sourceMode === "live_api" && (
              <div className="field-grid">
                <div className="field">
                  <label className="label" htmlFor="androidPackage">
                    Android package
                  </label>
                  <input
                    id="androidPackage"
                    className="mono-input"
                    value={form.androidPackage}
                    onChange={(event) => updateField("androidPackage", event.target.value)}
                    placeholder="com.company.app"
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="appleAppId">
                    App Store Connect ID
                  </label>
                  <input
                    id="appleAppId"
                    className="mono-input"
                    inputMode="numeric"
                    value={form.appleAppId}
                    onChange={(event) => updateField("appleAppId", event.target.value)}
                    placeholder="123456789"
                  />
                </div>
              </div>
            )}

            {form.sourceMode === "csv" && (
              <div className="field-grid">
                {(["android", "ios"] as Platform[]).map((platform) => {
                  const selection = csvFiles.find((entry) => entry.platform === platform);
                  return (
                    <label className="upload" key={platform}>
                      <span className="label">
                        {platform === "android" ? "Google Play report" : "App Store CSV"}
                      </span>
                      <span className="upload__file">
                        {selection?.file.name ?? "Choose a CSV file"}
                      </span>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(event) => addCsvFile(event, platform)}
                      />
                    </label>
                  );
                })}
              </div>
            )}

            <div className="field-grid">
              <div className="field">
                <label className="label" htmlFor="startDate">
                  From (UTC)
                </label>
                <input
                  id="startDate"
                  type="date"
                  value={form.startDate}
                  onChange={(event) => updateField("startDate", event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="endDate">
                  To (UTC)
                </label>
                <input
                  id="endDate"
                  type="date"
                  value={form.endDate}
                  onChange={(event) => updateField("endDate", event.target.value)}
                  required
                />
              </div>
            </div>

            <div className="field">
              <div className="field__row">
                <label className="label" htmlFor="lastN">
                  Latest reviews to list
                </label>
                <span className="mono">{form.lastN}</span>
              </div>
              <input
                id="lastN"
                className="range"
                type="range"
                min="5"
                max="50"
                step="5"
                value={form.lastN}
                onChange={(event) => updateField("lastN", Number(event.target.value))}
              />
            </div>

            {needsToken && (
              <div className="field">
                <label className="label" htmlFor="accessToken">
                  Access token
                </label>
                <input
                  id="accessToken"
                  className="mono-input"
                  type="password"
                  autoComplete="off"
                  value={accessToken}
                  onChange={(event) => setAccessToken(event.target.value)}
                  placeholder="Provided by your Loomit admin"
                />
              </div>
            )}

            <button className="button-primary" disabled={loading} type="submit">
              {loading ? "Analyzing reviews…" : "Run analysis"}
            </button>
          </form>

          <p className="fineprint">
            Store and classifier credentials stay on the server. Reviews are
            classified in their original language.
          </p>
        </aside>

        <section className="results" aria-live="polite" aria-busy={loading}>
          {error && (
            <div className="card card--chip alert" role="alert">
              <Pill tone="negative">Error</Pill>
              <p className="body">{error}</p>
            </div>
          )}

          {loading && !result ? (
            <div className="card empty-state">
              <p className="eyebrow">Working</p>
              <h2 className="section-title">Classifying reviews…</h2>
              <p className="body muted">Fetching, normalizing and classifying written reviews.</p>
            </div>
          ) : result && summary ? (
            <>
              <header className="results__header">
                <div>
                  <p className="eyebrow">
                    {result.appName} · {formatRange(result.period.startDate, result.period.endDate)}
                  </p>
                  <h2 className="page-title">{summary.title}</h2>
                  <p className="subtitle">{summary.subtitle}</p>
                </div>
                {isSample && <span className="sample-tag">Sample data</span>}
              </header>

              <div className="kpi-row">
                <article className="card card--brand kpi">
                  <p className="label">Average sentiment</p>
                  <p className="kpi__value">
                    {result.metrics.averageSentiment.toFixed(2)}
                    <span className="kpi__unit">/ 4</span>
                  </p>
                  <p className="kpi__note">
                    {sentimentWord(result.metrics.averageSentiment)} ·{" "}
                    {ESTIMATOR_COPY[result.metrics.sentimentEstimator].toLowerCase()}
                  </p>
                  <div className="meter" aria-hidden="true">
                    <span style={{ width: `${(result.metrics.averageSentiment / 4) * 100}%` }} />
                  </div>
                </article>

                <article className="card kpi">
                  <p className="label">Written-review rating</p>
                  <p className="kpi__value">
                    {result.metrics.averageRating.toFixed(2)}
                    <span className="kpi__unit">/ 5</span>
                  </p>
                  <p className="kpi__note">Excludes star-only ratings</p>
                </article>

                <article className="card kpi">
                  <p className="label">Reviews analyzed</p>
                  <p className="kpi__value">{result.metrics.reviewsAnalyzed}</p>
                  <p className="kpi__note">
                    {result.metrics.androidReviews} Google Play · {result.metrics.iosReviews} App Store
                    {result.metrics.reviewsUnclassified > 0 &&
                      ` · ${result.metrics.reviewsUnclassified} unclassified`}
                  </p>
                </article>

                <article className="card kpi">
                  <p className="label">Classifier confidence</p>
                  <p className="kpi__value">{formatPercent(result.metrics.averageConfidence)}</p>
                  <p className="kpi__note mono-note" title={result.classifier.model}>
                    {result.classifier.model}
                  </p>
                </article>
              </div>

              <div className="split">
                <article className="card">
                  <p className="eyebrow">Distribution · n = {result.metrics.reviewsAnalyzed}</p>
                  <h3 className="card-title">Sentiment mix</h3>
                  <div className="stacked" role="img" aria-label="Sentiment distribution">
                    {result.sentimentDistribution.map((item) => (
                      <span
                        key={item.label}
                        className={`stacked__seg seg--${item.label}`}
                        style={{ width: formatPercent(item.share) }}
                        title={`${SENTIMENT_COPY[item.label].label}: ${item.count}`}
                      />
                    ))}
                  </div>
                  <ul className="legend">
                    {result.sentimentDistribution.map((item) => (
                      <li key={item.label}>
                        <span className={`legend__swatch seg--${item.label}`} aria-hidden="true" />
                        <span>{SENTIMENT_COPY[item.label].short}</span>
                        <span className="mono">{formatPercent(item.share)}</span>
                      </li>
                    ))}
                  </ul>
                </article>

                <article className="card">
                  <p className="eyebrow">Data coverage</p>
                  <h3 className="card-title">
                    {result.coverage.every((item) => item.status === "complete")
                      ? "All selected sources are complete"
                      : "Some sources are incomplete"}
                  </h3>
                  <ul className="coverage">
                    {result.coverage.map((item) => (
                      <li key={`${item.source}-${item.label}`}>
                        <div className="coverage__row">
                          <span className="coverage__name">{item.label}</span>
                          <Pill tone={COVERAGE_COPY[item.status].tone}>
                            {COVERAGE_COPY[item.status].label}
                          </Pill>
                        </div>
                        <p className="coverage__meta mono">
                          {item.reviewsFetched} reviews
                          {item.pagesFetched !== undefined && ` · ${item.pagesFetched} pages`}
                          {item.truncated && " · truncated"}
                        </p>
                        {item.note && <p className="body muted">{item.note}</p>}
                      </li>
                    ))}
                  </ul>
                  <dl className="facts">
                    <div>
                      <dt className="label">Period by</dt>
                      <dd>{MEMBERSHIP_COPY[result.period.membership]}</dd>
                    </div>
                    <div>
                      <dt className="label">Rating scope</dt>
                      <dd>Written reviews only</dd>
                    </div>
                  </dl>
                </article>
              </div>

              <article className="card">
                <p className="eyebrow">Drivers · primary reason per review</p>
                <h3 className="card-title">Why users feel this way</h3>
                <div className="reasons">
                  <section>
                    <p className="reasons__title">
                      <Pill tone="negative">Negative</Pill>
                    </p>
                    <RankingBars items={result.reasons.negative} emptyCopy="No negative reviews." />
                  </section>
                  <section>
                    <p className="reasons__title">
                      <Pill tone="neutral">Mixed</Pill>
                    </p>
                    <RankingBars items={result.reasons.neutral} emptyCopy="No mixed reviews." />
                  </section>
                  <section>
                    <p className="reasons__title">
                      <Pill tone="positive">Positive</Pill>
                    </p>
                    <RankingBars items={result.reasons.positive} emptyCopy="No positive reviews." />
                  </section>
                </div>
              </article>

              <article className="card">
                <div className="card-heading">
                  <div>
                    <p className="eyebrow">Latest {result.reviews.length} reviews</p>
                    <h3 className="card-title">What users wrote most recently</h3>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Review</th>
                        <th scope="col">Store</th>
                        <th scope="col" className="num">Rating</th>
                        <th scope="col">Sentiment</th>
                        <th scope="col">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.reviews.map((review) => (
                        <tr key={`${review.store}-${review.id}`}>
                          <td className="table__review">
                            <strong>{review.title || "Untitled review"}</strong>
                            <p>{review.body}</p>
                            <span className="mono table__meta">
                              {formatDate(review.createdAt)}
                              {review.appVersion && ` · v${review.appVersion}`}
                              {review.territory && ` · ${review.territory}`}
                            </span>
                          </td>
                          <td data-label="Store">
                            {review.platform === "android" ? "Google Play" : "App Store"}
                          </td>
                          <td data-label="Rating" className="num mono">
                            {review.rating}/5
                          </td>
                          <td data-label="Sentiment">
                            <Pill tone={sentimentTone(review.analysis.sentimentLabel)}>
                              {SENTIMENT_COPY[review.analysis.sentimentLabel].label}
                            </Pill>
                            <span className="mono table__meta">
                              {formatPercent(review.analysis.sentimentConfidence)} conf.
                            </span>
                          </td>
                          <td data-label="Reason">
                            {REASON_DEFINITIONS[review.analysis.primaryReason]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              {result.notices.length > 0 && (
                <article className="card card--chip notes">
                  <p className="label">Notes on this analysis</p>
                  <ul>
                    {result.notices.map((notice) => (
                      <li key={notice} className="body">
                        {notice}
                      </li>
                    ))}
                  </ul>
                </article>
              )}

              <footer className="results__footer mono">
                <span>
                  {CLASSIFIER_COPY[result.classifier.provider]} · {result.classifier.promptVersion} ·{" "}
                  {result.classifier.taxonomyVersion}
                </span>
                <span>Official store APIs and exports only</span>
              </footer>
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}
