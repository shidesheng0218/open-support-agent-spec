import type { ShadowRun, ShadowRunOutcome } from "@osas/core";
import type { ShadowRunStore } from "@osas/ecommerce-shadow";
import { ensureTenant, type Queryable } from "./pool.js";

interface ShadowRunRow {
  payload: ShadowRun;
}

/**
 * Milestone 3 ShadowRun persistence on the shadow_runs table. The full
 * ShadowRun lives in `payload`; the dedicated columns (proposal_id,
 * human_outcome, would_auto_execute, ...) exist for filtering/inspection.
 */
export class PostgresShadowRunStore implements ShadowRunStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresShadowRunStore {
    return new PostgresShadowRunStore(db);
  }

  async create(run: ShadowRun): Promise<ShadowRun> {
    await ensureTenant(this.db, run.tenantId);
    await this.db.query(
      `INSERT INTO shadow_runs
         (tenant_id, shadow_run_id, proposal_id, policy_version, decision,
          would_auto_execute, suggested_action, human_outcome, human_comment,
          external_reference, reviewed_at, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        run.tenantId,
        run.id,
        run.proposalId,
        run.policyDecision.policyVersion,
        JSON.stringify(run.policyDecision),
        run.wouldAutoExecute,
        JSON.stringify(run.suggestedAction),
        run.humanOutcome,
        run.humanComment ?? null,
        run.externalReference ?? null,
        run.reviewedAt ?? null,
        JSON.stringify(run),
        run.createdAt,
      ],
    );
    return structuredClone(run);
  }

  async get(tenantId: string, id: string): Promise<ShadowRun | undefined> {
    const { rows } = await this.db.query<ShadowRunRow>(
      `SELECT payload FROM shadow_runs WHERE tenant_id = $1 AND shadow_run_id = $2`,
      [tenantId, id],
    );
    const row = rows[0];
    return row ? structuredClone(row.payload) : undefined;
  }

  async list(
    tenantId: string,
    q: { proposalId?: string; humanOutcome?: ShadowRunOutcome } = {},
  ): Promise<ShadowRun[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (q.proposalId !== undefined) {
      params.push(q.proposalId);
      conditions.push(`proposal_id = $${params.length}`);
    }
    if (q.humanOutcome !== undefined) {
      params.push(q.humanOutcome);
      conditions.push(`human_outcome = $${params.length}`);
    }
    const { rows } = await this.db.query<ShadowRunRow>(
      `SELECT payload FROM shadow_runs WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
      params,
    );
    return rows.map((r) => structuredClone(r.payload));
  }

  async save(run: ShadowRun): Promise<ShadowRun> {
    await this.db.query(
      `UPDATE shadow_runs
          SET policy_version = $3, decision = $4, would_auto_execute = $5,
              suggested_action = $6, human_outcome = $7, human_comment = $8,
              external_reference = $9, reviewed_at = $10, payload = $11
        WHERE tenant_id = $1 AND shadow_run_id = $2`,
      [
        run.tenantId,
        run.id,
        run.policyDecision.policyVersion,
        JSON.stringify(run.policyDecision),
        run.wouldAutoExecute,
        JSON.stringify(run.suggestedAction),
        run.humanOutcome,
        run.humanComment ?? null,
        run.externalReference ?? null,
        run.reviewedAt ?? null,
        JSON.stringify(run),
      ],
    );
    return structuredClone(run);
  }
}
