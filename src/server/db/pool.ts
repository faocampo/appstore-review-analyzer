import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString, max, application_name: "reviewsignal" });
  pool.on("error", (error) => {
    console.error("[reviewsignal] idle database client error", error);
  });
  return pool;
}

export type Scope = { tenantId: string } | { bypassRls: true };

/**
 * Runs `work` in a transaction scoped to one tenant (row-level security
 * enforced) or, for trusted jobs and admin endpoints, with RLS bypassed.
 * Settings are transaction-local, so pooled connections never leak scope.
 */
export async function withScope<T>(
  pool: Pool,
  scope: Scope,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if ("tenantId" in scope) {
      await client.query("select set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    } else {
      await client.query("select set_config('app.bypass_rls', 'on', true)");
    }
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const SYSTEM: Scope = { bypassRls: true };
