import { createServer } from "node:http";

import { getClassifier } from "@/lib/classifiers";
import { loadConfig } from "@/server/config";
import { pendingMigrations } from "@/server/db/migrate";
import { createPool } from "@/server/db/pool";
import { createUploadsStorage, S3ObjectStorage } from "@/server/ingestion/imports";
import { createBoss, startWorkers } from "@/server/jobs/queue";
import { registry } from "@/server/metrics";
import { createSecretStore } from "@/server/secrets/store";
import { S3Client } from "@aws-sdk/client-s3";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  // Fail fast on a missing classifier configuration instead of on the first job.
  getClassifier();

  const boss = createBoss(config.DATABASE_URL);
  await boss.start();
  await startWorkers(
    boss,
    {
      pool,
      secrets: createSecretStore(config, pool),
      classifier: getClassifier,
      uploads: createUploadsStorage(config),
      exports: config.EXPORT_BUCKET
        ? new S3ObjectStorage(new S3Client({ region: config.AWS_REGION }), config.EXPORT_BUCKET)
        : undefined,
      notify: { url: config.LOOMIT_NOTIFY_URL, secret: config.LOOMIT_NOTIFY_SECRET },
      alertCooldownHours: config.ALERT_COOLDOWN_HOURS,
    },
    { sync: config.SYNC_CRON, evaluate: config.EVALUATE_CRON, export: config.EXPORT_CRON },
  );

  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    } else if (request.url === "/readyz") {
      const pending = await pendingMigrations(pool).catch(() => ["unreachable"]);
      response.writeHead(pending.length ? 503 : 200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ready: !pending.length }));
    } else if (request.url === "/metrics") {
      response.writeHead(200, { "Content-Type": registry.contentType }).end(await registry.metrics());
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(config.METRICS_PORT, "0.0.0.0");
  console.log(`[reviewsignal] worker started; metrics on :${config.METRICS_PORT}`);

  const shutdown = async (signal: string) => {
    console.log(`[reviewsignal] worker received ${signal}, draining`);
    server.close();
    await boss.stop({ graceful: true, timeout: 60_000 });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[reviewsignal] worker failed to start", error);
  process.exit(1);
});
