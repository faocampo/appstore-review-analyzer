import { z } from "zod";

import {
  appleCredentialsSchema,
  createAppSchema,
  googleCredentialsSchema,
  linkExperimentSchema,
  uploadRequestSchema,
} from "@/server/api/contracts";

/**
 * OpenAPI 3.1 description of API v1. Request bodies are generated from the
 * same Zod schemas the server validates with; responses reference the
 * TypeScript contracts in src/server/api/contracts.ts (described here at the
 * level Loomit's Kotlin client needs).
 */
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

const bearer = [{ bearerAuth: [] }];
const publisherHeader = {
  name: "X-Loomit-Publisher-Id",
  in: "header",
  required: false,
  description: "Required for service and x3m_admin tokens: the publisher the request acts for.",
  schema: { type: "string" },
};
const appId = { name: "appId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const experimentId = { name: "experimentId", in: "path", required: true, description: "Loomit experiment id.", schema: { type: "string" } };
const store = { name: "store", in: "path", required: true, schema: { type: "string", enum: ["google_play", "apple_app_store"] } };
const range = [
  { name: "from", in: "query", required: true, schema: { type: "string", format: "date" } },
  { name: "to", in: "query", required: true, schema: { type: "string", format: "date" } },
  { name: "store", in: "query", schema: { type: "string", enum: ["google_play", "apple_app_store"] } },
  { name: "appVersion", in: "query", schema: { type: "string" } },
  { name: "territory", in: "query", schema: { type: "string" } },
];
const errors = {
  "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "401": { description: "Missing or invalid token" },
  "403": { description: "Role not allowed" },
  "404": { description: "Not found" },
  "429": { description: "Rate limited" },
};
const ok = (description: string, schema: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
});
const body = (schema: object) => ({ required: true, content: { "application/json": { schema } } });

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "ReviewSignal API",
    version: "1.0.0",
    description:
      "Review intelligence for Loomit publishers: ingestion of owned-app store reviews, classification, evolution metrics and experiment guardrails.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      Error: { type: "object", required: ["error"], properties: { error: { type: "string" }, details: { type: "array", items: { type: "string" } } } },
      CreateAppRequest: json(createAppSchema),
      GoogleCredentials: json(googleCredentialsSchema),
      AppleCredentials: json(appleCredentialsSchema),
      UploadRequest: json(uploadRequestSchema),
      LinkExperimentRequest: json(linkExperimentSchema),
      App: { type: "object", description: "AppDto in contracts.ts" },
      Timeseries: { type: "object", description: "TimeseriesResponse in contracts.ts" },
      Reasons: { type: "object", description: "ReasonsResponse in contracts.ts" },
      Versions: { type: "object", description: "VersionsResponse in contracts.ts" },
      Reviews: { type: "object", description: "ReviewsResponse in contracts.ts" },
      Coverage: { type: "object", description: "CoverageResponse in contracts.ts" },
      Guardrails: { type: "object", description: "GuardrailResponse in contracts.ts" },
    },
  },
  security: bearer,
  paths: {
    "/v1/apps": {
      get: { summary: "List the publisher's apps", parameters: [publisherHeader], responses: { "200": { description: "Apps" }, ...errors } },
      post: {
        summary: "Register or update an app",
        parameters: [publisherHeader],
        requestBody: body({ $ref: "#/components/schemas/CreateAppRequest" }),
        responses: { "201": ok("Created", "App"), ...errors },
      },
    },
    "/v1/apps/{appId}": { get: { summary: "Get an app with its connections", parameters: [appId, publisherHeader], responses: { "200": ok("App", "App"), ...errors } } },
    "/v1/apps/{appId}/connections/{store}": {
      put: {
        summary: "Store credentials for a store (write-only)",
        parameters: [appId, store, publisherHeader],
        requestBody: body({ oneOf: [{ $ref: "#/components/schemas/GoogleCredentials" }, { $ref: "#/components/schemas/AppleCredentials" }] }),
        responses: { "202": { description: "Stored; verify next" }, ...errors },
      },
      delete: { summary: "Disconnect and delete credentials", parameters: [appId, store, publisherHeader], responses: { "204": { description: "Deleted" }, ...errors } },
    },
    "/v1/apps/{appId}/connections/{store}/verify": {
      post: { summary: "Verify credentials and start the first sync", parameters: [appId, store, publisherHeader], responses: { "200": { description: "Verification result" }, ...errors } },
    },
    "/v1/apps/{appId}/sync": { post: { summary: "Queue a sync of every connection", parameters: [appId, publisherHeader], responses: { "202": { description: "Queued" }, ...errors } } },
    "/v1/apps/{appId}/uploads": {
      post: {
        summary: "Get a presigned URL for a CSV upload",
        parameters: [appId, publisherHeader],
        requestBody: body({ $ref: "#/components/schemas/UploadRequest" }),
        responses: { "201": { description: "Presigned upload" }, ...errors },
      },
    },
    "/v1/apps/{appId}/imports": {
      post: {
        summary: "Import an uploaded CSV",
        parameters: [appId, publisherHeader],
        requestBody: body({ type: "object", required: ["uploadId"], properties: { uploadId: { type: "string", format: "uuid" } } }),
        responses: { "202": { description: "Queued" }, ...errors },
      },
    },
    "/v1/apps/{appId}/backfill/play-reports": {
      post: { summary: "Backfill history from the Play Console reports bucket", parameters: [appId, publisherHeader], responses: { "202": { description: "Queued" }, ...errors } },
    },
    "/v1/apps/{appId}/timeseries": {
      get: {
        summary: "Sentiment, rating and ad-complaint share over time, with coverage and release markers",
        parameters: [appId, publisherHeader, ...range, { name: "granularity", in: "query", schema: { type: "string", enum: ["day", "week"] } }],
        responses: { "200": ok("Time series", "Timeseries"), ...errors },
      },
    },
    "/v1/apps/{appId}/reasons": {
      get: {
        summary: "Reason ranking, ad sub-reasons and weekly trend for a sentiment group",
        parameters: [appId, publisherHeader, ...range, { name: "group", in: "query", schema: { type: "string", enum: ["negative", "neutral", "positive"] } }],
        responses: { "200": ok("Reasons", "Reasons"), ...errors },
      },
    },
    "/v1/apps/{appId}/versions": { get: { summary: "Per-version summary and change vs. previous version", parameters: [appId, publisherHeader, ...range], responses: { "200": ok("Versions", "Versions"), ...errors } } },
    "/v1/apps/{appId}/reviews": {
      get: {
        summary: "Review drill-down (cursor pagination)",
        parameters: [
          appId, publisherHeader, ...range,
          { name: "sentiment", in: "query", schema: { type: "string", enum: ["negative", "neutral", "positive"] } },
          { name: "reason", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": ok("Reviews", "Reviews"), ...errors },
      },
    },
    "/v1/apps/{appId}/coverage": { get: { summary: "Data coverage per day and store", parameters: [appId, publisherHeader, ...range], responses: { "200": ok("Coverage", "Coverage"), ...errors } } },
    "/v1/experiments/{experimentId}/link": {
      post: {
        summary: "Link a Loomit experiment (service or x3m_admin role)",
        parameters: [experimentId, publisherHeader],
        requestBody: body({ $ref: "#/components/schemas/LinkExperimentRequest" }),
        responses: { "202": { description: "Linked; evaluation queued" }, ...errors },
      },
    },
    "/v1/experiments/{experimentId}/guardrails": {
      get: { summary: "Latest guardrail evaluation", parameters: [experimentId, publisherHeader], responses: { "200": ok("Guardrails", "Guardrails"), ...errors } },
    },
    "/v1/experiments/{experimentId}/evaluate": {
      post: { summary: "Queue a guardrail evaluation", parameters: [experimentId, publisherHeader], responses: { "202": { description: "Queued" }, ...errors } },
    },
    "/v1/admin/tenants": { get: { summary: "Tenant ingestion health and spend (x3m_admin)", responses: { "200": { description: "Tenants" }, ...errors } } },
    "/v1/admin/apps/{appId}/reprocess": { post: { summary: "Reclassify an app (x3m_admin)", parameters: [appId], responses: { "202": { description: "Queued" }, ...errors } } },
    "/v1/tenants/me": { delete: { summary: "Offboard: delete the publisher's data and credentials", parameters: [publisherHeader], responses: { "204": { description: "Deleted" }, ...errors } } },
  },
} as const;
