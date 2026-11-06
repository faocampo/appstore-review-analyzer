"use client";

import Link from "next/link";
import { type ReactElement, useId, useState } from "react";

import { AccessTokenGate, LoadingCard, NavLink, PanelTopbar, Pill, RequestProblem, SampleTag, StatusWord } from "@/app/_components/ui";
import { errorMessage, isUnauthorized, panelClient, type PanelClient } from "@/app/_lib/api-client";
import { CONNECTION_STATUS_COPY, STORE_COPY } from "@/app/_lib/copy";
import { formatDateTime, formatShortDate } from "@/app/_lib/dates";
import { useResource } from "@/app/_lib/use-resource";
import type { Store } from "@/lib/types";
import type { AppDto, ConnectionDto, VerifyResponse } from "@/server/api/contracts";

import { AppStoreForm, CsvImportForm, GooglePlayForm, RegisterAppForm, type ConnectionPatch } from "./forms";

const DEFAULT_APPLE_ROLE = "Customer Support";

// ---------------------------------------------------------------------------
// Onboarding steps (TimelineSlide → steps)
// ---------------------------------------------------------------------------

type StepState = { word: string; dot: "strong" | "on" | "off" };

function storeStep(app: AppDto | null, store: Store, configured: boolean): StepState {
  if (!app) return { word: "To do", dot: "off" };
  if (!configured) return { word: "Not used", dot: "off" };
  const connection = app.connections.find((item) => item.store === store);
  if (!connection) return { word: "Next", dot: "strong" };
  return { word: CONNECTION_STATUS_COPY[connection.status].label, dot: CONNECTION_STATUS_COPY[connection.status].dot };
}

