import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { PublicError } from "@/lib/errors";
import {
  appleCredentialsSchema,
  createAppSchema,
  googleCredentialsSchema,
  linkExperimentSchema,
  rangeQuerySchema,
  reviewsQuerySchema,
  storeSchema,
  timeseriesQuerySchema,
  uploadRequestSchema,
  type TenantHealthDto,
} from "@/server/api/contracts";
import { actingPublisher, authenticate, type Principal, type Role, type TokenVerifier } from "@/server/api/auth";
import { openApiDocument } from "@/server/api/openapi";
import { pendingMigrations } from "@/server/db/migrate";
import { SYSTEM, withScope, type Client, type Pool } from "@/server/db/pool";
import { guardrailView, linkExperiment } from "@/server/guardrails/evaluate";
import { tokenForConnection } from "@/server/ingestion/credentials";
import type { ObjectStorage } from "@/server/ingestion/imports";
import { QUEUES, type Sender } from "@/server/jobs/queue";
import { metrics, registry } from "@/server/metrics";
import {
  getApp,
  getAppByLoomitId,
  listApps,
  listConnections,
  markConnection,
  toAppDto,
  upsertApp,
  upsertConnection,
} from "@/server/repo/apps";
import * as panel from "@/server/repo/panel";
import { audit, ensureTenant } from "@/server/repo/tenants";
import { secretRef, type SecretStore } from "@/server/secrets/store";

export interface ApiDeps {
  pool: Pool;
  secrets: SecretStore;
  jobs: Sender;
  verify: TokenVerifier;
  uploads?: ObjectStorage;
  claims: { tenant: string; roles: string };
  corsOrigins: string[];
  minN: number;
  /** Max requests per tenant per minute (per pod). */
  rateLimitPerMinute?: number;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const reasonsQuery = rangeQuerySchema.and(z.object({ group: z.enum(["negative", "neutral", "positive"]).default("negative") }));
const importSchema = z.object({ uploadId: z.uuid() });
const reportsSchema = z.object({ months: z.number().int().min(1).max(60).optional() });

function requireRole(principal: Principal, roles: Role[]): void {
  if (!roles.some((role) => principal.roles.has(role))) {
    throw new PublicError("You do not have access to this resource.", 403);
  }
}

/** Fixed-window per-tenant rate limit, per pod. */
function tenantLimiter(limit: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const current = windows.get(key);
    if (!current || now - current.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
    trustProxy: true,
  });
  const allow = tenantLimiter(deps.rateLimitPerMinute ?? 600);

