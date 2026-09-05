import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@osas/core";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  hashAuditEvent,
  verifyAuditChain,
} from "./audit-chain.js";

let seq = 0;
function makeEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  seq += 1;
  return {
    id: `audit_${seq}`,
    specVersion: "0.1",
    tenantId: "tenant_demo",
    eventType: "policy_evaluated",
    actorType: "policy_engine",
    actorId: "osas-api",
    detail: { n: seq },
    createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    ...over,
  };
}

/** Append-only chain builder mirroring the mock adapter's append logic. */
function chain(events: AuditEvent[]): AuditEvent[] {
  let previousHash = AUDIT_CHAIN_GENESIS_HASH;
  return events.map((e, i) => {
    const linked: AuditEvent = { ...e, sequence: i + 1, previousHash };
    const eventHash = hashAuditEvent(linked);
    previousHash = eventHash;
    return { ...linked, eventHash };
  });
}

describe("audit hash chain", () => {
  it("an empty chain is intact", () => {
    expect(verifyAuditChain([])).toEqual({ intact: true, chainLength: 0 });
  });

  it("a well-formed chain verifies", () => {
    const events = chain([makeEvent(), makeEvent(), makeEvent()]);
    const result = verifyAuditChain(events);
    expect(result.intact).toBe(true);
    expect(result.chainLength).toBe(3);
  });

  it("is order-independent on input (sorts by sequence)", () => {
    const events = chain([makeEvent(), makeEvent(), makeEvent()]);
    expect(verifyAuditChain([...events].reverse()).intact).toBe(true);
  });

  it("detects a tampered event body (eventHash mismatch)", () => {
    const events = chain([makeEvent(), makeEvent(), makeEvent()]);
    events[1] = { ...events[1]!, detail: { n: 999, forged: true } };
    const result = verifyAuditChain(events);
    expect(result.intact).toBe(false);
    expect(result.firstError?.eventId).toBe(events[1]!.id);
    expect(result.firstError?.reason).toBe("event_hash_mismatch");
    expect(result.firstError?.expectedEventHash).toBe(events[1]!.eventHash);
    expect(result.firstError?.actualEventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.firstError?.actualEventHash).not.toBe(events[1]!.eventHash);
  });

  it("detects a deleted middle event (previousHash mismatch)", () => {
    const events = chain([makeEvent(), makeEvent(), makeEvent()]);
    const result = verifyAuditChain([events[0]!, events[2]!]);
    expect(result.intact).toBe(false);
    expect(result.firstError?.reason).toBe("sequence_gap");
  });

  it("detects a forged previousHash link", () => {
    const events = chain([makeEvent(), makeEvent()]);
    events[1] = { ...events[1]!, previousHash: "f".repeat(64) };
    const result = verifyAuditChain(events);
    expect(result.intact).toBe(false);
    expect(result.firstError?.reason).toBe("previous_hash_mismatch");
  });

  it("rejects events without chain fields", () => {
    const result = verifyAuditChain([makeEvent()]);
    expect(result.intact).toBe(false);
    expect(result.firstError?.reason).toBe("missing_chain_fields");
  });

  it("hash excludes the eventHash field itself", () => {
    const e = makeEvent({ sequence: 1, previousHash: AUDIT_CHAIN_GENESIS_HASH });
    const withHash = { ...e, eventHash: "a".repeat(64) };
    expect(hashAuditEvent(withHash)).toBe(hashAuditEvent(e));
  });

  it("two tenants' chains are independent (cross-tenant isolation)", () => {
    const tenantA = chain([makeEvent({ tenantId: "tenant_a" }), makeEvent({ tenantId: "tenant_a" })]);
    const tenantB = chain([makeEvent({ tenantId: "tenant_b" })]);
    expect(verifyAuditChain(tenantA).intact).toBe(true);
    expect(verifyAuditChain(tenantB).intact).toBe(true);
    // Mixing another tenant's event into a stream breaks that stream.
    const mixed = [tenantA[0]!, tenantB[0]!];
    expect(verifyAuditChain(mixed).intact).toBe(false);
    // Tampering tenant B does not affect tenant A's verification.
    tenantB[0] = { ...tenantB[0]!, detail: { forged: true } };
    expect(verifyAuditChain(tenantA).intact).toBe(true);
    expect(verifyAuditChain(tenantB).intact).toBe(false);
  });
});
