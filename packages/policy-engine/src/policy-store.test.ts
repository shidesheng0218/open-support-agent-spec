import { describe, expect, it } from "vitest";
import { IllegalTransitionError, type TenantPolicy } from "@osas/core";
import {
  InMemoryPolicyStore,
  PolicyVersionConflictError,
  PolicyVersionNotFoundError,
} from "./policy-store.js";

function makePolicy(version: string, over: Partial<TenantPolicy> = {}): TenantPolicy {
  return {
    id: `pol_${version}`,
    specVersion: "0.1",
    tenantId: "tenant_demo",
    version,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    duplicateWindowSeconds: 86400,
    maxEvidenceAgeSeconds: 604800,
    defaultDecision: "block",
    rules: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("InMemoryPolicyStore", () => {
  it("creates drafts without touching the active version", () => {
    const store = new InMemoryPolicyStore();
    store.importActive(makePolicy("1.0.0"), "seed");
    const draft = store.createDraft("tenant_demo", makePolicy("1.1.0"), "admin_1");
    expect(draft.status).toBe("draft");
    expect(draft.createdBy).toBe("admin_1");
    expect(store.getActive("tenant_demo")?.version).toBe("1.0.0");
    expect(store.list("tenant_demo").map((v) => v.version).sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  it("rejects duplicate version numbers", () => {
    const store = new InMemoryPolicyStore();
    store.createDraft("tenant_demo", makePolicy("1.1.0"), "admin_1");
    expect(() => store.createDraft("tenant_demo", makePolicy("1.1.0"), "admin_1")).toThrowError(
      PolicyVersionConflictError,
    );
  });

  it("walks the full lifecycle and supersede-retires the old active version", () => {
    const store = new InMemoryPolicyStore();
    store.importActive(makePolicy("1.0.0"), "seed");
    store.createDraft("tenant_demo", makePolicy("1.1.0"), "admin_1");

    const simulated = store.markSimulated("tenant_demo", "1.1.0");
    expect(simulated.status).toBe("simulated");
    expect(simulated.simulatedAt).toBeDefined();

    const approved = store.approve("tenant_demo", "1.1.0", "admin_2");
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("admin_2");

    const { activated, superseded } = store.activate("tenant_demo", "1.1.0", "admin_3");
    expect(activated.status).toBe("active");
    expect(activated.activatedBy).toBe("admin_3");
    expect(activated.activatedAt).toBeDefined();
    expect(superseded?.version).toBe("1.0.0");
    expect(superseded?.status).toBe("retired");
    expect(store.getActive("tenant_demo")?.version).toBe("1.1.0");
  });

  it("enforces the lifecycle: no skipping steps, no touching retired versions", () => {
    const store = new InMemoryPolicyStore();
    store.createDraft("tenant_demo", makePolicy("1.1.0"), "admin_1");
    expect(() => store.approve("tenant_demo", "1.1.0", "a")).toThrowError(IllegalTransitionError);
    expect(() => store.activate("tenant_demo", "1.1.0", "a")).toThrowError(IllegalTransitionError);

    store.markSimulated("tenant_demo", "1.1.0");
    store.approve("tenant_demo", "1.1.0", "a");
    store.retire("tenant_demo", "1.1.0", "admin_9");
    expect(store.get("tenant_demo", "1.1.0")?.status).toBe("retired");
    expect(() => store.activate("tenant_demo", "1.1.0", "a")).toThrowError(IllegalTransitionError);
  });

  it("re-simulation of a simulated version is allowed", () => {
    const store = new InMemoryPolicyStore();
    store.createDraft("tenant_demo", makePolicy("1.1.0"), "admin_1");
    store.markSimulated("tenant_demo", "1.1.0");
    expect(store.markSimulated("tenant_demo", "1.1.0").status).toBe("simulated");
  });

  it("active versions are never returned by reference (no in-place mutation)", () => {
    const store = new InMemoryPolicyStore();
    store.importActive(makePolicy("1.0.0"), "seed");
    const a = store.getActive("tenant_demo");
    a!.rules.push({ actionType: "refund", decision: "auto_execute" });
    expect(store.getActive("tenant_demo")!.rules).toHaveLength(0);
  });

  it("throws PolicyVersionNotFoundError for unknown versions", () => {
    const store = new InMemoryPolicyStore();
    expect(store.get("tenant_demo", "9.9.9")).toBeUndefined();
    expect(() => store.markSimulated("tenant_demo", "9.9.9")).toThrowError(
      PolicyVersionNotFoundError,
    );
  });
});
