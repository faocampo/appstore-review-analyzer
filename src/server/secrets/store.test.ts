import { randomBytes } from "node:crypto";

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SYSTEM, withScope } from "@/server/db/pool";
import {
  AwsSecretStore,
  DatabaseSecretStore,
  createSecretStore,
  secretRef,
} from "@/server/secrets/store";
import { createTestDatabase, type TestDatabase } from "@/server/testing/database";

let db: TestDatabase;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  db = await createTestDatabase();
  [tenantA, tenantB] = await withScope(db.pool, SYSTEM, async (client) => {
    const ids: string[] = [];
    for (const name of ["a", "b"]) {
      const row = await client.query<{ id: string }>(
        "insert into tenant (loomit_publisher_id, name) values ($1, $1) returning id",
        [name],
      );
      ids.push(row.rows[0].id);
    }
    return ids;
  });
});

afterAll(async () => {
  await db.drop();
});

describe("DatabaseSecretStore", () => {
  it("encrypts, reads back, isolates tenants and deletes", async () => {
    const store = new DatabaseSecretStore(db.pool, randomBytes(32).toString("base64"));
    const ref = secretRef(tenantA, "app-1", "google_play");
    await store.put(tenantA, ref, { serviceAccountJson: "{\"secret\":true}" });
    await store.put(tenantA, ref, { serviceAccountJson: "{\"secret\":2}" });

    await expect(store.get(tenantA, ref)).resolves.toEqual({ serviceAccountJson: "{\"secret\":2}" });
    await expect(store.get(tenantB, ref)).resolves.toBeNull();

    const raw = await withScope(db.pool, SYSTEM, (client) =>
      client.query<{ ciphertext: Buffer }>("select ciphertext from secret where ref = $1", [ref]),
    );
    expect(raw.rows[0].ciphertext.toString("utf8")).not.toContain("secret");

    await store.delete(tenantA, ref);
    await expect(store.get(tenantA, ref)).resolves.toBeNull();

    await store.put(tenantA, `${ref}-2`, { a: 1 });
    await store.purgeTenant(tenantA);
    await expect(store.get(tenantA, `${ref}-2`)).resolves.toBeNull();
  });

  it("rejects a wrong-size key and tampered ciphertext", async () => {
    expect(() => new DatabaseSecretStore(db.pool, "c2hvcnQ=")).toThrow("32 bytes");
    const store = new DatabaseSecretStore(db.pool, randomBytes(32).toString("base64"));
    const other = new DatabaseSecretStore(db.pool, randomBytes(32).toString("base64"));
    const ref = secretRef(tenantB, "app-2", "apple_app_store");
    await store.put(tenantB, ref, { keyId: "K" });
    await expect(other.get(tenantB, ref)).rejects.toThrow();
  });
});

describe("AwsSecretStore", () => {
  const notFound = () =>
    new ResourceNotFoundException({ message: "missing", $metadata: {} });

  it("creates on first put, updates afterwards, and reads/deletes", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ SecretString: "{\"keyId\":\"K\"}" })
      .mockResolvedValueOnce({});
    const store = new AwsSecretStore({ send }, "reviewsignal/");

    await store.put("t", "ref", { keyId: "K" });
    await store.put("t", "ref", { keyId: "K" });
    await expect(store.get("t", "ref")).resolves.toEqual({ keyId: "K" });
    await store.delete("t", "ref");

    expect(send.mock.calls[0][0]).toBeInstanceOf(PutSecretValueCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateSecretCommand);
    expect(send.mock.calls[1][0].input).toMatchObject({ Name: "reviewsignal/ref" });
    expect(send.mock.calls[3][0]).toBeInstanceOf(GetSecretValueCommand);
    expect(send.mock.calls[4][0]).toBeInstanceOf(DeleteSecretCommand);
  });

  it("treats missing secrets as null or already deleted, and rethrows other errors", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("throttled"))
      .mockRejectedValueOnce(new Error("denied"))
      .mockRejectedValueOnce(new Error("denied"));
    const store = new AwsSecretStore({ send }, "p/");

    await expect(store.get("t", "missing")).resolves.toBeNull();
    await expect(store.delete("t", "missing")).resolves.toBeUndefined();
    await expect(store.get("t", "empty")).resolves.toBeNull();
    await expect(store.put("t", "x", {})).rejects.toThrow("throttled");
    await expect(store.get("t", "x")).rejects.toThrow("denied");
    await expect(store.delete("t", "x")).rejects.toThrow("denied");
  });

  it("is selected by configuration", () => {
    expect(
      createSecretStore({ SECRET_STORE: "aws", SECRETS_PREFIX: "p/", AWS_REGION: "us-east-1" }, db.pool),
    ).toBeInstanceOf(AwsSecretStore);
    expect(
      createSecretStore(
        { SECRET_STORE: "database", SECRETS_PREFIX: "p/", SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
        db.pool,
      ),
    ).toBeInstanceOf(DatabaseSecretStore);
  });
});
