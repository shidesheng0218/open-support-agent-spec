import type { Clock, IdFactory } from "./deps.js";
import { GOVERNANCE_SPEC_VERSION } from "./types.js";
import type { JobFailure, JobKind, JobRun, Reconciliation } from "./types.js";
import type { GovernanceStores, JobClaimInput } from "./ports.js";
import { backoffFrom } from "./memory.js";

/**
 * Job runner (M1).
 *
 * The runner is deliberately boring, and three of its properties are the point:
 *
 * 1. **Only claim what you can run.** Claiming is restricted to registered job
 *    kinds, so a queued job with no handler stays visible instead of being
 *    claimed and destroyed.
 * 2. **Leases, not locks.** A worker that dies mid-job leaves a lease that
 *    expires; the next sweep reclaims it. For a side-effecting job the
 *    reclaimed attempt is an *unknown outcome*, so it is dead-lettered and
 *    reconciled rather than retried.
 * 3. **Retry class decides, not the caller.** `side_effecting` jobs are never
 *    automatically retried; a failure opens a reconciliation.
 */

export interface JobHandlerContext {
  job: JobRun;
  stores: GovernanceStores;
  clock: Clock;
  ids: IdFactory;
}

export type JobHandler = (job: JobRun, ctx: JobHandlerContext) => Promise<Record<string, unknown>>;

export interface JobRunnerDeps {
  stores: GovernanceStores;
  clock: Clock;
  ids: IdFactory;
  /** Stable worker identity, written to the job lease. */
  owner: string;
  /** Lease duration; a job claimed but not finished within it is reclaimed. */
  leaseMs?: number;
  handlers: Partial<Record<JobKind, JobHandler>>;
}

export interface RunOnceReport {
  reclaimed: JobRun[];
  claimed: JobRun[];
  succeeded: JobRun[];
  retried: JobRun[];
  deadLettered: JobRun[];
  reconciliations: Reconciliation[];
}

const DEFAULT_LEASE_MS = 30_000;

export class JobRunner {
  constructor(private readonly deps: JobRunnerDeps) {}

  get leaseMs(): number {
    return this.deps.leaseMs ?? DEFAULT_LEASE_MS;
  }

  async runOnce(opts: { limit?: number; tenantId?: string } = {}): Promise<RunOnceReport> {
    const now = this.deps.clock.now();
    const report: RunOnceReport = {
      reclaimed: [],
      claimed: [],
      succeeded: [],
      retried: [],
      deadLettered: [],
      reconciliations: [],
    };

    const reclaimed = await this.reclaimExpiredLeases();
    report.reclaimed.push(...reclaimed.reclaimed);
    report.deadLettered.push(...reclaimed.deadLettered);
    report.reconciliations.push(...reclaimed.reconciliations);

    const kinds = Object.keys(this.deps.handlers) as JobKind[];
    if (kinds.length === 0) return report;

    const claimInput: JobClaimInput = {
      owner: this.deps.owner,
      now,
      leaseMs: this.leaseMs,
      limit: opts.limit ?? 10,
      kinds,
    };
    if (opts.tenantId) claimInput.tenantId = opts.tenantId;

    const claimed = await this.deps.stores.jobs.claim(claimInput);
    report.claimed.push(...claimed);

    for (const job of claimed) {
      const handler = this.deps.handlers[job.kind];
      if (!handler) {
        // The handler set is deployment configuration; retrying cannot fix it.
        const dead = await this.applyFailure(job, {
          errorCode: "NO_HANDLER",
          errorMessage: `no handler registered for job kind "${job.kind}"`,
          deadLetter: true,
        });
        report.deadLettered.push(dead.job);
        if (dead.reconciliation) report.reconciliations.push(dead.reconciliation);
        continue;
      }
      try {
        const result = await handler(job, {
          job,
          stores: this.deps.stores,
          clock: this.deps.clock,
          ids: this.deps.ids,
        });
        const finished = await this.deps.stores.jobs.complete(
          job.tenantId,
          job.id,
          result,
          this.deps.clock.now(),
        );
        report.succeeded.push(finished);
      } catch (err) {
        const failure = toJobFailure(err);
        const applied = await this.applyFailure(job, failure);
        if (applied.job.status === "dead_letter") report.deadLettered.push(applied.job);
        else report.retried.push(applied.job);
        if (applied.reconciliation) report.reconciliations.push(applied.reconciliation);
      }
    }
    return report;
  }

