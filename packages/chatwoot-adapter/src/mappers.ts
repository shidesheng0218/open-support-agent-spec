import type { Case, CaseChannel, CasePriority, CaseStatus, Customer, Evidence } from "@osas/core";
import { SPEC_VERSION } from "@osas/core";
import { ChatwootCustomerIdUnavailableError } from "./errors.js";

/** Chatwoot conversation JSON (subset of GET /api/v1/accounts/{id}/conversations/{cid}). */
export interface ChatwootConversation {
  id: number;
  status?: string;
  priority?: string | null;
  inbox_id?: number;
  assignee_id?: number | null;
  team_id?: number | null;
  labels?: string[];
  additional_attributes?: { mail_subject?: string };
  meta?: {
    channel?: string;
    sender?: { id?: number; name?: string; email?: string };
    assignee?: { id?: number } | null;
    team?: { id?: number } | null;
  };
  messages?: Array<{
    id?: number;
    content?: string;
    message_type?: number | string;
    private?: boolean;
  }>;
  created_at?: number | string;
  updated_at?: number | string;
  last_activity_at?: number | string;
}

/** Chatwoot contact JSON (subset of GET /api/v1/accounts/{id}/contacts/{cid}). */
export interface ChatwootContact {
  id: number;
  name?: string;
  email?: string;
  phone_number?: string | null;
  identifier?: string | null;
  additional_attributes?: { country_code?: string; city?: string };
  created_at?: number | string;
  updated_at?: number | string;
}

export const caseIdForConversation = (conversationId: number | string): string =>
  `cw_conv_${conversationId}`;
export const customerIdForContact = (contactId: number | string): string =>
  `cw_contact_${contactId}`;

/** Accept "cw_conv_123" or a bare numeric id; throws on anything else. */
export function conversationIdFromCaseId(caseId: string): string {
  const m = /^(?:cw_conv_)?(\d+)$/.exec(caseId);
  if (!m) throw new Error(`not a Chatwoot conversation case id: ${caseId}`);
  return m[1] as string;
}

export function contactIdFromCustomerId(customerId: string): string {
  const m = /^(?:cw_contact_)?(\d+)$/.exec(customerId);
  if (!m) throw new Error(`not a Chatwoot contact customer id: ${customerId}`);
  return m[1] as string;
}

/** Chatwoot conversations use unix epoch seconds; contacts use ISO strings. */
export function toIsoTime(v: number | string | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const STATUS_MAP: Record<string, CaseStatus> = {
  open: "open",
  pending: "pending_agent",
  snoozed: "pending_agent",
  resolved: "resolved",
};

const PRIORITY_MAP: Record<string, CasePriority> = {
  low: "low",
  medium: "normal",
  high: "high",
  urgent: "urgent",
};

const CHANNEL_MAP: Record<string, CaseChannel> = {
  "Channel::Email": "email",
  "Channel::WebWidget": "chat",
  "Channel::Whatsapp": "chat",
  "Channel::TwilioSms": "chat",
  "Channel::Sms": "chat",
  "Channel::Telegram": "chat",
  "Channel::Line": "chat",
  "Channel::FacebookPage": "social",
  "Channel::TwitterProfile": "social",
  "Channel::Instagram": "social",
  "Channel::Api": "api",
};

/** Email-channel conversations carry a mail subject; else first visible message. */
function conversationSubject(conv: ChatwootConversation): string {
  const mailSubject = conv.additional_attributes?.mail_subject?.trim();
  if (mailSubject) return mailSubject;
  const first = conv.messages?.find(
    (m) => !m.private && (m.message_type === 0 || m.message_type === "incoming") && m.content,
  );
  const content = first?.content?.trim();
  if (content) return content.length > 120 ? `${content.slice(0, 117)}...` : content;
  return `Chatwoot conversation ${conv.id}`;
}

/**
 * A conversation without a positive integer sender id has no real customer —
 * fail closed with CUSTOMER_ID_UNAVAILABLE rather than inventing one.
 */
function senderCustomerId(conv: ChatwootConversation): string {
  const id = conv.meta?.sender?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new ChatwootCustomerIdUnavailableError(
      `Chatwoot conversation ${conv.id} has no usable sender id; refusing to fabricate a customer id.`,
    );
  }
  return customerIdForContact(id);
}

