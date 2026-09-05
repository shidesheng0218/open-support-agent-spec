import type { ShadowRun, ShadowRunOutcome } from "@osas/core";

/**
 * ShadowRun persistence seam. In-memory by default; PostgresShadowRunStore
 * (@osas/store-postgres) maps onto the shadow_runs table.
 */
export interface ShadowRunStore {
  create(run: ShadowRun): Promise<ShadowRun>;
  get(tenantId: string, id: string): Promise<ShadowRun | undefined>;
  list(
    tenantId: string,
    q?: { proposalId?: string; humanOutcome?: ShadowRunOutcome },
  ): Promise<ShadowRun[]>;
  /** Replace a stored run (human review). */
  save(run: ShadowRun): Promise<ShadowRun>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryShadowRunStore implements ShadowRunStore {
  private readonly runs = new Map<string, ShadowRun>();

  private static key(tenantId: string, id: string): string {
    return `${tenantId} ${id}`;
  }

  async create(run: ShadowRun): Promise<ShadowRun> {
    this.runs.set(InMemoryShadowRunStore.key(run.tenantId, run.id), clone(run));
    return clone(run);
  }

  async get(tenantId: string, id: string): Promise<ShadowRun | undefined> {
    const found = this.runs.get(InMemoryShadowRunStore.key(tenantId, id));
    return found ? clone(found) : undefined;
  }

  async list(
    tenantId: string,
    q: { proposalId?: string; humanOutcome?: ShadowRunOutcome } = {},
  ): Promise<ShadowRun[]> {
    return clone(
      [...this.runs.values()]
        .filter(
          (r) =>
            r.tenantId === tenantId &&
            (q.proposalId === undefined || r.proposalId === q.proposalId) &&
            (q.humanOutcome === undefined || r.humanOutcome === q.humanOutcome),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }

  async save(run: ShadowRun): Promise<ShadowRun> {
    this.runs.set(InMemoryShadowRunStore.key(run.tenantId, run.id), clone(run));
    return clone(run);
  }
}
