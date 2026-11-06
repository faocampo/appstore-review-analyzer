export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Reads an integer environment variable, clamped to a safe range. */
export function envInteger(
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

/** True when a secret is present and is not a `.env.example` placeholder. */
export function isConfigured(value: string | undefined): value is string {
  return Boolean(value && !value.endsWith("_placeholder"));
}