export function mapConversationToCase(conv: ChatwootConversation, tenantId: string): Case {
  const status = conv.status ? STATUS_MAP[conv.status] : undefined;
  const priority = conv.priority ? PRIORITY_MAP[conv.priority] : undefined;
  const channel = conv.meta?.channel ? CHANNEL_MAP[conv.meta.channel] : undefined;
  const hasAssignee = Boolean(conv.assignee_id ?? conv.meta?.assignee?.id);
  const createdAt = toIsoTime(conv.created_at) ?? new Date().toISOString();
  const updatedAt =
    toIsoTime(conv.updated_at) ?? toIsoTime(conv.last_activity_at) ?? createdAt;
  return {
    id: caseIdForConversation(conv.id),
    specVersion: SPEC_VERSION,
    tenantId,
    customerId: senderCustomerId(conv),
    profile: "core",
    channel: channel ?? "api",
    subject: conversationSubject(conv),
    status: status ?? "open",
    priority: priority ?? "normal",
    assigneeType: hasAssignee ? "human" : "none",
    tags: conv.labels ?? [],
    evidenceIds: [],
    ...(status === "resolved" ? { closedAt: updatedAt } : {}),
    createdAt,
    updatedAt,
  };
}

export function mapContactToCustomer(contact: ChatwootContact, tenantId: string): Customer {
  const country = contact.additional_attributes?.country_code?.trim();
  const createdAt = toIsoTime(contact.created_at) ?? new Date().toISOString();
  return {
    id: customerIdForContact(contact.id),
    specVersion: SPEC_VERSION,
    tenantId,
    displayName: contact.name ?? `Chatwoot contact ${contact.id}`,
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone_number ? { phone: contact.phone_number } : {}),
    // Best-effort region from contact attributes; "ZZ" when unknown.
    region: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "ZZ",
    // Chatwoot does not verify OSAS-level identity; never fabricate "verified".
    identityVerification: { status: "unverified" },
    tags: [],
    createdAt,
    updatedAt: toIsoTime(contact.updated_at) ?? createdAt,
  };
}

/** Agent-console URL used as the external link in Evidence sources. */
export function conversationAgentUrl(
  baseUrl: string,
  accountId: number | string,
  conversationId: number | string,
): string {
  return `${baseUrl}/app/accounts/${accountId}/conversations/${conversationId}`;
}

export function contactAgentUrl(
  baseUrl: string,
  accountId: number | string,
  contactId: number | string,
): string {
  return `${baseUrl}/app/accounts/${accountId}/contacts/${contactId}`;
}

/** Conversation → Evidence payload (id/specVersion/createdAt filled by captureEvidence). */
export function conversationEvidenceInput(
  conv: ChatwootConversation,
  tenantId: string,
  baseUrl: string,
  accountId: number | string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  return {
    tenantId,
    caseId: caseIdForConversation(conv.id),
    kind: "conversation",
    source: {
      system: "chatwoot",
      recordType: "conversation",
      recordId: String(conv.id),
      url: conversationAgentUrl(baseUrl, accountId, conv.id),
    },
    summary: `Chatwoot conversation #${conv.id}: ${conversationSubject(conv)} [${conv.status ?? "unknown"}]`,
    data: {
      status: conv.status,
      priority: conv.priority,
      labels: conv.labels ?? [],
      channel: conv.meta?.channel,
      teamId: conv.team_id ?? conv.meta?.team?.id,
    },
    retrievedAt: new Date().toISOString(),
  };
}

export function contactEvidenceInput(
  contact: ChatwootContact,
  tenantId: string,
  baseUrl: string,
  accountId: number | string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  return {
    tenantId,
    kind: "identity",
    source: {
      system: "chatwoot",
      recordType: "contact",
      recordId: String(contact.id),
      url: contactAgentUrl(baseUrl, accountId, contact.id),
    },
    summary: `Chatwoot contact #${contact.id}: ${contact.name ?? "(unnamed)"} (identity unverified at source)`,
    data: {
      countryCode: contact.additional_attributes?.country_code,
      identifier: contact.identifier,
    },
    retrievedAt: new Date().toISOString(),
  };
}
