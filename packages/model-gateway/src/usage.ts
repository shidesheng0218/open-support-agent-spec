/**
 * Model usage persistence (Milestone 2). Every model call's telemetry is
 * recorded through a UsageStore — in-memory for tests/local dev, PostgreSQL
 * (@osas/store-postgres) for real deployments. Costs are stored as recorded:
 * when no price is configured `costUsd` is undefined ("unknown"), never a
 * fabricated number.
 */
import type { ModelTask, ModelTier } from "./types.js";

export interface UsageRecord {
  tenantId: string;
  caseId?: string;
  provider: string;
  model: string;
  tier: ModelTier;
  task: ModelTask;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** USD cost; undefined = unknown (provider price not configured). */
  costUsd?: number;
  truncated: boolean;
  createdAt: string;
}

export interface UsageQuery {
  tenantId?: string;
  /** ISO date-time bounds on createdAt (inclusive from, exclusive to). */
  from?: string;
  to?: string;
  model?: string;
  task?: ModelTask;
}

export interface UsageStore {
  record(entry: UsageRecord): Promise<void>;
  query(q: UsageQuery): Promise<UsageRecord[]>;
  /**
   * Sum of known (priced) costs in USD. Unknown-cost records contribute 0 —
   * budgets are enforced on measured spend only.
   */
  sumKnownCostUsd(q: UsageQuery): Promise<number>;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly entries: UsageRecord[] = [];

  async record(entry: UsageRecord): Promise<void> {
    this.entries.push(structuredClone(entry));
  }

  async query(q: UsageQuery): Promise<UsageRecord[]> {
    return structuredClone(
      this.entries.filter(
        (e) =>
          (q.tenantId === undefined || e.tenantId === q.tenantId) &&
          (q.from === undefined || e.createdAt >= q.from) &&
          (q.to === undefined || e.createdAt < q.to) &&
          (q.model === undefined || e.model === q.model) &&
          (q.task === undefined || e.task === q.task),
      ),
    );
  }

  async sumKnownCostUsd(q: UsageQuery): Promise<number> {
    const rows = await this.query(q);
    return rows.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  }

  /** Conformance Mode (Milestone 4, test-only): wipe all usage records. */
  reset(): void {
    this.entries.length = 0;
  }
}
