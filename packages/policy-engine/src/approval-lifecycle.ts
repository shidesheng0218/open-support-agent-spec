import type { Approval, ApprovalStatus, IsoDateTime, TenantPolicy } from "@osas/core";

/**
 * Approval lifecycle — fail-safe timeout semantics (CONTRACTS.md §4 side
 * effects / approval runtime semantics).
 *
 * Modelled on the Microsoft Agent Governance Toolkit approval fail-safe: an
 * approval that is not decided before its deadline is treated as DENIED, never
 * as approved. These helpers are pure; persisting the "expired" transition and
 * emitting audit events are the API layer's job.
 */

export const APPROVAL_TIMED_OUT = "APPROVAL_TIMED_OUT";

export interface ApprovalExpiryResult {
  status: ApprovalStatus;
  reason?: { code: typeof APPROVAL_TIMED_OUT; message: string };
}

/**
 * The minimum an approval must carry to resolve a deadline. Structurally
 * satisfied by a full `Approval`, and also usable at creation time (before an
 * id/status exist) so the deadline can be stamped onto the record.
 */
export interface ApprovalDeadlineInput {
  requestedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
}

/**
 * Effective deadline of an approval: the explicit `expiresAt` when present,
 * otherwise `requestedAt + policy.approval.timeoutSeconds` when the policy
 * configures a timeout. Returns undefined when no deadline applies.
 */
export function resolveApprovalDeadline(
  approval: ApprovalDeadlineInput,
  policy: Pick<TenantPolicy, "approval">,
  _now: Date = new Date(),
): IsoDateTime | undefined {
  if (approval.expiresAt) return approval.expiresAt;
  const timeoutSeconds = policy.approval?.timeoutSeconds;
  if (timeoutSeconds === undefined) return undefined;
  return new Date(
    new Date(approval.requestedAt).getTime() + timeoutSeconds * 1000,
  ).toISOString();
}

/**
 * Fail-safe expiry check: a "pending" approval whose deadline has passed is
 * reported as "expired" with reason APPROVAL_TIMED_OUT. Non-pending statuses
 * are returned unchanged (an already-decided approval is never re-judged), and
 * a pending approval without a deadline stays pending.
 */
export function evaluateApprovalExpiry(
  approval: Approval,
  policy: Pick<TenantPolicy, "approval">,
  now: Date = new Date(),
): ApprovalExpiryResult {
  if (approval.status !== "pending") return { status: approval.status };
  const expiresAt = resolveApprovalDeadline(approval, policy, now);
  if (!expiresAt) return { status: approval.status };
  if (now.getTime() > new Date(expiresAt).getTime()) {
    return {
      status: "expired",
      reason: {
        code: APPROVAL_TIMED_OUT,
        message: `approval expired at ${expiresAt} without a decision; fail-safe onTimeout policy applies`,
      },
    };
  }
  return { status: approval.status };
}
