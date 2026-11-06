import { z } from "zod";

const boolish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const schema = z
  .object({
    NODE_ENV: z.string().default("development"),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
    AUTH_MODE: z.enum(["oidc", "dev"]).default("dev"),
    OIDC_ISSUER: z.string().optional(),
    OIDC_AUDIENCE: z.string().optional(),
    OIDC_JWKS_URL: z.string().url().optional(),
    AUTH_TENANT_CLAIM: z.string().default("loomit_publisher_id"),
    AUTH_ROLES_CLAIM: z.string().default("roles"),
    DEV_JWT_SECRET: z.string().optional(),
    CORS_ORIGINS: z.string().default(""),
    SECRET_STORE: z.enum(["aws", "database"]).default("database"),
    SECRETS_ENCRYPTION_KEY: z.string().optional(),
    SECRETS_PREFIX: z.string().default("reviewsignal/"),
    AWS_REGION: z.string().optional(),
    UPLOADS_BUCKET: z.string().optional(),
    EXPORT_BUCKET: z.string().optional(),
    LOOMIT_NOTIFY_URL: z.string().url().optional(),
    LOOMIT_NOTIFY_SECRET: z.string().optional(),
    SYNC_CRON: z.string().default("0 */2 * * *"),
    EVALUATE_CRON: z.string().default("15 * * * *"),
    EXPORT_CRON: z.string().default("30 3 * * *"),
    MIN_N: z.coerce.number().int().min(1).max(10_000).default(20),
    TENANT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(600),
    ALERT_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    TRUST_PROXY: boolish.default(true),
  })
  .superRefine((value, context) => {
    const production = value.NODE_ENV === "production";
    if (value.AUTH_MODE === "oidc") {
      for (const key of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URL"] as const) {
        if (!value[key]) context.addIssue({ code: "custom", message: `${key} is required when AUTH_MODE=oidc`, path: [key] });
      }
    }
    if (value.AUTH_MODE === "dev") {
      if (production) context.addIssue({ code: "custom", message: "AUTH_MODE=dev is not allowed in production", path: ["AUTH_MODE"] });
      if (!value.DEV_JWT_SECRET || value.DEV_JWT_SECRET.length < 32) {
        context.addIssue({ code: "custom", message: "DEV_JWT_SECRET must be at least 32 characters", path: ["DEV_JWT_SECRET"] });
      }
    }
    if (value.SECRET_STORE === "database") {
      if (production) context.addIssue({ code: "custom", message: "SECRET_STORE=database is not allowed in production; use aws", path: ["SECRET_STORE"] });
      const key = value.SECRETS_ENCRYPTION_KEY ? Buffer.from(value.SECRETS_ENCRYPTION_KEY, "base64") : null;
      if (!key || key.length !== 32) {
        context.addIssue({ code: "custom", message: "SECRETS_ENCRYPTION_KEY must be 32 bytes, base64-encoded", path: ["SECRETS_ENCRYPTION_KEY"] });
      }
    }
    if (value.SECRET_STORE === "aws" && !value.AWS_REGION) {
      context.addIssue({ code: "custom", message: "AWS_REGION is required when SECRET_STORE=aws", path: ["AWS_REGION"] });
    }
  });

export type ServerConfig = z.infer<typeof schema>;

/** Parses and validates the server environment; throws with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server configuration: ${problems}`);
  }
  return result.data;
}
