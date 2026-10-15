import type { ActionProposal, Approval } from "@osas/core";
import { formatMoney } from "../workers/shadow-note.js";

/**
 * Block Kit for the approval card. The card shows what the approver is
 * approving (action, amount, order) and which exact action it is bound to (the
 * first 12 chars of actionDigest). It never contains customer text or contact
 * details. Everything interpolated is escaped for Slack mrkdwn.
 */
export const ACTION_APPROVE = "osas_approval_approve";
export const ACTION_REJECT = "osas_approval_reject";

export const escapeMrkdwn = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `decision|approvalId|actionDigest` — validated again against the store on click. */
export const buttonValue = (decision: "approved" | "rejected", approvalId: string, digest: string): string =>
  `${decision}|${approvalId}|${digest}`;

export function parseButtonValue(
  v: unknown,
): { decision: "approved" | "rejected"; approvalId: string; digest: string } | undefined {
  if (typeof v !== "string") return undefined;
  const [decision, approvalId, digest, extra] = v.split("|");
  if (extra !== undefined) return undefined;
  if (decision !== "approved" && decision !== "rejected") return undefined;
  if (!approvalId || !/^[A-Za-z0-9_.:-]{1,80}$/.test(approvalId)) return undefined;
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  return { decision, approvalId, digest };
}

const header = (proposal: ActionProposal): string =>
  clip(`Approval needed: ${proposal.actionType.replace(/_/g, " ")}`, 150);

function facts(proposal: ActionProposal, approval: Approval): unknown[] {
  const orderId = typeof proposal.params.orderId === "string" ? proposal.params.orderId : undefined;
  const fields: string[] = [
    `*Action*\n${escapeMrkdwn(proposal.actionType)}`,
    `*Amount*\n${proposal.amount ? escapeMrkdwn(formatMoney(proposal.amount)) : "n/a"}`,
    `*Reason*\n${escapeMrkdwn(clip(proposal.reasonCode, 60))}`,
    `*Order*\n${orderId ? escapeMrkdwn(clip(orderId, 60)) : "n/a"}`,
  ];
  if (approval.expiresAt) fields.push(`*Expires*\n${escapeMrkdwn(approval.expiresAt)}`);
  return fields.map((text) => ({ type: "mrkdwn", text }));
}

const refs = (proposal: ActionProposal, approval: Approval): unknown => ({
  type: "context",
  elements: [
    {
      type: "mrkdwn",
      text:
        `Tenant \`${escapeMrkdwn(approval.tenantId)}\` · proposal \`${escapeMrkdwn(proposal.id)}\` · ` +
        `approval \`${escapeMrkdwn(approval.id)}\` · bound to action \`${(approval.actionDigest ?? "").slice(0, 12)}\``,
    },
  ],
});

export function approvalCard(proposal: ActionProposal, approval: Approval): { text: string; blocks: unknown[] } {
  const digest = approval.actionDigest ?? "";
  return {
    text: header(proposal),
    blocks: [
      { type: "header", text: { type: "plain_text", text: header(proposal) } },
      { type: "section", fields: facts(proposal, approval) },
      refs(proposal, approval),
      {
        type: "actions",
        block_id: "osas_approval",
        elements: [
          {
            type: "button",
            action_id: ACTION_APPROVE,
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            value: buttonValue("approved", approval.id, digest),
            confirm: {
              title: { type: "plain_text", text: "Approve this action?" },
              text: { type: "mrkdwn", text: "You approve exactly the action shown on this card." },
              confirm: { type: "plain_text", text: "Approve" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
          {
            type: "button",
            action_id: ACTION_REJECT,
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
            value: buttonValue("rejected", approval.id, digest),
          },
        ],
      },
    ],
  };
}

/** Card without buttons: the request was decided, or it can no longer be decided here. */
export function closedCard(
  proposal: ActionProposal,
  approval: Approval,
  statusLine: string,
): { text: string; blocks: unknown[] } {
  return {
    text: `${header(proposal)} — ${statusLine}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: header(proposal) } },
      { type: "section", fields: facts(proposal, approval) },
      refs(proposal, approval),
      { type: "section", text: { type: "mrkdwn", text: statusLine } },
    ],
  };
}
