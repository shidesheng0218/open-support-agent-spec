import type { UsageQuery, UsageRecord, UsageStore } from "@osas/model-gateway";
import { ensureTenant, type Queryable } from "./pool.js";

interface UsageRow {
  tenant_id: string;
  case_id: string | null;
  provider: string;
  model: string;
  tier: UsageRecord["tier"];
  task: UsageRecord["task"];
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_usd: string | null; // numeric arrives as string
  truncated: boolean;
  created_at: Date;
}

function toRecord(r: UsageRow): UsageRecord {
  const record: UsageRecord = {
    tenantId: r.tenant_id,
    provider: r.provider,
    model: r.model,
    tier: r.tier,
    task: r.task,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    latencyMs: r.latency_ms,
    truncated: r.truncated,
    createdAt: r.created_at.toISOString(),
  };
  if (r.case_id) record.caseId = r.case_id;
  if (r.cost_usd !== null) record.costUsd = Number(r.cost_usd);
  return record;
}

/** §8 model telemetry on PostgreSQL. cost_usd stays NULL when unpriced. */
export class PostgresUsageStore implements UsageStore {
  constructor(private readonly db: Queryable) {}

  /** Bind to a transaction client (see withTransaction). */
  withClient(db: Queryable): PostgresUsageStore {
    return new PostgresUsageStore(db);
  }

  async record(entry: UsageRecord): Promise<void> {
    await ensureTenant(this.db, entry.tenantId);
    await this.db.query(
      `INSERT INTO model_usage
         (tenant_id, case_id, provider, model, tier, task,
          input_tokens, output_tokens, latency_ms, cost_usd, truncated, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        entry.tenantId,
        entry.caseId ?? null,
        entry.provider,
        entry.model,
        entry.tier,
        entry.task,
        entry.inputTokens,
        entry.outputTokens,
        entry.latencyMs,
        entry.costUsd ?? null,
        entry.truncated,
        entry.createdAt,
      ],
    );
  }

  async query(q: UsageQuery): Promise<UsageRecord[]> {
    const { rows } = await this.db.query<UsageRow>(
      `SELECT tenant_id, case_id, provider, model, tier, task,
              input_tokens, output_tokens, latency_ms, cost_usd, truncated, created_at
         FROM model_usage
        WHERE ($1::text IS NULL OR tenant_id = $1)
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at < $3)
          AND ($4::text IS NULL OR model = $4)
          AND ($5::text IS NULL OR task = $5)
        ORDER BY created_at ASC, id ASC`,
      [q.tenantId ?? null, q.from ?? null, q.to ?? null, q.model ?? null, q.task ?? null],
    );
    return rows.map(toRecord);
  }

  async sumKnownCostUsd(q: UsageQuery): Promise<number> {
    const { rows } = await this.db.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
         FROM model_usage
        WHERE cost_usd IS NOT NULL
          AND ($1::text IS NULL OR tenant_id = $1)
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at < $3)
          AND ($4::text IS NULL OR model = $4)
          AND ($5::text IS NULL OR task = $5)`,
      [q.tenantId ?? null, q.from ?? null, q.to ?? null, q.model ?? null, q.task ?? null],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
