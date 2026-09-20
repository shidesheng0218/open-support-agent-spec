import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ActionProposal, Approval, TenantPolicy } from "@osas/core";
import { buildApp } from "./app.js";

/**
 * Approval fail-safe lifecycle wiring: a policy with
 * `approval.timeoutSeconds` stamps `expiresAt` on new approvals; reads report
 * the effective `expired` status; deciding an expired approval is refused
 * (fail-safe denial) and audited. An undecided approval is denied, never
 * approved.
 */

const AGENT = { "x-osas-role": "support_agent" };
const ADMIN = { "x-osas-role": "policy_admin" };

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function start(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false });
  apps.push(app);
  return app;
}

/** Activate a copy of the demo policy with approval.timeoutSeconds = 0. */
async function activateZeroTimeoutPolicy(app: FastifyInstance): Promise<void> {
  const current = (
    await app.inject({ method: "GET", url: "/v1/policies/tenant_demo", headers: ADMIN })
  ).json() as TenantPolicy & { version: string };
  const { version: _version, ...rest } = current;
  const draftRes = await app.inject({
    method: "POST",
    url: "/v1/policies/tenant_demo/drafts",
    headers: ADMIN,
    payload: { ...rest, approval: { timeoutSeconds: 0 } },
  });
  expect(draftRes.statusCode).toBe(201);
  const draft = draftRes.json() as { version: string };

  const simulateRes = await app.inject({
    method: "POST",
    url: "/v1/policies/tenant_demo/simulate",
    headers: ADMIN,
    payload: {
      version: draft.version,
      proposal: {
        caseId: "case_refund",
        profile: "ecommerce",
        actionType: "refund",
        reasonCode: "damaged",
        params: { orderId: "ord_small" },
        amount: { currency: "USD", minorUnits: 2500 },
        evidenceIds: ["ev_ord_small"],
      },
      customer: "cus_verified",
    },
  });
  expect(simulateRes.statusCode).toBe(200);

  for (const step of ["approve", "activate"]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/policies/tenant_demo/versions/${draft.version}/${step}`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
  }
}

describe("approval fail-safe expiry (wired)", () => {
  it("stamps expiresAt, reports effective expired status, and refuses late decisions", async () => {
    const app = await start();
    await activateZeroTimeoutPolicy(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: AGENT,
      payload: {
        caseId: "case_credit",
        profile: "saas",
        actionType: "credit_apply",
        reasonCode: "goodwill",
        params: {},
        requestedPermission: "request-approval",
        requestedBy: { actorType: "model", actorId: "mock-local" },
        amount: { currency: "USD", minorUnits: 12000 },
        evidenceIds: ["ev_ord_small"],
        idempotencyKey: `idem_expiry_${Math.random().toString(36).slice(2)}`,
      },
    });
    expect(created.statusCode).toBe(201);
    const proposal = created.json() as ActionProposal;

    const evaluated = await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposal.id}/evaluate`,
      headers: AGENT,
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision.decision).toBe("require_approval");

    // Wait a beat so `now > deadline` (timeoutSeconds: 0 -> deadline = requestedAt).
    await new Promise((resolve) => setTimeout(resolve, 25));

    const listRes = await app.inject({ method: "GET", url: "/v1/approvals", headers: AGENT });
    expect(listRes.statusCode).toBe(200);
    const rows = listRes.json() as (Approval & { proposal?: ActionProposal })[];
    const row = rows.find((r) => r.proposalId === proposal.id);
    expect(row).toBeDefined();
    expect(row!.expiresAt).toBeDefined();
    expect(row!.status).toBe("expired");

    // `?status=pending` must not surface it (effective status is expired).
    const pendingRes = await app.inject({
      method: "GET",
      url: "/v1/approvals?status=pending",
      headers: AGENT,
    });
    const pending = pendingRes.json() as Approval[];
    expect(pending.some((r) => r.proposalId === proposal.id)).toBe(false);

    // A late decision is refused, never approved.
    const decideRes = await app.inject({
      method: "POST",
      url: `/v1/approvals/${row!.id}/decide`,
      headers: AGENT,
      payload: { decision: "approved", approverId: "late_agent" },
    });
    expect(decideRes.statusCode).toBe(409);
    expect(decideRes.json().error.message).toContain("APPROVAL_TIMED_OUT");

    // The denial is final: the proposal is closed as rejected...
    const closed = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposal.id}`,
      headers: AGENT,
    });
    expect(closed.json().status).toBe("rejected");

    // ...so an identical new request is NOT blocked as a duplicate — the
    // fail-safe denial must not create a dead end.
    const retry = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: AGENT,
      payload: {
        caseId: "case_credit",
        profile: "saas",
        actionType: "credit_apply",
        reasonCode: "goodwill",
        params: {},
        requestedPermission: "request-approval",
        requestedBy: { actorType: "model", actorId: "mock-local" },
        amount: { currency: "USD", minorUnits: 12000 },
        evidenceIds: ["ev_ord_small"],
        idempotencyKey: `idem_expiry_retry_${Math.random().toString(36).slice(2)}`,
      },
    });
    expect(retry.statusCode).toBe(201);
    const retryEvaluated = await app.inject({
      method: "POST",
      url: `/v1/proposals/${(retry.json() as ActionProposal).id}/evaluate`,
      headers: AGENT,
    });
    const retryReasons = (retryEvaluated.json().decision.reasons as { code: string }[]).map(
      (r) => r.code,
    );
    expect(retryReasons).not.toContain("DUPLICATE_REQUEST");
    expect(retryEvaluated.json().decision.decision).toBe("require_approval");

    // Repeating the refused decision stays refused and does NOT append a
    // second expiry-denial audit event (the first refusal per proposal is the
    // recorded denial).
    const decideAgain = await app.inject({
      method: "POST",
      url: `/v1/approvals/${row!.id}/decide`,
      headers: AGENT,
      payload: { decision: "approved", approverId: "late_agent" },
    });
    expect(decideAgain.statusCode).toBe(409);

    const auditRes = await app.inject({
      method: "GET",
      url: `/v1/audit?proposalId=${proposal.id}`,
      headers: AGENT,
    });
    const events = auditRes.json() as { eventType: string; detail: Record<string, unknown> }[];
    const denials = events.filter(
      (e) => e.eventType === "approval_decided" && e.detail.decision === "expired",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]!.detail.reason).toBe("APPROVAL_TIMED_OUT");
    expect(denials[0]!.detail.expiresAt).toBeDefined();
  });
});