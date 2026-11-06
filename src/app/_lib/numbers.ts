/** Number formatting for the panels. A true minus sign (U+2212) is used for negatives. */

const MINUS = "−";
const COUNT = new Intl.NumberFormat("en");

export function formatCount(value: number): string {
  return COUNT.format(value);
}

export function formatFixed(value: number, digits = 2): string {
  const text = Math.abs(value).toFixed(digits);
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text;
}

/** "+0.12" / "−0.46" / "0.00" */
export function formatSigned(value: number, digits = 2): string {
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return text;
  return `${value < 0 ? MINUS : "+"}${text}`;
}

/** A 0–1 share as a whole percentage: "38%". */
export function formatShare(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** A 0–1 share difference as percentage points: "+9.8 pts". */
export function formatPoints(value: number, digits = 1): string {
  return `${formatSigned(value * 100, digits)} pts`;
}

export function formatPValue(value: number): string {
  if (value < 0.001) return "p < 0.001";
  return `p = ${value.toFixed(3)}`;
}
