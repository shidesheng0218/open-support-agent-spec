-- Execution claims (§5 hardening): a slot is reserved with status 'executing'
-- BEFORE the adapter call and finalized in place afterwards. Pending rows have
-- no result or completion time yet, so relax the NOT NULL constraints.
ALTER TABLE execution_records ALTER COLUMN result DROP NOT NULL;
ALTER TABLE execution_records ALTER COLUMN completed_at DROP NOT NULL;