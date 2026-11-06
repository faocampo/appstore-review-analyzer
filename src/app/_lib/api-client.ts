/**
 * Typed client for ReviewSignal API v1, used by the publisher panels.
 *
 * - The base URL comes from NEXT_PUBLIC_API_URL; every call sends the bearer
 *   token kept in sessionStorage (shared with the dev harness on `/`).
 * - Errors arrive as `{ error, details? }` and surface as ApiRequestError.
 * - In fixture mode (no API URL, or `?fixture=1`) the same interface is served
 *   from typed, clearly synthetic fixtures so the panels render without a backend.
 */
import type { z } from "zod";

import type {
  AppDto,
  AppsResponse,
  ConnectionWriteResponse,
  CreateAppRequest,
  GuardrailResponse,
  ImportResponse,
  OnboardingResponse,
  VerifyResponse,
  ReasonsResponse,
  ReviewsResponse,
  TimeseriesResponse,
  UploadResponse,
  VersionsResponse,
  CoverageResponse,
  appleCredentialsSchema,
  googleCredentialsSchema,
  uploadRequestSchema,
} from "@/server/api/contracts";
import type { Store } from "@/lib/types";

// ---------------------------------------------------------------------------
// Request shapes (derived from the contract schemas where they exist)
// ---------------------------------------------------------------------------

export interface RangeParams {
  from: string;
  to: string;
  store?: Store;
  territory?: string;
  appVersion?: string;
}

export interface TimeseriesParams extends RangeParams {
  granularity: "day" | "week";
}

export interface ReasonsParams extends RangeParams {
  group: ReasonsResponse["group"];
}

/** Mirrors reviewsQuerySchema (its `limit` is coerced, so its input type is `unknown`). */
export interface ReviewsParams extends RangeParams {
  sentiment?: "negative" | "neutral" | "positive";
  reason?: string;
  limit?: number;
  cursor?: string;
}
export type GoogleCredentials = z.input<typeof googleCredentialsSchema>;
export type AppleCredentials = z.input<typeof appleCredentialsSchema>;
export type StoreCredentials = GoogleCredentials | AppleCredentials;
export type UploadRequest = z.input<typeof uploadRequestSchema>;

export interface PanelClient {
  readonly fixture: boolean;
  listApps(): Promise<AppsResponse>;
  createApp(input: CreateAppRequest): Promise<AppDto>;
  getApp(appId: string): Promise<AppDto>;
  getOnboarding(): Promise<OnboardingResponse>;
  putConnection(appId: string, store: Store, credentials: StoreCredentials): Promise<ConnectionWriteResponse>;
  verifyConnection(appId: string, store: Store): Promise<VerifyResponse>;
  createUpload(appId: string, request: UploadRequest): Promise<UploadResponse>;
  uploadFile(upload: UploadResponse, file: File): Promise<void>;
  startImport(appId: string, uploadId: string): Promise<ImportResponse>;
  getUpload(appId: string, uploadId: string): Promise<ImportResponse>;
  getTimeseries(appId: string, params: TimeseriesParams): Promise<TimeseriesResponse>;
  getReasons(appId: string, params: ReasonsParams): Promise<ReasonsResponse>;
  getVersions(appId: string, params: RangeParams): Promise<VersionsResponse>;
  getReviews(appId: string, params: ReviewsParams): Promise<ReviewsResponse>;
  getCoverage(appId: string, params: RangeParams): Promise<CoverageResponse>;
  getGuardrails(loomitExperimentId: string): Promise<GuardrailResponse>;
}

// ---------------------------------------------------------------------------
// Configuration and token storage
// ---------------------------------------------------------------------------

export const TOKEN_STORAGE_KEY = "reviewsignal.accessToken";

export function apiBaseUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_API_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

/** Fixture mode: no API configured, or explicitly requested with `?fixture=1`. */
export function isFixtureMode(searchParams: Record<string, string | string[] | undefined>): boolean {
  const flag = searchParams.fixture;
  return !apiBaseUrl() || flag === "1" || (Array.isArray(flag) && flag.includes("1"));
}

export function readAccessToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeAccessToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); nothing to persist then.
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

export function errorMessage(error: unknown, fallback = "The request could not be completed."): string {
  if (error instanceof ApiRequestError) {
    return error.details.length ? `${error.message} ${error.details.join(" ")}` : error.message;
  }
  if (error instanceof TypeError) return "The ReviewSignal API could not be reached.";
  return error instanceof Error && error.message ? error.message : fallback;
}

