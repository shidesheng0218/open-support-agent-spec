import { describe, expect, it } from "vitest";
import { CAPABILITIES, type AuditEvent } from "@osas/core";
import { verifyAuditChain } from "@osas/policy-engine";
import { createDemoFixtures, DEMO_TENANT_ID } from "./fixtures.js";
import { MockSupportAdapter } from "./mock-adapter.js";

const ctx = { tenantId: DEMO_TENANT_ID, principal: { actorType: "system", actorId: "t", permission: "execute" } } as const;

async function appendThree(adapter: MockSupportAdapter, tenantId = DEMO_TENANT_ID): Promise<AuditEvent[]> {
  const c = { ...ctx, tenantId };
  const out: AuditEvent[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(
      await adapter.appendAuditEvent(c, {
        tenantId,
        eventType: "policy_evaluated",
        actorType: "policy_engine",
        actorId: "t",
        detail: { i },
      }),
    );
  }
  return out;
}

describe("mock adapter capability manifest (v0.1.1)", () => {
  it("declares all 20 spec capabilities across the three profiles", async () => {
    const adapter = new MockSupportAdapter(createDemoFixtures());
    const manifest = await adapter.getCapabilities!(ctx);
    const declared = manifest.profiles.flatMap((p) => p.capabilities);
    expect([...declared].sort()).toEqual([...CAPABILITIES].sort());
    expect(manifest.transports).toEqual(["http", "mcp"]);
    expect(manifest.executionModes).toEqual(["proposal_only", "shadow", "live"]);
    expect(manifest.specVersion).toBe("0.2");
  });
});

describe("mock adapter audit hash chain (v0.1.1)", () => {
  it("stamps sequence/previousHash/eventHash on append and the chain verifies", async () => {
    const adapter = new MockSupportAdapter(createDemoFixtures());
    const events = await appendThree(adapter);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(events[0]!.previousHash).toMatch(/^0{64}$/);
    expect(events[1]!.previousHash).toBe(events[0]!.eventHash);
    const listed = await adapter.listAuditEvents(ctx, {});
    expect(verifyAuditChain(listed).intact).toBe(true);
  });

  it("keeps per-tenant chains independent", async () => {
    const adapter = new MockSupportAdapter(createDemoFixtures());
    await appendThree(adapter, DEMO_TENANT_ID);
    const b = await appendThree(adapter, "tenant_b");
    expect(b[0]!.sequence).toBe(1);
    expect(b[0]!.previousHash).toMatch(/^0{64}$/);
    const eventsB = await adapter.listAuditEvents({ ...ctx, tenantId: "tenant_b" }, {});
    expect(verifyAuditChain(eventsB).intact).toBe(true);
    expect(verifyAuditChain(await adapter.listAuditEvents(ctx, {})).intact).toBe(true);
  });
});
