import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SYSTEM, withScope } from "@/server/db/pool";
import {
  S3ObjectStorage,
  createUploadsStorage,
  importPlayReports,
  importUpload,
  type ObjectStorage,
} from "@/server/ingestion/imports";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";
import { seedConnectedApp, testSecretStore } from "@/server/testing/fixtures";

vi.mock("@/lib/credentials/google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/credentials/google")>()),
  mintGoogleAccessToken: vi.fn().mockResolvedValue("gcs-token"),
}));

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function utf16(csv: string): Uint8Array {
  return Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]));
}

const PLAY_CSV = [
  "Package Name,App Version Name,Reviewer Language,Review Submit Date and Time,Star Rating,Review Title,Review Text,Review ID",
  "com.example.puzzle,6.1.0,es,2026-09-10T10:00:00Z,1,,Demasiados anuncios,gp-1",
  "com.example.puzzle,6.1.0,en,2026-09-12T10:00:00Z,5,,Great game,gp-2",
].join("\n");

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  async presignPut(key: string) {
    return `https://uploads.example.test/${key}`;
  }
  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) throw new Error("NoSuchKey");
    return value;
  }
  async put(key: string, body: Uint8Array | string) {
    this.objects.set(key, typeof body === "string" ? Buffer.from(body) : body);
  }
}

async function createUpload(tenantId: string, appId: string, key: string) {
  return withScope(db.pool, SYSTEM, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "insert into upload (tenant_id, app_id, object_key, file_name, platform) values ($1, $2, $3, 'reviews.csv', 'android') returning id",
      [tenantId, appId, key],
    );
    return rows[0].id;
  });
}

describe("CSV upload import", () => {
  it("imports a UTF-16 Play report from object storage", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    const storage = new MemoryStorage();
    storage.objects.set("uploads/a.csv", utf16(PLAY_CSV));
    const uploadId = await createUpload(seed.tenant.id, seed.app.id, "uploads/a.csv");

    const result = await importUpload({ pool: db.pool, secrets, uploads: storage }, uploadId);
    expect(result).toMatchObject({ upserted: 2, skippedRows: 0, days: ["2026-09-10", "2026-09-12"] });
    const status = await withScope(db.pool, SYSTEM, (client) =>
      client.query<{ status: string }>("select status from upload where id = $1", [uploadId]),
    );
    expect(status.rows[0].status).toBe("imported");
  });

  it("marks failed imports and requires storage configuration", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    const uploadId = await createUpload(seed.tenant.id, seed.app.id, "uploads/missing.csv");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(importUpload({ pool: db.pool, secrets, uploads: new MemoryStorage() }, uploadId)).rejects.toThrow(
      "Import failed",
    );
    const status = await withScope(db.pool, SYSTEM, (client) =>
      client.query<{ status: string; error: string }>("select status, error from upload where id = $1", [uploadId]),
    );
    expect(status.rows[0]).toEqual({ status: "failed", error: "Import failed. See server logs." });
    await expect(importUpload({ pool: db.pool, secrets }, uploadId)).rejects.toThrow("not configured");
    await expect(
      importUpload({ pool: db.pool, secrets, uploads: new MemoryStorage() }, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("Upload not found");
    consoleError.mockRestore();
  });
});

describe("Play reports backfill", () => {
  it("lists monthly reports, imports them and records coverage", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    await withScope(db.pool, SYSTEM, (client) =>
      client.query("update app set play_reports_bucket = 'pubsite_prod_123' where id = $1", [seed.app.id]),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [
            { name: "reviews/reviews_com.example.puzzle_202609.csv" },
            { name: "reviews/reviews_com.example.puzzle_202001.csv" },
            { name: "reviews/other_file.csv" },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(Buffer.from(utf16(PLAY_CSV))));
    vi.stubGlobal("fetch", fetchMock);

    const result = await importPlayReports(
      { pool: db.pool, secrets },
      { appId: seed.app.id, months: 12, now: new Date("2026-11-06T00:00:00Z") },
    );
    expect(result).toMatchObject({ files: 1, upserted: 2 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/b/pubsite_prod_123/o?prefix=reviews%2Freviews_com.example.puzzle_");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer gcs-token");

    const coverage = await withScope(db.pool, SYSTEM, (client) =>
      client.query<{ count: string }>(
        "select count(*) from coverage_day where app_id = $1 and source = 'play_reports' and status = 'complete'",
        [seed.app.id],
      ),
    );
    expect(coverage.rows[0].count).toBe("30");
  });

  it("requires a bucket and reports storage errors safely", async () => {
    const secrets = testSecretStore(db.pool);
    const seed = await seedConnectedApp(db.pool, secrets);
    await expect(importPlayReports({ pool: db.pool, secrets }, { appId: seed.app.id })).rejects.toThrow(
      "Set the Play reports bucket",
    );
    await withScope(db.pool, SYSTEM, (client) =>
      client.query("update app set play_reports_bucket = 'pubsite_prod_9' where id = $1", [seed.app.id]),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    await expect(importPlayReports({ pool: db.pool, secrets }, { appId: seed.app.id })).rejects.toThrow(
      "Google Cloud Storage returned HTTP 403.",
    );
    consoleError.mockRestore();
  });
});

describe("S3ObjectStorage", () => {
  it("presigns uploads and reads/writes objects", async () => {
    const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" } });
    const send = vi
      .spyOn(client, "send")
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => Uint8Array.from([1, 2]) } } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);
    const storage = new S3ObjectStorage(client, "uploads-bucket");

    const url = await storage.presignPut("tenant/a.csv", "text/csv", 600);
    expect(url).toContain("uploads-bucket");
    expect(url).toContain("X-Amz-Expires=600");
    await expect(storage.get("tenant/a.csv")).resolves.toEqual(Uint8Array.from([1, 2]));
    await storage.put("exports/x.json", "{}", "application/json");
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutObjectCommand);
    await expect(storage.get("missing")).rejects.toThrow("Uploaded file not found");
  });

  it("is only created when a bucket is configured", () => {
    expect(createUploadsStorage({})).toBeUndefined();
    expect(createUploadsStorage({ UPLOADS_BUCKET: "b", AWS_REGION: "us-east-1" })).toBeInstanceOf(S3ObjectStorage);
  });
});
