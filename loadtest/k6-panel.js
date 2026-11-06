// k6 load test for the ReviewSignal evolution panel API.
//
// Each iteration is one panel load: the panel requests timeseries, reasons
// and the first page of reviews in parallel, and 25% of loads open a second
// page of reviews. Thresholds encode the SLOs in docs/operations/slo.md:
// p95 < 500 ms per endpoint and < 0.5% failed requests.
//
// Usage (see loadtest/README.md):
//   BASE_URL=https://reviewsignal.staging.example \
//   API_TOKEN=<bearer token for the load-test publisher> \
//   APP_IDS=<appId>[,<appId>...] \
//   k6 run loadtest/k6-panel.js
//
// Optional: PROFILE=smoke|load|stress (default load), RATE (panel loads per
// second, overrides the profile), DURATION (e.g. 10m), RANGES_DAYS (default
// 7,30,90), STORE (google_play|apple_app_store).

import http from "k6/http";
import { check, fail } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "").replace(/\/+$/, "");
const API_TOKEN = __ENV.API_TOKEN || "";
const APP_IDS = (__ENV.APP_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const RANGES_DAYS = (__ENV.RANGES_DAYS || "7,30,90")
  .split(",")
  .map((value) => Number.parseInt(value, 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const STORE = __ENV.STORE || "";

// Panel loads per second. Each load issues 3 requests (3.25 on average).
const PROFILES = {
  smoke: { rate: 1, duration: "1m", vus: 5, maxVUs: 10 },
  load: { rate: 20, duration: "10m", vus: 50, maxVUs: 200 },
  stress: { rate: 60, duration: "10m", vus: 150, maxVUs: 600 },
};
const profile = PROFILES[__ENV.PROFILE || "load"];
if (!profile) {
  throw new Error(`Unknown PROFILE "${__ENV.PROFILE}". Use smoke, load or stress.`);
}
const rate = Number.parseInt(__ENV.RATE || `${profile.rate}`, 10);
const duration = __ENV.DURATION || profile.duration;

export const options = {
  scenarios: {
    panel: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: profile.vus,
      maxVUs: profile.maxVUs,
      stages: [
        { target: rate, duration: "1m" },
        { target: rate, duration },
        { target: 0, duration: "30s" },
      ],
    },
  },
  thresholds: {
    "http_req_duration{endpoint:timeseries}": ["p(95)<500"],
    "http_req_duration{endpoint:reasons}": ["p(95)<500"],
    "http_req_duration{endpoint:reviews}": ["p(95)<500"],
    // Any status >= 400 counts as failed (k6 default expected statuses).
    http_req_failed: [{ threshold: "rate<0.005", abortOnFail: true, delayAbortEval: "1m" }],
    checks: ["rate>0.995"],
    dropped_iterations: ["count<1"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  userAgent: "reviewsignal-loadtest/1.0 (k6)",
};

const panelLoads = new Counter("panel_loads");

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function query(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function request(endpoint, appId, params) {
  return {
    method: "GET",
    url: `${BASE_URL}/v1/apps/${encodeURIComponent(appId)}/${endpoint}?${query(params)}`,
    params: {
      headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: "application/json" },
      // Group URLs by route so per-app ids do not explode metric cardinality.
      tags: { endpoint, name: `/v1/apps/{appId}/${endpoint}` },
      timeout: "10s",
    },
  };
}

export function setup() {
  if (!BASE_URL || !API_TOKEN || APP_IDS.length === 0) {
    fail("BASE_URL, API_TOKEN and APP_IDS are required (see loadtest/README.md).");
  }
  if (!BASE_URL.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE_URL)) {
    fail("BASE_URL must use https:// (plain http is allowed for localhost only).");
  }
  if (RANGES_DAYS.length === 0) {
    fail("RANGES_DAYS must list at least one positive number of days.");
  }
  // Fail fast on credentials or app ids before generating load.
  const to = isoDate(new Date());
  const from = isoDate(new Date(Date.now() - 7 * 86_400_000));
  for (const appId of APP_IDS) {
    const { url, params } = request("timeseries", appId, { from, to, granularity: "day" });
    const response = http.get(url, params);
    if (response.status !== 200) {
      exec.test.abort(`Preflight GET timeseries for app ${appId} returned ${response.status}; check API_TOKEN and APP_IDS.`);
    }
  }
  return { startedAt: new Date().toISOString() };
}

export default function panelLoad() {
  const appId = pick(APP_IDS);
  const days = pick(RANGES_DAYS);
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const range = { from: isoDate(from), to: isoDate(to), store: STORE };
  const granularity = days > 31 ? "week" : "day";

  const [timeseries, reasons, reviews] = http.batch([
    request("timeseries", appId, { ...range, granularity }),
    request("reasons", appId, { ...range, group: "negative" }),
    request("reviews", appId, { ...range, limit: 50 }),
  ]);
  panelLoads.add(1);

  check(timeseries, {
    "timeseries 200": (r) => r.status === 200,
    "timeseries has points": (r) => r.status === 200 && Array.isArray(r.json("points")),
  });
  check(reasons, {
    "reasons 200": (r) => r.status === 200,
    "reasons has list": (r) => r.status === 200 && Array.isArray(r.json("reasons")),
  });
  const reviewsOk = check(reviews, {
    "reviews 200": (r) => r.status === 200,
    "reviews has items": (r) => r.status === 200 && Array.isArray(r.json("items")),
  });

  // A quarter of panel loads page through the review drill-down.
  if (reviewsOk && Math.random() < 0.25) {
    const cursor = reviews.json("nextCursor");
    if (cursor) {
      const { url, params } = request("reviews", appId, { ...range, limit: 50, cursor });
      check(http.get(url, params), { "reviews page 2 200": (r) => r.status === 200 });
    }
  }
}
