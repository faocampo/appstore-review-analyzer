"use client";

import {
  Activity,
  Apple,
  Bot,
  BrainCircuit,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CloudUpload,
  Database,
  FileSpreadsheet,
  Info,
  LoaderCircle,
  MessageSquareText,
  Play,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  TrendingUp,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  useEffect,
  useState,
} from "react";

import {
  REASON_DEFINITIONS,
  type AnalysisResult,
  type AnalyzeInput,
  type Platform,
  type ReasonSummary,
  type SentimentLabel,
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
  translationLanguage: string;
}

interface CsvSelection {
  file: File;
  platform: Platform;
}

async function requestAnalysis(
  state: FormState,
  selectedFiles: CsvSelection[],
): Promise<AnalysisResult> {
  const files =
    state.sourceMode === "csv"
      ? await Promise.all(
          selectedFiles.map(async ({ file, platform }) => ({
            name: file.name,
            platform,
            content: await file.text(),
          })),
        )
      : undefined;
  const payload: AnalyzeInput = {
    ...state,
    androidPackage: state.androidPackage || undefined,
    appleAppId: state.appleAppId || undefined,
    translationLanguage: state.translationLanguage || undefined,
    csvFiles: files,
  };
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();

  if (!response.ok) {
    if (typeof body === "object" && body !== null) {
      const summary =
        "error" in body && typeof body.error === "string"
          ? body.error
          : "The analysis could not be completed.";
      const details =
        "details" in body &&
        Array.isArray(body.details) &&
        body.details.every((detail) => typeof detail === "string")
          ? body.details.join(" ")
          : "";
      throw new Error(details ? `${summary} ${details}` : summary);
    }

    throw new Error("The analysis could not be completed.");
  }

  return body as AnalysisResult;
}

const SENTIMENT_COPY: Record<
  SentimentLabel,
  { label: string; shortLabel: string }
> = {
  highly_negative: { label: "Highly negative", shortLabel: "Very neg." },
  negative: { label: "Negative", shortLabel: "Negative" },
  neutral_mixed: { label: "Neutral / mixed", shortLabel: "Neutral" },
  positive: { label: "Positive", shortLabel: "Positive" },
  highly_positive: { label: "Highly positive", shortLabel: "Very pos." },
};

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
    translationLanguage: "en",
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function sentimentFromAverage(value: number): string {
  if (value < 0.8) return "Highly negative";
  if (value < 1.6) return "Negative";
  if (value < 2.4) return "Neutral / mixed";
  if (value < 3.2) return "Positive";
  return "Highly positive";
}

function RatingStars({ rating }: { rating: number }): ReactElement {
  return (
    <span className="rating-stars" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, index) => (
        <Star
          key={index}
          size={13}
          fill={index < Math.round(rating) ? "currentColor" : "none"}
        />
      ))}
    </span>
  );
}

