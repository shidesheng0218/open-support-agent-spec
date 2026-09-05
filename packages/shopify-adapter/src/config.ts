import { ShopifyNotConfiguredError } from "./errors.js";

/**
 * Shopify Admin API config. Fails closed when the shop domain or the Admin
 * API access token is missing — an unconfigured adapter must throw, never
 * fake success.
 *
 * SHOPIFY_SHOP_DOMAIN (e.g. acme.myshopify.com), SHOPIFY_ADMIN_ACCESS_TOKEN,
 * SHOPIFY_API_VERSION (optional, default pinned below).
 */
export const SHOPIFY_DEFAULT_API_VERSION = "2025-01";

export interface ShopifyConfig {
  /** e.g. acme.myshopify.com (host only, no scheme). */
  shopDomain: string;
  adminAccessToken: string;
  apiVersion: string;
}

export function shopifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ShopifyConfig {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const adminAccessToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  const missing: string[] = [];
  if (!shopDomain) missing.push("SHOPIFY_SHOP_DOMAIN");
  if (!adminAccessToken) missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN");
  if (missing.length > 0) {
    throw new ShopifyNotConfiguredError(
      `Shopify adapter is not configured: missing ${missing.join(", ")}. ` +
        "Failing closed — no Shopify calls will be attempted.",
    );
  }
  return {
    shopDomain: shopDomain!,
    adminAccessToken: adminAccessToken!,
    apiVersion: env.SHOPIFY_API_VERSION?.trim() || SHOPIFY_DEFAULT_API_VERSION,
  };
}