type QueryValue = string | number | undefined | null;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const base = apiBaseUrl();
  if (!base) throw new ApiRequestError("NEXT_PUBLIC_API_URL is not configured.", 0);
  const url = new URL(`${base}/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseError(status: number, body: unknown): ApiRequestError {
  let message = status === 401 ? "An access token is required." : `Request failed (${status}).`;
  let details: string[] = [];
  if (typeof body === "object" && body !== null) {
    if ("error" in body && typeof body.error === "string") message = body.error;
    if ("details" in body && Array.isArray(body.details)) {
      details = body.details.filter((detail): detail is string => typeof detail === "string");
    }
  }
  return new ApiRequestError(message, status, details);
}

async function request<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  options: { query?: Record<string, QueryValue>; body?: unknown } = {},
): Promise<T> {
  const token = readAccessToken();
  const response = await fetch(buildUrl(path, options.query), {
    method,
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw parseError(response.status, body);
  return body as T;
}

const enc = encodeURIComponent;

function rangeQuery(params: RangeParams): Record<string, QueryValue> {
  return {
    from: params.from,
    to: params.to,
    store: params.store,
    territory: params.territory,
    appVersion: params.appVersion,
  };
}

const httpClient: PanelClient = {
  fixture: false,
  listApps: () => request<AppsResponse>("GET", "/apps"),
  createApp: (input) => request<AppDto>("POST", "/apps", { body: input }),
  getApp: (appId) => request<AppDto>("GET", `/apps/${enc(appId)}`),
  getOnboarding: () => request<OnboardingResponse>("GET", "/onboarding"),
  putConnection: (appId, store, credentials) =>
    request<ConnectionWriteResponse>("PUT", `/apps/${enc(appId)}/connections/${store}`, { body: credentials }),
  verifyConnection: (appId, store) =>
    request<VerifyResponse>("POST", `/apps/${enc(appId)}/connections/${store}/verify`),
  createUpload: (appId, upload) =>
    request<UploadResponse>("POST", `/apps/${enc(appId)}/uploads`, { body: upload }),
  async uploadFile(upload, file) {
    // Presigned URL: no bearer token, the signature authorizes the PUT. Send exactly
    // the signed headers; the browser's file.type would break the signature.
    const response = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: upload.headers,
      body: file,
    });
    if (!response.ok) {
      throw new ApiRequestError(`The file upload failed (${response.status}).`, response.status);
    }
  },
  startImport: (appId, uploadId) =>
    request<ImportResponse>("POST", `/apps/${enc(appId)}/imports`, { body: { uploadId } }),
  getUpload: (appId, uploadId) =>
    request<ImportResponse>("GET", `/apps/${enc(appId)}/uploads/${enc(uploadId)}`),
  getTimeseries: (appId, params) =>
    request<TimeseriesResponse>("GET", `/apps/${enc(appId)}/timeseries`, {
      query: { ...rangeQuery(params), granularity: params.granularity },
    }),
  getReasons: (appId, params) =>
    request<ReasonsResponse>("GET", `/apps/${enc(appId)}/reasons`, {
      query: { ...rangeQuery(params), group: params.group },
    }),
  getVersions: (appId, params) =>
    request<VersionsResponse>("GET", `/apps/${enc(appId)}/versions`, { query: rangeQuery(params) }),
  getReviews: (appId, params) =>
    request<ReviewsResponse>("GET", `/apps/${enc(appId)}/reviews`, {
      query: {
        ...rangeQuery(params),
        sentiment: params.sentiment,
        reason: params.reason,
        limit: params.limit,
        cursor: params.cursor,
      },
    }),
  getCoverage: (appId, params) =>
    request<CoverageResponse>("GET", `/apps/${enc(appId)}/coverage`, { query: rangeQuery(params) }),
  getGuardrails: (loomitExperimentId) =>
    request<GuardrailResponse>("GET", `/experiments/${enc(loomitExperimentId)}/guardrails`),
};

// ---------------------------------------------------------------------------
// Fixture client (code-split: fixtures only load in fixture mode)
// ---------------------------------------------------------------------------

const fixtures = () => import("./fixtures");

const fixtureClient: PanelClient = {
  fixture: true,
  listApps: async () => (await fixtures()).fixtureListApps(),
  createApp: async (input) => (await fixtures()).fixtureCreateApp(input),
  getApp: async (appId) => (await fixtures()).fixtureGetApp(appId),
  getOnboarding: async () => (await fixtures()).fixtureOnboarding(),
  putConnection: async (appId, store) => (await fixtures()).fixturePutConnection(appId, store),
  verifyConnection: async (appId, store) => (await fixtures()).fixtureVerifyConnection(appId, store),
  createUpload: async (appId, upload) => (await fixtures()).fixtureCreateUpload(appId, upload),
  uploadFile: async () => {
    // Nothing leaves the browser in fixture mode.
  },
  startImport: async (appId, uploadId) => (await fixtures()).fixtureStartImport(appId, uploadId),
  getUpload: async (appId, uploadId) => (await fixtures()).fixtureGetUpload(appId, uploadId),
  getTimeseries: async (appId, params) => (await fixtures()).fixtureTimeseries(appId, params),
  getReasons: async (appId, params) => (await fixtures()).fixtureReasons(appId, params),
  getVersions: async (appId, params) => (await fixtures()).fixtureVersions(appId, params),
  getReviews: async (appId, params) => (await fixtures()).fixtureReviews(appId, params),
  getCoverage: async (appId, params) => (await fixtures()).fixtureCoverage(appId, params),
  getGuardrails: async (experimentId) => (await fixtures()).fixtureGuardrails(experimentId),
};

export function panelClient(fixture: boolean): PanelClient {
  return fixture ? fixtureClient : httpClient;
}
