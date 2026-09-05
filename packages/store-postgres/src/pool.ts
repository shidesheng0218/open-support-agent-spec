import pg from "pg";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export type { Pool, PoolClient } from "pg";

/** Minimal query surface shared by Pool and PoolClient (transaction clients). */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString });
}

/** Fail-closed connectivity probe used at startup when OSAS_STORAGE=postgres. */
export async function assertConnectable(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * Run `fn` inside a single transaction; COMMIT on success, ROLLBACK on any
 * throw. Used for execution-state updates and their audit writes (§5).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Tenant rows are created lazily so first-write to any table succeeds. */
export async function ensureTenant(db: Queryable, tenantId: string): Promise<void> {
  await db.query("INSERT INTO tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [
    tenantId,
  ]);
}
