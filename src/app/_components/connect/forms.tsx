"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Pill, type Tone } from "@/app/_components/ui";
import { errorMessage, isUnauthorized, type PanelClient, type UploadRequest } from "@/app/_lib/api-client";
import { formatDateTime } from "@/app/_lib/dates";
import {
  createAppSchema,
  type AppDto,
  type ConnectionDto,
  type ImportResponse,
  type OnboardingResponse,
} from "@/server/api/contracts";

/** What the panel learns about a connection from a write or a verify. */
export type ConnectionPatch = Pick<ConnectionDto, "store" | "status"> & Partial<Pick<ConnectionDto, "lastError">>;

// ---------------------------------------------------------------------------
// Shared action state
// ---------------------------------------------------------------------------

interface Outcome {
  tone: Tone;
  label: string;
  message: string;
}

type ActionState = { status: "idle" } | { status: "busy" } | ({ status: "settled" } & Outcome);

function useAction(onUnauthorized: () => void): [ActionState, (task: () => Promise<string | Outcome>) => Promise<boolean>] {
  const [state, setState] = useState<ActionState>({ status: "idle" });
  async function run(task: () => Promise<string | Outcome>): Promise<boolean> {
    setState({ status: "busy" });
    try {
      const result = await task();
      setState(
        typeof result === "string"
          ? { status: "settled", tone: "positive", label: "Done", message: result }
          : { status: "settled", ...result },
      );
      return true;
    } catch (error) {
      if (isUnauthorized(error)) onUnauthorized();
      setState({ status: "settled", tone: "negative", label: "Error", message: errorMessage(error) });
      return false;
    }
  }
  return [state, run];
}

