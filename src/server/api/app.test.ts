import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApi } from "@/server/api/app";
import { createVerifier } from "@/server/api/auth";
import { SYSTEM, withScope } from "@/server/db/pool";
import type { ObjectStorage } from "@/server/ingestion/imports";
import { QUEUES, type QueueName, type Sender } from "@/server/jobs/queue";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";
import { testSecretStore } from "@/server/testing/fixtures";

vi.mock("@/lib/credentials/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/credentials/google")>()),
  mintGoogleAccessToken: vi.fn().mockResolvedValue("google-token"),
}));

const SECRET = "dev-secret-dev-secret-dev-secret-0123";
let db: TestDatabase;
let api: FastifyInstance;
const sent: Array<{ name: QueueName; data: object }> = [];
const jobs: Sender = { send: async (name, data) => void sent.push({ name, data }) };

const uploads: ObjectStorage = {
  presignPut: async (key) => `https://uploads.example.test/${key}?X-Amz-Signature=abc`,
  get: async () => new Uint8Array(),
  put: async () => undefined,
};

async function token(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("reviewsignal-dev")
    .setAudience("reviewsignal")
    .setSubject(String(claims.sub ?? "user-1"))
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

const publisherA = () => token({ loomit_publisher_id: "pub-a", roles: ["publisher"], publisher_name: "Studio A" });
const publisherB = () => token({ loomit_publisher_id: "pub-b", roles: ["publisher"] });
const service = () => token({ sub: "loomit-backend", roles: ["service"] });
const admin = () => token({ sub: "ops@x3m", roles: ["x3m_admin"] });

beforeAll(async () => {
  db = await createTestDatabase();
  api = await buildApi({
    pool: db.pool,
    secrets: testSecretStore(db.pool),
    jobs,
    uploads,
    verify: createVerifier({ AUTH_MODE: "dev", DEV_JWT_SECRET: SECRET }),
    claims: { tenant: "loomit_publisher_id", roles: "roles" },
    corsOrigins: ["https://console.loomit.example"],
    minN: 1,
  });
});

afterAll(async () => {
  await api.close();
  await db.drop();
});

async function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, auth?: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await api.inject({
    method,
    url,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    payload: payload as object | undefined,
  });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, headers: response.headers };
}

