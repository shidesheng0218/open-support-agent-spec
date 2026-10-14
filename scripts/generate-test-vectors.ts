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
  proposal: ActionProposal;
  context: {
    policy: TenantPolicy;
    evidence: any[];
    recentProposals: ActionProposal[];
    injectionSuspected: boolean;
  };
  expectedDecision: PolicyDecision;
  description?: string;
}

const demoPolicy: TenantPolicy = {
  id: "pol_demo",
  specVersion: "0.2",
  tenantId: "tenant_demo",
  version: 1,
  status: "active",
  duplicateWindowSeconds: 86400,
  maxEvidenceAgeSeconds: 604800,
  rules: [
    {
      actionType: "refund",
      decision: "auto_execute",
      maxAmount: { currency: "USD", minorUnits: 5000 },
      reasonCodes: ["damaged", "wrong_item", "not_received"],
    },
  ],
  defaultDecision: "block",
  createdAt: baseTime,
  updatedAt: baseTime,
  createdBy: { actorType: "human", actorId: "admin_1", role: "policy_admin" },
};

const policyEvaluationVectors: PolicyEvaluationVector[] = [
  {
    name: "auto-execute-small-refund",
    description: "Small refund within threshold and allowed reason",
    proposal: {
      id: "prop_1",
      specVersion: "0.2",
      tenantId: "tenant_demo",
      caseId: "case_1",
      profile: "ecommerce",
      actionType: "refund",
      status: "pending_evaluation",
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "model_1", role: "support_agent" },
      params: {
        orderId: "ord_123",
        amount: { currency: "USD", minorUnits: 2500 },
        reason: "damaged",
      },
      evidenceIds: ["ev_1"],
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    context: {
      policy: demoPolicy,
      evidence: [
        {
          id: "ev_1",
          specVersion: "0.2",
          tenantId: "tenant_demo",
          caseId: "case_1",
          evidenceType: "order_details",
          timestamp: "2026-01-15T09:00:00.000Z",
          content: { orderId: "ord_123", status: "delivered" },
          createdAt: "2026-01-15T09:00:00.000Z",
        },
      ],
      recentProposals: [],
      injectionSuspected: false,
    },
    expectedDecision: {
      decision: "auto_execute",
      reasons: [],
    },
  },
  {
    name: "require-approval-over-threshold",
    description: "Refund exceeds threshold",
    proposal: {
      id: "prop_2",
      specVersion: "0.2",
      tenantId: "tenant_demo",
      caseId: "case_2",
      profile: "ecommerce",
      actionType: "refund",
      status: "pending_evaluation",
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "model_1", role: "support_agent" },
      params: {
        orderId: "ord_456",
        amount: { currency: "USD", minorUnits: 10000 },
        reason: "damaged",
      },
      evidenceIds: ["ev_2"],
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    context: {
      policy: demoPolicy,
      evidence: [
        {
          id: "ev_2",
          specVersion: "0.2",
          tenantId: "tenant_demo",
          caseId: "case_2",
          evidenceType: "order_details",
          timestamp: "2026-01-15T09:00:00.000Z",
          content: { orderId: "ord_456", status: "delivered" },
          createdAt: "2026-01-15T09:00:00.000Z",
        },
      ],
      recentProposals: [],
      injectionSuspected: false,
    },
    expectedDecision: {
      decision: "require_approval",
      reasons: [
        {
          code: "OVER_THRESHOLD",
          message: "amount {\"currency\":\"USD\",\"minorUnits\":10000} exceeds rule maxAmount {\"currency\":\"USD\",\"minorUnits\":5000}",
        },
      ],
    },
  },
  {
    name: "block-permission-overreach",
    description: "Model requests execute permission",
    proposal: {
      id: "prop_3",
      specVersion: "0.2",
      tenantId: "tenant_demo",
      caseId: "case_3",
      profile: "ecommerce",
      actionType: "refund",
      status: "pending_evaluation",
      requestedPermission: "execute",
      requestedBy: { actorType: "model", actorId: "model_1", role: "support_agent" },
      params: {
        orderId: "ord_789",
        amount: { currency: "USD", minorUnits: 2500 },
        reason: "damaged",
      },
      evidenceIds: [],
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    context: {
      policy: demoPolicy,
      evidence: [],
      recentProposals: [],
      injectionSuspected: false,
    },
    expectedDecision: {
      decision: "block",
      reasons: [
        {
          code: "PERMISSION_OVERREACH",
          message: "model principals are capped at request-approval; requestedPermission 'execute' is not allowed",
        },
      ],
    },
  },
  {
    name: "block-injection-suspected",
    description: "Prompt injection detected",
    proposal: {
      id: "prop_4",
      specVersion: "0.2",
      tenantId: "tenant_demo",
      caseId: "case_4",
      profile: "ecommerce",
      actionType: "refund",
      status: "pending_evaluation",
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "model_1", role: "support_agent" },
      params: {
        orderId: "ord_abc",
        amount: { currency: "USD", minorUnits: 2500 },
        reason: "damaged",
      },
      evidenceIds: [],
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    context: {
      policy: demoPolicy,
      evidence: [],
      recentProposals: [],
      injectionSuspected: true,
    },
    expectedDecision: {
      decision: "block",
      reasons: [
        {
          code: "PROMPT_INJECTION_SUSPECTED",
          message: "prompt injection suspected in the originating conversation",
        },
      ],
    },
  },
  {
    name: "block-no-rule",
    description: "Action type not in policy rules",
    proposal: {
      id: "prop_5",
      specVersion: "0.2",
      tenantId: "tenant_demo",
      caseId: "case_5",
      profile: "ecommerce",
      actionType: "cancel_order",
      status: "pending_evaluation",
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "model_1", role: "support_agent" },
      params: { orderId: "ord_xyz" },
      evidenceIds: [],
      createdAt: baseTime,
      updatedAt: baseTime,
    },
    context: {
      policy: demoPolicy,
      evidence: [],
      recentProposals: [],
      injectionSuspected: false,
    },
    expectedDecision: {
      decision: "block",
      reasons: [
        {
          code: "NO_RULE",
          message: "no rule matches actionType 'cancel_order'; defaultDecision is 'block'",
        },
      ],
    },
  },
];

// Run evaluations
policyEvaluationVectors.forEach(v => {
  const ctx: EvaluationContext = {
    policy: v.context.policy,
    evidence: v.context.evidence,
    recentProposals: v.context.recentProposals,
    injectionSuspected: v.context.injectionSuspected,
    now: new Date(baseTime),
  };
  v.expectedDecision = evaluateProposal(v.proposal, ctx);
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
