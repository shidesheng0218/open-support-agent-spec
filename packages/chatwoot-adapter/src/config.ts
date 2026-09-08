import { ChatwootNotConfiguredError } from "./errors.js";

/**
 * Chatwoot connection config. Loaded from env; fails closed when endpoint or
 * credentials are missing — an unconfigured adapter must throw, never fake
 * success.
 *
 * CHATWOOT_BASE_URL (e.g. https://app.chatwoot.com or a self-hosted origin),
 * CHATWOOT_ACCOUNT_ID (numeric account id in the API path),
 * CHATWOOT_API_TOKEN (user access token, sent as the api_access_token
 * header), CHATWOOT_ESCALATION_TEAM_ID (default team for human escalations;
 * createEscalation fails closed without it).
 */
export interface ChatwootConfig {
  /** e.g. https://app.chatwoot.com (no trailing slash). */
  baseUrl: string;
  accountId: string;
  apiToken: string;
  escalationTeamId?: string;
}

export function chatwootConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChatwootConfig {
  const baseUrl = (env.CHATWOOT_BASE_URL?.trim() ?? "").replace(/\/+$/, "");
  const accountId = env.CHATWOOT_ACCOUNT_ID?.trim();
  const apiToken = env.CHATWOOT_API_TOKEN?.trim();
  const missing: string[] = [];
  if (!baseUrl) missing.push("CHATWOOT_BASE_URL");
  if (!accountId) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!apiToken) missing.push("CHATWOOT_API_TOKEN");
  if (missing.length > 0) {
    throw new ChatwootNotConfiguredError(
      `Chatwoot adapter is not configured: missing ${missing.join(", ")}. ` +
        "Failing closed — no Chatwoot calls will be attempted.",
    );
  }
  const team = env.CHATWOOT_ESCALATION_TEAM_ID?.trim();
  return {
    baseUrl,
    accountId: accountId!,
    apiToken: apiToken!,
    ...(team ? { escalationTeamId: team } : {}),
  };
}
