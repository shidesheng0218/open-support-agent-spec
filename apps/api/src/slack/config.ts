import { ConfigError } from "../config.js";

/**
 * Slack approval-card configuration. All-or-nothing and fail closed: setting
 * any SLACK_* variable without the rest throws at startup instead of leaving a
 * half-working approval path. Secrets are read here and never logged.
 *
 *   SLACK_BOT_TOKEN        xoxb-... (chat:write)
 *   SLACK_SIGNING_SECRET   Slack app signing secret (verifies button clicks)
 *   SLACK_APPROVAL_CHANNEL channel id the cards are posted to (C0123...)
 *   OSAS_SLACK_APPROVERS   "U0123=tenant_demo:alice,U0456=tenant_demo:bob"
 *   SLACK_TEAM_ID          optional; when set, clicks from other workspaces are refused
 */
export interface SlackApprover {
  tenantId: string;
  approverId: string;
}

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
  channel: string;
  teamId?: string;
  /** Slack user id -> the OSAS approver (and the only tenant they may decide for). */
  approvers: ReadonlyMap<string, SlackApprover>;
}

const SLACK_USER = /^[UW][A-Z0-9]{2,}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const KEYS = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_APPROVAL_CHANNEL", "OSAS_SLACK_APPROVERS"] as const;

export function loadSlackConfig(env: NodeJS.ProcessEnv = process.env): SlackConfig | undefined {
  const present = KEYS.filter((k) => env[k]?.trim());
  if (present.length === 0) return undefined;
  const missing = KEYS.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`Slack approvals are partially configured; also set: ${missing.join(", ")}`);
  }
  const botToken = env.SLACK_BOT_TOKEN!.trim();
  const signingSecret = env.SLACK_SIGNING_SECRET!.trim();
  const channel = env.SLACK_APPROVAL_CHANNEL!.trim();
  if (signingSecret.length < 16) throw new ConfigError("SLACK_SIGNING_SECRET must be at least 16 characters");
  if (!/^[CG][A-Z0-9]{2,}$/.test(channel)) {
    throw new ConfigError("SLACK_APPROVAL_CHANNEL must be a channel id such as C0123ABCD, not a name");
  }
  const approvers = new Map<string, SlackApprover>();
  for (const entry of env.OSAS_SLACK_APPROVERS!.split(",").map((e) => e.trim()).filter(Boolean)) {
    const m = /^([^=]+)=([^:]+):(.+)$/.exec(entry);
    if (!m || !SLACK_USER.test(m[1]!) || !SAFE_ID.test(m[2]!) || !SAFE_ID.test(m[3]!)) {
      throw new ConfigError('OSAS_SLACK_APPROVERS entries must look like "U0123ABCD=tenant_demo:alice"');
    }
    approvers.set(m[1]!, { tenantId: m[2]!, approverId: m[3]! });
  }
  if (approvers.size === 0) throw new ConfigError("OSAS_SLACK_APPROVERS lists no approvers");
  const teamId = env.SLACK_TEAM_ID?.trim();
  return { botToken, signingSecret, channel, ...(teamId ? { teamId } : {}), approvers };
}
