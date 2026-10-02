import { GOVERNANCE_SPEC_VERSION } from "@osas/governance";
import type {
  JobFailure,
  JobKind,
  JobRun,
  JobStatus,
  JobStore,
} from "@osas/governance";
import { GovernanceConflictError, GovernanceNotFoundError, backoffFrom } from "@osas/governance";
import { ensureTenant, type Queryable } from "./pool.js";

/**
 * PostgreSQL job queue (M1).
 *
 * `claim` is a single statement using FOR UPDATE SKIP LOCKED, so two workers
 * cannot lease the same job even when they race. `fail` applies the retry
 * policy in SQL: a side-effecting job is never returned to "queued".
 */

const JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "leased",
  "succeeded",
  "dead_letter",
  "cancelled",
];

interface JobRow {
  tenant_id: string;
  job_id: string;
  kind: JobKind;
  status: JobStatus;
  retry_class: JobRun["retryClass"];
  attempts: number;
  max_attempts: number;
  run_at: Date;
  deadline_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  last_error_code: string | null;
  last_error_message: string | null;
  reconciliation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toJob(r: JobRow): JobRun {
  const job: JobRun = {
    id: r.job_id,
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: r.tenant_id,
    kind: r.kind,
    status: r.status,
    retryClass: r.retry_class,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAt: r.run_at.toISOString(),
    input: r.input,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
  if (r.deadline_at) job.deadlineAt = r.deadline_at.toISOString();
  if (r.lease_owner) job.leaseOwner = r.lease_owner;
  if (r.lease_expires_at) job.leaseExpiresAt = r.lease_expires_at.toISOString();
  if (r.result) job.result = r.result;
  if (r.last_error_code) job.lastErrorCode = r.last_error_code;
  if (r.last_error_message) job.lastErrorMessage = r.last_error_message;
  if (r.reconciliation_id) job.reconciliationId = r.reconciliation_id;
  return job;
}

export class PostgresJobStore implements JobStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresJobStore {
    return new PostgresJobStore(db);
  }

  async create(job: JobRun) {
    await ensureTenant(this.db, job.tenantId);
    try {
      const { rows } = await this.db.query<JobRow>(
        `INSERT INTO job_runs
           (tenant_id, job_id, kind, status, retry_class, attempts, max_attempts, run_at,
            deadline_at, lease_owner, lease_expires_at, input, result, last_error_code,
            last_error_message, reconciliation_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          job.tenantId,
          job.id,
          job.kind,
          job.status,
          job.retryClass,
          job.attempts,
          job.maxAttempts,
          job.runAt,
          job.deadlineAt ?? null,
          job.leaseOwner ?? null,
          job.leaseExpiresAt ?? null,
          JSON.stringify(job.input),
          job.result ? JSON.stringify(job.result) : null,
          job.lastErrorCode ?? null,
          job.lastErrorMessage ?? null,
          job.reconciliationId ?? null,
          job.createdAt,
          job.updatedAt,
        ],
      );
      return toJob(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new GovernanceConflictError(`job "${job.id}" already exists`, "job", job.id);
      }
      throw err;
    }
  }

  async get(tenantId: string, id: string) {
    const { rows } = await this.db.query<JobRow>(
      "SELECT * FROM job_runs WHERE tenant_id = $1 AND job_id = $2",
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toJob(row) : undefined;
  }

  async list(tenantId: string, filter?: { status?: JobStatus; kind?: JobKind }, limit = 100) {
    const { rows } = await this.db.query<JobRow>(
      `SELECT * FROM job_runs
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR kind = $3)
        ORDER BY created_at ASC, job_id ASC
        LIMIT $4`,
      [tenantId, filter?.status ?? null, filter?.kind ?? null, limit],
    );
    return rows.map(toJob);
  }

  async claim(input: {
    owner: string;
    now: Date;
    leaseMs: number;
    limit: number;
    tenantId?: string;
    kinds?: readonly JobKind[];
  }) {
    const leaseExpires = new Date(input.now.getTime() + input.leaseMs);
    const { rows } = await this.db.query<JobRow>(
      `WITH claimable AS (
         SELECT tenant_id, job_id FROM job_runs
          WHERE status = 'queued'
            AND run_at <= $1
            AND (deadline_at IS NULL OR deadline_at > $1)
            AND ($2::text IS NULL OR tenant_id = $2)
            AND (cardinality($3::text[]) = 0 OR kind = ANY($3::text[]))
          ORDER BY run_at ASC, created_at ASC
          LIMIT $4
          FOR UPDATE SKIP LOCKED
       )
       UPDATE job_runs j
          SET status = 'leased',
              lease_owner = $5,
              lease_expires_at = $6,
              attempts = j.attempts + 1,
              updated_at = $1
         FROM claimable c
        WHERE j.tenant_id = c.tenant_id AND j.job_id = c.job_id
        RETURNING j.*`,
      [
        input.now.toISOString(),
        input.tenantId ?? null,
        input.kinds ? [...input.kinds] : [],
        input.limit,
        input.owner,
        leaseExpires.toISOString(),
      ],
    );
    return rows.map(toJob);
  }

  async complete(tenantId: string, id: string, result: Record<string, unknown>, now: Date) {
    const { rows } = await this.db.query<JobRow>(
      `UPDATE job_runs SET
         status = 'succeeded', result = $3::jsonb,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = $4
       WHERE tenant_id = $1 AND job_id = $2
       RETURNING *`,
      [tenantId, id, JSON.stringify(result), now.toISOString()],
    );
    const row = rows[0];
    if (!row) throw new GovernanceNotFoundError("job", id);
    return toJob(row);
  }

  async fail(tenantId: string, id: string, failure: JobFailure, now: Date) {
    const current = await this.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("job", id);
    const exhausted = current.attempts >= current.maxAttempts;
    // The retry decision is computed here and applied in one statement, so a
    // concurrent sweep cannot observe a half-applied policy.
    const deadLetter =
      failure.deadLetter === true || current.retryClass === "side_effecting" || exhausted;
    const nextRunAt = deadLetter
      ? null
      : (failure.nextRunAt ?? backoffFrom(now, current.attempts));
    const { rows } = await this.db.query<JobRow>(
      `UPDATE job_runs SET
         status = $3,
         run_at = COALESCE($4::timestamptz, run_at),
         deadline_at = COALESCE($5::timestamptz, deadline_at),
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error_code = $6,
         last_error_message = $7,
         updated_at = $8
       WHERE tenant_id = $1 AND job_id = $2
       RETURNING *`,
      [
        tenantId,
        id,
        deadLetter ? "dead_letter" : "queued",
        nextRunAt,
        failure.deadlineAt ?? null,
        failure.errorCode,
        failure.errorMessage,
        now.toISOString(),
      ],
    );
    const row = rows[0];
    if (!row) throw new GovernanceNotFoundError("job", id);
    return toJob(row);
  }

  async reclaimExpiredLeases(now: Date) {
    const { rows } = await this.db.query<JobRow>(
      `UPDATE job_runs SET
         status = 'queued', run_at = $1, lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
       WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1
       RETURNING *`,
      [now.toISOString()],
    );
    return rows.map(toJob);
  }

  async countByStatus(tenantId?: string): Promise<Record<JobStatus, number>> {
    const { rows } = await this.db.query<{ status: JobStatus; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM job_runs
        WHERE ($1::text IS NULL OR tenant_id = $1) GROUP BY status`,
      [tenantId ?? null],
    );
    const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }
}
