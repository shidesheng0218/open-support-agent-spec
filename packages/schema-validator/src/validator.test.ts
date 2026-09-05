import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_VERSION } from "@osas/core";
import {
  createValidator,
  getValidator,
  listSchemas,
  loadManifest,
  loadSchema,
  resolveSchemasDir,
} from "./index.js";

const NOW = "2026-01-01T00:00:00.000Z";

const base = {
  id: "x_1",
  specVersion: SPEC_VERSION,
  tenantId: "tenant_demo",
  createdAt: NOW,
};

const validFixtures: Record<string, unknown> = {
  "core/case": {
    ...base,
    customerId: "cus_1",
    profile: "ecommerce",
    channel: "email",
    subject: "Refund request",
    status: "open",
    priority: "normal",
    assigneeType: "agent",
    tags: [],
    evidenceIds: [],
    updatedAt: NOW,
  },
  "core/customer": {
    ...base,
    displayName: "Ada",
    region: "US",
    identityVerification: { status: "verified", verifiedAt: NOW },
    tags: [],
    updatedAt: NOW,
  },
  "core/evidence": {
    ...base,
    caseId: "case_1",
    kind: "order",
    source: { system: "shopify", recordType: "order", recordId: "ord_1" },
    summary: "Order record",
    data: {},
    retrievedAt: NOW,
  },
  "core/action-proposal": {
    ...base,
    caseId: "case_1",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_1" },
    requestedPermission: "request-approval",
    requestedBy: {
      actorType: "model",
      actorId: "agent-1",
      model: { provider: "mock-local", model: "mock" },
    },
    amount: { currency: "USD", minorUnits: 2500 },
    evidenceIds: ["ev_1"],
    idempotencyKey: "k-1",
    status: "proposed",
    updatedAt: NOW,
  },
  "core/approval": {
    ...base,
    proposalId: "prop_1",
    status: "pending",
    policyVersion: "1.0.0",
    requestedAt: NOW,
    updatedAt: NOW,
  },
  "core/tenant-policy": {
    ...base,
    version: "1.0.0",
    effectiveFrom: NOW,
    duplicateWindowSeconds: 86400,
    maxEvidenceAgeSeconds: 604800,
    rules: [{ actionType: "refund", decision: "auto_execute" }],
    defaultDecision: "block",
    updatedAt: NOW,
  },
  "core/audit-event": {
    ...base,
    eventType: "proposal_created",
    actorType: "model",
    actorId: "agent-1",
    detail: {},
  },
  "core/human-handoff": {
    ...base,
    caseId: "case_1",
    reason: "identity_unverified",
    status: "open",
    updatedAt: NOW,
  },
  "core/knowledge-article": {
    ...base,
    title: "Refund policy",
    body: "…",
    tags: ["refund"],
    updatedAt: NOW,
  },
  "core/case-note": { ...base, caseId: "case_1", body: "note" },
  "core/escalation": { ...base, caseId: "case_1", reason: "vip" },
  "core/capability-manifest": {
    specVersion: SPEC_VERSION,
    implementationId: "test-impl",
    implementationVersion: "0.1.1",
    profiles: [{ name: "core", capabilities: ["case.read", "customer.read"] }],
    transports: ["http"],
    executionModes: ["proposal_only"],
    adapterVersion: "0.1.1",
  },
};

// v0.1.1 hash-chain extension fields on AuditEvent + policy lifecycle event types.
const chainedAuditEvent = {
  ...(validFixtures["core/audit-event"] as object),
  eventType: "policy_activated",
  sequence: 1,
  previousHash: "0".repeat(64),
  eventHash: "a".repeat(64),
};

const validator = createValidator();

describe("schemas dir resolution + manifest", () => {
  it("resolveSchemasDir points at the repo-root schemas/ from src/", () => {
    const dir = resolveSchemasDir();
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });

  it("honors OSAS_SCHEMAS_DIR override", () => {
    process.env.OSAS_SCHEMAS_DIR = "/tmp/osas-schemas-override";
    try {
      expect(resolveSchemasDir()).toBe("/tmp/osas-schemas-override");
    } finally {
      delete process.env.OSAS_SCHEMAS_DIR;
    }
  });

  it("manifest covers 14 core + 5 profile + 16 tool schemas", () => {
    const manifest = loadManifest();
    expect(manifest.specVersion).toBe(SPEC_VERSION);
    expect(manifest.schemas).toHaveLength(35);
    expect(listSchemas().map((s) => s.name)).toContain("core/capability-manifest");
    expect(listSchemas().map((s) => s.name)).toContain("core/shadow-run");
    expect(listSchemas().map((s) => s.name)).toContain("tools/osas_core_get_case");
    expect(loadSchema("core/case")).toMatchObject({ title: "Case" });
    expect(() => loadSchema("nope/nope")).toThrow(/Unknown schema/);
  });
});