  await app.register(cors, {
    origin: deps.corsOrigins.length ? deps.corsOrigins : false,
    allowedHeaders: ["Authorization", "Content-Type", "X-Loomit-Publisher-Id"],
    methods: ["GET", "POST", "PUT", "DELETE"],
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    metrics.httpRequests.inc({ route, method: request.method, status: String(reply.statusCode) });
    metrics.httpDuration.observe({ route, method: request.method }, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Invalid request.", details: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
    }
    if (error instanceof PublicError) return reply.status(error.status).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: "Invalid request." });
    request.log.error(error);
    console.error("[reviewsignal] API error", error);
    return reply.status(500).send({ error: "Internal error." });
  });

  // ---- health, metrics, spec (no auth) ---------------------------------
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    try {
      const pending = await pendingMigrations(deps.pool);
      if (pending.length) return reply.status(503).send({ ready: false, pendingMigrations: pending });
      return { ready: true };
    } catch {
      return reply.status(503).send({ ready: false });
    }
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
  app.get("/v1/openapi.json", async () => openApiDocument);

  // ---- authenticated v1 ------------------------------------------------
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1/") || request.url.startsWith("/v1/openapi.json")) return;
    if (request.method === "OPTIONS") return;
    request.principal = await authenticate(request.headers.authorization, deps.verify, deps.claims);
  });

  /** Runs `work` scoped to the acting tenant (RLS enforced). */
  async function asTenant<T>(request: FastifyRequest, work: (client: Client, tenantId: string, principal: Principal) => Promise<T>): Promise<T> {
    const principal = request.principal!;
    const publisherId = actingPublisher(principal, request.headers["x-loomit-publisher-id"] as string | undefined);
    if (!allow(publisherId)) throw new PublicError("Too many requests for this publisher. Try again shortly.", 429);
    const tenant = await withScope(deps.pool, SYSTEM, (client) =>
      ensureTenant(client, publisherId, principal.publisherName ?? undefined),
    );
    return withScope(deps.pool, { tenantId: tenant.id }, (client) => work(client, tenant.id, principal));
  }

  async function requireApp(client: Client, appId: string) {
    const found = await getApp(client, appId);
    if (!found) throw new PublicError("App not found.", 404);
    return found;
  }

  app.get("/v1/apps", async (request) =>
    asTenant(request, async (client) => {
      const apps = await listApps(client);
      const connections = await listConnections(client, apps.map((item) => item.id));
      return { items: apps.map((item) => toAppDto(item, connections)) };
    }),
  );

  app.post("/v1/apps", async (request, reply) => {
    const body = createAppSchema.parse(request.body);
    const created = await asTenant(request, async (client, tenantId, principal) => {
      requireRole(principal, ["publisher", "x3m_admin", "service"]);
      const row = await upsertApp(client, tenantId, body);
      await audit(client, { tenantId, actor: principal.subject, action: "app.upsert", target: row.id });
      return toAppDto(row, []);
    });
    return reply.status(201).send(created);
  });

  app.get<{ Params: { appId: string } }>("/v1/apps/:appId", async (request) =>
    asTenant(request, async (client) => {
      const row = await requireApp(client, request.params.appId);
      return toAppDto(row, await listConnections(client, [row.id]));
    }),
  );

  app.put<{ Params: { appId: string; store: string } }>("/v1/apps/:appId/connections/:store", async (request, reply) => {
    const store = storeSchema.parse(request.params.store);
    const credentials =
      store === "google_play" ? googleCredentialsSchema.parse(request.body) : appleCredentialsSchema.parse(request.body);
    const result = await asTenant(request, async (client, tenantId, principal) => {
      requireRole(principal, ["publisher", "x3m_admin"]);
      const row = await requireApp(client, request.params.appId);
      const ref = secretRef(tenantId, row.id, store);
      await deps.secrets.put(tenantId, ref, credentials);
      const connection = await upsertConnection(client, { tenantId, appId: row.id, store, secretRef: ref });
      await audit(client, { tenantId, actor: principal.subject, action: "credentials.put", target: ref });
      return connection;
    });
    return reply.status(202).send({ store, status: result.status });
  });

  app.post<{ Params: { appId: string; store: string } }>("/v1/apps/:appId/connections/:store/verify", async (request) => {
    const store = storeSchema.parse(request.params.store);
    const connection = await asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      const found = (await listConnections(client, [request.params.appId])).find((row) => row.store === store);
      if (!found) throw new PublicError("Connect the store first.", 404);
      return found;
    });
    try {
      await tokenForConnection(deps.secrets, connection);
    } catch (error) {
      const message = error instanceof PublicError ? error.message : "Verification failed.";
      await withScope(deps.pool, SYSTEM, (client) => markConnection(client, connection.id, { status: "error", error: message }));
      return { store, status: "error", error: message };
    }
    await withScope(deps.pool, SYSTEM, (client) => markConnection(client, connection.id, { status: "active", verified: true }));
    await deps.jobs.send(QUEUES.sync, { connectionId: connection.id }, { singletonKey: connection.id });
    return { store, status: "active", error: null };
  });

  app.delete<{ Params: { appId: string; store: string } }>("/v1/apps/:appId/connections/:store", async (request, reply) => {
    const store = storeSchema.parse(request.params.store);
    await asTenant(request, async (client, tenantId, principal) => {
      requireRole(principal, ["publisher", "x3m_admin"]);
      const found = (await listConnections(client, [request.params.appId])).find((row) => row.store === store);
      if (!found) throw new PublicError("Connection not found.", 404);
      if (found.secret_ref) await deps.secrets.delete(tenantId, found.secret_ref);
      await client.query("update store_connection set status = 'disabled', secret_ref = null where id = $1", [found.id]);
      await audit(client, { tenantId, actor: principal.subject, action: "credentials.delete", target: found.secret_ref ?? found.id });
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { appId: string } }>("/v1/apps/:appId/sync", async (request, reply) => {
    const connections = await asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      return listConnections(client, [request.params.appId]);
    });
    for (const connection of connections.filter((row) => row.status !== "disabled")) {
      await deps.jobs.send(QUEUES.sync, { connectionId: connection.id }, { singletonKey: connection.id });
    }
    return reply.status(202).send({ queued: connections.length });
  });

  app.post<{ Params: { appId: string } }>("/v1/apps/:appId/uploads", async (request, reply) => {
    const body = uploadRequestSchema.parse(request.body);
    if (!deps.uploads) throw new PublicError("CSV uploads are not configured.", 503);
    const uploads = deps.uploads;
    const created = await asTenant(request, async (client, tenantId) => {
      const row = await requireApp(client, request.params.appId);
      const id = randomUUID();
      const key = `uploads/${tenantId}/${row.id}/${id}.csv`;
      await client.query(
        "insert into upload (id, tenant_id, app_id, object_key, file_name, platform) values ($1, $2, $3, $4, $5, $6)",
        [id, tenantId, row.id, key, body.fileName, body.platform],
      );
      return { id, key };
    });
    const expiresIn = 900;
    return reply.status(201).send({
      uploadId: created.id,
      uploadUrl: await uploads.presignPut(created.key, "text/csv", expiresIn),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  });

  app.post<{ Params: { appId: string } }>("/v1/apps/:appId/imports", async (request, reply) => {
    const body = importSchema.parse(request.body);
    await asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      const { rowCount } = await client.query("select 1 from upload where id = $1 and app_id = $2", [body.uploadId, request.params.appId]);
      if (!rowCount) throw new PublicError("Upload not found.", 404);
    });
    await deps.jobs.send(QUEUES.importUpload, { uploadId: body.uploadId }, { singletonKey: body.uploadId });
    return reply.status(202).send({ queued: true });
  });

  app.post<{ Params: { appId: string } }>("/v1/apps/:appId/backfill/play-reports", async (request, reply) => {
    const body = reportsSchema.parse(request.body ?? {});
    const tenantId = await asTenant(request, async (client, tenant) => {
      await requireApp(client, request.params.appId);
      return tenant;
    });
    await deps.jobs.send(QUEUES.importReports, { appId: request.params.appId, tenantId, months: body.months });
    return reply.status(202).send({ queued: true });
  });

  // ---- panel reads -----------------------------------------------------
  app.get<{ Params: { appId: string } }>("/v1/apps/:appId/timeseries", async (request) => {
    const query = timeseriesQuerySchema.parse(request.query);
    return asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      return panel.timeseries(client, request.params.appId, query, deps.minN);
    });
  });

  app.get<{ Params: { appId: string } }>("/v1/apps/:appId/reasons", async (request) => {
    const query = reasonsQuery.parse(request.query);
    return asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      return panel.reasons(client, request.params.appId, query);
    });
  });

  app.get<{ Params: { appId: string } }>("/v1/apps/:appId/versions", async (request) => {
    const query = rangeQuerySchema.parse(request.query);
    return asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      return panel.versions(client, request.params.appId, query, deps.minN);
    });
  });

  app.get<{ Params: { appId: string } }>("/v1/apps/:appId/reviews", async (request) => {
    const query = reviewsQuerySchema.parse(request.query);
    return asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      return panel.reviewsPage(client, request.params.appId, query);
    });
  });

  app.get<{ Params: { appId: string } }>("/v1/apps/:appId/coverage", async (request) => {
    const query = rangeQuerySchema.parse(request.query);
    return asTenant(request, async (client) => {
      await requireApp(client, request.params.appId);
      return panel.coverage(client, request.params.appId, query);
    });
  });

  // ---- experiments -----------------------------------------------------
  app.post<{ Params: { experimentId: string } }>("/v1/experiments/:experimentId/link", async (request, reply) => {
    const body = linkExperimentSchema.parse(request.body);
    const experiment = await asTenant(request, async (client, tenantId, principal) => {
      requireRole(principal, ["service", "x3m_admin"]);
      const linkedApp = await getAppByLoomitId(client, body.loomitAppId);
      if (!linkedApp) throw new PublicError("No ReviewSignal app is registered for this Loomit app.", 404);
      const row = await linkExperiment(client, { tenantId, appId: linkedApp.id, loomitExperimentId: request.params.experimentId, body });
      await audit(client, { tenantId, actor: principal.subject, action: "experiment.link", target: request.params.experimentId });
      return row;
    });
    await deps.jobs.send(QUEUES.evaluate, { experimentId: experiment.id }, { singletonKey: experiment.id });
    return reply.status(202).send({ experimentId: experiment.id, status: experiment.status });
  });

  app.get<{ Params: { experimentId: string } }>("/v1/experiments/:experimentId/guardrails", async (request) =>
    asTenant(request, async (client) => {
      const view = await guardrailView(client, request.params.experimentId);
      if (!view) throw new PublicError("Experiment not found.", 404);
      return view;
    }),
  );

  app.post<{ Params: { experimentId: string } }>("/v1/experiments/:experimentId/evaluate", async (request, reply) => {
    const id = await asTenant(request, async (client) => {
      const { rows } = await client.query<{ id: string }>("select id from experiment where loomit_experiment_id = $1", [request.params.experimentId]);
      if (!rows[0]) throw new PublicError("Experiment not found.", 404);
      return rows[0].id;
    });
    await deps.jobs.send(QUEUES.evaluate, { experimentId: id }, { singletonKey: id });
    return reply.status(202).send({ queued: true });
  });

  // ---- admin -----------------------------------------------------------
  app.get("/v1/admin/tenants", async (request) => {
    requireRole(request.principal!, ["x3m_admin"]);
    const items = await withScope(deps.pool, SYSTEM, async (client) => {
      const { rows } = await client.query<TenantHealthDto & { budgetUsd: string; spendTodayUsd: string }>(
        `select t.id as "tenantId", t.loomit_publisher_id as "loomitPublisherId", t.name,
           (select count(*)::int from app a where a.tenant_id = t.id) as apps,
           (select count(*)::int from store_connection c where c.tenant_id = t.id and c.status = 'active') as "activeConnections",
           (select count(*)::int from store_connection c where c.tenant_id = t.id and c.status = 'error') as "erroredConnections",
           (select max(last_synced_at) from store_connection c where c.tenant_id = t.id) as "lastSyncedAt",
           (select count(*)::int from review r where r.tenant_id = t.id and r.created_at > now() - interval '30 days') as "reviews30d",
           (select count(*)::int from review r where r.tenant_id = t.id
              and not exists (select 1 from classification c where c.review_id = r.id and c.text_hash = r.text_hash)) as unclassified,
           coalesce((select cost_usd from classification_spend s where s.tenant_id = t.id and s.day = (now() at time zone 'UTC')::date), 0) as "spendTodayUsd",
           t.daily_budget_usd as "budgetUsd"
         from tenant t order by t.name`,
      );
      return rows.map((row) => ({ ...row, budgetUsd: Number(row.budgetUsd), spendTodayUsd: Number(row.spendTodayUsd) }));
    });
    return { items };
  });

  app.post<{ Params: { appId: string } }>("/v1/admin/apps/:appId/reprocess", async (request, reply) => {
    requireRole(request.principal!, ["x3m_admin"]);
    const target = await withScope(deps.pool, SYSTEM, (client) => getApp(client, request.params.appId));
    if (!target) throw new PublicError("App not found.", 404);
    await withScope(deps.pool, SYSTEM, (client) =>
      audit(client, { tenantId: target.tenant_id, actor: request.principal!.subject, action: "app.reprocess", target: target.id }),
    );
    await deps.jobs.send(QUEUES.classify, { appId: target.id, tenantId: target.tenant_id }, { singletonKey: target.id });
    return reply.status(202).send({ queued: true });
  });

  app.delete("/v1/tenants/me", async (request, reply) => {
    await asTenant(request, async (client, tenantId, principal) => {
      requireRole(principal, ["x3m_admin", "publisher"]);
      const { rows } = await client.query<{ secret_ref: string | null }>("select secret_ref from store_connection");
      for (const row of rows) if (row.secret_ref) await deps.secrets.delete(tenantId, row.secret_ref);
      await audit(client, { tenantId: null, actor: principal.subject, action: "tenant.offboard", target: tenantId });
    });
    const publisherId = actingPublisher(request.principal!, request.headers["x-loomit-publisher-id"] as string | undefined);
    await withScope(deps.pool, SYSTEM, (client) => client.query("delete from tenant where loomit_publisher_id = $1", [publisherId]));
    return reply.status(204).send();
  });

  return app;
}

export function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error });
}
