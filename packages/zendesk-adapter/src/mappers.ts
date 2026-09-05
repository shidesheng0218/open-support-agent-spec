import type { Case, CaseChannel, CasePriority, CaseStatus, Customer, Evidence } from "@osas/core";
import { SPEC_VERSION } from "@osas/core";

/** Zendesk ticket JSON (subset of GET /api/v2/tickets/{id}.json). */
export interface ZendeskTicket {
  id: number;
  subject?: string;
  description?: string;
  status?: string;
  priority?: string | null;
  requester_id?: number;
  assignee_id?: number | null;
  tags?: string[];
  via?: { channel?: string };
  created_at?: string;
  updated_at?: string;
}

/** Zendesk user JSON (subset of GET /api/v2/users/{id}.json). */
export interface ZendeskUser {
  id: number;
  name?: string;
  email?: string;
  phone?: string | null;
  locale?: string;
  time_zone?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export const caseIdForTicket = (ticketId: number | string): string => `zd_ticket_${ticketId}`;
export const customerIdForUser = (userId: number | string): string => `zd_user_${userId}`;

/** Accept "zd_ticket_123" or a bare numeric id; throws on anything else. */
export function ticketIdFromCaseId(caseId: string): string {
  const m = /^(?:zd_ticket_)?(\d+)$/.exec(caseId);
  if (!m) throw new Error(`not a Zendesk ticket case id: ${caseId}`);
  return m[1] as string;
}

export function userIdFromCustomerId(customerId: string): string {
  const m = /^(?:zd_user_)?(\d+)$/.exec(customerId);
  if (!m) throw new Error(`not a Zendesk user customer id: ${customerId}`);
  return m[1] as string;
}

const STATUS_MAP: Record<string, CaseStatus> = {
  new: "open",
  open: "open",
  pending: "pending_agent",
  hold: "pending_agent",
  solved: "resolved",
  closed: "closed",
};

const PRIORITIES: readonly CasePriority[] = ["low", "normal", "high", "urgent"];

const CHANNEL_MAP: Record<string, CaseChannel> = {
  mail: "email",
  email: "email",
  chat: "chat",
  messaging: "chat",
  voice: "phone",
  phone: "phone",
  twitter: "social",
  facebook: "social",
  web: "api",
  api: "api",
};

export function mapTicketToCase(ticket: ZendeskTicket, tenantId: string): Case {
  const status = ticket.status ? STATUS_MAP[ticket.status] : undefined;
  const priority = PRIORITIES.includes(ticket.priority as CasePriority)
    ? (ticket.priority as CasePriority)
    : "normal";
  const channel = ticket.via?.channel ? CHANNEL_MAP[ticket.via.channel] : undefined;
  return {
    id: caseIdForTicket(ticket.id),
    specVersion: SPEC_VERSION,
    tenantId,
    customerId: customerIdForUser(ticket.requester_id ?? 0),
    profile: "core",
    channel: channel ?? "api",
    subject: ticket.subject ?? ticket.description ?? `Zendesk ticket ${ticket.id}`,
    status: status ?? "open",
    priority,
    assigneeType: ticket.assignee_id ? "human" : "none",
    tags: ticket.tags ?? [],
    evidenceIds: [],
    ...(status === "closed" && ticket.updated_at ? { closedAt: ticket.updated_at } : {}),
    createdAt: ticket.created_at ?? new Date().toISOString(),
    updatedAt: ticket.updated_at ?? ticket.created_at ?? new Date().toISOString(),
  };
}

export function mapUserToCustomer(user: ZendeskUser, tenantId: string): Customer {
  return {
    id: customerIdForUser(user.id),
    specVersion: SPEC_VERSION,
    tenantId,
    displayName: user.name ?? `Zendesk user ${user.id}`,
    ...(user.email ? { email: user.email } : {}),
    ...(user.phone ? { phone: user.phone } : {}),
    ...(user.locale ? { locale: user.locale } : {}),
    // Zendesk does not verify OSAS-level identity; never fabricate "verified".
    region: "ZZ",
    identityVerification: { status: "unverified" },
    tags: user.tags ?? [],
    createdAt: user.created_at ?? new Date().toISOString(),
    updatedAt: user.updated_at ?? user.created_at ?? new Date().toISOString(),
  };
}

/** Agent-console URL used as the external link in Evidence sources. */
export function ticketAgentUrl(baseUrl: string, ticketId: number | string): string {
  return `${baseUrl}/agent/tickets/${ticketId}`;
}

export function userAgentUrl(baseUrl: string, userId: number | string): string {
  return `${baseUrl}/agent/users/${userId}`;
}

/** Ticket → Evidence payload (id/specVersion/createdAt filled by captureEvidence). */
export function ticketEvidenceInput(
  ticket: ZendeskTicket,
  tenantId: string,
  baseUrl: string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  return {
    tenantId,
    caseId: caseIdForTicket(ticket.id),
    kind: "conversation",
    source: {
      system: "zendesk",
      recordType: "ticket",
      recordId: String(ticket.id),
      url: ticketAgentUrl(baseUrl, ticket.id),
    },
    summary: `Zendesk ticket #${ticket.id}: ${ticket.subject ?? "(no subject)"} [${ticket.status ?? "unknown"}]`,
    data: {
      status: ticket.status,
      priority: ticket.priority,
      tags: ticket.tags ?? [],
      channel: ticket.via?.channel,
    },
    retrievedAt: new Date().toISOString(),
  };
}

export function userEvidenceInput(
  user: ZendeskUser,
  tenantId: string,
  baseUrl: string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  return {
    tenantId,
    kind: "identity",
    source: {
      system: "zendesk",
      recordType: "user",
      recordId: String(user.id),
      url: userAgentUrl(baseUrl, user.id),
    },
    summary: `Zendesk user #${user.id}: ${user.name ?? "(unnamed)"} (identity unverified at source)`,
    data: { locale: user.locale, tags: user.tags ?? [] },
    retrievedAt: new Date().toISOString(),
  };
}