function ReasonList({
  items,
  tone,
}: {
  items: ReasonSummary[];
  tone: "negative" | "neutral" | "positive";
}): ReactElement {
  if (!items.length) {
    return <p className="empty-reasons">No reviews in this group.</p>;
  }

  return (
    <div className="reason-list">
      {items.map((item) => (
        <div className="reason-row" key={item.reason}>
          <div className="reason-row__top">
            <span>{item.label}</span>
            <span>{item.count}</span>
          </div>
          <div className="reason-track">
            <span
              className={`reason-fill reason-fill--${tone}`}
              style={{ width: formatPercent(item.share) }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ModeButton({
  active,
  icon,
  title,
  copy,
  onClick,
}: {
  active: boolean;
  icon: ReactElement;
  title: string;
  copy: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      className={`mode-button ${active ? "mode-button--active" : ""}`}
      type="button"
      onClick={onClick}
    >
      <span className="mode-button__icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{copy}</small>
      </span>
      <ChevronRight size={16} />
    </button>
  );
}

export default function Home(): ReactElement {
  const [form, setForm] = useState<FormState>(defaultForm);
  const [csvFiles, setCsvFiles] = useState<CsvSelection[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function runAnalysis(
    state: FormState,
    selectedFiles: CsvSelection[],
  ): Promise<void> {
    setLoading(true);
    setError("");

    try {
      setResult(await requestAnalysis(state, selectedFiles));
    } catch (analysisError) {
      setError(
        analysisError instanceof Error
          ? analysisError.message
          : "The analysis could not be completed.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void requestAnalysis(defaultForm(), [])
      .then((initialResult) => {
        if (active) setResult(initialResult);
      })
      .catch((initialError: unknown) => {
        if (active) {
          setError(
            initialError instanceof Error
              ? initialError.message
              : "The demo analysis could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  function updateField<Key extends keyof FormState>(
    key: Key,
    value: FormState[Key],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void runAnalysis(form, csvFiles);
  }

  function addCsvFile(
    event: ChangeEvent<HTMLInputElement>,
    platform: Platform,
  ): void {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvFiles((current) => [
      ...current.filter((selection) => selection.platform !== platform),
      { file, platform },
    ]);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ReviewSignal home">
          <span className="brand-mark">
            <Activity size={20} />
          </span>
          <span>
            Review<span>Signal</span>
          </span>
        </a>
        <div className="topbar__meta">
          <span className="status-pill">
            <span className="status-dot" />
            Owned-app intelligence
          </span>
          <span className="topbar__divider" />
          <span className="secure-label">
            <ShieldCheck size={15} />
            Server-side credentials
          </span>
        </div>
      </header>

      <div className="workspace" id="top">
        <aside className="control-panel">
          <div className="panel-intro">
            <span className="eyebrow">
              <Sparkles size={13} />
              New analysis
            </span>
            <h1>Understand what users are really saying.</h1>
            <p>
              Combine owned-app reviews across stores, then classify sentiment
              and the reasons behind it.
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="form-section">
              <label className="field-label" htmlFor="appName">
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

            <div className="form-section">
              <span className="field-label">Data source</span>
              <div className="mode-list">
                <ModeButton
                  active={form.sourceMode === "demo"}
                  icon={<Bot size={18} />}
                  title="Demo dataset"
                  copy="No credentials required"
                  onClick={() => updateField("sourceMode", "demo")}
                />
                <ModeButton
                  active={form.sourceMode === "live_api"}
                  icon={<Database size={18} />}
                  title="Official store APIs"
                  copy="Owned apps only"
                  onClick={() => updateField("sourceMode", "live_api")}
                />
                <ModeButton
                  active={form.sourceMode === "csv"}
                  icon={<CloudUpload size={18} />}
                  title="Store exports"
                  copy="Historical CSV files"
                  onClick={() => updateField("sourceMode", "csv")}
                />
              </div>
            </div>

            {form.sourceMode === "live_api" && (
              <div className="form-section source-fields">
                <div>
                  <label className="field-label" htmlFor="androidPackage">
                    <Smartphone size={14} />
                    Android package
                  </label>
                  <input
                    id="androidPackage"
                    value={form.androidPackage}
                    onChange={(event) =>
                      updateField("androidPackage", event.target.value)
                    }
                    placeholder="com.company.app"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="appleAppId">
                    <Apple size={14} />
                    App Store Connect ID
                  </label>
                  <input
                    id="appleAppId"
                    value={form.appleAppId}
                    onChange={(event) =>
                      updateField("appleAppId", event.target.value)
                    }
                    placeholder="123456789"
                  />
                </div>
              </div>
            )}

            {form.sourceMode === "csv" && (
              <div className="form-section upload-grid">
                {(["android", "ios"] as Platform[]).map((platform) => {
                  const selection = csvFiles.find(
                    (entry) => entry.platform === platform,
                  );
                  return (
                    <label className="upload-card" key={platform}>
                      {platform === "android" ? (
                        <Smartphone size={18} />
                      ) : (
                        <Apple size={18} />
                      )}
                      <span>
                        <strong>
                          {platform === "android" ? "Google Play" : "App Store"}
                        </strong>
                        <small>{selection?.file.name ?? "Choose CSV"}</small>
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

            <div className="form-section">
              <span className="field-label">
                <CalendarDays size={14} />
                Review period
              </span>
              <div className="date-grid">
                <label>
                  <small>From</small>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(event) =>
                      updateField("startDate", event.target.value)
                    }
                    required
                  />
                </label>
                <label>
                  <small>To</small>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(event) =>
                      updateField("endDate", event.target.value)
                    }
                    required
                  />
                </label>
              </div>
            </div>

            <div className="form-section">
              <div className="range-heading">
                <label className="field-label" htmlFor="lastN">
                  Latest reviews to show
                </label>
                <strong>{form.lastN}</strong>
              </div>
              <input
                id="lastN"
                className="range-input"
                type="range"
                min="5"
                max="50"
                step="5"
                value={form.lastN}
                onChange={(event) =>
                  updateField("lastN", Number(event.target.value))
                }
              />
              <div className="range-scale">
                <span>5</span>
                <span>50</span>
              </div>
            </div>

            <button className="analyze-button" disabled={loading} type="submit">
              {loading ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
              {loading ? "Analyzing reviews…" : "Run sentiment analysis"}
            </button>
          </form>

          <div className="privacy-note">
            <ShieldCheck size={16} />
            <span>
              Tokens stay on the server and are never sent to the browser.
            </span>
          </div>
        </aside>

        <section className="results-panel">
          <div className="results-header">
            <div>
              <span className="eyebrow eyebrow--blue">
                <TrendingUp size={13} />
                Review intelligence
              </span>
              <h2>{result?.appName ?? form.appName}</h2>
              <p>
                {result
                  ? `${formatDate(result.period.startDate)} — ${formatDate(result.period.endDate)}`
                  : "Preparing your analysis…"}
              </p>
            </div>
            <div className="model-pill">
              <BrainCircuit size={16} />
              <span>
                <small>Classifier</small>
                {result?.analysisMode === "jev"
                  ? result.model
                  : "Mock rules · demo"}
              </span>
            </div>
          </div>

          {error && (
            <div className="error-banner">
              <CircleAlert size={18} />
              <div>
                <strong>Analysis failed</strong>
                <p>{error}</p>
              </div>
            </div>
          )}

          {loading && !result ? (
            <div className="loading-state">
              <span className="loading-orbit">
                <BrainCircuit size={34} />
              </span>
              <h3>Reading the signal</h3>
              <p>Normalizing reviews and classifying user feedback…</p>
            </div>
          ) : result ? (
            <>
              <div className="metric-grid">
                <article className="metric-card metric-card--primary">
                  <span className="metric-icon">
                    <BrainCircuit size={19} />
                  </span>
                  <div className="metric-heading">
                    <span>Average sentiment</span>
                    <Info size={13} />
                  </div>
                  <strong>{result.metrics.averageSentiment.toFixed(2)}</strong>
                  <span className="metric-scale">out of 4.00</span>
                  <div className="sentiment-meter">
                    <span
                      style={{
                        width: `${(result.metrics.averageSentiment / 4) * 100}%`,
                      }}
                    />
                  </div>
                  <small>
                    {sentimentFromAverage(result.metrics.averageSentiment)}
                  </small>
                </article>

                <article className="metric-card">
                  <span className="metric-icon metric-icon--amber">
                    <Star size={19} fill="currentColor" />
                  </span>
                  <div className="metric-heading">
                    <span>Written-review rating</span>
                    <Info size={13} />
                  </div>
                  <strong>{result.metrics.averageRating.toFixed(2)}</strong>
                  <span className="metric-scale">out of 5.00</span>
                  <RatingStars rating={result.metrics.averageRating} />
                  <small>Excludes star-only ratings</small>
                </article>

                <article className="metric-card">
                  <span className="metric-icon metric-icon--violet">
                    <MessageSquareText size={19} />
                  </span>
                  <div className="metric-heading">
                    <span>Reviews analyzed</span>
                    <Info size={13} />
                  </div>
                  <strong>{result.metrics.reviewsAnalyzed}</strong>
                  <span className="metric-scale">written reviews</span>
                  <div className="store-counts">
                    <span>
                      <Smartphone size={13} />
                      {result.metrics.androidReviews} Android
                    </span>
                    <span>
                      <Apple size={13} />
                      {result.metrics.iosReviews} iOS
                    </span>
                  </div>
                </article>

                <article className="metric-card">
                  <span className="metric-icon metric-icon--green">
                    <ShieldCheck size={19} />
                  </span>
                  <div className="metric-heading">
                    <span>Avg. confidence</span>
                    <Info size={13} />
                  </div>
                  <strong>
                    {formatPercent(result.metrics.averageConfidence)}
                  </strong>
                  <span className="metric-scale">sentiment confidence</span>
                  <div className="confidence-track">
                    <span
                      style={{
                        width: formatPercent(
                          result.metrics.averageConfidence,
                        ),
                      }}
                    />
                  </div>
                  <small>{result.model}</small>
                </article>
              </div>

              <div className="insights-grid">
                <article className="surface distribution-card">
                  <div className="section-heading">
                    <div>
                      <span className="section-kicker">Distribution</span>
                      <h3>Sentiment mix</h3>
                    </div>
                    <span className="sample-pill">
                      n = {result.metrics.reviewsAnalyzed}
                    </span>
                  </div>
                  <div className="stacked-bar">
                    {result.sentimentDistribution.map((item) => (
                      <span
                        className={`sentiment-block sentiment-block--${item.label}`}
                        key={item.label}
                        style={{ width: formatPercent(item.share) }}
                        title={`${SENTIMENT_COPY[item.label].label}: ${item.count}`}
                      />
                    ))}
                  </div>
                  <div className="distribution-legend">
                    {result.sentimentDistribution.map((item) => (
                      <div key={item.label}>
                        <span
                          className={`legend-dot legend-dot--${item.label}`}
                        />
                        <span>
                          <strong>{formatPercent(item.share)}</strong>
                          <small>{SENTIMENT_COPY[item.label].shortLabel}</small>
                        </span>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="surface coverage-card">
                  <div className="section-heading">
                    <div>
                      <span className="section-kicker">Data quality</span>
                      <h3>Coverage snapshot</h3>
                    </div>
                    <ShieldCheck size={19} />
                  </div>
                  <div className="coverage-row">
                    <span>Source</span>
                    <strong>
                      {result.sourceMode === "demo"
                        ? "Synthetic demo"
                        : result.sourceMode === "csv"
                          ? "Store export"
                          : "Official APIs"}
                    </strong>
                  </div>
                  <div className="coverage-row">
                    <span>Period membership</span>
                    <strong>Review date</strong>
                  </div>
                  <div className="coverage-row">
                    <span>Rating scope</span>
                    <strong>Written only</strong>
                  </div>
                </article>
              </div>

              <article className="surface reasons-card">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">Drivers</span>
                    <h3>Why users feel this way</h3>
                  </div>
                  <p>Primary reason per review</p>
                </div>
                <div className="reason-columns">
                  <section>
                    <div className="reason-title reason-title--negative">
                      <span />
                      Negative
                    </div>
                    <ReasonList
                      items={result.reasons.negative}
                      tone="negative"
                    />
                  </section>
                  <section>
                    <div className="reason-title reason-title--neutral">
                      <span />
                      Neutral / mixed
                    </div>
                    <ReasonList
                      items={result.reasons.neutral}
                      tone="neutral"
                    />
                  </section>
                  <section>
                    <div className="reason-title reason-title--positive">
                      <span />
                      Positive
                    </div>
                    <ReasonList
                      items={result.reasons.positive}
                      tone="positive"
                    />
                  </section>
                </div>
              </article>

              <article className="surface reviews-card">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">Review map</span>
                    <h3>Latest classified reviews</h3>
                  </div>
                  <span className="sample-pill">
                    Latest {result.reviews.length}
                  </span>
                </div>
                <div className="review-table">
                  <div className="review-table__header">
                    <span>Review</span>
                    <span>Store & rating</span>
                    <span>Sentiment</span>
                    <span>Primary reason</span>
                  </div>
                  {result.reviews.map((review) => (
                    <div className="review-row" key={`${review.store}-${review.id}`}>
                      <div className="review-copy">
                        <div>
                          <strong>{review.title || "Untitled review"}</strong>
                          <time>{formatDate(review.createdAt)}</time>
                        </div>
                        <p>{review.body}</p>
                      </div>
                      <div className="review-store">
                        <span className={`store-icon store-icon--${review.platform}`}>
                          {review.platform === "android" ? (
                            <Smartphone size={15} />
                          ) : (
                            <Apple size={15} />
                          )}
                        </span>
                        <div>
                          <strong>
                            {review.platform === "android"
                              ? "Google Play"
                              : "App Store"}
                          </strong>
                          <RatingStars rating={review.rating} />
                        </div>
                      </div>
                      <div>
                        <span
                          className={`sentiment-badge sentiment-badge--${review.analysis.sentimentLabel}`}
                        >
                          {SENTIMENT_COPY[review.analysis.sentimentLabel].label}
                        </span>
                        <small className="confidence-copy">
                          {formatPercent(review.analysis.sentimentConfidence)} confidence
                        </small>
                      </div>
                      <div className="reason-chip">
                        {REASON_DEFINITIONS[review.analysis.primaryReason]}
                      </div>
                    </div>
                  ))}
                </div>
              </article>

              <div className="notice-stack">
                {result.notices.map((notice) => (
                  <div className="notice" key={notice}>
                    <Info size={15} />
                    <span>{notice}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <footer className="results-footer">
            <span>
              <FileSpreadsheet size={14} />
              Official APIs and exports only
            </span>
            <span>ReviewSignal MVP</span>
          </footer>
        </section>
      </div>
    </main>
  );
}
