import { createHash } from "node:crypto";
import type { ActionProposal } from "@osas/core";
import { stableStringify } from "./stable-stringify.js";

/**
 * RFC 0008 — action-bound approvals.
 *
 * An approval carries `actionDigest`: SHA-256 over the canonical stable-JSON
 * serialization of `{ actionType, params }` of the proposal it approves —
 * exactly what the human saw and decided on. The execution boundary recomputes
 * the digest from the proposal it is about to execute and refuses on mismatch,
 * closing the decide/execute TOCTOU gap. The canonicalization is the same
 * stable JSON the audit hash chain uses (spec §12.3), so the digest is
 * reproducible across implementations.
 */
export const ACTION_BINDING_MISMATCH = "ACTION_BINDING_MISMATCH";

/** The canonical action input an approval binds to. */
export type ActionBindingInput = Pick<ActionProposal, "actionType" | "params">;

/** What a caller supplies to executeProposal to enforce the binding. */
export interface ActionBinding {
  /** 64 lowercase hex chars; when absent, the check is skipped (legacy approvals). */
  actionDigest?: string;
}

export class ActionBindingMismatchError extends Error {
  readonly code = ACTION_BINDING_MISMATCH;
  constructor() {
    super(
      "the proposal's action no longer matches the approved action digest; " +
        "the approval does not authorize this execution",
    );
    this.name = "ActionBindingMismatchError";
  }
}

/**
 * Compute the digest stamped on approvals and re-verified at execution.
 * Deterministic and key-order independent (stableStringify sorts keys).
 */
export function computeActionDigest(input: ActionBindingInput): string {
  return createHash("sha256")
    .update(stableStringify({ actionType: input.actionType, params: input.params }), "utf8")
    .digest("hex");
}

/**
 * Fail-closed verification. Throws ActionBindingMismatchError when a supplied
 * digest does not match the proposal; no-op when the binding carries no digest
 * (approvals predating RFC 0008) so existing flows are unaffected.
 */
export function assertActionBinding(
  proposal: ActionBindingInput,
  binding?: ActionBinding,
): void {
  if (!binding?.actionDigest) return;
  if (computeActionDigest(proposal) !== binding.actionDigest) {
    throw new ActionBindingMismatchError();
  }
}
