-- OSAS Milestone 2 — initial PostgreSQL schema.
-- Every record is tenant-scoped; there are no cross-tenant tables.
-- All access goes through parameterized queries in src/ (never string-built SQL).

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id   text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Versioned, immutable tenant policies (PolicyVersionRecord payload + columns).
CREATE TABLE IF NOT EXISTS policy_versions (
  tenant_id     text        NOT NULL REFERENCES tenants (tenant_id),
  version       text        NOT NULL,
  status        text        NOT NULL,
  policy        jsonb       NOT NULL,
  created_by    text        NOT NULL,
  simulated_at  timestamptz,
  approved_by   text,
  approved_at   timestamptz,
  activated_by  text,
  activated_at  timestamptz,
  retired_by    text,
  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

CREATE TABLE IF NOT EXISTS proposals (
  tenant_id       text        NOT NULL REFERENCES tenants (tenant_id),
  proposal_id     text        NOT NULL,
  case_id         text        NOT NULL,
  status          text        NOT NULL,
  idempotency_key text        NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, proposal_id)
);
-- At most one live proposal per (tenant, idempotency key).
CREATE UNIQUE INDEX IF NOT EXISTS proposals_idempotency_uq
  ON proposals (tenant_id, idempotency_key);

CREATE TABLE IF NOT EXISTS approvals (
  tenant_id    text        NOT NULL REFERENCES tenants (tenant_id),
  approval_id  text        NOT NULL,
  proposal_id  text        NOT NULL,
  status       text        NOT NULL,
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, approval_id)
);

CREATE TABLE IF NOT EXISTS evidence (
  tenant_id   text        NOT NULL REFERENCES tenants (tenant_id),
  evidence_id text        NOT NULL,
  case_id     text,
  kind        text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, evidence_id)
);

-- Append-only audit stream. sequence/previous_hash/event_hash carry the
-- v0.1.1 per-tenant hash chain (tamper-evidence).
CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id      text   NOT NULL REFERENCES tenants (tenant_id),
  event_id       text   NOT NULL,
  sequence       bigint,
  previous_hash  text,
  event_hash     text,
  event_type     text   NOT NULL,
  actor_type     text   NOT NULL,
  actor_id       text   NOT NULL,
  case_id        text,
  proposal_id    text,
  approval_id    text,
  policy_version text,
  model_info     jsonb,
  detail         jsonb  NOT NULL,
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain_uq
  ON audit_events (tenant_id, sequence);

-- §5 idempotent execution ledger: the PRIMARY KEY IS the
-- (tenant_id, idempotency_key) uniqueness constraint.
CREATE TABLE IF NOT EXISTS execution_records (
  tenant_id       text        NOT NULL REFERENCES tenants (tenant_id),
  idempotency_key text        NOT NULL,
  proposal_id     text        NOT NULL,
  status          text        NOT NULL,
  result          jsonb       NOT NULL,
  completed_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- v0.3 controlled execution records. Full JSON payloads preserve forward
-- compatibility while dedicated columns support tenant-scoped queries.
CREATE TABLE IF NOT EXISTS execution_attempts (
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  attempt_id          text NOT NULL,
  proposal_id         text NOT NULL,
  idempotency_key     text NOT NULL,
  mode                text NOT NULL,
  status              text NOT NULL,
  request_hash        text NOT NULL,
  provider_request_id text,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  payload             jsonb NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS execution_attempts_proposal_idx
  ON execution_attempts (tenant_id, proposal_id, started_at);

CREATE TABLE IF NOT EXISTS execution_receipts (
  tenant_id      text NOT NULL REFERENCES tenants (tenant_id),
  receipt_id     text NOT NULL,
  proposal_id    text NOT NULL,
  attempt_id     text NOT NULL,
  status         text NOT NULL,
  external_ref   text,
  provider_status text,
  detail         text,
  safe_to_retry  boolean NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS execution_receipts_proposal_idx
  ON execution_receipts (tenant_id, proposal_id, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_tasks (
  tenant_id    text NOT NULL REFERENCES tenants (tenant_id),
  task_id      text NOT NULL,
  proposal_id  text NOT NULL,
  attempt_id   text NOT NULL,
  reason       text NOT NULL,
  query_key    text NOT NULL,
  status       text NOT NULL,
  resolved_by  text,
  resolved_at  timestamptz,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);
CREATE INDEX IF NOT EXISTS reconciliation_tasks_status_idx
  ON reconciliation_tasks (tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS provider_events (
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  event_id          text NOT NULL,
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  idempotency_key   text NOT NULL,
  occurred_at       timestamptz NOT NULL,
  payload_hash      text NOT NULL,
  payload           jsonb NOT NULL,
  created_at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS provider_events_idempotency_idx
  ON provider_events (tenant_id, idempotency_key, occurred_at);

-- Milestone 3 fills the semantics; the table exists now so shadow evaluations
-- have a stable home.
CREATE TABLE IF NOT EXISTS shadow_runs (
  tenant_id      text        NOT NULL REFERENCES tenants (tenant_id),
  shadow_run_id  text        NOT NULL,
  proposal_id    text,
  policy_version text,
  decision       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shadow_run_id)
);

-- §8 model telemetry. cost_usd IS NULL when no price is configured — costs
-- are never fabricated.
CREATE TABLE IF NOT EXISTS model_usage (
  id            bigserial PRIMARY KEY,
  tenant_id     text        NOT NULL REFERENCES tenants (tenant_id),
  case_id       text,
  provider      text        NOT NULL,
  model         text        NOT NULL,
  tier          text        NOT NULL,
  task          text        NOT NULL,
  input_tokens  integer     NOT NULL,
  output_tokens integer     NOT NULL,
  latency_ms    integer     NOT NULL,
  cost_usd      numeric,
  truncated     boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_usage_tenant_time_idx
  ON model_usage (tenant_id, created_at);
