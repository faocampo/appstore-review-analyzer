"use client";

import Image from "next/image";
import Link from "next/link";
import { type FormEvent, type ReactElement, type ReactNode, useId, useState } from "react";

import { errorMessage, isUnauthorized, readAccessToken, writeAccessToken } from "@/app/_lib/api-client";

export type Tone = "positive" | "negative" | "neutral";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }): ReactElement {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

/** Status dot plus the status word; the word is always shown, colour only reinforces it. */
export function StatusWord({
  dot,
  children,
}: {
  dot: "strong" | "on" | "off";
  children: ReactNode;
}): ReactElement {
  return (
    <span className="status">
      <span className={`dot is-${dot}`} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function SampleTag(): ReactElement {
  return <span className="sample-tag">Sample data</span>;
}

export function PanelTopbar({
  context,
  children,
}: {
  context?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <Image src="/brand/loomit-logo-teal.png" alt="loomit" width={84} height={22} priority />
        <span className="topbar__divider" aria-hidden="true" />
        <span className="topbar__product">ReviewSignal</span>
        {context && <span className="eyebrow topbar__eyebrow">{context}</span>}
      </div>
      {children && <nav className="topbar__nav">{children}</nav>}
    </header>
  );
}

export function NavLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <Link className="nav-link" href={href}>
      {children}
    </Link>
  );
}

export function LoadingCard({ eyebrow, title }: { eyebrow: string; title: string }): ReactElement {
  return (
    <div className="card empty-state" aria-busy="true">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title">{title}</h2>
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }): ReactElement {
  return (
    <div className="card card--chip alert" role="alert">
      <Pill tone="negative">Error</Pill>
      <p className="body">{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="button-quiet alert__action" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Asks for a bearer token after a 401; the token is kept in sessionStorage only. */
export function AccessTokenGate({ onSaved }: { onSaved: () => void }): ReactElement {
  const id = useId();
  const [token, setToken] = useState(readAccessToken);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    writeAccessToken(token.trim());
    onSaved();
  }

  return (
    <form className="card token-gate" onSubmit={handleSubmit}>
      <p className="eyebrow">Access token required</p>
      <h2 className="card-title">Sign in to load this panel</h2>
      <p className="body muted">
        The ReviewSignal API answered 401. Paste the access token from your Loomit admin. It is
        kept in this browser tab only.
      </p>
      <div className="token-gate__row">
        <label className="visually-hidden" htmlFor={id}>
          Access token
        </label>
        <input
          id={id}
          className="mono-input"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Bearer token"
          required
        />
        <button className="button-primary" type="submit">
          Use token
        </button>
      </div>
    </form>
  );
}

/** Error or token prompt, depending on the failure. */
export function RequestProblem({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): ReactElement {
  return isUnauthorized(error) ? <AccessTokenGate onSaved={onRetry} /> : <ErrorNotice error={error} onRetry={onRetry} />;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/** Compact single-choice control (radio semantics). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
}): ReactElement {
  return (
    <div className="filter">
      <span className="label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={option.value === value ? "seg__option is-active" : "seg__option"}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A KPI value, or "Insufficient data" when the API withheld it. */
export function KpiValue({
  value,
  unit,
}: {
  value: string | null;
  unit?: string;
}): ReactElement {
  if (value === null) return <p className="kpi__value kpi__value--na">Insufficient data</p>;
  return (
    <p className="kpi__value">
      {value}
      {unit && <span className="kpi__unit">{unit}</span>}
    </p>
  );
}
