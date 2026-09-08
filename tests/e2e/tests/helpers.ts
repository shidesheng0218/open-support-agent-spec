import { expect, type APIRequestContext } from "@playwright/test";

// Shared helpers for the after-sales E2E flows (Phase 7). Same conventions as
// shadow.spec.ts: drive the API through page.request (baseURL-proxied to the
// API), assert in the console UI where a surface exists.

export interface ProposalInput {
  caseId: string;
  profile: "core" | "ecommerce" | "saas";
  actionType: string;
  reasonCode: string;
  params: Record<string, unknown>;
  evidenceIds: string[];
  idempotencyKey: string;
  amount?: { currency: string; minorUnits: number };
}

export interface Proposal {
  id: string;
  caseId: string;
  actionType: string;
  reasonCode: string;
  status: string;
  params: Record<string, unknown>;
}

export async function createProposal(
  request: APIRequestContext,
  input: ProposalInput,
): Promise<Proposal> {
  const res = await request.post("/v1/proposals", {
    data: {
      caseId: input.caseId,
      profile: input.profile,
      actionType: input.actionType,
      reasonCode: input.reasonCode,
      params: input.params,
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "mock-local" },
      ...(input.amount ? { amount: input.amount } : {}),
      evidenceIds: input.evidenceIds,
      idempotencyKey: input.idempotencyKey,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export interface AuditEvent {
  eventType: string;
  actorType: string;
  proposalId?: string;
  detail?: Record<string, unknown>;
}

export async function auditEventsForProposal(
  request: APIRequestContext,
  proposalId: string,
): Promise<AuditEvent[]> {
  const res = await request.get(`/v1/audit?proposalId=${proposalId}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export async function getProposal(
  request: APIRequestContext,
  proposalId: string,
): Promise<Proposal> {
  const res = await request.get(`/v1/proposals/${proposalId}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}
