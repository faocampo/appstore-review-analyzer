import type { ConnectionStatus, CoverageDayStatus, GuardrailStatus } from "@/server/api/contracts";
import type { Store } from "@/lib/types";

export const STORE_COPY: Record<Store, string> = {
  google_play: "Google Play",
  apple_app_store: "App Store",
};

export const COVERAGE_DAY_COPY: Record<CoverageDayStatus, string> = {
  complete: "Complete",
  partial: "Partial",
  unknown: "Unknown",
};

/** Guardrail statuses as mono pills; the word is always shown. */
export const GUARDRAIL_STATUS_COPY: Record<GuardrailStatus, { label: string; tone: "positive" | "negative" | "neutral" }> = {
  ok: { label: "OK", tone: "positive" },
  warn: { label: "Warn", tone: "neutral" },
  breach: { label: "Breach", tone: "negative" },
  insufficient: { label: "Insufficient", tone: "neutral" },
};

/** Connection statuses as status dots plus words (plan §3.7). */
export const CONNECTION_STATUS_COPY: Record<ConnectionStatus, { label: string; dot: "strong" | "on" | "off" }> = {
  active: { label: "Active", dot: "on" },
  pending: { label: "Pending verification", dot: "off" },
  error: { label: "Error", dot: "off" },
  disabled: { label: "Paused", dot: "off" },
};