describe("valid minimal fixtures pass", () => {
  for (const [name, fixture] of Object.entries(validFixtures)) {
    it(`${name}`, () => {
      const result = validator.validate(name, fixture);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }

  it("audit events accept the v0.1.1 hash-chain fields and policy lifecycle event types", () => {
    const result = validator.validate("core/audit-event", chainedAuditEvent);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("audit events reject malformed hashes", () => {
    const result = validator.validate("core/audit-event", {
      ...(chainedAuditEvent as object),
      eventHash: "not-a-sha256",
    });
    expect(result.valid).toBe(false);
  });
});

describe("invalid data is rejected", () => {
  it("unknown extra field fails (additionalProperties: false)", () => {
    const result = validator.validate("core/case", {
      ...(validFixtures["core/case"] as object),
      hacker: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/additional/);
  });

  it("wrong enum fails", () => {
    const result = validator.validate("core/case", {
      ...(validFixtures["core/case"] as object),
      status: "limbo",
    });
    expect(result.valid).toBe(false);
  });

  it("specVersion mismatch fails (const 0.1)", () => {
    const result = validator.validate("core/customer", {
      ...(validFixtures["core/customer"] as object),
      specVersion: "0.2",
    });
    expect(result.valid).toBe(false);
  });

  it("missing required field fails", () => {
    const { status: _dropped, ...rest } = validFixtures["core/case"] as Record<string, unknown>;
    expect(validator.validate("core/case", rest).valid).toBe(false);
  });

  it("money minorUnits float fails", () => {
    const result = validator.validate("core/action-proposal", {
      ...(validFixtures["core/action-proposal"] as object),
      amount: { currency: "USD", minorUnits: 25.5 },
    });
    expect(result.valid).toBe(false);
  });

  it("non-ISO-4217 currency fails", () => {
    const result = validator.validate("core/action-proposal", {
      ...(validFixtures["core/action-proposal"] as object),
      amount: { currency: "usd", minorUnits: 2500 },
    });
    expect(result.valid).toBe(false);
  });

  it("cross-schema $ref resolves (Money from common.json)", () => {
    const result = validator.validate("core/action-proposal", {
      ...(validFixtures["core/action-proposal"] as object),
      amount: { currency: "USD" },
    });
    expect(result.valid).toBe(false);
  });
});

describe("tools input schemas", () => {
  it("osas_core_get_case accepts { id } and rejects extras", () => {
    expect(validator.validate("tools/osas_core_get_case", { id: "case_1" }).valid).toBe(true);
    expect(validator.validate("tools/osas_core_get_case", {}).valid).toBe(false);
    expect(validator.validate("tools/osas_core_get_case", { id: "c", tenantId: "t" }).valid).toBe(
      false,
    );
  });

  it("osas_saas_create_credit_request takes the shortcut shape (server sets permission/actor)", () => {
    const input = {
      caseId: "case_1",
      customerId: "cus_1",
      reasonCode: "goodwill",
      amount: { currency: "USD", minorUnits: 5000 },
      evidenceIds: ["ev_1"],
      idempotencyKey: "k-1",
    };
    expect(validator.validate("tools/osas_saas_create_credit_request", input).valid).toBe(true);
    expect(
      validator.validate("tools/osas_saas_create_credit_request", { ...input, tenantId: "t" })
        .valid,
    ).toBe(false);
    expect(
      validator.validate("tools/osas_saas_create_credit_request", {
        ...input,
        requestedPermission: "execute",
      }).valid,
    ).toBe(false);
  });
});

describe("singleton", () => {
  it("getValidator returns a cached working instance", () => {
    const v1 = getValidator();
    expect(v1).toBe(getValidator());
    expect(v1.validate("core/case-note", validFixtures["core/case-note"]).valid).toBe(true);
  });

  it("validate throws on unknown schema name", () => {
    expect(() => validator.validate("core/nope", {})).toThrow(/Unknown schema/);
  });
});
