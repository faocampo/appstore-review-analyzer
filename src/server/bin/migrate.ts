import { loadConfig } from "@/server/config";
import { migrate } from "@/server/db/migrate";
import { createPool } from "@/server/db/pool";

async function main(): Promise<void> {
  // Migrations only need the database; validate just that.
  const url = process.env.DATABASE_URL;
  if (!url) {
    loadConfig();
    return;
  }
  const pool = createPool(url, 1);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `[reviewsignal] applied migrations: ${applied.join(", ")}` : "[reviewsignal] database is up to date");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[reviewsignal] migration failed", error);
  process.exit(1);
});
