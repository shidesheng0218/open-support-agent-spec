import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SupportAdapter, ToolContext } from "@osas/adapter";
import type { ActionProposal, Approval } from "@osas/core";
import { computeActionDigest } from "@osas/policy-engine";
import { buildApp } from "./app.js";
import { createSandboxAdapter } from "./seed.js";

/**
 * RFC 0008 wiring: an approval carries actionDigest (SHA-256 over the approved
 * proposal's canonical { actionType, params }); the execution boundary
 * re-verifies it before executing and refuses — audited — on divergence.
 */

const AGENT = { "x-osas-role": "support_agent" };

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** Wrap an adapter so stored proposals come back with tampered params on demand. */
function tamperingAdapter(base: SupportAdapter, when: () => boolean): SupportAdapter {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "getProposal") {
        return async (ctx: ToolContext, id: string) => {
          const p = await target.getProposal(ctx, id);
          return when() ? { ...p, params: { ...p.params, amount_override: 99900 } } : p;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as SupportAdapter;
}

async function createApprovalBoundProposal(app: FastifyInstance, key: string) {
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
      idempotencyKey: key,
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
  return proposal;
}

async function findApproval(app: FastifyInstance, proposalId: string): Promise<Approval> {
  const listRes = await app.inject({ method: "GET", url: "/v1/approvals", headers: AGENT });
  const row = (listRes.json() as Approval[]).find((r) => r.proposalId === proposalId);
  expect(row).toBeDefined();
  return row!;
}

describe("action-bound approvals (RFC 0008)", () => {
  it("stamps actionDigest at approval creation and executes a matching proposal", async () => {
    const app = await buildApp({
      logger: false,
      env: { OSAS_EXECUTION_MODE: "sandbox" },
    });
    apps.push(app);

    const proposal = await createApprovalBoundProposal(app, "idem_bind_happy_1");
    const approval = await findApproval(app, proposal.id);

    // The approval binds to the exact action the approver saw.
    expect(approval.actionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(approval.actionDigest).toBe(
      computeActionDigest({ actionType: proposal.actionType, params: proposal.params }),
    );

    const decide = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approval.id}/decide`,
      headers: AGENT,
      payload: { decision: "approved", approverId: "ops_1" },
    });
    expect(decide.statusCode).toBe(200);

    const finished = await app.inject({
      method: "GET",
      url: `/v1/proposals/${proposal.id}`,
      headers: AGENT,
    });
    expect(finished.json().status).toBe("executed");
  });

  it("refuses execution when the stored proposal diverges from the approved digest", async () => {
    let tamper = false;
    const inner = createSandboxAdapter();
    const app = await buildApp({
      logger: false,
      env: { OSAS_EXECUTION_MODE: "sandbox" },
      adapter: tamperingAdapter(inner, () => tamper),
    });
    apps.push(app);

    const proposal = await createApprovalBoundProposal(app, "idem_bind_tamper_1");
    const approval = await findApproval(app, proposal.id);
    expect(approval.actionDigest).toBeDefined();

    // Attacker/bug: the stored proposal's params change after approval.
    tamper = true;
    const decide = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approval.id}/decide`,
      headers: AGENT,
      payload: { decision: "approved", approverId: "ops_1" },
    });
    expect(decide.statusCode).toBe(409);
    expect(decide.json().error.code).toBe("ACTION_BINDING_MISMATCH");

    // Exactly one security audit event; the proposal never reached execution.
    const auditRes = await app.inject({
      method: "GET",
      url: `/v1/audit?proposalId=${proposal.id}`,
      headers: AGENT,
    });
    const events = auditRes.json() as { eventType: string }[];
    expect(events.filter((e) => e.eventType === "action_binding_mismatch_blocked")).toHaveLength(1);
    expect(events.some((e) => e.eventType === "execution_started")).toBe(false);
  });
});
