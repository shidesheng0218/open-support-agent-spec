import { describe, expect, test } from "vitest";
import { requireAdapterCapability, AdapterCapabilityError } from "@osas/adapter";
import { CAPABILITIES, IllegalTransitionError } from "@osas/core";
import { TOOL_DEFINITIONS } from "@osas/mcp-server";
import { MockSupportAdapter, createDemoFixtures } from "@osas/mock-backend";
import {
  InMemoryPolicyStore,
  PolicyVersionConflictError,
  verifyAuditChain,
} from "@osas/policy-engine";
import { ReportCollector, runCase } from "./report.js";
import { validateAgainst } from "./helpers.js";

const SUITE = "capabilities-policy-audit";

const CTX = {
  tenantId: "tenant_demo",
  principal: { actorType: "system", actorId: "compat", permission: "execute" },
} as const;

function demoPolicy(version: string) {
  return {
    ...createDemoFixtures().policy,
    version,
  };
}

export function registerCapabilitiesPolicyAudit(collector: ReportCollector): void {
  describe(SUITE, () => {
    test("mock adapter's CapabilityManifest validates against core/capability-manifest", () =>
      runCase(collector, SUITE, "mock manifest validates against schema", async () => {
        const adapter = new MockSupportAdapter(createDemoFixtures());
        const manifest = await adapter.getCapabilities!(CTX);
        expect(validateAgainst("core/capability-manifest", manifest)).toBe(true);
      }));

    test("mock adapter declares all 20 spec capabilities", () =>
      runCase(collector, SUITE, "mock manifest declares all 20 capabilities", async () => {
        const adapter = new MockSupportAdapter(createDemoFixtures());
        const manifest = await adapter.getCapabilities!(CTX);
        const declared = manifest.profiles.flatMap((p) => p.capabilities);
        expect([...declared].sort()).toEqual([...CAPABILITIES].sort());
      }));

    test("every MCP tool declares a spec-known capabilityRequired", () =>
      runCase(collector, SUITE, "all 20 tools map to a known capability", () => {
        for (const def of TOOL_DEFINITIONS) {
          expect(
            (CAPABILITIES as readonly string[]).includes(def.capabilityRequired),
            `${def.name}.capabilityRequired=${def.capabilityRequired}`,
          ).toBe(true);
        }
      }));

    test("a read-only adapter can legally declare a core read-compatible manifest", () =>
      runCase(collector, SUITE, "read-only manifest validates + gates writes", async () => {
        const adapter = new MockSupportAdapter(createDemoFixtures());
        adapter.getCapabilities = async () => ({
          specVersion: "0.2",
          implementationId: "read-only-impl",
          implementationVersion: "0.2.0",
          profiles: [
            {
              name: "core",
              capabilities: ["case.read", "customer.read", "knowledge.read", "evidence.read"],
            },
          ],
          transports: ["http"],
          executionModes: ["proposal_only"],
          adapterVersion: "0.2.0",
        });
        const manifest = await adapter.getCapabilities(CTX);
        expect(validateAgainst("core/capability-manifest", manifest)).toBe(true);
        // reads allowed, writes refused
        await requireAdapterCapability(adapter, CTX, "case.read");
        await requireAdapterCapability(adapter, CTX, "evidence.read");
        for (const write of ["note.write", "proposal.write", "approval.decide"] as const) {
          await expect(requireAdapterCapability(adapter, CTX, write)).rejects.toThrowError(
            AdapterCapabilityError,
          );
        }
      }));

    test("adapters without getCapabilities stay permissive", () =>
      runCase(collector, SUITE, "no capability provider -> permissive", async () => {
        const adapter = new MockSupportAdapter(createDemoFixtures());
        Object.defineProperty(adapter, "getCapabilities", { value: undefined });
        await requireAdapterCapability(adapter, CTX, "ecommerce.refund.execute");
      }));

    test("policy lifecycle: active version cannot be overwritten; draft->simulated->approved->active->retired", () =>
      runCase(collector, SUITE, "immutable policy versions + lifecycle", async () => {
        const store = new InMemoryPolicyStore();
        await store.importActive(demoPolicy("1.0.0"), "seed");
        // Same version number cannot be reused — no in-place overwrite.
        await expect(store.createDraft("tenant_demo", demoPolicy("1.0.0"), "admin")).rejects.toThrowError(
          PolicyVersionConflictError,
        );
        // Steps cannot be skipped.
        await store.createDraft("tenant_demo", demoPolicy("1.1.0"), "admin");
        await expect(store.activate("tenant_demo", "1.1.0", "admin")).rejects.toThrowError(
          IllegalTransitionError,
        );
        await store.markSimulated("tenant_demo", "1.1.0");
        await store.approve("tenant_demo", "1.1.0", "admin");
        const { activated, superseded } = await store.activate("tenant_demo", "1.1.0", "admin");
        expect(activated.status).toBe("active");
        expect(superseded).toMatchObject({ version: "1.0.0", status: "retired" });
        // The previous version is preserved (not deleted).
        expect((await store.get("tenant_demo", "1.0.0"))?.status).toBe("retired");
        await store.retire("tenant_demo", "1.1.0", "admin");
        expect(await store.getActive("tenant_demo")).toBeUndefined();
      }));

    test("audit hash chain: mock adapter appends verify; tampering breaks verification", () =>
      runCase(collector, SUITE, "audit hash chain tamper detection", async () => {
        const adapter = new MockSupportAdapter(createDemoFixtures());
        for (let i = 0; i < 3; i++) {
          await adapter.appendAuditEvent(CTX, {
            tenantId: "tenant_demo",
            eventType: "policy_evaluated",
            actorType: "policy_engine",
            actorId: "compat",
            detail: { i },
          });
        }
        const events = await adapter.listAuditEvents(CTX, {});
        expect(verifyAuditChain(events).intact).toBe(true);
        const tampered = events.map((e, i) =>
          i === 1 ? { ...e, detail: { forged: true } } : e,
        );
        const result = verifyAuditChain(tampered);
        expect(result.intact).toBe(false);
        expect(result.firstError?.reason).toBe("event_hash_mismatch");
      }));

    test("audit hash chain: tenant streams are isolated", () =>
      runCase(collector, SUITE, "audit chain cross-tenant isolation", async () => {
        const adapter = new MockSupportAdapter(createDemoFixtures());
        const ctxB = { ...CTX, tenantId: "tenant_b" };
        await adapter.appendAuditEvent(CTX, {
          tenantId: "tenant_demo",
          eventType: "policy_evaluated",
          actorType: "policy_engine",
          actorId: "compat",
          detail: {},
        });
        await adapter.appendAuditEvent(ctxB, {
          tenantId: "tenant_b",
          eventType: "policy_evaluated",
          actorType: "policy_engine",
          actorId: "compat",
          detail: {},
        });
        const a = await adapter.listAuditEvents(CTX, {});
        const b = await adapter.listAuditEvents(ctxB, {});
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(verifyAuditChain(a).intact).toBe(true);
        expect(verifyAuditChain(b).intact).toBe(true);
        // Each tenant's chain restarts at the genesis hash.
        expect(a[0]!.sequence).toBe(1);
        expect(b[0]!.sequence).toBe(1);
      }));
  });
}
