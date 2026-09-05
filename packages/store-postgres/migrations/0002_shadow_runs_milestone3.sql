-- OSAS Milestone 3 — fill shadow_runs semantics (ShadowRun object).
-- The 0001 table already carried tenant_id/shadow_run_id/proposal_id/
-- policy_version/decision; this adds the human-review and payload columns.

ALTER TABLE shadow_runs
  ADD COLUMN IF NOT EXISTS would_auto_execute boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suggested_action jsonb,
  ADD COLUMN IF NOT EXISTS human_outcome text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS human_comment text,
  ADD COLUMN IF NOT EXISTS external_reference text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payload jsonb;

CREATE INDEX IF NOT EXISTS shadow_runs_proposal_idx
  ON shadow_runs (tenant_id, proposal_id);
CREATE INDEX IF NOT EXISTS shadow_runs_outcome_idx
  ON shadow_runs (tenant_id, human_outcome);
