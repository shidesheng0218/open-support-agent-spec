import { createHash } from "node:crypto";
import type { AuditEvent } from "@osas/core";
import { stableStringify } from "./stable-stringify.js";

/** previousHash of the first event in a tenant's audit stream. */
export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

/**
 * SHA-256 over the stable (key-sorted) JSON of the event, excluding the
 * `eventHash` field itself. `sequence` and `previousHash` are part of the
 * hashed content, so edits, deletions and reordering are all detectable.
 */
export function hashAuditEvent(event: AuditEvent): string {
  const { eventHash: _excluded, ...content } = event;
  return createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
}

export type AuditChainErrorReason =
  | "missing_chain_fields"
  | "sequence_gap"
  | "previous_hash_mismatch"
  | "event_hash_mismatch";

export interface AuditChainError {
  eventId: string;
  sequence?: number;
  reason: AuditChainErrorReason;
  expectedEventHash?: string;
  actualEventHash?: string;
  expectedPreviousHash?: string;
  actualPreviousHash?: string;
}

export interface AuditChainVerification {
  intact: boolean;
  chainLength: number;
  firstError?: AuditChainError;
}

/**
 * Verify one audit stream (a single tenant's events). Input may be in any
 * order; events are verified in ascending `sequence` order.
 *
 * Tamper-evidence only: an attacker who can rewrite the whole stream can
 * recompute the chain — this does not replace WORM storage.
 */
export function verifyAuditChain(events: AuditEvent[]): AuditChainVerification {
  const sorted = [...events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  let previousHash = AUDIT_CHAIN_GENESIS_HASH;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i] as AuditEvent;
    const fail = (error: AuditChainError): AuditChainVerification => ({
      intact: false,
      chainLength: sorted.length,
      firstError: error,
    });

    if (event.sequence === undefined || event.previousHash === undefined || !event.eventHash) {
      return fail({ eventId: event.id, sequence: event.sequence, reason: "missing_chain_fields" });
    }
    if (event.sequence !== i + 1) {
      return fail({
        eventId: event.id,
        sequence: event.sequence,
        reason: "sequence_gap",
        actualEventHash: event.eventHash,
      });
    }
    if (event.previousHash !== previousHash) {
      return fail({
        eventId: event.id,
        sequence: event.sequence,
        reason: "previous_hash_mismatch",
        expectedPreviousHash: event.previousHash,
        actualPreviousHash: previousHash,
      });
    }
    const actual = hashAuditEvent(event);
    if (actual !== event.eventHash) {
      return fail({
        eventId: event.id,
        sequence: event.sequence,
        reason: "event_hash_mismatch",
        expectedEventHash: event.eventHash,
        actualEventHash: actual,
      });
    }
    previousHash = event.eventHash;
  }

  return { intact: true, chainLength: sorted.length };
}
