/** Typed governance errors; each maps to a stable API error code. */

export class GovernanceConfigError extends Error {
  override name = "GovernanceConfigError";
}

export class GovernanceNotFoundError extends Error {
  override name = "GovernanceNotFoundError";
  constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} "${id}" was not found`);
  }
}

/** Optimistic-concurrency / uniqueness conflict. */
export class GovernanceConflictError extends Error {
  override name = "GovernanceConflictError";
  constructor(
    message: string,
    public readonly resource?: string,
    public readonly id?: string,
  ) {
    super(message);
  }
}

/**
 * A caller passed a value that must never be persisted in a record — the
 * canonical case being a raw credential where an opaque reference is required.
 * Failing closed here keeps secrets out of the database and out of logs.
 */
export class GovernanceSecretRefusedError extends Error {
  override name = "GovernanceSecretRefusedError";
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Refusing to store ${field}: ${reason}`);
  }
}

/** Illegal governed-case state transition. */
export class GovernanceTransitionError extends Error {
  override name = "GovernanceTransitionError";
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Governed case cannot move from "${from}" to "${to}"`);
  }
}

export class GovernanceValidationError extends Error {
  override name = "GovernanceValidationError";
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`Invalid ${field}: ${message}`);
  }
}