function Steps({ app, imported, appleRole }: { app: AppDto | null; imported: boolean; appleRole: string }): ReactElement {
  const anyActive = app?.connections.some((item) => item.status === "active") ?? false;
  const steps: Array<{ title: string; copy: string; state: StepState }> = [
    {
      title: "Register the app",
      copy: "Link the Loomit app to its store IDs.",
      state: app ? { word: "Done", dot: "on" } : { word: "Next", dot: "strong" },
    },
    {
      title: "Connect Google Play",
      copy: "Invite X3M's read-only service account.",
      state: storeStep(app, "google_play", Boolean(app?.androidPackage)),
    },
    {
      title: "Connect the App Store",
      copy: `API key with the ${appleRole} role.`,
      state: storeStep(app, "apple_app_store", Boolean(app?.appleAppId)),
    },
    {
      title: "Import history",
      copy: "Optional CSV backfill.",
      state: imported ? { word: "Queued", dot: "on" } : { word: "Optional", dot: "off" },
    },
    {
      title: "Read the panels",
      copy: "Evolution and guardrails.",
      state: anyActive ? { word: "Ready", dot: "on" } : { word: "Waiting", dot: "off" },
    },
  ];
  return (
    <ol className="steps" aria-label="Onboarding steps">
      {steps.map((step, index) => (
        <li key={step.title} className="card card--chip step">
          <span className="label">Step {index + 1}</span>
          <strong className="step__title">{step.title}</strong>
          <span className="step__copy">{step.copy}</span>
          <StatusWord dot={step.state.dot}>{step.state.word}</StatusWord>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Connection status list
// ---------------------------------------------------------------------------

function ConnectionRow({
  app,
  store,
  client,
  onConnection,
  onUnauthorized,
}: {
  app: AppDto;
  store: Store;
  client: PanelClient;
  onConnection: (patch: ConnectionPatch) => void;
  onUnauthorized: () => void;
}): ReactElement {
  const connection = app.connections.find((item) => item.store === store);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function verify(): Promise<void> {
    setVerifying(true);
    setProblem(null);
    setResult(null);
    try {
      const verified = await client.verifyConnection(app.id, store);
      setResult(verified);
      onConnection({ store: verified.store, status: verified.status, lastError: verified.status === "error" ? verified.error : null });
    } catch (error) {
      if (isUnauthorized(error)) onUnauthorized();
      setProblem(errorMessage(error, "Verification failed."));
    } finally {
      setVerifying(false);
    }
  }

  const copy = connection ? CONNECTION_STATUS_COPY[connection.status] : { label: "Not connected", dot: "off" as const };
  const facts = connection
    ? [
        connection.lastVerifiedAt ? `Verified ${formatDateTime(connection.lastVerifiedAt)}` : "Not verified yet",
        connection.lastSyncedAt ? `Synced ${formatDateTime(connection.lastSyncedAt)}` : "Never synced",
        connection.watermark ? `Reviews through ${formatShortDate(connection.watermark)}` : null,
      ].filter(Boolean)
    : ["Add credentials below to connect."];

  return (
    <li>
      <div className="coverage__row">
        <span className="coverage__name">{STORE_COPY[store]}</span>
        {verifying ? <StatusWord dot="strong">Verifying…</StatusWord> : <StatusWord dot={copy.dot}>{copy.label}</StatusWord>}
      </div>
      <ul className="connection__facts mono">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {result?.status === "active" && (
        <p className="connection__error" role="status">
          <Pill tone="positive">Verified</Pill>
          <span className="body">The store accepted the credentials. Syncing starts on the next run.</span>
        </p>
      )}
      {result?.status === "error" && (
        <p className="connection__error" role="alert">
          <Pill tone="negative">Verification failed</Pill>
          <span className="body">{result.error ?? "The store rejected the credentials."}</span>
        </p>
      )}
      {connection?.lastError && result?.status !== "error" && (
        <p className="connection__error">
          <Pill tone="negative">Last error</Pill>
          <span className="body">{connection.lastError}</span>
        </p>
      )}
      {problem && (
        <p className="connection__error" role="alert">
          <Pill tone="negative">Error</Pill>
          <span className="body">{problem}</span>
        </p>
      )}
      {connection && (
        <button type="button" className="button-secondary" onClick={() => void verify()} disabled={verifying}>
          {verifying ? "Verifying…" : "Verify connection"}
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export function ConnectFlow({ fixture, initialAppId }: { fixture: boolean; initialAppId: string | null }): ReactElement {
  const client = panelClient(fixture);
  const selectId = useId();
  const [attempt, setAttempt] = useState(0);
  const [needsToken, setNeedsToken] = useState(false);
  const [local, setLocal] = useState<Record<string, AppDto>>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialAppId);
  const [registering, setRegistering] = useState(false);
  const [imported, setImported] = useState<Record<string, boolean>>({});

  const listed = useResource(`apps:${attempt}`, () => client.listApps());
  const onboarding = useResource(`onboarding:${attempt}`, () => client.getOnboarding());
  const fetched = listed.error ? [] : (listed.data?.items ?? []);
  const appleRole = onboarding.data?.appleKeyRole ?? DEFAULT_APPLE_ROLE;
  const apps = [
    ...fetched.map((app) => local[app.id] ?? app),
    ...Object.values(local).filter((app) => !fetched.some((item) => item.id === app.id)),
  ];
  const app = apps.find((item) => item.id === selectedId) ?? (selectedId ? null : (apps[0] ?? null));
  const showRegister = registering || (listed.data !== null && apps.length === 0);

  function retry(): void {
    setNeedsToken(false);
    setAttempt((value) => value + 1);
  }

  function upsert(next: AppDto): void {
    setLocal((current) => ({ ...current, [next.id]: next }));
  }

  function applyConnection(patch: ConnectionPatch): void {
    if (!app) return;
    const current: ConnectionDto = app.connections.find((item) => item.store === patch.store) ?? {
      store: patch.store,
      status: patch.status,
      lastVerifiedAt: null,
      lastSyncedAt: null,
      lastError: null,
      watermark: null,
    };
    const next = { ...current, ...patch };
    upsert({ ...app, connections: [...app.connections.filter((item) => item.store !== patch.store), next] });
  }

  const onUnauthorized = () => setNeedsToken(true);
  const panelHref = app ? `/apps/${encodeURIComponent(app.id)}${fixture ? "?fixture=1" : ""}` : null;

  return (
    <>
      <PanelTopbar context="Onboarding">{panelHref && <NavLink href={panelHref}>Evolution panel</NavLink>}</PanelTopbar>

      <main className="panel">
        <header className="panel__header">
          <div>
            <p className="eyebrow">Onboarding · store connections</p>
            <h1 className="page-title">
              {app ? `Connect ${app.name} to its stores` : "Register an app to start reading its reviews"}
            </h1>
            <p className="subtitle">
              ReviewSignal reads written reviews through the official store APIs with read-only access. Credentials go to the
              secret store and are never shown back.
            </p>
          </div>
          {fixture && <SampleTag />}
        </header>

        {fixture && (
          <p className="card card--chip fixture-note body">
            Sample mode: nothing is sent to a server, and the keys you type stay in this browser tab.
          </p>
        )}

        {needsToken || isUnauthorized(listed.error) || isUnauthorized(onboarding.error) ? (
          <AccessTokenGate onSaved={retry} />
        ) : listed.error ? (
          <RequestProblem error={listed.error} onRetry={retry} />
        ) : listed.loading && !listed.data ? (
          <LoadingCard eyebrow="Working" title="Loading your apps…" />
        ) : (
          <>
            <Steps app={app} imported={app ? Boolean(imported[app.id]) : false} appleRole={appleRole} />

            <div className="connect-layout">
              <div className="stack">
                {showRegister && (
                  <article className="card">
                    <p className="eyebrow">Step 1 · register</p>
                    <h2 className="card-title">Register the app with its store IDs</h2>
                    <RegisterAppForm
                      client={client}
                      onUnauthorized={onUnauthorized}
                      onCreated={(created) => {
                        upsert(created);
                        setSelectedId(created.id);
                        setRegistering(false);
                      }}
                    />
                  </article>
                )}

                {app?.androidPackage && (
                  <article className="card">
                    <p className="eyebrow">Step 2 · Google Play</p>
                    <h2 className="card-title">Invite X3M&apos;s service account in Play Console, read-only</h2>
                    <GooglePlayForm
                      key={`gp-${app.id}`}
                      client={client}
                      app={app}
                      onboarding={onboarding.error ? null : onboarding.data}
                      onboardingError={onboarding.error}
                      onConnection={applyConnection}
                      onUnauthorized={onUnauthorized}
                    />
                  </article>
                )}

                {app?.appleAppId && (
                  <article className="card">
                    <p className="eyebrow">Step 3 · App Store</p>
                    <h2 className="card-title">Add an App Store Connect key with the {appleRole} role</h2>
                    <AppStoreForm
                      key={`as-${app.id}`}
                      client={client}
                      app={app}
                      keyRole={appleRole}
                      onConnection={applyConnection}
                      onUnauthorized={onUnauthorized}
                    />
                  </article>
                )}

                {app && (
                  <article className="card">
                    <p className="eyebrow">Step 4 · optional</p>
                    <h2 className="card-title">Import older reviews from a store export</h2>
                    <CsvImportForm
                      key={`csv-${app.id}`}
                      client={client}
                      app={app}
                      onUnauthorized={onUnauthorized}
                      onImported={() => setImported((current) => ({ ...current, [app.id]: true }))}
                    />
                  </article>
                )}
              </div>

              <aside className="card connect-status" aria-label="Connection status">
                <p className="eyebrow">Connection status</p>
                {apps.length > 0 ? (
                  <>
                    <div className="field">
                      <label className="label" htmlFor={selectId}>
                        App
                      </label>
                      <select id={selectId} value={app?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
                        {!app && <option value="">Choose an app</option>}
                        {apps.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {app ? (
                      <>
                        <dl className="facts facts--ids">
                          <div>
                            <dt className="label">Loomit app</dt>
                            <dd className="mono">{app.loomitAppId}</dd>
                          </div>
                          {app.androidPackage && (
                            <div>
                              <dt className="label">Android package</dt>
                              <dd className="mono">{app.androidPackage}</dd>
                            </div>
                          )}
                          {app.appleAppId && (
                            <div>
                              <dt className="label">Apple ID</dt>
                              <dd className="mono">{app.appleAppId}</dd>
                            </div>
                          )}
                        </dl>
                        <ul className="coverage">
                          {(["google_play", "apple_app_store"] as Store[])
                            .filter((store) => (store === "google_play" ? app.androidPackage : app.appleAppId))
                            .map((store) => (
                              <ConnectionRow
                                key={`${app.id}-${store}`}
                                app={app}
                                store={store}
                                client={client}
                                onConnection={applyConnection}
                                onUnauthorized={onUnauthorized}
                              />
                            ))}
                        </ul>
                        {panelHref && app.connections.some((item) => item.status === "active") && (
                          <Link className="button-secondary button-link" href={panelHref}>
                            Open the evolution panel
                          </Link>
                        )}
                      </>
                    ) : (
                      <p className="body muted">This app is not in your account. Choose another one or register it.</p>
                    )}
                    {!showRegister && (
                      <button type="button" className="button-quiet" onClick={() => setRegistering(true)}>
                        Register another app
                      </button>
                    )}
                  </>
                ) : (
                  <p className="body muted">No apps yet. Register one to see its connections here.</p>
                )}
              </aside>
            </div>
          </>
        )}
      </main>
    </>
  );
}
