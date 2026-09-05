/**
 * Adapter error contract (CONTRACTS.md §6):
 * AdapterNotFoundError → API 404, AdapterPermissionError → API 403.
 */
export class AdapterNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message = "Resource not found") {
    super(message);
    this.name = "AdapterNotFoundError";
  }
}

export class AdapterPermissionError extends Error {
  readonly code = "PERMISSION_DENIED";
  constructor(message = "Permission denied") {
    super(message);
    this.name = "AdapterPermissionError";
  }
}
