-- OSAS M1 — governance control plane.
-- Provider-neutral by construction: no column in this migration names a vendor.
-- Same rules as 0001: every record is tenant-scoped, all access goes through
-- parameterized queries in src/, and state changes that matter are
-- compare-and-set or idempotent-insert.

-- ---------------------------------------------------------------- identity --

CREATE TABLE IF NOT EXISTS organizations (
  organization_id text        PRIMARY KEY,
  name            text        NOT NULL,
  status          text        NOT NULL,
  version         integer     NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- A tenant belongs to exactly one workspace: the UNIQUE on tenant_id is the
-- database-level enforcement of that rule (the in-memory store mirrors it).
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id    text        PRIMARY KEY,
  organization_id text        NOT NULL REFERENCES organizations (organization_id),
  tenant_id       text        NOT NULL UNIQUE REFERENCES tenants (tenant_id),
  name            text        NOT NULL,
  status          text        NOT NULL,
  version         integer     NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_org_idx ON workspaces (organization_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  membership_id   text        PRIMARY KEY,
  organization_id text        NOT NULL REFERENCES organizations (organization_id),
  workspace_id    text,
  principal_id    text        NOT NULL,
  role            text        NOT NULL,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL
);
-- NULL workspace_id means "organization-wide", and NULLs are distinct in a
-- plain UNIQUE, so the sentinel expression index carries the real rule.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_uq
  ON workspace_members (organization_id, principal_id, COALESCE(workspace_id, '*'));

-- ------------------------------------------------------------- connections --

CREATE TABLE IF NOT EXISTS connections (
  tenant_id           text        NOT NULL REFERENCES tenants (tenant_id),
  connection_id       text        NOT NULL,
  provider            text        NOT NULL,
  external_account_id text        NOT NULL,
  display_name        text        NOT NULL,
  status              text        NOT NULL,
  capabilities        jsonb       NOT NULL,
  scopes              jsonb       NOT NULL,
  api_version         text,
  -- Opaque pointer into a secret manager. NEVER a credential: the service
  -- layer refuses to persist anything that looks like a raw secret.
  credential_ref      text,
  last_verified_at    timestamptz,
  last_error_at       timestamptz,
  last_error_code     text,
  version             integer     NOT NULL,
  created_by          text        NOT NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  PRIMARY KEY (tenant_id, connection_id)
);
CREATE INDEX IF NOT EXISTS connections_status_idx ON connections (tenant_id, status);
-- One live connection per provider account (revoked ones are excluded so an
-- account can be reconnected after a revoke).
CREATE UNIQUE INDEX IF NOT EXISTS connections_live_account_uq
  ON connections (tenant_id, provider, external_account_id)
  WHERE status <> 'revoked';

-- --------------------------------------------------------- integration inbox --

CREATE TABLE IF NOT EXISTS integration_events (
  tenant_id         text        NOT NULL REFERENCES tenants (tenant_id),
  event_id          text        NOT NULL,
  connection_id     text        NOT NULL,
  provider          text        NOT NULL,
  topic             text        NOT NULL,
  external_event_id text        NOT NULL,
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL,
  status            text        NOT NULL,
  payload           jsonb       NOT NULL,
  signature_verified boolean    NOT NULL,
  attempts          integer     NOT NULL,
  last_error_code   text,
  last_error_message text,
  PRIMARY KEY (tenant_id, event_id),
  -- Provider-authoritative dedupe: a replay can never create a second row.
  UNIQUE (tenant_id, connection_id, topic, external_event_id)
);
-- Watermark lookups scan accepted events for one connection.
CREATE INDEX IF NOT EXISTS integration_events_watermark_idx
  ON integration_events (tenant_id, connection_id, status, occurred_at);

-- --------------------------------------------------------------- job queue --

CREATE TABLE IF NOT EXISTS job_runs (
  tenant_id        text        NOT NULL REFERENCES tenants (tenant_id),
  job_id           text        NOT NULL,
  kind             text        NOT NULL,
  status           text        NOT NULL,
  retry_class      text        NOT NULL,
  attempts         integer     NOT NULL,
  max_attempts     integer     NOT NULL,
  run_at           timestamptz NOT NULL,
  deadline_at      timestamptz,
  lease_owner      text,
  lease_expires_at timestamptz,
  input            jsonb       NOT NULL,
  result           jsonb,
  last_error_code  text,
  last_error_message text,
  reconciliation_id text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, job_id)
);
CREATE INDEX IF NOT EXISTS job_runs_claim_idx ON job_runs (status, run_at);
CREATE INDEX IF NOT EXISTS job_runs_lease_idx ON job_runs (lease_expires_at);
CREATE INDEX IF NOT EXISTS job_runs_tenant_idx ON job_runs (tenant_id, status);

-- --------------------------------------------------------- reconciliations --

CREATE TABLE IF NOT EXISTS reconciliations (
  tenant_id         text        NOT NULL REFERENCES tenants (tenant_id),
  reconciliation_id text        NOT NULL,
  reason            text        NOT NULL,
  status            text        NOT NULL,
  dedupe_key        text        NOT NULL,
  job_run_id        text,
  connection_id     text,
  case_id           text,
  proposal_id       text,
  idempotency_key   text,
  detail            jsonb       NOT NULL,
  resolved_by       text,
  resolution        text,
  version           integer     NOT NULL,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, reconciliation_id),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS reconciliations_open_idx ON reconciliations (tenant_id, status);

-- --------------------------------------------------------- governed cases --

CREATE TABLE IF NOT EXISTS governed_cases (
  tenant_id            text        NOT NULL REFERENCES tenants (tenant_id),
  case_id              text        NOT NULL,
  connection_id        text,
  external_case_id     text,
  subject              text        NOT NULL,
  state                text        NOT NULL,
  priority             text        NOT NULL,
  idempotency_key      text        NOT NULL,
  assigned_to          text,
  evidence_ids         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  proposal_ids         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  approval_ids         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  execution_attempt_ids jsonb      NOT NULL DEFAULT '[]'::jsonb,
  reconciliation_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  version              integer     NOT NULL,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  closed_at            timestamptz,
  PRIMARY KEY (tenant_id, case_id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS governed_cases_state_idx ON governed_cases (tenant_id, state);

-- -------------------------------------------------------- usage metering --

CREATE TABLE IF NOT EXISTS governance_usage_events (
  tenant_id       text        NOT NULL REFERENCES tenants (tenant_id),
  usage_id        text        NOT NULL,
  kind            text        NOT NULL,
  quantity        integer     NOT NULL,
  idempotency_key text        NOT NULL,
  connection_id   text,
  case_id         text,
  occurred_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, usage_id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS governance_usage_kind_idx
  ON governance_usage_events (tenant_id, kind, occurred_at);
