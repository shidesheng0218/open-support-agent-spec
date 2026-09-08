/**
 * Chatwoot adapter errors.
 * ChatwootNotConfiguredError → fail closed at construction/startup (never
 * pretend success without credentials). ChatwootApiError carries the HTTP
 * status but never the request headers or body secrets.
 */

export class ChatwootNotConfiguredError extends Error {
  readonly code = "CHATWOOT_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "ChatwootNotConfiguredError";
  }
}

/**
 * Thrown when a conversation has no usable sender id — the adapter fails
 * closed instead of fabricating a customer id like `cw_contact_0`.
 */
export class ChatwootCustomerIdUnavailableError extends Error {
  readonly code = "CUSTOMER_ID_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "ChatwootCustomerIdUnavailableError";
  }
}

export class ChatwootApiError extends Error {
  readonly code = "CHATWOOT_API_ERROR";
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatwootApiError";
  }
}
