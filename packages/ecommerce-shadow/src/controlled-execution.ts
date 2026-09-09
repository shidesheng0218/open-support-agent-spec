import { createHash } from "node:crypto";
import type {
  ActionProposal,
  ExecutionAttempt,
  ExecutionMode,
  ExecutionReceipt,
  ExecutionResult,
  ProviderEvent,
  ReconciliationTask,
} from "@osas/core";

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
};

const requestHash = (proposal: ActionProposal): string =>
  createHash("sha256")
    .update(
      stable({
        tenantId: proposal.tenantId,
        proposalId: proposal.id,
        actionType: proposal.actionType,
        params: proposal.params,
        amount: proposal.amount,
        idempotencyKey: proposal.idempotencyKey,
      }),
    )
    .digest("hex");

export function hashProviderPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stable(payload)).digest("hex");
}

export function createExecutionAttempt(
  proposal: ActionProposal,
  mode: ExecutionMode,
  input: { id: string; now?: Date },
): ExecutionAttempt {
  return {
    id: input.id,
    specVersion: "0.3",
    tenantId: proposal.tenantId,
    proposalId: proposal.id,
    idempotencyKey: proposal.idempotencyKey,
    mode,
    status: "started",
    requestHash: requestHash(proposal),
    startedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function createExecutionReceipt(
  attempt: ExecutionAttempt,
  result: ExecutionResult,
  input: { id: string; now?: Date },
): ExecutionReceipt {
  return {
    id: input.id,
    specVersion: "0.3",
    tenantId: attempt.tenantId,
    proposalId: attempt.proposalId,
    attemptId: attempt.id,
    status: result.status,
    ...(result.externalRef ? { externalRef: result.externalRef } : {}),
    ...(result.providerStatus ? { providerStatus: result.providerStatus } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
    safeToRetry: result.status === "failed" && result.safeToRetry === true,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function createReconciliationTask(
  attempt: ExecutionAttempt,
  result: ExecutionResult,
  input: { id: string; now?: Date },
): ReconciliationTask {
  return {
    id: input.id,
    specVersion: "0.3",
    tenantId: attempt.tenantId,
    proposalId: attempt.proposalId,
    attemptId: attempt.id,
    reason: result.detail ?? "provider returned an uncertain result",
    queryKey: `${attempt.tenantId}:${attempt.idempotencyKey}`,
    status: "open",
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export interface ProviderEventStore {
  append(event: ProviderEvent): Promise<{ event: ProviderEvent; duplicate: boolean }>;
  list(tenantId: string): Promise<ProviderEvent[]>;
}

export interface ExecutionAttemptStore {
  create(attempt: ExecutionAttempt): Promise<ExecutionAttempt>;
  get(tenantId: string, id: string): Promise<ExecutionAttempt | undefined>;
  list(tenantId: string, proposalId?: string): Promise<ExecutionAttempt[]>;
}

export interface ExecutionReceiptStore {
  create(receipt: ExecutionReceipt): Promise<ExecutionReceipt>;
  get(tenantId: string, id: string): Promise<ExecutionReceipt | undefined>;
  list(tenantId: string, proposalId?: string): Promise<ExecutionReceipt[]>;
}

export interface ReconciliationStore {
  create(task: ReconciliationTask): Promise<ReconciliationTask>;
  get(tenantId: string, id: string): Promise<ReconciliationTask | undefined>;
  list(tenantId: string, status?: ReconciliationTask["status"]): Promise<ReconciliationTask[]>;
  resolve(task: ReconciliationTask, resolvedBy: string, now?: Date): Promise<ReconciliationTask>;
}

export class InMemoryExecutionAttemptStore implements ExecutionAttemptStore {
  private readonly attempts = new Map<string, ExecutionAttempt>();

  async create(attempt: ExecutionAttempt): Promise<ExecutionAttempt> {
    this.attempts.set(`${attempt.tenantId}:${attempt.id}`, structuredClone(attempt));
    return structuredClone(attempt);
  }

  async get(tenantId: string, id: string): Promise<ExecutionAttempt | undefined> {
    const found = this.attempts.get(`${tenantId}:${id}`);
    return found ? structuredClone(found) : undefined;
  }

  async list(tenantId: string, proposalId?: string): Promise<ExecutionAttempt[]> {
    return structuredClone(
      [...this.attempts.values()].filter(
        (attempt) =>
          attempt.tenantId === tenantId &&
          (proposalId === undefined || attempt.proposalId === proposalId),
      ),
    );
  }

  /** Conformance Mode (test-only): remove all attempts. */
  reset(): void {
    this.attempts.clear();
  }
}

export class InMemoryExecutionReceiptStore implements ExecutionReceiptStore {
  private readonly receipts = new Map<string, ExecutionReceipt>();

  async create(receipt: ExecutionReceipt): Promise<ExecutionReceipt> {
    this.receipts.set(`${receipt.tenantId}:${receipt.id}`, structuredClone(receipt));
    return structuredClone(receipt);
  }

  async get(tenantId: string, id: string): Promise<ExecutionReceipt | undefined> {
    const found = this.receipts.get(`${tenantId}:${id}`);
    return found ? structuredClone(found) : undefined;
  }

  async list(tenantId: string, proposalId?: string): Promise<ExecutionReceipt[]> {
    return structuredClone(
      [...this.receipts.values()].filter(
        (receipt) =>
          receipt.tenantId === tenantId &&
          (proposalId === undefined || receipt.proposalId === proposalId),
      ),
    );
  }

  /** Conformance Mode (test-only): remove all receipts. */
  reset(): void {
    this.receipts.clear();
  }
}

export class InMemoryReconciliationStore implements ReconciliationStore {
  private readonly tasks = new Map<string, ReconciliationTask>();

  async create(task: ReconciliationTask): Promise<ReconciliationTask> {
    this.tasks.set(`${task.tenantId}:${task.id}`, structuredClone(task));
    return structuredClone(task);
  }

  async get(tenantId: string, id: string): Promise<ReconciliationTask | undefined> {
    const found = this.tasks.get(`${tenantId}:${id}`);
    return found ? structuredClone(found) : undefined;
  }

  async list(tenantId: string, status?: ReconciliationTask["status"]): Promise<ReconciliationTask[]> {
    return structuredClone(
      [...this.tasks.values()].filter(
        (task) => task.tenantId === tenantId && (status === undefined || task.status === status),
      ),
    );
  }

  async resolve(task: ReconciliationTask, resolvedBy: string, now = new Date()): Promise<ReconciliationTask> {
    const resolved = {
      ...task,
      status: "resolved" as const,
      resolvedBy,
      resolvedAt: now.toISOString(),
    };
    this.tasks.set(`${task.tenantId}:${task.id}`, structuredClone(resolved));
    return structuredClone(resolved);
  }

  /** Conformance Mode (test-only): remove all reconciliation tasks. */
  reset(): void {
    this.tasks.clear();
  }
}

export class InMemoryProviderEventStore implements ProviderEventStore {
  private readonly events = new Map<string, ProviderEvent>();

  private key(event: Pick<ProviderEvent, "tenantId" | "provider" | "providerEventId">): string {
    return `${event.tenantId}:${event.provider}:${event.providerEventId}`;
  }

  async append(event: ProviderEvent): Promise<{ event: ProviderEvent; duplicate: boolean }> {
    const key = this.key(event);
    const existing = this.events.get(key);
    if (existing) return { event: structuredClone(existing), duplicate: true };
    this.events.set(key, structuredClone(event));
    return { event: structuredClone(event), duplicate: false };
  }

  async list(tenantId: string): Promise<ProviderEvent[]> {
    return structuredClone([...this.events.values()].filter((event) => event.tenantId === tenantId));
  }

  reset(): void {
    this.events.clear();
  }
}
