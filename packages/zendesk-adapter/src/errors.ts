/**
 * Zendesk adapter errors.
 * ZendeskNotConfiguredError → fail closed at construction/startup (never
 * pretend success without credentials). ZendeskApiError carries the HTTP
 * status but never the request headers or body secrets.
 */

export class ZendeskNotConfiguredError extends Error {
  readonly code = "ZENDESK_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "ZendeskNotConfiguredError";
  }
}

export class ZendeskApiError extends Error {
  readonly code = "ZENDESK_API_ERROR";
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ZendeskApiError";
  }
}
