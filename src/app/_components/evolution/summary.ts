import { sentimentWord } from "@/app/format";
import { addDays, daysBetween } from "@/app/_lib/dates";
import { formatCount, formatFixed, formatShare, formatSigned } from "@/app/_lib/numbers";
import type { TimeseriesPoint, TimeseriesTotals, VersionSummary } from "@/server/api/contracts";

export function sortedVersions(versions: VersionSummary[]): VersionSummary[] {
  return versions.slice().sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || a.appVersion.localeCompare(b.appVersion));
}

/**
 * Point-stating title from the data only: the latest version's change vs. the
 * previous one when both had enough reviews, else a neutral description.
 */
export function evolutionHeadline(
  versions: VersionSummary[],
  totals: TimeseriesTotals,
  minN: number,
): { title: string; subtitle: string } {
  const ordered = sortedVersions(versions);
  const latest = ordered.at(-1);
  const previous = ordered.at(-2);

  if (
    latest &&
    previous &&
    latest.status === "ok" &&
    latest.deltaSentiment !== null &&
    latest.averageSentiment !== null &&
    previous.averageSentiment !== null
  ) {
    const delta = latest.deltaSentiment;
    const verb = delta <= -0.05 ? "fell" : delta >= 0.05 ? "rose" : "held steady";
    const title = `Sentiment ${verb} after v${latest.appVersion}`;
    let subtitle = `Average sentiment went from ${formatFixed(previous.averageSentiment)} on v${previous.appVersion} to ${formatFixed(latest.averageSentiment)} on v${latest.appVersion} (${formatSigned(delta)} on a 0–4 scale, n = ${formatCount(latest.n)}).`;
    if (latest.adsNegativeShare !== null && previous.adsNegativeShare !== null) {
      const direction =
        latest.adsNegativeShare > previous.adsNegativeShare
          ? "up from"
          : latest.adsNegativeShare < previous.adsNegativeShare
            ? "down from"
            : "the same as";
      subtitle += ` Ads are behind ${formatShare(latest.adsNegativeShare)} of negative reviews on v${latest.appVersion}, ${direction} ${formatShare(previous.adsNegativeShare)}.`;
    }
    return { title, subtitle };
  }

  if (totals.averageSentiment !== null) {
    return {
      title: `Sentiment is ${sentimentWord(totals.averageSentiment)} across ${formatCount(totals.n)} reviews`,
      subtitle: "No version in this range has enough reviews to compare with the one before it.",
    };
  }

  return {
    title: "Not enough reviews yet to state a trend",
    subtitle: `Values appear once a period has at least ${minN} written reviews.`,
  };
}

/** Where a bucket sits on the date axis, clipped to the selected range. */
export function bucketGeometry(
  period: string,
  granularity: "day" | "week",
  from: string,
  to: string,
): { center: string; width: number } {
  if (granularity === "day") return { center: period, width: 1 };
  const start = period < from ? from : period;
  const rawEnd = addDays(period, 6);
  const end = rawEnd > to ? to : rawEnd;
  const length = Math.max(0, daysBetween(start, end));
  return { center: addDays(start, Math.round(length / 2)), width: length + 1 };
}

/** A y-axis domain for the 0–4 sentiment scale that fits the data and its intervals. */
export function sentimentDomain(points: TimeseriesPoint[]): { domain: [number, number]; ticks: number[] } {
  let low = 4;
  let high = 0;
  for (const point of points) {
    if (point.averageSentiment === null) continue;
    low = Math.min(low, point.sentimentCi?.[0] ?? point.averageSentiment);
    high = Math.max(high, point.sentimentCi?.[1] ?? point.averageSentiment);
  }
  if (low > high) return { domain: [0, 4], ticks: [0, 1, 2, 3, 4] };
  const lo = Math.max(0, Math.floor(low * 2) / 2 - 0.5);
  const hi = Math.min(4, Math.ceil(high * 2) / 2 + 0.5);
  const step = hi - lo > 2.5 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let tick = Math.ceil(lo / step) * step; tick <= hi + 1e-9; tick += step) ticks.push(Number(tick.toFixed(2)));
  return { domain: [lo, hi], ticks };
}
