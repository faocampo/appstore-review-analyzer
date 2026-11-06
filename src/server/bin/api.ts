import { buildApi } from "@/server/api/app";
import { createVerifier } from "@/server/api/auth";
import { loadConfig } from "@/server/config";
import { createPool } from "@/server/db/pool";
import { createUploadsStorage } from "@/server/ingestion/imports";
import { createBoss, senderFor } from "@/server/jobs/queue";
import { createSecretStore } from "@/server/secrets/store";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  // The API only enqueues; the worker process consumes.
  const boss = createBoss(config.DATABASE_URL);
  await boss.start();

  const api = await buildApi({
    pool,
    secrets: createSecretStore(config, pool),
    jobs: senderFor(boss),
    uploads: createUploadsStorage(config),
    verify: createVerifier(config),
    claims: { tenant: config.AUTH_TENANT_CLAIM, roles: config.AUTH_ROLES_CLAIM },
    corsOrigins: config.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    minN: config.MIN_N,
    rateLimitPerMinute: config.TENANT_RATE_LIMIT_PER_MINUTE,
    logger: true,
  });

  const shutdown = async (signal: string) => {
    console.log(`[reviewsignal] api received ${signal}, shutting down`);
    await api.close();
    await boss.stop({ graceful: true, timeout: 10_000 });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await api.listen({ host: "0.0.0.0", port: config.PORT });
}

main().catch((error) => {
  console.error("[reviewsignal] api failed to start", error);
  process.exit(1);
});
