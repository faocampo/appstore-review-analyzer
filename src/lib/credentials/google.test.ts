import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANDROID_PUBLISHER_SCOPE, getGooglePlayAccessToken, resetGoogleAuthCache } from "@/lib/credentials/google";

const getAccessToken = vi.fn();
const GoogleAuth = vi.fn();

vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function (this: unknown, options: unknown) {
    GoogleAuth(options);
    return { getClient: async () => ({ getAccessToken }) };
  }),
}));

const serviceAccount = { type: "service_account", client_email: "reader@example.iam.gserviceaccount.com" };

describe("getGooglePlayAccessToken", () => {
  beforeEach(() => {
    resetGoogleAuthCache();
    getAccessToken.mockReset();
    GoogleAuth.mockReset();
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("mints tokens from inline service-account JSON with the publisher scope", async () => {
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", JSON.stringify(serviceAccount));
    getAccessToken.mockResolvedValue({ token: "minted" });

    await expect(getGooglePlayAccessToken()).resolves.toBe("minted");
    await getGooglePlayAccessToken();

    expect(GoogleAuth).toHaveBeenCalledTimes(1);
    expect(GoogleAuth).toHaveBeenCalledWith({
      credentials: serviceAccount,
      scopes: [ANDROID_PUBLISHER_SCOPE],
    });
  });

  it("accepts base64 JSON and key files", async () => {
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", Buffer.from(JSON.stringify(serviceAccount)).toString("base64"));
    getAccessToken.mockResolvedValue({ token: "from-base64" });
    await expect(getGooglePlayAccessToken()).resolves.toBe("from-base64");

    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/secrets/sa.json");
    getAccessToken.mockResolvedValue({ token: "from-file" });
    await expect(getGooglePlayAccessToken()).resolves.toBe("from-file");
    expect(GoogleAuth).toHaveBeenLastCalledWith({ keyFile: "/secrets/sa.json", scopes: [ANDROID_PUBLISHER_SCOPE] });
  });

  it("reports invalid JSON and minting failures without leaking details", async () => {
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "{not json");
    await expect(getGooglePlayAccessToken()).rejects.toThrow("not valid JSON");

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", JSON.stringify(serviceAccount));
    getAccessToken.mockRejectedValueOnce(new Error("invalid_grant: secret"));
    await expect(getGooglePlayAccessToken()).rejects.toThrow("Could not mint a Google Play access token");

    getAccessToken.mockResolvedValueOnce({ token: null });
    await expect(getGooglePlayAccessToken()).rejects.toThrow("Could not mint");
    consoleError.mockRestore();
  });

  it("falls back to a static token and explains missing configuration", async () => {
    vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "static-token");
    await expect(getGooglePlayAccessToken()).resolves.toBe("static-token");

    vi.stubEnv("GOOGLE_PLAY_ACCESS_TOKEN", "google_play_access_token_placeholder");
    await expect(getGooglePlayAccessToken()).rejects.toThrow("no credentials are configured");
  });
});
