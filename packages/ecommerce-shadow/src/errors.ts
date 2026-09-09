/**
 * Shadow Mode errors (v0.1.1 Milestone 3).
 *
 * LiveExecutionNotAvailableError → startup abort (fail closed).
 * ShadowRunNotFoundError → API 404. ShadowRunAlreadyReviewedError → API 409.
 */

export class LiveExecutionNotAvailableError extends Error {
  // Preserve the v0.2 error code so existing clients can continue to classify
  // the fail-closed live-mode response while the v0.3 Draft adds Sandbox.
  readonly code = "LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1";
  constructor() {
    super(
      "OSAS_EXECUTION_MODE=live is not available in v0.3 Draft. " +
        "Proposal-only, Shadow, and Sandbox are the supported non-live modes. " +
        'Run with OSAS_EXECUTION_MODE=shadow (the default).',
    );
    this.name = "LiveExecutionNotAvailableError";
  }
}

export class ExecutionModeConfigError extends Error {
  readonly code = "EXECUTION_MODE_CONFIG_INVALID";
  constructor(value: string) {
    super(`OSAS_EXECUTION_MODE must be "proposal_only", "shadow", "sandbox" or "live"; got "${value}"`);
    this.name = "ExecutionModeConfigError";
  }
}

export class ShadowRunNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(id: string, tenantId: string) {
    super(`ShadowRun ${id} not found for tenant ${tenantId}`);
    this.name = "ShadowRunNotFoundError";
  }
}

/** A reviewed ShadowRun is final; re-reviewing is a conflict (API 409). */
export class ShadowRunAlreadyReviewedError extends Error {
  readonly code = "SHADOW_RUN_ALREADY_REVIEWED";
  constructor(id: string, current: string) {
    super(`ShadowRun ${id} already has humanOutcome '${current}'; reviewed ShadowRuns are final`);
    this.name = "ShadowRunAlreadyReviewedError";
  }
}