  /**
   * Recover jobs whose worker died. A read-only job simply becomes claimable
   * again; a side-effecting job becomes an unknown outcome and is reconciled.
   */
  async reclaimExpiredLeases(): Promise<{
    reclaimed: JobRun[];
    deadLettered: JobRun[];
    reconciliations: Reconciliation[];
  }> {
    const now = this.deps.clock.now();
    const reclaimed = await this.deps.stores.jobs.reclaimExpiredLeases(now);
    const deadLettered: JobRun[] = [];
    const reconciliations: Reconciliation[] = [];
    for (const job of reclaimed) {
      if (job.retryClass === "side_effecting") {
        const applied = await this.applyFailure(job, {
          errorCode: "LEASE_EXPIRED_UNKNOWN_OUTCOME",
          errorMessage:
            "worker lease expired while a side-effecting job was in flight; the provider outcome is unknown",
        });
        deadLettered.push(applied.job);
        if (applied.reconciliation) reconciliations.push(applied.reconciliation);
      } else if (job.attempts >= job.maxAttempts) {
        const applied = await this.applyFailure(job, {
          errorCode: "LEASE_EXPIRED_ATTEMPTS_EXHAUSTED",
          errorMessage: `worker lease expired after ${job.attempts} attempts`,
          deadLetter: true,
        });
        deadLettered.push(applied.job);
        if (applied.reconciliation) reconciliations.push(applied.reconciliation);
      }
      // Otherwise it is queued again and the next runOnce claims it.
    }
    return { reclaimed, deadLettered, reconciliations };
  }

  private async applyFailure(
    job: JobRun,
    failure: JobFailure,
  ): Promise<{ job: JobRun; reconciliation?: Reconciliation }> {
    const failed = await this.deps.stores.jobs.fail(
      job.tenantId,
      job.id,
      failure,
      this.deps.clock.now(),
    );
    if (failed.status !== "dead_letter") return { job: failed };
    const reconciliation = await this.openReconciliation(failed, failure);
    return reconciliation ? { job: failed, reconciliation } : { job: failed };
  }

  /**
   * A side-effecting job that dead-lettered may or may not have changed
   * provider state. That is exactly the case a human must reconcile, so the
   * record is opened automatically — the platform never assumes "probably
   * fine".
   */
  private async openReconciliation(
    job: JobRun,
    failure: JobFailure,
  ): Promise<Reconciliation | undefined> {
    if (job.retryClass !== "side_effecting") return undefined;
    const now = this.deps.clock.now();
    const detail: Record<string, unknown> = {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      input: job.input,
      note: "side-effecting job did not complete; the provider outcome is unknown and must be verified before any retry",
    };
    const { reconciliation } = await this.deps.stores.reconciliations.createIfAbsent({
      id: this.deps.ids.next("recon"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: job.tenantId,
      reason: "unknown_outcome",
      status: "open",
      dedupeKey: `job:${job.id}`,
      jobRunId: job.id,
      ...(typeof job.input.connectionId === "string" ? { connectionId: job.input.connectionId } : {}),
      ...(typeof job.input.caseId === "string" ? { caseId: job.input.caseId } : {}),
      ...(typeof job.input.proposalId === "string" ? { proposalId: job.input.proposalId } : {}),
      ...(typeof job.input.idempotencyKey === "string"
        ? { idempotencyKey: job.input.idempotencyKey }
        : {}),
      detail,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    return reconciliation;
  }

  /** Queue a job. Used by services; the reason must be one of the known kinds. */
  async enqueue(input: {
    tenantId: string;
    kind: JobKind;
    input: Record<string, unknown>;
    retryClass?: JobRun["retryClass"];
    maxAttempts?: number;
    runAt?: Date;
    deadlineAt?: Date;
    reconciliationId?: string;
  }): Promise<JobRun> {
    const now = this.deps.clock.now();
    const job: JobRun = {
      id: this.deps.ids.next("job"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: input.tenantId,
      kind: input.kind,
      status: "queued",
      retryClass: input.retryClass ?? defaultRetryClass(input.kind),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      runAt: (input.runAt ?? now).toISOString(),
      input: { ...input.input },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (input.deadlineAt) job.deadlineAt = input.deadlineAt.toISOString();
    if (input.reconciliationId) job.reconciliationId = input.reconciliationId;
    return this.deps.stores.jobs.create(job);
  }
}

/** Reads may be retried; anything that may write may not. */
export function defaultRetryClass(kind: JobKind): JobRun["retryClass"] {
  return kind === "reconciliation.refetch" ? "safe_read" : "side_effecting";
}

export function toJobFailure(err: unknown): JobFailure {
  if (err instanceof Error) {
    const rawCode = (err as unknown as { code?: unknown }).code;
    const code = typeof rawCode === "string" && rawCode.trim() ? rawCode : err.name || "JOB_HANDLER_FAILED";
    return { errorCode: code.toUpperCase(), errorMessage: err.message };
  }
  return { errorCode: "JOB_HANDLER_FAILED", errorMessage: String(err) };
}

export { backoffFrom };
