import type { ExecutionStore, StoredExecution } from "@osas/policy-engine";
import { ensureTenant, type Queryable } from "./pool.js";

/**
 * §5 execution ledger on PostgreSQL. The PRIMARY KEY (tenant_id,
 * idempotency_key) enforces execution idempotency at the database level.
 */
export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly db: Queryable) {}

  /** Bind to a transaction client (see withTransaction). */
  withClient(db: Queryable): PostgresExecutionStore {
    return new PostgresExecutionStore(db);
  }

  async get(tenantId: string, idempotencyKey: string): Promise<StoredExecution | undefined> {
    const { rows } = await this.db.query<{
      proposal_id: string;
      status: StoredExecution["status"];
      result: StoredExecution["result"];
      completed_at: Date;
    }>(
      `SELECT proposal_id, status, result, completed_at
         FROM execution_records
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      tenantId,
      idempotencyKey,
      proposalId: row.proposal_id,
      status: row.status,
      result: row.result,
      completedAt: row.completed_at.toISOString(),
    };
  }

  async put(record: StoredExecution): Promise<void> {
    await ensureTenant(this.db, record.tenantId);
    // Idempotent by construction: a replayed put of the same key is a no-op.
    await this.db.query(
      `INSERT INTO execution_records
         (tenant_id, idempotency_key, proposal_id, status, result, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [
        record.tenantId,
        record.idempotencyKey,
        record.proposalId,
        record.status,
        JSON.stringify(record.result),
        record.completedAt,
      ],
    );
  }
}
