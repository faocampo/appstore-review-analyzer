import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANDROID_PUBLISHER_SCOPE,
  getGooglePlayAccessToken,
  isValidServiceAccountKey,
  mintGoogleAccessToken,
  parseServiceAccountKey,
  resetGoogleAuthCache,
} from "@/lib/credentials/google";

const getAccessToken = vi.fn();
const JWT = vi.fn();

vi.mock("google-auth-library", () => ({
  JWT: vi.fn(function (this: unknown, options: unknown) {
    JWT(options);
    return { getAccessToken };
  }),
}));

const KEY = "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n";
const serviceAccount = { type: "service_account", client_email: "reader@project.iam.gserviceaccount.com", private_key: KEY };

describe("service-account key validation", () => {
  it("accepts plain service-account keys, raw or base64", () => {
    expect(parseServiceAccountKey(JSON.stringify(serviceAccount))).toEqual({
      email: "reader@project.iam.gserviceaccount.com",
      privateKey: KEY,
    });
    const withDefaults = { ...serviceAccount, token_uri: "https://oauth2.googleapis.com/token", universe_domain: "googleapis.com" };
    expect(isValidServiceAccountKey(Buffer.from(JSON.stringify(withDefaults)).toString("base64"))).toBe(true);
  });

  it.each([
    ["external_account (reads local files / URLs)", { type: "external_account", audience: "x", token_url: "https://attacker.example/", credential_source: { file: "/proc/self/environ" } }],
    ["impersonated_service_account", { type: "impersonated_service_account", service_account_impersonation_url: "https://attacker.example/" }],
    ["authorized_user", { type: "authorized_user", client_id: "x", refresh_token: "y" }],
    ["a custom token endpoint", { ...serviceAccount, token_uri: "https://attacker.example/token" }],
    ["a non-Google universe", { ...serviceAccount, universe_domain: "attacker.example" }],
    ["a non-service-account email", { ...serviceAccount, client_email: "someone@gmail.com" }],
  ])("rejects %s", (_, value) => {
    expect(() => parseServiceAccountKey(JSON.stringify(value))).toThrow("Only Google service-account keys");
    expect(isValidServiceAccountKey(JSON.stringify(value))).toBe(false);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseServiceAccountKey("{nope")).toThrow("not valid JSON");
  });
});

describe("token minting", () => {
  beforeEach(() => {
    resetGoogleAuthCache();
    getAccessToken.mockReset();
    JWT.mockReset();
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("mints tenant tokens with the JWT client from email and key only", async () => {
    getAccessToken.mockResolvedValueOnce({ token: "tenant-token" });
    await expect(mintGoogleAccessToken(JSON.stringify(serviceAccount), ["scope-a"])).resolves.toBe("tenant-token");
    expect(JWT).toHaveBeenCalledWith({ email: serviceAccount.client_email, key: KEY, scopes: ["scope-a"] });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getAccessToken.mockRejectedValueOnce(new Error("invalid_grant"));
    await expect(mintGoogleAccessToken(JSON.stringify(serviceAccount))).rejects.toThrow("Google rejected");
    getAccessToken.mockResolvedValueOnce({ token: null });
    await expect(mintGoogleAccessToken(JSON.stringify(serviceAccount))).rejects.toThrow("Google rejected");
    consoleError.mockRestore();
    await expect(mintGoogleAccessToken(JSON.stringify({ type: "external_account" }))).rejects.toThrow("Only Google service-account keys");
    expect(JWT).toHaveBeenCalledTimes(3);
  });

  it("uses the environment key (inline or file) for the standalone analyzer", async () => {
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", JSON.stringify(serviceAccount));
    getAccessToken.mockResolvedValue({ token: "env-token" });
    await expect(getGooglePlayAccessToken()).resolves.toBe("env-token");
    expect(JWT).toHaveBeenLastCalledWith({ email: serviceAccount.client_email, key: KEY, scopes: [ANDROID_PUBLISHER_SCOPE] });

    const dir = mkdtempSync(join(tmpdir(), "sa-"));
    const file = join(dir, "key.json");
    writeFileSync(file, JSON.stringify({ ...serviceAccount, client_email: "file@p.iam.gserviceaccount.com" }));
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
    await getGooglePlayAccessToken();
    expect(JWT).toHaveBeenLastCalledWith(expect.objectContaining({ email: "file@p.iam.gserviceaccount.com" }));
  });

  it("falls back to a static token and explains missing configuration", async () => {
    vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "static-token");
    await expect(getGooglePlayAccessToken()).resolves.toBe("static-token");
    vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "google_play_access_token_placeholder");
    await expect(getGooglePlayAccessToken()).rejects.toThrow("no credentials are configured");
  });
});
