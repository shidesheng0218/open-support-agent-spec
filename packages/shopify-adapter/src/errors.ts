/**
 * Shopify adapter errors. ShopifyNotConfiguredError → fail closed at
 * construction/startup. ShopifyApiError carries the HTTP status, never the
 * access token or request payload.
 */

export class ShopifyNotConfiguredError extends Error {
  readonly code = "SHOPIFY_NOT_CONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "ShopifyNotConfiguredError";
  }
}

export class ShopifyApiError extends Error {
  readonly code = "SHOPIFY_API_ERROR";
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}
