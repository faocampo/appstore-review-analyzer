import { describe, expect, it } from "vitest";

import { loadConfig } from "@/server/config";

const key = Buffer.alloc(32, 1).toString("base64");
const base = { DATABASE_URL: "postgres://x", DEV_JWT_SECRET: "x".repeat(32), SECRETS_ENCRYPTION_KEY: key };

describe("loadConfig", () => {
  it("applies defaults for local development", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ AUTH_MODE: "dev", SECRET_STORE: "database", PORT: 8080, MIN_N: 20, TRUST_PROXY: true });
  });

  it("requires OIDC settings and AWS for production, and forbids dev shortcuts there", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(
      /AUTH_MODE=dev is not allowed in production.*SECRET_STORE=database is not allowed in production/,
    );
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", AUTH_MODE: "oidc", SECRET_STORE: "aws" })).toThrow(
      /OIDC_ISSUER is required.*AWS_REGION is required/,
    );
    const production = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x",
      AUTH_MODE: "oidc",
      OIDC_ISSUER: "https://id.loomit.example",
      OIDC_AUDIENCE: "reviewsignal",
      OIDC_JWKS_URL: "https://id.loomit.example/jwks",
      SECRET_STORE: "aws",
      AWS_REGION: "us-east-1",
      TRUST_PROXY: "false",
    });
    expect(production.TRUST_PROXY).toBe(false);
  });

  it("validates secrets", () => {
    expect(() => loadConfig({ ...base, DEV_JWT_SECRET: "short" })).toThrow("DEV_JWT_SECRET must be at least 32 characters");
    expect(() => loadConfig({ ...base, SECRETS_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow("SECRETS_ENCRYPTION_KEY must be 32 bytes");
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
  });
});
