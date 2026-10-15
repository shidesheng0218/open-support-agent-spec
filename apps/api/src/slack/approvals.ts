import type { FastifyInstance } from "fastify";
import { requireAdapterCapability, type ToolContext } from "@osas/adapter";
import type { ActionProposal, Approval } from "@osas/core";
import { computeActionDigest } from "@osas/policy-engine";
import { decideApprovalCore } from "../routes/approvals.js";
import { effectiveApproval, tryResolveActivePolicy } from "../domain.js";
import { SYSTEM_PRINCIPAL } from "../plugins.js";
import { approvalCard, closedCard, parseButtonValue } from "./card.js";
import type { SlackConfig } from "./config.js";
import type { SlackClient } from "./client.js";

export interface SlackApprovals {
  /** Post an approval card. Never throws: a Slack outage must not fail the request that created the approval. */
  notify(ctx: ToolContext, proposal: ActionProposal, approval: Approval): Promise<void>;
  /** Apply one verified block_actions payload. Resolves to a short outcome label. */
  handleInteraction(payload: unknown): Promise<SlackInteractionOutcome>;
}

export type SlackInteractionOutcome =
  | "ignored"
  | "wrong_team"
  | "wrong_channel"
  | "unknown_approver"
  | "bad_button"
  | "approval_not_found"
  | "action_changed"
  | "already_decided"
  | "expired"
  | "approved"
  | "rejected"
  | "error";

interface InteractionPayload {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

export function createSlackApprovals(
  app: FastifyInstance,
  config: SlackConfig,
  client: SlackClient,
): SlackApprovals {
  const log = app.log;

  async function notify(ctx: ToolContext, proposal: ActionProposal, approval: Approval): Promise<void> {
    try {
      // Without a digest the click could not be bound to the shown action.
      if (!approval.actionDigest) return;
      // Cards go to one configured channel; refuse to mix tenants into it unless an approver exists for that tenant.
      if (![...config.approvers.values()].some((a) => a.tenantId === ctx.tenantId)) return;
      const card = approvalCard(proposal, approval);
      await client.postMessage(config.channel, card.text, card.blocks);
    } catch (err) {
      log.warn(
        { approvalId: approval.id, code: (err as { code?: string }).code ?? "slack_post_failed" },
        "slack approval card was not posted",
      );
    }
  }

  async function handleInteraction(raw: unknown): Promise<SlackInteractionOutcome> {
    const p = (raw ?? {}) as InteractionPayload;
    if (p.type !== "block_actions") return "ignored";
    if (config.teamId && p.team?.id !== config.teamId) return "wrong_team";
    const channel = p.channel?.id;
    if (channel !== config.channel) return "wrong_channel";
    const slackUser = p.user?.id;
    const ts = p.message?.ts;
    const action = p.actions?.[0];
    if (!slackUser || !ts || !action) return "ignored";

    const reply = (text: string) => client.postEphemeral(channel, slackUser, text).catch(() => undefined);

    const approver = config.approvers.get(slackUser);
    if (!approver) {
      await reply("You are not on the OSAS approver list.");
      return "unknown_approver";
    }
    const button = parseButtonValue(action.value);
    if (!button) return "bad_button";

    const ctx: ToolContext = { tenantId: approver.tenantId, principal: SYSTEM_PRINCIPAL };
    const adapter = app.adapter;
    let approval: Approval;
    let proposal: ActionProposal;
    try {
      await requireAdapterCapability(adapter, ctx, "approval.decide");
      // Tenant-scoped read: an approver mapped to tenant A cannot reach tenant B's approval.
      approval = await adapter.getApproval(ctx, button.approvalId);
      proposal = await adapter.getProposal(ctx, approval.proposalId);
    } catch {
      await reply("That approval could not be found for your tenant.");
      return "approval_not_found";
    }

    const update = (line: string) => {
      const card = closedCard(proposal, approval, line);
      return client.updateMessage(channel, ts, card.text, card.blocks);
    };

    // Two bindings, both must hold: the button was minted for this approval's
    // digest, and the proposal as it stands NOW still hashes to that digest.
    if (
      !approval.actionDigest ||
      button.digest !== approval.actionDigest ||
      computeActionDigest(proposal) !== approval.actionDigest
    ) {
      await update(":no_entry: The action changed after this card was posted. Nothing was decided.").catch(() => undefined);
      return "action_changed";
    }

    const policy = await tryResolveActivePolicy(adapter, app.policyStore, ctx, ctx.tenantId);
    const effective = effectiveApproval(approval, policy);
    if (effective.status === "expired") {
      await update(":hourglass: This approval expired and is denied.").catch(() => undefined);
      // Let the shared core record the fail-safe denial and close the proposal.
      await decideApprovalCore(app, ctx, approval.id, {
        decision: button.decision,
        approverId: approver.approverId,
      }).catch(() => undefined);
      return "expired";
    }
    if (effective.status !== "pending") {
      await update(`This request was already ${effective.status}.`).catch(() => undefined);
      return "already_decided";
    }

    try {
      const result = await decideApprovalCore(app, ctx, approval.id, {
        decision: button.decision,
        approverId: approver.approverId,
        comment: `Decided in Slack by ${slackUser}`,
      });
      const line =
        button.decision === "approved"
          ? `:white_check_mark: Approved by <@${slackUser}>.` +
            (result.execution ? ` Execution: ${result.execution.status}.` : " Recorded; nothing executed in this mode.")
          : `:x: Rejected by <@${slackUser}>.`;
      await update(line).catch(() => undefined);
      return button.decision;
    } catch (err) {
      log.warn({ approvalId: approval.id, err: (err as Error).name }, "slack approval decision failed");
      await reply("The decision could not be applied. Check the OSAS console.");
      return "error";
    }
  }

  return { notify, handleInteraction };
}