describe("API v1", () => {
  it("serves health, readiness, metrics and the OpenAPI document without auth", async () => {
    expect((await call("GET", "/healthz")).body).toEqual({ ok: true });
    expect((await call("GET", "/readyz")).body).toEqual({ ready: true });
    const metrics = await api.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain("reviewsignal_http_requests_total");
    const spec = await call("GET", "/v1/openapi.json");
    expect(spec.body.openapi).toBe("3.1.0");
    expect(spec.body.components.schemas.LinkExperimentRequest.properties.attributionMode).toBeDefined();
  });

  it("rejects missing, invalid and role-less tokens", async () => {
    expect((await call("GET", "/v1/apps")).status).toBe(401);
    expect((await call("GET", "/v1/apps", "not-a-jwt")).body).toEqual({ error: "The access token is invalid or expired." });
    expect((await call("GET", "/v1/apps", await token({ sub: "x" }))).status).toBe(403);
    expect((await call("GET", "/v1/apps", await service())).body).toEqual({ error: "Set the X-Loomit-Publisher-Id header." });
  });

  it("registers apps, stores credentials write-only, verifies and isolates tenants", async () => {
    const a = await publisherA();
    const created = await call("POST", "/v1/apps", a, { loomitAppId: "app-1", name: "Puzzle Quest", androidPackage: "com.example.puzzle", appleAppId: "123456789" });
    expect(created.status).toBe(201);
    const appId = created.body.id as string;

    const invalid = await call("POST", "/v1/apps", a, { loomitAppId: "app-2", name: "x" });
    expect(invalid.status).toBe(400);

    const put = await call("PUT", `/v1/apps/${appId}/connections/google_play`, a, { serviceAccountJson: JSON.stringify({ type: "service_account", client_email: "sa@x.iam.gserviceaccount.com" }) });
    expect(put).toMatchObject({ status: 202, body: { store: "google_play", status: "pending" } });
    expect((await call("PUT", `/v1/apps/${appId}/connections/apple_app_store`, a, { issuerId: "short" })).status).toBe(400);

    const verified = await call("POST", `/v1/apps/${appId}/connections/google_play/verify`, a);
    expect(verified.body).toEqual({ store: "google_play", status: "active", error: null });
    expect(sent.at(-1)?.name).toBe(QUEUES.sync);
    expect((await call("POST", `/v1/apps/${appId}/connections/apple_app_store/verify`, a)).status).toBe(404);

    const fetched = await call("GET", `/v1/apps/${appId}`, a);
    expect(fetched.body.connections).toEqual([expect.objectContaining({ store: "google_play", status: "active" })]);
    expect(JSON.stringify(fetched.body)).not.toContain("service_account");

    const b = await publisherB();
    expect((await call("GET", `/v1/apps/${appId}`, b)).status).toBe(404);
    expect((await call("GET", "/v1/apps", b)).body).toEqual({ items: [] });
    expect((await call("GET", "/v1/apps/not-a-uuid", a)).status).toBe(404);

    const audit = await withScope(db.pool, SYSTEM, (client) => client.query("select action from audit_log order by id"));
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(["app.upsert", "credentials.put"]));
  });

  it("serves panel reads from rollups and paginates reviews", async () => {
    const a = await publisherA();
    const apps = await call("GET", "/v1/apps", a);
    const appId = apps.body.items[0].id as string;
    await withScope(db.pool, SYSTEM, async (client) => {
      const tenant = await client.query<{ id: string }>("select tenant_id as id from app where id = $1", [appId]);
      const tenantId = tenant.rows[0].id;
      for (let index = 0; index < 3; index += 1) {
        const review = await client.query<{ id: string }>(
          `insert into review (tenant_id, app_id, store, store_review_id, created_at, date_semantics, rating, body, text_hash, source, app_version, territory)
           values ($1, $2, 'google_play', $3, $4, 'last_modified_fallback', $5, 'Too many ads', 'h', 'api', $6, 'BR') returning id`,
          [tenantId, appId, `r${index}`, `2026-11-0${index + 1}T10:00:00Z`, index === 2 ? 5 : 1, index === 2 ? "6.5.0" : "6.4.0"],
        );
        await client.query(
          `insert into classification (tenant_id, review_id, text_hash, model_version, provider, model, prompt_version, taxonomy_version,
             sentiment_score, sentiment_ev, sentiment_estimator, sentiment_confidence, primary_reason, ad_subreason, reason_confidence)
           values ($1, $2, 'h', 'mock/m/p/t', 'mock', 'm', 'p', 't', $3, $4, 'provider_score', 0.8, $5, $6, 0.8)`,
          [tenantId, review.rows[0].id, index === 2 ? 4 : 0, index === 2 ? 4 : 0, index === 2 ? "praise_general" : "ads", index === 2 ? null : "ad_frequency"],
        );
      }
      const { rebuildRollups } = await import("@/server/repo/rollups");
      await rebuildRollups(client, { appId, modelVersion: "mock/m/p/t", days: ["2026-11-01", "2026-11-02", "2026-11-03"] });
      await client.query(
        "insert into coverage_day (tenant_id, app_id, store, day, status, source) values ($1, $2, 'google_play', '2026-11-01', 'complete', 'api')",
        [tenantId, appId],
      );
    });

    const range = "from=2026-11-01&to=2026-11-03";
    const series = await call("GET", `/v1/apps/${appId}/timeseries?${range}`, a);
    expect(series.status).toBe(200);
    expect(series.body.points.map((point: { n: number; coverage: string }) => [point.n, point.coverage])).toEqual([
      [1, "complete"],
      [1, "unknown"],
      [1, "unknown"],
    ]);
    expect(series.body.points[0]).toMatchObject({ averageSentiment: 0, adsNegativeShare: 1 });
    expect(series.body.releases).toEqual([
      { appVersion: "6.4.0", firstSeen: "2026-11-01" },
      { appVersion: "6.5.0", firstSeen: "2026-11-03" },
    ]);
    const weekly = await call("GET", `/v1/apps/${appId}/timeseries?${range}&granularity=week`, a);
    expect(weekly.body.points.map((point: { period: string; n: number }) => [point.period, point.n])).toEqual([
      ["2026-10-26", 1],
      ["2026-11-02", 2],
    ]);

    const reasons = await call("GET", `/v1/apps/${appId}/reasons?${range}`, a);
    expect(reasons.body).toMatchObject({ total: 2, reasons: [{ reason: "ads", count: 2, share: 1 }], adSubreasons: [{ subreason: "ad_frequency", count: 2 }] });

    const versions = await call("GET", `/v1/apps/${appId}/versions?${range}`, a);
    expect(versions.body.versions.map((item: { appVersion: string; deltaSentiment: number | null }) => [item.appVersion, item.deltaSentiment])).toEqual([
      ["6.5.0", 4],
      ["6.4.0", null],
    ]);

    const page1 = await call("GET", `/v1/apps/${appId}/reviews?${range}&limit=2`, a);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].classification).toMatchObject({ sentimentLabel: "highly_positive", primaryReason: "praise_general" });
    const page2 = await call("GET", `/v1/apps/${appId}/reviews?${range}&limit=2&cursor=${page1.body.nextCursor}`, a);
    expect(page2.body).toMatchObject({ nextCursor: null });
    expect(page2.body.items).toHaveLength(1);
    const negatives = await call("GET", `/v1/apps/${appId}/reviews?${range}&sentiment=negative&reason=ads`, a);
    expect(negatives.body.items).toHaveLength(2);
    expect((await call("GET", `/v1/apps/${appId}/reviews?${range}&cursor=garbage`, a)).body.items).toHaveLength(3);

    const filtered = await call("GET", `/v1/apps/${appId}/timeseries?${range}&store=google_play&appVersion=6.4.0&territory=BR`, a);
    expect(filtered.body.points.map((point: { n: number }) => point.n)).toEqual([1, 1, 0]);
    const filteredReasons = await call("GET", `/v1/apps/${appId}/reasons?${range}&group=positive&store=google_play`, a);
    expect(filteredReasons.body.reasons).toEqual([expect.objectContaining({ reason: "praise_general" })]);
    const filteredVersions = await call("GET", `/v1/apps/${appId}/versions?${range}&territory=XX`, a);
    expect(filteredVersions.body.versions).toEqual([]);

    const coverage = await call("GET", `/v1/apps/${appId}/coverage?${range}`, a);
    expect(coverage.body.summary).toEqual([{ store: "google_play", complete: 1, partial: 0, unknown: 2 }]);
    expect((await call("GET", `/v1/apps/${appId}/timeseries?from=2026-11-05&to=2026-11-01`, a)).status).toBe(400);
  });

  it("presigns CSV uploads and queues imports, syncs and backfills", async () => {
    const a = await publisherA();
    const appId = (await call("GET", "/v1/apps", a)).body.items[0].id as string;
    const upload = await call("POST", `/v1/apps/${appId}/uploads`, a, { fileName: "reviews.csv", platform: "android", byteSize: 1000 });
    expect(upload.status).toBe(201);
    expect(upload.body.uploadUrl).toContain("uploads.example.test/uploads/");
    expect((await call("POST", `/v1/apps/${appId}/imports`, a, { uploadId: upload.body.uploadId })).status).toBe(202);
    expect(sent.at(-1)).toEqual({ name: QUEUES.importUpload, data: { uploadId: upload.body.uploadId } });
    expect((await call("POST", `/v1/apps/${appId}/imports`, a, { uploadId: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
    expect((await call("POST", `/v1/apps/${appId}/sync`, a)).body).toEqual({ queued: 1 });
    expect((await call("POST", `/v1/apps/${appId}/backfill/play-reports`, a, { months: 6 })).status).toBe(202);
  });

  it("links experiments for the Loomit backend and serves guardrails to the publisher", async () => {
    const link = {
      loomitAppId: "app-1",
      name: "Interstitial cap",
      attributionMode: "dimension",
      dimension: "territory",
      arms: [
        { key: "t", role: "test", values: ["BR"] },
        { key: "c", role: "control", values: ["MX"] },
      ],
      startAt: "2026-11-01T00:00:00Z",
    };
    const svc = await service();
    expect((await call("POST", "/v1/experiments/exp-9/link", await publisherA(), link)).status).toBe(403);
    const linked = await call("POST", "/v1/experiments/exp-9/link", svc, link, { "x-loomit-publisher-id": "pub-a" });
    expect(linked.status).toBe(202);
    expect(sent.at(-1)?.name).toBe(QUEUES.evaluate);
    expect((await call("POST", "/v1/experiments/exp-9/link", svc, { ...link, loomitAppId: "nope" }, { "x-loomit-publisher-id": "pub-a" })).status).toBe(404);
    expect((await call("POST", "/v1/experiments/exp-9/link", svc, { ...link, arms: [] }, { "x-loomit-publisher-id": "pub-a" })).status).toBe(400);

    const view = await call("GET", "/v1/experiments/exp-9/guardrails", await publisherA());
    expect(view.body).toMatchObject({ loomitExperimentId: "exp-9", status: "insufficient", evaluatedAt: null, metrics: [] });
    expect((await call("GET", "/v1/experiments/exp-9/guardrails", await publisherB())).status).toBe(404);
    expect((await call("POST", "/v1/experiments/exp-9/evaluate", await publisherA())).status).toBe(202);
    expect((await call("POST", "/v1/experiments/missing/evaluate", await publisherA())).status).toBe(404);
  });

  it("restricts admin endpoints and supports offboarding", async () => {
    expect((await call("GET", "/v1/admin/tenants", await publisherA())).status).toBe(403);
    const tenants = await call("GET", "/v1/admin/tenants", await admin());
    expect(tenants.body.items.map((item: { loomitPublisherId: string }) => item.loomitPublisherId)).toEqual(expect.arrayContaining(["pub-a", "pub-b"]));
    const appId = (await call("GET", "/v1/apps", await publisherA())).body.items[0].id as string;
    expect((await call("POST", `/v1/admin/apps/${appId}/reprocess`, await admin())).status).toBe(202);
    expect((await call("POST", "/v1/admin/apps/00000000-0000-0000-0000-000000000000/reprocess", await admin())).status).toBe(404);

    expect((await call("DELETE", `/v1/apps/${appId}/connections/google_play`, await publisherA())).status).toBe(204);
    expect((await call("DELETE", `/v1/apps/${appId}/connections/google_play`, await publisherA())).status).toBe(204);
    expect((await call("DELETE", `/v1/apps/${appId}/connections/apple_app_store`, await publisherA())).status).toBe(404);
    expect((await call("DELETE", "/v1/tenants/me", await publisherB())).status).toBe(204);
    const remaining = await withScope(db.pool, SYSTEM, (client) => client.query("select loomit_publisher_id from tenant"));
    expect(remaining.rows.map((row) => row.loomit_publisher_id)).toEqual(["pub-a"]);
  });

  it("verifies OIDC tokens against a JWKS", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const verify = createVerifier(
      { AUTH_MODE: "oidc", OIDC_ISSUER: "https://id.loomit.example", OIDC_AUDIENCE: "reviewsignal", OIDC_JWKS_URL: "https://id.loomit.example/jwks" },
      createLocalJWKSet({ keys: [jwk] }),
    );
    const good = await new SignJWT({ loomit_publisher_id: "pub-z" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://id.loomit.example")
      .setAudience("reviewsignal")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verify(good)).resolves.toMatchObject({ loomit_publisher_id: "pub-z" });
    const wrongAudience = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://id.loomit.example").setAudience("other").sign(privateKey);
    await expect(verify(wrongAudience)).rejects.toThrow();
  });
});
