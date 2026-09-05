import { ZendeskNotConfiguredError } from "./errors.js";

/**
 * Zendesk connection config. Loaded from env; fails closed when endpoint or
 * credentials are missing — an unconfigured adapter must throw, never fake
 * success.
 *
 * ZENDESK_BASE_URL (e.g. https://acme.zendesk.com) or ZENDESK_SUBDOMAIN,
 * ZENDESK_EMAIL, ZENDESK_API_TOKEN, ZENDESK_ESCALATION_GROUP_ID (default
 * group for human escalations; createEscalation fails closed without it).
 */
export interface ZendeskConfig {
  /** e.g. https://acme.zendesk.com (no trailing slash). */
  baseUrl: string;
  email: string;
  apiToken: string;
  escalationGroupId?: string;
}

export function zendeskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZendeskConfig {
  const baseUrlRaw = env.ZENDESK_BASE_URL?.trim();
  const subdomain = env.ZENDESK_SUBDOMAIN?.trim();
  const baseUrl = (
    baseUrlRaw ||
    (subdomain ? `https://${subdomain}.zendesk.com` : "")
  ).replace(/\/+$/, "");
  const email = env.ZENDESK_EMAIL?.trim();
  const apiToken = env.ZENDESK_API_TOKEN?.trim();
  const missing: string[] = [];
  if (!baseUrl) missing.push("ZENDESK_BASE_URL or ZENDESK_SUBDOMAIN");
  if (!email) missing.push("ZENDESK_EMAIL");
  if (!apiToken) missing.push("ZENDESK_API_TOKEN");
  if (missing.length > 0) {
    throw new ZendeskNotConfiguredError(
      `Zendesk adapter is not configured: missing ${missing.join(", ")}. ` +
        "Failing closed — no Zendesk calls will be attempted.",
    );
  }
  const group = env.ZENDESK_ESCALATION_GROUP_ID?.trim();
  return {
    baseUrl: baseUrl!,
    email: email!,
    apiToken: apiToken!,
    ...(group ? { escalationGroupId: group } : {}),
  };
}
