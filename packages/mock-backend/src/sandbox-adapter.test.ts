import { describe, expect, it } from "vitest";
import { SandboxSupportAdapter } from "./sandbox-adapter.js";
import { createDemoFixtures } from "./fixtures.js";

const systemContext = {
  tenantId: "tenant_demo",
  principal: { actorType: "system" as const, actorId: "sandbox", permission: "execute" as const },
};

const proposal = (simulate?: string) => ({
  id: "prop_sandbox",
  specVersion: "0.2" as const,
  tenantId: "tenant_demo",
  caseId: "case_refund",
  profile: "ecommerce" as const,
  actionType: "refund" as const,
  reasonCode: "customer_request",
  params: { orderId: "ord_small", ...(simulate ? { simulate } : {}) },
  requestedPermission: "request-approval" as const,
  requestedBy: { actorType: "human" as const, actorId: "agent_1" },
  amount: { currency: "USD" as const, minorUnits: 2500 },
  evidenceIds: [],
  idempotencyKey: "sandbox-refund-1",
  status: "approved" as const,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
});

describe("SandboxSupportAdapter", () => {
  it("returns deterministic provider references for successful actions", async () => {
    const adapter = new SandboxSupportAdapter(createDemoFixtures());
    const first = await adapter.executeAction(systemContext, proposal());
    const second = await adapter.executeAction(systemContext, proposal());

    expect(first.status).toBe("succeeded");
    expect(first.externalRef).toBe("sandbox_refund_1");
    expect(second.externalRef).toBe("sandbox_refund_2");
  });

  it("supports explicit failure and uncertain provider scenarios", async () => {
    const adapter = new SandboxSupportAdapter(createDemoFixtures());

    await expect(adapter.executeAction(systemContext, proposal("failure"))).resolves.toMatchObject({
      status: "failed",
      detail: expect.stringContaining("sandbox failure"),
    });
    await expect(adapter.executeAction(systemContext, proposal("timeout"))).resolves.toMatchObject({
      status: "uncertain",
      detail: expect.stringContaining("timeout"),
    });
  });
});
