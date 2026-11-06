/**
 * UTC calendar-date helpers for the panels. Dates are ISO `YYYY-MM-DD`
 * strings throughout, matching the API v1 contract.
 */

const DAY_MS = 86_400_000;

function toTime(isoDate: string): number {
  return Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
}

function fromTime(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Today's UTC date. Call from event handlers, effects or server code, not render. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return fromTime(toTime(isoDate) + days * DAY_MS);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY_MS);
}

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let time = toTime(from), end = toTime(to); time <= end; time += DAY_MS) {
    days.push(fromTime(time));
  }
  return days;
}

/** Monday of the ISO week that contains the date. */
export function isoWeekStart(isoDate: string): string {
  const weekday = new Date(toTime(isoDate)).getUTCDay();
  return addDays(isoDate, -((weekday + 6) % 7));
}

/** Position of a date (plus a fractional day offset) on [from, to] as 0–1. */
export function dateFraction(isoDate: string, from: string, to: string, offsetDays = 0): number {
  const span = Math.max(1, toTime(to) - toTime(from));
  return (toTime(isoDate) + offsetDays * DAY_MS - toTime(from)) / span;
}

const SHORT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});

/** "Oct 3" */
export function formatShortDate(isoDate: string): string {
  return SHORT.format(new Date(toTime(isoDate)));
}

/** "Oct 3, 2026, 14:05 UTC" */
export function formatDateTime(isoDateTime: string): string {
  return `${DATE_TIME.format(new Date(isoDateTime))} UTC`;
}
