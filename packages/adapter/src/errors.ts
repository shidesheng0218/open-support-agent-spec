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

/**
 * Thrown when an operation needs a capability the implementation's
 * CapabilityManifest does not declare (v0.1.1). → API 403 CAPABILITY_UNSUPPORTED.
 */
export class AdapterCapabilityError extends Error {
  readonly code = "CAPABILITY_UNSUPPORTED";
  constructor(capability: string, message?: string) {
    super(message ?? `Capability '${capability}' is not declared by this implementation`);
    this.name = "AdapterCapabilityError";
  }
}
