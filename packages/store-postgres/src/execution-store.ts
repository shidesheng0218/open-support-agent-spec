import type { ExecutionClaim, ExecutionStore, StoredExecution } from "@osas/policy-engine";
import { ensureTenant, type Queryable } from "./pool.js";

/**
 * §5 execution ledger on PostgreSQL. The PRIMARY KEY (tenant_id,
 * idempotency_key) enforces execution idempotency at the database level.
 *
 * Claimed slots: `claim` inserts the pending (`executing`) row on `claimDb` —
 * by default the pool, i.e. its own auto-commit statement — so the
 * reservation is durable BEFORE the adapter call. `get` serves terminal
 * records only; `finalize` updates the pending row in place and runs on the
 * transaction client passed at construction, so the terminal record and the
 * mirrored audit events still commit atomically.
 */
export class PostgresExecutionStore implements ExecutionStore {
  constructor(
    private readonly db: Queryable,
    private readonly claimDb: Queryable = db,
  ) {}

  /** Bind to a transaction client (see withTransaction). */
  withClient(db: Queryable): PostgresExecutionStore {
    return new PostgresExecutionStore(db, this.claimDb);
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
        WHERE tenant_id = $1 AND idempotency_key = $2
          AND status IN ('executed', 'failed')`,
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

  /**
   * Atomically reserve the slot. One winner per key: a failed insert means the
   * row already exists — terminal → `completed` (replay), pending → `in_flight`
   * (fail closed; the holder may already have a provider side effect).
   */
  async claim(
    tenantId: string,
    idempotencyKey: string,
    proposalId: string,
  ): Promise<ExecutionClaim> {
    await ensureTenant(this.claimDb, tenantId);
    const inserted = await this.claimDb.query<{ status: string }>(
      `INSERT INTO execution_records
         (tenant_id, idempotency_key, proposal_id, status, result, completed_at)
       VALUES ($1, $2, $3, 'executing', NULL, NULL)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING status`,
      [tenantId, idempotencyKey, proposalId],
    );
    if (inserted.rows.length > 0) return { outcome: "claimed" };

    const { rows } = await this.claimDb.query<{
      proposal_id: string;
      status: string;
      result: StoredExecution["result"] | null;
      completed_at: Date | null;
    }>(
      `SELECT proposal_id, status, result, completed_at
         FROM execution_records
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const row = rows[0];
    if (
      row &&
      (row.status === "executed" || row.status === "failed") &&
      row.result &&
      row.completed_at
    ) {
      return {
        outcome: "completed",
        record: {
          tenantId,
          idempotencyKey,
          proposalId: row.proposal_id,
          status: row.status,
          result: row.result,
          completedAt: row.completed_at.toISOString(),
        },
      };
    }
    return { outcome: "in_flight" };
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

  async finalize(record: StoredExecution): Promise<void> {
    await ensureTenant(this.db, record.tenantId);
    const updated = await this.db.query(
      `UPDATE execution_records
          SET status = $3, result = $4, completed_at = $5
        WHERE tenant_id = $1 AND idempotency_key = $2
        RETURNING status`,
      [
        record.tenantId,
        record.idempotencyKey,
        record.status,
        JSON.stringify(record.result),
        record.completedAt,
      ],
    );
    if (updated.rows.length === 0) {
      // No claimed row to finalize (claim-less writers): fall back to insert.
      await this.put(record);
    }
  }
}