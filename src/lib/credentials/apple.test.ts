import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify, decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAppStoreConnectToken, resetAppleTokenCache, signAppStoreConnectToken } from "@/lib/credentials/apple";

describe("getAppStoreConnectToken", () => {
  beforeEach(() => resetAppleTokenCache());
  afterEach(() => vi.unstubAllEnvs());

  it("signs a short-lived ES256 JWT from the .p8 key and caches it", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    vi.stubEnv("APPLE_ISSUER_ID", "issuer-123");
    vi.stubEnv("APPLE_KEY_ID", "KEY123");
    vi.stubEnv("APPLE_PRIVATE_KEY", pem.replace(/\n/g, "\\n"));

    const now = Date.parse("2026-11-05T12:00:00Z");
    const token = await getAppStoreConnectToken(() => now);
    const verified = await jwtVerify(token, await importSPKI(await exportSPKI(publicKey), "ES256"), {
      audience: "appstoreconnect-v1",
      issuer: "issuer-123",
      currentDate: new Date(now),
    });

    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(900);
    await expect(getAppStoreConnectToken(() => now + 60_000)).resolves.toBe(token);
    await expect(getAppStoreConnectToken(() => now + 15 * 60_000)).resolves.not.toBe(token);
  });

  it("accepts a base64-encoded key", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    vi.stubEnv("APPLE_ISSUER_ID", "issuer");
    vi.stubEnv("APPLE_KEY_ID", "KEY");
    vi.stubEnv("APPLE_PRIVATE_KEY", Buffer.from(await exportPKCS8(privateKey)).toString("base64"));

    await expect(getAppStoreConnectToken()).resolves.toMatch(/^ey/);
  });

  it("rejects invalid keys", async () => {
    vi.stubEnv("APPLE_ISSUER_ID", "issuer");
    vi.stubEnv("APPLE_KEY_ID", "KEY");
    vi.stubEnv("APPLE_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----");

    await expect(getAppStoreConnectToken()).rejects.toThrow("not a valid PKCS#8");
  });

  it("falls back to a static token and explains missing configuration", async () => {
    vi.stubEnv("APPLE_ISSUER_ID", "");
    vi.stubEnv("APPLE_APP_STORE_CONNECT_TOKEN", "static-jwt");
    await expect(getAppStoreConnectToken()).resolves.toBe("static-jwt");

    vi.stubEnv("APPLE_APP_STORE_CONNECT_TOKEN", "apple_app_store_connect_jwt_placeholder");
    await expect(getAppStoreConnectToken()).rejects.toThrow("no credentials are configured");
  });

  it("signs per-tenant tokens and rejects invalid keys", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const token = await signAppStoreConnectToken(
      { issuerId: "tenant-issuer", keyId: "TENANTKEY", privateKey: await exportPKCS8(privateKey) },
      () => Date.parse("2026-11-06T00:00:00Z"),
    );
    const verified = await jwtVerify(token, await importSPKI(await exportSPKI(publicKey), "ES256"), {
      issuer: "tenant-issuer",
      audience: "appstoreconnect-v1",
      currentDate: new Date("2026-11-06T00:01:00Z"),
    });
    expect(verified.protectedHeader.kid).toBe("TENANTKEY");

    await expect(
      signAppStoreConnectToken({ issuerId: "i", keyId: "k", privateKey: "not a key" }),
    ).rejects.toThrow("not a valid .p8");
  });
});
