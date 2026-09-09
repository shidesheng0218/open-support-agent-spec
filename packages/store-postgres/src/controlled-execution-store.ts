import type {
  ExecutionAttempt,
  ExecutionReceipt,
  ProviderEvent,
  ReconciliationTask,
} from "@osas/core";
import type {
  ExecutionAttemptStore,
  ExecutionReceiptStore,
  ProviderEventStore,
  ReconciliationStore,
} from "@osas/ecommerce-shadow";
import { ensureTenant, type Queryable } from "./pool.js";

interface PayloadRow<T> {
  payload: T;
}

const clone = <T>(value: T): T => structuredClone(value);

export class PostgresExecutionAttemptStore implements ExecutionAttemptStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresExecutionAttemptStore {
    return new PostgresExecutionAttemptStore(db);
  }

  async create(attempt: ExecutionAttempt): Promise<ExecutionAttempt> {
    await ensureTenant(this.db, attempt.tenantId);
    await this.db.query(
      `INSERT INTO execution_attempts
        (tenant_id, attempt_id, proposal_id, idempotency_key, mode, status, request_hash, provider_request_id, started_at, finished_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, attempt_id) DO UPDATE SET status = EXCLUDED.status, provider_request_id = EXCLUDED.provider_request_id, finished_at = EXCLUDED.finished_at, payload = EXCLUDED.payload`,
      [attempt.tenantId, attempt.id, attempt.proposalId, attempt.idempotencyKey, attempt.mode, attempt.status, attempt.requestHash, attempt.providerRequestId ?? null, attempt.startedAt, attempt.finishedAt ?? null, JSON.stringify(attempt)],
    );
    return clone(attempt);
  }

  async get(tenantId: string, id: string): Promise<ExecutionAttempt | undefined> {
    const { rows } = await this.db.query<PayloadRow<ExecutionAttempt>>(
      `SELECT payload FROM execution_attempts WHERE tenant_id = $1 AND attempt_id = $2`,
      [tenantId, id],
    );
    return rows[0] ? clone(rows[0].payload) : undefined;
  }

  async list(tenantId: string, proposalId?: string): Promise<ExecutionAttempt[]> {
    const params: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (proposalId !== undefined) {
      params.push(proposalId);
      where.push(`proposal_id = $${params.length}`);
    }
    const { rows } = await this.db.query<PayloadRow<ExecutionAttempt>>(
      `SELECT payload FROM execution_attempts WHERE ${where.join(" AND ")} ORDER BY started_at ASC`,
      params,
    );
    return rows.map((row) => clone(row.payload));
  }
}

export class PostgresExecutionReceiptStore implements ExecutionReceiptStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresExecutionReceiptStore {
    return new PostgresExecutionReceiptStore(db);
  }

  async create(receipt: ExecutionReceipt): Promise<ExecutionReceipt> {
    await ensureTenant(this.db, receipt.tenantId);
    await this.db.query(
      `INSERT INTO execution_receipts
        (tenant_id, receipt_id, proposal_id, attempt_id, status, external_ref, provider_status, detail, safe_to_retry, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, receipt_id) DO NOTHING`,
      [receipt.tenantId, receipt.id, receipt.proposalId, receipt.attemptId, receipt.status, receipt.externalRef ?? null, receipt.providerStatus ?? null, receipt.detail ?? null, receipt.safeToRetry, JSON.stringify(receipt), receipt.createdAt],
    );
    return clone(receipt);
  }

  async get(tenantId: string, id: string): Promise<ExecutionReceipt | undefined> {
    const { rows } = await this.db.query<PayloadRow<ExecutionReceipt>>(
      `SELECT payload FROM execution_receipts WHERE tenant_id = $1 AND receipt_id = $2`,
      [tenantId, id],
    );
    return rows[0] ? clone(rows[0].payload) : undefined;
  }

  async list(tenantId: string, proposalId?: string): Promise<ExecutionReceipt[]> {
    const params: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (proposalId !== undefined) {
      params.push(proposalId);
      where.push(`proposal_id = $${params.length}`);
    }
    const { rows } = await this.db.query<PayloadRow<ExecutionReceipt>>(
      `SELECT payload FROM execution_receipts WHERE ${where.join(" AND ")} ORDER BY created_at ASC`,
      params,
    );
    return rows.map((row) => clone(row.payload));
  }
}

export class PostgresReconciliationStore implements ReconciliationStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresReconciliationStore {
    return new PostgresReconciliationStore(db);
  }

  async create(task: ReconciliationTask): Promise<ReconciliationTask> {
    await ensureTenant(this.db, task.tenantId);
    await this.db.query(
      `INSERT INTO reconciliation_tasks
        (tenant_id, task_id, proposal_id, attempt_id, reason, query_key, status, resolved_by, resolved_at, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, task_id) DO UPDATE SET status = EXCLUDED.status, resolved_by = EXCLUDED.resolved_by, resolved_at = EXCLUDED.resolved_at, payload = EXCLUDED.payload`,
      [task.tenantId, task.id, task.proposalId, task.attemptId, task.reason, task.queryKey, task.status, task.resolvedBy ?? null, task.resolvedAt ?? null, JSON.stringify(task), task.createdAt],
    );
    return clone(task);
  }

  async get(tenantId: string, id: string): Promise<ReconciliationTask | undefined> {
    const { rows } = await this.db.query<PayloadRow<ReconciliationTask>>(
      `SELECT payload FROM reconciliation_tasks WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, id],
    );
    return rows[0] ? clone(rows[0].payload) : undefined;
  }

  async list(tenantId: string, status?: ReconciliationTask["status"]): Promise<ReconciliationTask[]> {
    const params: unknown[] = [tenantId];
    const where = ["tenant_id = $1"];
    if (status !== undefined) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    const { rows } = await this.db.query<PayloadRow<ReconciliationTask>>(
      `SELECT payload FROM reconciliation_tasks WHERE ${where.join(" AND ")} ORDER BY created_at ASC`,
      params,
    );
    return rows.map((row) => clone(row.payload));
  }

  async resolve(task: ReconciliationTask, resolvedBy: string, now = new Date()): Promise<ReconciliationTask> {
    return this.create({ ...task, status: "resolved", resolvedBy, resolvedAt: now.toISOString() });
  }
}

export class PostgresProviderEventStore implements ProviderEventStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresProviderEventStore {
    return new PostgresProviderEventStore(db);
  }

  async append(event: ProviderEvent): Promise<{ event: ProviderEvent; duplicate: boolean }> {
    await ensureTenant(this.db, event.tenantId);
    const inserted = await this.db.query(
      `INSERT INTO provider_events
        (tenant_id, event_id, provider, provider_event_id, event_type, idempotency_key, occurred_at, payload_hash, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING`,
      [event.tenantId, event.id, event.provider, event.providerEventId, event.eventType, event.idempotencyKey, event.occurredAt, event.payloadHash, JSON.stringify(event), event.createdAt],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await this.db.query<PayloadRow<ProviderEvent>>(
        `SELECT payload FROM provider_events WHERE tenant_id = $1 AND provider = $2 AND provider_event_id = $3`,
        [event.tenantId, event.provider, event.providerEventId],
      );
      return { event: rows[0] ? clone(rows[0].payload) : clone(event), duplicate: true };
    }
    return { event: clone(event), duplicate: false };
  }

  async list(tenantId: string): Promise<ProviderEvent[]> {
    const { rows } = await this.db.query<PayloadRow<ProviderEvent>>(
      `SELECT payload FROM provider_events WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return rows.map((row) => clone(row.payload));
  }
}
