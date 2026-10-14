#!/usr/bin/env tsx
/**
 * Generate cross-language test vectors for OSAS implementations.
 * 
 * Outputs conformance/test-vectors/*.json with canonical inputs/outputs
 * for stable-json, audit-chain, and policy-evaluation algorithms.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../packages/policy-engine/src/stable-stringify.js";
import { hashAuditEvent, verifyAuditChain, AUDIT_CHAIN_GENESIS_HASH } from "../packages/policy-engine/src/audit-chain.js";
import { evaluateProposal } from "../packages/policy-engine/src/evaluate.js";
import type { AuditEvent, ActionProposal, TenantPolicy } from "@osas/core";
import type { EvaluationContext, PolicyDecision } from "../packages/policy-engine/src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../conformance/test-vectors");

// ============================================================================
// Stable JSON Test Vectors
// ============================================================================

interface StableJsonVector {
  name: string;
  input: unknown;
  canonical: string;
  description?: string;
}

const stableJsonVectors: StableJsonVector[] = [
  {
    name: "simple-object",
    input: { z: 1, a: 2, b: 3 },
    canonical: '{"a":2,"b":3,"z":1}',
    description: "Keys sorted lexicographically",
  },
  {
    name: "nested-object",
    input: { outer: { z: 1, a: 2 }, middle: 5 },
    canonical: '{"middle":5,"outer":{"a":2,"z":1}}',
    description: "Recursive key sorting",
  },
  {
    name: "array-preserved-order",
    input: [3, 1, 2],
    canonical: "[3,1,2]",
    description: "Array order unchanged",
  },
  {
    name: "null-value",
    input: { a: null, b: 2 },
    canonical: '{"a":null,"b":2}',
    description: "null serialized as null",
  },
  {
    name: "amount-object",
    input: { currency: "USD", minorUnits: 5000 },
    canonical: '{"currency":"USD","minorUnits":5000}',
    description: "Money object (50.00 USD)",
  },
  {
    name: "proposal-params",
    input: {
      orderId: "ord_123",
      amount: { currency: "USD", minorUnits: 2500 },
      reason: "damaged",
    },
    canonical: '{"amount":{"currency":"USD","minorUnits":2500},"orderId":"ord_123","reason":"damaged"}',
    description: "Typical refund proposal params",
  },
  {
    name: "empty-object",
    input: {},
    canonical: "{}",
  },
  {
    name: "empty-array",
    input: [],
    canonical: "[]",
  },
  {
    name: "string-escaping",
    input: { text: 'Hello\n"World"' },
    canonical: '{"text":"Hello\\n\\"World\\""}',
    description: "JSON escaping for newline and quotes",
  },
  {
    name: "number-formats",
    input: { int: 42, float: 3.14, negative: -10 },
    canonical: '{"float":3.14,"int":42,"negative":-10}',
    description: "Various number formats",
  },
  {
    name: "unicode",
    input: { emoji: "🚀", chinese: "中文" },
    canonical: '{"chinese":"中文","emoji":"🚀"}',
    description: "UTF-8 non-ASCII characters preserved",
  },
];

// Generate canonical strings
stableJsonVectors.forEach(v => {
  v.canonical = stableStringify(v.input);
});

// ============================================================================
// Audit Chain Test Vectors
// ============================================================================

interface AuditChainVector {
  name: string;
  events: AuditEvent[];
  expectedHashes: { eventId: string; eventHash: string }[];
  verification: { intact: boolean; chainLength: number; firstError?: any };
  description?: string;
}

const baseTime = "2026-01-15T10:00:00.000Z";
const tenantId = "tenant_test";

const auditChainVectors: AuditChainVector[] = [
  {
    name: "single-event",
    description: "Genesis event with sequence 1",
    events: [
      {
        id: "evt_1",
        specVersion: "0.2",
        tenantId,
        eventType: "policy_draft_created",
        timestamp: baseTime,
        sequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        eventHash: "", // will be computed
        principal: { actorType: "human", actorId: "admin_1", role: "policy_admin" },
        resource: { resourceType: "policy", resourceId: "pol_1" },
      },
    ],
    expectedHashes: [],
    verification: { intact: true, chainLength: 1 },
  },
  {
    name: "three-event-chain",
    description: "Valid chain with 3 events",
    events: [
      {
        id: "evt_1",
        specVersion: "0.2",
        tenantId,
        eventType: "policy_draft_created",
        timestamp: baseTime,
        sequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        eventHash: "",
        principal: { actorType: "human", actorId: "admin_1", role: "policy_admin" },
        resource: { resourceType: "policy", resourceId: "pol_1" },
      },
      {
        id: "evt_2",
        specVersion: "0.2",
        tenantId,
        eventType: "policy_activated",
        timestamp: "2026-01-15T10:01:00.000Z",
        sequence: 2,
        previousHash: "",
        eventHash: "",
        principal: { actorType: "human", actorId: "admin_1", role: "policy_admin" },
        resource: { resourceType: "policy", resourceId: "pol_1" },
      },
      {
        id: "evt_3",
        specVersion: "0.2",
        tenantId,
        eventType: "proposal_created",
        timestamp: "2026-01-15T10:02:00.000Z",
        sequence: 3,
        previousHash: "",
        eventHash: "",
        principal: { actorType: "model", actorId: "model_gpt4", role: "support_agent" },
        resource: { resourceType: "proposal", resourceId: "prop_1" },
      },
    ],
    expectedHashes: [],
    verification: { intact: true, chainLength: 3 },
  },
  {
    name: "tampered-event",
    description: "Event with modified content (hash mismatch)",
    events: [
      {
        id: "evt_1",
        specVersion: "0.2",
        tenantId,
        eventType: "policy_draft_created",
        timestamp: baseTime,
        sequence: 1,
        previousHash: AUDIT_CHAIN_GENESIS_HASH,
        eventHash: "0000000000000000000000000000000000000000000000000000000000000000",
        principal: { actorType: "human", actorId: "admin_1", role: "policy_admin" },
        resource: { resourceType: "policy", resourceId: "pol_1" },
      },
    ],
    expectedHashes: [],
    verification: {
      intact: false,
      chainLength: 1,
      firstError: {
        eventId: "evt_1",
        sequence: 1,
        reason: "event_hash_mismatch",
      },
    },
  },
];

// Compute hashes for valid chains
auditChainVectors.forEach(v => {
  if (v.name !== "tampered-event") {
    for (let i = 0; i < v.events.length; i++) {
      const event = v.events[i]!;
      if (i > 0) {
        event.previousHash = v.events[i - 1]!.eventHash;
      }
      event.eventHash = hashAuditEvent(event);
      v.expectedHashes.push({
        eventId: event.id,
        eventHash: event.eventHash,
      });
    }
  }
  
  // Run verification
  const result = verifyAuditChain(v.events);
  if (v.name === "tampered-event") {
    v.verification = {
      intact: false,
      chainLength: 1,
      firstError: result.firstError,
    };
  }
});

// ============================================================================
// Policy Evaluation Test Vectors
// ============================================================================

interface PolicyEvaluationVector {
  name: string;
  description: string;
  proposal: ActionProposal;
  context: EvaluationContext;
  expected: PolicyDecision;
}

const evalNow = new Date("2026-01-15T10:00:00.000Z");

const basePolicy: TenantPolicy = {
  id: "pol_test",
  specVersion: "0.2",
  tenantId: "tenant_demo",
  version: "1.0.0",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  duplicateWindowSeconds: 86400,
  maxEvidenceAgeSeconds: 604800,
  defaultDecision: "block",
  rules: [
    {
      actionType: "refund",
      decision: "auto_execute",
      maxAmount: { currency: "USD", minorUnits: 5000 },
      reasonCodes: ["defective_item", "wrong_item"],
      requireVerifiedIdentity: true,
      identityMaxAgeSeconds: 7776000,
      allowedRegions: ["US", "CA", "GB"]
    }
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const baseCustomer = {
  id: "cust_001",
  tenantId: "tenant_demo",
  region: "US",
  identityVerification: {
    status: "verified" as const,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    method: "government_id"
  }
};

const baseEvidence = [
  {
    id: "ev_photo_001",
    tenantId: "tenant_demo",
    caseId: "case_001",
    kind: "order",
    retrievedAt: "2026-01-15T09:00:00.000Z",
    expiresAt: "2026-01-22T09:00:00.000Z",
    createdAt: "2026-01-15T09:00:00.000Z"
  }
];

const baseProposal = {
  tenantId: "tenant_demo",
  caseId: "case_001",
  profile: "ecommerce" as const,
  requestedPermission: "request-approval" as const,
  requestedBy: { actorType: "model" as const, modelId: "gpt-4" },
  evidenceIds: ["ev_photo_001"],
  params: { orderId: "ord_001" },
  specVersion: "0.2" as const
};

const baseContext: EvaluationContext = {
  policy: basePolicy,
  customer: baseCustomer,
  evidence: baseEvidence,
  recentProposals: [],
  injectionSuspected: false,
  now: evalNow
};

const policyEvaluationVectors: PolicyEvaluationVector[] = [];

// 1. Small refund - auto_execute
const p1 = {
  ...baseProposal,
  id: "prop_001",
  actionType: "refund" as const,
  reasonCode: "defective_item",
  amount: { currency: "USD", minorUnits: 2000 }
};
policyEvaluationVectors.push({
  name: "small_refund_auto_execute",
  description: "Small refund within limit, verified identity, allowed region - should auto_execute",
  proposal: p1,
  context: baseContext,
  expected: evaluateProposal(p1, baseContext)
});

// 2. Large refund - require_approval
const p2 = {
  ...baseProposal,
  id: "prop_002",
  actionType: "refund" as const,
  reasonCode: "defective_item",
  amount: { currency: "USD", minorUnits: 6000 }
};
policyEvaluationVectors.push({
  name: "large_refund_over_threshold",
  description: "Refund exceeds maxAmount threshold - should require_approval",
  proposal: p2,
  context: baseContext,
  expected: evaluateProposal(p2, baseContext)
});

// 3. Missing amount - block
const p3 = {
  ...baseProposal,
  id: "prop_003",
  actionType: "refund" as const,
  reasonCode: "defective_item"
};
policyEvaluationVectors.push({
  name: "refund_missing_amount",
  description: "Financial action missing required amount field - should block",
  proposal: p3,
  context: baseContext,
  expected: evaluateProposal(p3, baseContext)
});

// 4. Disallowed reason code - block
const p4 = {
  ...baseProposal,
  id: "prop_004",
  actionType: "refund" as const,
  reasonCode: "customer_changed_mind",
  amount: { currency: "USD", minorUnits: 2000 }
};
policyEvaluationVectors.push({
  name: "refund_disallowed_reason",
  description: "reasonCode not in rule's allowed list - should block",
  proposal: p4,
  context: baseContext,
  expected: evaluateProposal(p4, baseContext)
});

// 5. Blocked region - block
const ctx5: EvaluationContext = {
  ...baseContext,
  policy: {
    ...basePolicy,
    rules: [
      {
        ...basePolicy.rules[0],
        blockedRegions: ["IR", "KP"]
      }
    ]
  },
  customer: { ...baseCustomer, region: "IR" }
};
const p5 = {
  ...baseProposal,
  id: "prop_005",
  actionType: "refund" as const,
  reasonCode: "defective_item",
  amount: { currency: "USD", minorUnits: 2000 }
};
policyEvaluationVectors.push({
  name: "refund_blocked_region",
  description: "Customer region in blockedRegions list - should block",
  proposal: p5,
  context: ctx5,
  expected: evaluateProposal(p5, ctx5)
});

// ============================================================================
// Output
// ============================================================================

function writeVector(filename: string, data: unknown) {
  const path = resolve(outDir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`✓ ${filename}`);
}

writeVector("stable-json.json", {
  schemaVersion: "1",
  description: "Test vectors for stable (key-sorted) JSON canonicalization",
  algorithm: "Keys sorted lexicographically (UTF-16 code unit order), no whitespace",
  vectors: stableJsonVectors,
});

writeVector("audit-chain.json", {
  schemaVersion: "1",
  description: "Test vectors for audit event hashing and chain verification",
  algorithm: "SHA-256(UTF-8(stableJson(event without eventHash))), lowercase hex",
  genesisHash: AUDIT_CHAIN_GENESIS_HASH,
  vectors: auditChainVectors,
});

writeVector("policy-evaluation.json", {
  schemaVersion: "1",
  description: "Test vectors for policy evaluation algorithm (spec §5)",
  note: "Expected decisions computed by the reference implementation",
  vectors: policyEvaluationVectors,
});

console.log(`\n✓ Generated ${stableJsonVectors.length + auditChainVectors.length + policyEvaluationVectors.length} test vectors in ${outDir}`);