function ActionStatus({ state }: { state: ActionState }): ReactElement | null {
  if (state.status !== "settled") return null;
  return (
    <p className="form-status" role={state.tone === "negative" ? "alert" : "status"}>
      <Pill tone={state.tone}>{state.label}</Pill>
      <span>{state.message}</span>
    </p>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Register app
// ---------------------------------------------------------------------------

export function RegisterAppForm({
  client,
  onCreated,
  onUnauthorized,
}: {
  client: PanelClient;
  onCreated: (app: AppDto) => void;
  onUnauthorized: () => void;
}): ReactElement {
  const id = useId();
  const [values, setValues] = useState({ loomitAppId: "", name: "", androidPackage: "", appleAppId: "", playReportsBucket: "" });
  const [issues, setIssues] = useState<string[]>([]);
  const [state, run] = useAction(onUnauthorized);

  function update(key: keyof typeof values) {
    return (event: ChangeEvent<HTMLInputElement>) => setValues((current) => ({ ...current, [key]: event.target.value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = createAppSchema.safeParse({
      loomitAppId: values.loomitAppId,
      name: values.name,
      androidPackage: values.androidPackage.trim() || undefined,
      appleAppId: values.appleAppId.trim() || undefined,
      playReportsBucket: values.playReportsBucket.trim() || undefined,
    });
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => issue.message));
      return;
    }
    setIssues([]);
    void run(async () => {
      const app = await client.createApp(parsed.data);
      onCreated(app);
      setValues({ loomitAppId: "", name: "", androidPackage: "", appleAppId: "", playReportsBucket: "" });
      return `${app.name} is registered. Connect its stores next.`;
    });
  }

  return (
    <form className="form form--tight" onSubmit={handleSubmit} noValidate>
      <div className="field-grid">
        <Field id={`${id}-name`} label="App name">
          <input id={`${id}-name`} value={values.name} onChange={update("name")} placeholder="My puzzle game" required />
        </Field>
        <Field id={`${id}-loomit`} label="Loomit app ID">
          <input id={`${id}-loomit`} className="mono-input" value={values.loomitAppId} onChange={update("loomitAppId")} required />
        </Field>
        <Field id={`${id}-android`} label="Android package">
          <input id={`${id}-android`} className="mono-input" value={values.androidPackage} onChange={update("androidPackage")} placeholder="com.company.app" />
        </Field>
        <Field id={`${id}-apple`} label="Apple ID">
          <input id={`${id}-apple`} className="mono-input" inputMode="numeric" value={values.appleAppId} onChange={update("appleAppId")} placeholder="123456789" />
        </Field>
      </div>
      <Field
        id={`${id}-bucket`}
        label="Play reports bucket (optional)"
        hint="From Play Console → Download reports → Reviews. Needed to import more than the last week of Google Play reviews."
      >
        <input
          id={`${id}-bucket`}
          className="mono-input"
          value={values.playReportsBucket}
          onChange={update("playReportsBucket")}
          placeholder="pubsite_prod_…"
          aria-describedby={`${id}-bucket-hint`}
        />
      </Field>
      {issues.length > 0 && (
        <ul className="form-issues" role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button className="button-primary" type="submit" disabled={state.status === "busy"}>
          {state.status === "busy" ? "Registering…" : "Register app"}
        </button>
      </div>
      <ActionStatus state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Google Play: X3M's service account (recommended) or the publisher's own key
// ---------------------------------------------------------------------------

function serviceAccountEmail(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && "client_email" in parsed && typeof parsed.client_email === "string") {
      return parsed.client_email;
    }
  } catch {
    // Not JSON yet.
  }
  return null;
}

function OnFile({ connection }: { connection: ConnectionDto | undefined }): ReactElement | null {
  if (!connection) return null;
  return <p className="field__hint">A credential is on file and is never shown again. Saving again replaces it.</p>;
}

function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" className="button-secondary button-small" onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function PermissionList({ permissions }: { permissions: string[] }): ReactElement {
  return (
    <ul className="permission-list">
      {permissions.map((permission) => (
        <li key={permission}>{permission}</li>
      ))}
    </ul>
  );
}

function OwnKeyForm({
  client,
  app,
  permissions,
  onConnection,
  onUnauthorized,
}: {
  client: PanelClient;
  app: AppDto;
  permissions: string[];
  onConnection: (patch: ConnectionPatch) => void;
  onUnauthorized: () => void;
}): ReactElement {
  const id = useId();
  const [json, setJson] = useState("");
  const [state, run] = useAction(onUnauthorized);
  const email = serviceAccountEmail(json);
  const looksValid = json.trim().length >= 20 && email !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!looksValid) return;
    void run(async () => {
      const written = await client.putConnection(app.id, "google_play", { serviceAccountJson: json });
      setJson("");
      onConnection({ ...written, lastError: null });
      return "Key stored in the secret store. Verify the connection to start syncing.";
    });
  }

  return (
    <form className="form form--tight" onSubmit={handleSubmit}>
      <ol className="howto">
        <li>In your Google Cloud project, create a service account and download a JSON key.</li>
        <li>
          In Play Console → Users and permissions, invite that service account&apos;s email for{" "}
          <span className="mono">{app.androidPackage ?? "this app"}</span>
          {permissions.length ? " with only these permissions:" : " with read-only access."}
          {permissions.length > 0 && <PermissionList permissions={permissions} />}
        </li>
        <li>Paste the JSON key below. It goes straight to the secret store and is never shown again.</li>
      </ol>
      <Field
        id={`${id}-json`}
        label="Service-account JSON key"
        hint={
          email ? (
            <>
              Invite <span className="mono">{email}</span> in Play Console if you haven&apos;t yet.
            </>
          ) : json.trim() ? (
            "This doesn't look like a service-account key yet (no client_email)."
          ) : undefined
        }
      >
        <textarea
          id={`${id}-json`}
          className="mono-input"
          rows={5}
          spellCheck={false}
          autoComplete="off"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          placeholder='{ "type": "service_account", "client_email": "…", "private_key": "…" }'
          aria-describedby={`${id}-json-hint`}
        />
      </Field>
      <div className="form-actions">
        <button className="button-primary" type="submit" disabled={!looksValid || state.status === "busy"}>
          {state.status === "busy" ? "Saving…" : "Save my key"}
        </button>
      </div>
      <ActionStatus state={state} />
    </form>
  );
}

export function GooglePlayForm({
  client,
  app,
  onboarding,
  onboardingError,
  onConnection,
  onUnauthorized,
}: {
  client: PanelClient;
  app: AppDto;
  onboarding: OnboardingResponse | null;
  onboardingError: unknown;
  onConnection: (patch: ConnectionPatch) => void;
  onUnauthorized: () => void;
}): ReactElement {
  const [state, run] = useAction(onUnauthorized);
  const existing = app.connections.find((item) => item.store === "google_play");
  const email = onboarding?.googleServiceAccountEmail ?? null;
  const permissions = onboarding?.googlePermissions ?? [];
  const ownKey = (
    <OwnKeyForm client={client} app={app} permissions={permissions} onConnection={onConnection} onUnauthorized={onUnauthorized} />
  );

  function connectWithX3m(): void {
    void run(async () => {
      const written = await client.putConnection(app.id, "google_play", { useX3mServiceAccount: true });
      onConnection({ ...written, lastError: null });
      return "Connected with X3M's service account. Verify the connection to confirm Play Console accepted the invitation.";
    });
  }

  if (!onboarding && !onboardingError) {
    return <p className="body muted form--tight">Loading the X3M service account…</p>;
  }

  if (!email) {
    return (
      <div className="form--tight stack">
        <p className="card card--chip notice">
          <Pill tone="neutral">Not configured</Pill>
          <span className="body">
            {onboardingError
              ? `The onboarding details could not be loaded (${errorMessage(onboardingError)}), so connect with your own service-account key.`
              : "X3M's service account is not configured for this environment, so connect with your own service-account key."}
          </span>
        </p>
        <OnFile connection={existing} />
        {ownKey}
      </div>
    );
  }

  return (
    <div className="form form--tight">
      <ol className="howto">
        <li>
          In Play Console → Users and permissions, choose <em>Invite new users</em> and enter X3M&apos;s service account:
          <span className="copyable">
            <span className="mono copyable__text">{email}</span>
            <CopyButton text={email} />
          </span>
        </li>
        <li>
          Under App permissions, add <span className="mono">{app.androidPackage ?? "this app"}</span> and grant only:
          <PermissionList permissions={permissions} />
        </li>
        <li>Send the invitation, then connect below. No key leaves your Google account.</li>
      </ol>
      <OnFile connection={existing} />
      <div className="form-actions">
        <button className="button-primary" type="button" onClick={connectWithX3m} disabled={state.status === "busy"}>
          {state.status === "busy" ? "Connecting…" : "I've invited it, connect"}
        </button>
      </div>
      <ActionStatus state={state} />
      <details className="own-key">
        <summary>Use my own service-account key instead</summary>
        {ownKey}
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App Store (write-only key)
// ---------------------------------------------------------------------------

export function AppStoreForm({
  client,
  app,
  keyRole,
  onConnection,
  onUnauthorized,
}: {
  client: PanelClient;
  app: AppDto;
  keyRole: string;
  onConnection: (patch: ConnectionPatch) => void;
  onUnauthorized: () => void;
}): ReactElement {
  const id = useId();
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [state, run] = useAction(onUnauthorized);
  const existing = app.connections.find((item) => item.store === "apple_app_store");
  const looksValid =
    issuerId.trim().length >= 8 && keyId.trim().length >= 6 && privateKey.includes("PRIVATE KEY") && privateKey.length >= 100;

  async function loadKeyFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) setPrivateKey(await file.text());
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!looksValid) return;
    void run(async () => {
      const written = await client.putConnection(app.id, "apple_app_store", {
        issuerId: issuerId.trim(),
        keyId: keyId.trim(),
        privateKey,
      });
      setIssuerId("");
      setKeyId("");
      setPrivateKey("");
      onConnection({ ...written, lastError: null });
      return "Key stored in the secret store. Verify the connection to start syncing.";
    });
  }

  return (
    <form className="form form--tight" onSubmit={handleSubmit}>
      <ol className="howto">
        <li>
          In App Store Connect → Users and Access → Integrations → App Store Connect API, generate a team key with the{" "}
          <em>{keyRole}</em> role. It can read reviews and nothing else ReviewSignal needs.
        </li>
        <li>Copy the issuer ID and key ID, and download the .p8 file (Apple lets you download it once).</li>
        <li>Enter them below. They go straight to the secret store and are never shown again.</li>
      </ol>
      <div className="field-grid">
        <Field id={`${id}-issuer`} label="Issuer ID">
          <input
            id={`${id}-issuer`}
            className="mono-input"
            autoComplete="off"
            value={issuerId}
            onChange={(event) => setIssuerId(event.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
        </Field>
        <Field id={`${id}-key`} label="Key ID">
          <input
            id={`${id}-key`}
            className="mono-input"
            autoComplete="off"
            value={keyId}
            onChange={(event) => setKeyId(event.target.value)}
            placeholder="ABC123DEFG"
          />
        </Field>
      </div>
      <Field id={`${id}-p8`} label="Private key (.p8 contents)">
        <textarea
          id={`${id}-p8`}
          className="mono-input"
          rows={4}
          spellCheck={false}
          autoComplete="off"
          value={privateKey}
          onChange={(event) => setPrivateKey(event.target.value)}
          placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
        />
      </Field>
      <label className="upload upload--inline">
        <span className="label">Or load the .p8 file</span>
        <span className="upload__file">Choose AuthKey_….p8</span>
        <input type="file" accept=".p8,application/pkcs8,text/plain" onChange={(event) => void loadKeyFile(event)} />
      </label>
      <OnFile connection={existing} />
      <div className="form-actions">
        <button className="button-primary" type="submit" disabled={!looksValid || state.status === "busy"}>
          {state.status === "busy" ? "Saving…" : existing ? "Replace key" : "Save key"}
        </button>
      </div>
      <ActionStatus state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// CSV import via presigned upload, then poll until processed
// ---------------------------------------------------------------------------

type ImportStep = "url" | "upload" | "queue" | "process";
type StepState = "todo" | "busy" | "done" | "failed" | "running";

const IMPORT_STEPS: Array<{ step: ImportStep; label: string }> = [
  { step: "url", label: "Request an upload link" },
  { step: "upload", label: "Upload the file" },
  { step: "queue", label: "Queue the import" },
  { step: "process", label: "Import the reviews" },
];

const STEP_WORDS: Record<StepState, string> = {
  todo: "Waiting",
  busy: "Working",
  done: "Done",
  failed: "Failed",
  running: "Still running",
};

const MAX_BYTES = 50_000_000;
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 120_000;

export function CsvImportForm({
  client,
  app,
  onImported,
  onUnauthorized,
}: {
  client: PanelClient;
  app: AppDto;
  onImported: () => void;
  onUnauthorized: () => void;
}): ReactElement {
  const id = useId();
  const alive = useRef(true);
  const [platform, setPlatform] = useState<UploadRequest["platform"]>(app.androidPackage ? "android" : "ios");
  const [file, setFile] = useState<File | null>(null);
  const [steps, setSteps] = useState<Record<ImportStep, StepState> | null>(null);
  const [state, run] = useAction(onUnauthorized);
  const tooLarge = file !== null && file.size > MAX_BYTES;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!file || tooLarge) return;
    const current = file;
    let active: ImportStep = "url";
    const mark = (step: ImportStep, status: StepState) =>
      setSteps((prev) => ({ ...(prev ?? { url: "todo", upload: "todo", queue: "todo", process: "todo" }), [step]: status }));
    const advance = (done: ImportStep, next: ImportStep) => {
      mark(done, "done");
      active = next;
      mark(next, "busy");
    };
    setSteps({ url: "busy", upload: "todo", queue: "todo", process: "todo" });

    void run(async () => {
      try {
        const upload = await client.createUpload(app.id, { fileName: current.name, platform, byteSize: current.size });
        advance("url", "upload");
        await client.uploadFile(upload, current);
        advance("upload", "queue");
        let result: ImportResponse = await client.startImport(app.id, upload.uploadId);
        advance("queue", "process");
        onImported();

        const deadline = Date.now() + POLL_LIMIT_MS;
        while (result.status === "pending" && alive.current && Date.now() < deadline) {
          await sleep(POLL_MS);
          result = await client.getUpload(app.id, upload.uploadId);
        }

        if (result.status === "imported") {
          mark("process", "done");
          setFile(null);
          return result.importedAt
            ? `Reviews imported ${formatDateTime(result.importedAt)}. They appear in the evolution panel now.`
            : "Reviews imported. They appear in the evolution panel now.";
        }
        if (result.status === "failed") {
          mark("process", "failed");
          return { tone: "negative" as const, label: "Import failed", message: result.error ?? "The import failed." };
        }
        mark("process", "running");
        return {
          tone: "neutral" as const,
          label: "Still running",
          message: "The import is still running after 2 minutes. It continues in the background; check the panel later.",
        };
      } catch (error) {
        mark(active, "failed");
        throw error;
      }
    });
  }

  return (
    <form className="form form--tight" onSubmit={handleSubmit}>
      <p className="body muted">
        Backfill history from store exports: Google Play review reports (CSV) or an App Store review export. Files up to 50 MB.
        The file goes directly to storage through a short-lived link.
      </p>
      <div className="field-grid">
        <Field id={`${id}-platform`} label="Store export">
          <select id={`${id}-platform`} value={platform} onChange={(event) => setPlatform(event.target.value as UploadRequest["platform"])}>
            <option value="android">Google Play reviews CSV</option>
            <option value="ios">App Store reviews CSV</option>
          </select>
        </Field>
        <div className="field">
          <span className="label">File</span>
          <label className="upload">
            <span className="upload__file">{file ? `${file.name} · ${(file.size / 1_000_000).toFixed(1)} MB` : "Choose a CSV file"}</span>
            <input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} aria-label="CSV file" />
          </label>
        </div>
      </div>
      {tooLarge && <p className="form-issues" role="alert">This file is over 50 MB. Split it by month and upload each part.</p>}
      {steps && (
        <ol className="import-steps">
          {IMPORT_STEPS.map(({ step, label }) => {
            const status = steps[step];
            const dot = status === "busy" || status === "running" ? "strong" : status === "done" ? "on" : "off";
            return (
              <li key={step}>
                <span className={`dot is-${dot}`} aria-hidden="true" />
                <span>{label}</span>
                <span className="mono muted">{STEP_WORDS[status]}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="form-actions">
        <button className="button-primary" type="submit" disabled={!file || tooLarge || state.status === "busy"}>
          {state.status === "busy" ? "Importing…" : "Upload and import"}
        </button>
      </div>
      <ActionStatus state={state} />
    </form>
  );
}
