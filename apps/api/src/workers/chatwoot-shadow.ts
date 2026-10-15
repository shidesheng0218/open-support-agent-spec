import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SupportAdapter, ToolContext } from "@osas/adapter";
import type { ChatwootAdapter } from "@osas/chatwoot-adapter";
import { caseIdForConversation } from "@osas/chatwoot-adapter";
import type { ActionProposal, ActionType, Money } from "@osas/core";
import { ACTION_TYPES, ACTION_TYPE_PROFILE, detectInjection } from "@osas/core";
import type { Connection, GovernanceStores, IntegrationEventIntake, JobHandler } from "@osas/governance";
import { BudgetExceededError } from "@osas/model-gateway";
import { evaluateProposal } from "@osas/policy-engine";
import { planShadowRun } from "@osas/ecommerce-shadow";
import { audit, resolveActivePolicy } from "../domain.js";
import { recordModelCall } from "../routes/chat.js";
import { composeInjectionNote, composeShadowNote } from "./shadow-note.js";
import { isOrderAction, lookupOrderEvidence, type OrderLookup, type ShopifyEvidenceDeps } from "./shopify-evidence.js";

/**
 * Chatwoot shadow worker (phase 1).
 *
 * For each verified `chatwoot.message_created` / `conversation_created` event:
 * read the recent customer messages, ask the model for a proposal, evaluate it
 * with the deterministic policy engine, record a ShadowRun and write ONE
 * private note back into the conversation.
 *
 * Hard limits, by construction:
 * - Shadow only. Nothing is executed and no proposal is ever marked executed.
 * - Chatwoot holds no order data, so by default the worker attaches NO evidence
 *   and a financial proposal comes back blocked with INSUFFICIENT_EVIDENCE.
 *   With an optional read-only Shopify client (see shopify-evidence.ts) it
 *   attaches order evidence, but only for an order whose email matches the
 *   Chatwoot contact. The conversation itself never counts as evidence.
 * - The worker principal holds `draft` only.
 * - The note carries ids, the action and policy reasons, never message text.
 */

const SUPPORTED_TOPICS = new Set(["chatwoot.message_created", "chatwoot.conversation_created"]);

export const SHADOW_WORKER_PRINCIPAL = {
  actorType: "system" as const,
  actorId: "osas-shadow-worker",
  permission: "draft" as const,
};

export interface ChatwootShadowDeps {
  /** Lazy: the app is still being assembled when governance is built. */
  app: () => FastifyInstance;
  intake: IntegrationEventIntake;
  /** Resolve the Chatwoot client for a connection; undefined = not configured. */
  chatwootFor: (connection: Connection) => ChatwootAdapter | undefined;
  /** Optional read-only Shopify source for order evidence. */
  shopify?: ShopifyEvidenceDeps;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseMoney(v: unknown): Money | undefined {
  if (!isRecord(v)) return undefined;
  const { currency, minorUnits } = v;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return undefined;
  if (typeof minorUnits !== "number" || !Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    return undefined;
  }
  return { currency, minorUnits };
}

type DraftProposal = Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">;

/**
 * Turn untrusted model output into a proposal draft, or undefined. Only the
 * action, reason, params and amount are taken from the model; scope, profile,
 * permission, evidence and idempotency are decided here.
 */
export function draftFromModel(
  parsed: unknown,
  scope: { tenantId: string; caseId: string; eventId: string; provider: string; model: string },
): DraftProposal | undefined {
  if (!isRecord(parsed) || typeof parsed.actionType !== "string") return undefined;
  if (!(ACTION_TYPES as readonly string[]).includes(parsed.actionType)) return undefined;
  const actionType = parsed.actionType as ActionType;
  const amount = parseMoney(parsed.amount);
  return {
    tenantId: scope.tenantId,
    caseId: scope.caseId,
    profile: ACTION_TYPE_PROFILE[actionType],
    actionType,
    reasonCode: typeof parsed.reasonCode === "string" && parsed.reasonCode ? parsed.reasonCode : "other",
    params: isRecord(parsed.params) ? parsed.params : {},
    requestedPermission: "request-approval",
    requestedBy: {
      actorType: "model",
      actorId: scope.provider,
      model: { provider: scope.provider, model: scope.model },
    },
    ...(amount ? { amount } : {}),
    evidenceIds: [],
    idempotencyKey: `idem_cw_${scope.eventId}`,
  };
}

/** Carries a stable code so the job runner records it as the failure code. */
export class ShadowWorkerError extends Error {
  override name = "ShadowWorkerError";
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createChatwootShadowHandler(deps: ChatwootShadowDeps): JobHandler {
  return async (job, hctx) => {
    const eventId = job.input.eventId;
    if (typeof eventId !== "string") {
      throw new ShadowWorkerError("MISSING_EVENT_ID", "integration_event.process job is missing input.eventId");
    }
    const tenantId = job.tenantId;
    await deps.intake.markProcessing(tenantId, eventId);
    try {
      const result = await processEvent(deps, hctx.stores, tenantId, eventId);
      await deps.intake.markProcessed(tenantId, eventId);
      return { eventId, ...result };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      await deps.intake
        .markFailed(tenantId, eventId, {
          code: typeof code === "string" ? code : "SHADOW_WORKER_FAILED",
          message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        })
        .catch(() => undefined);
      throw err;
    }
  };
}

async function processEvent(
  deps: ChatwootShadowDeps,
  stores: GovernanceStores,
  tenantId: string,
  eventId: string,
): Promise<Record<string, unknown>> {
  const event = await stores.integrationEvents.get(tenantId, eventId);
  if (!event) throw new ShadowWorkerError("EVENT_NOT_FOUND", `integration event ${eventId} not found`);
  if (!SUPPORTED_TOPICS.has(event.topic)) return { outcome: "ignored", reason: "unsupported_topic" };

  const conversationId = event.payload?.conversationId;
  if (typeof conversationId !== "string" || !/^\d+$/.test(conversationId)) {
    throw new ShadowWorkerError("BAD_EVENT_PAYLOAD", "event payload has no valid conversationId");
  }
  const connection = await stores.connections.get(tenantId, event.connectionId);
  if (!connection || connection.status !== "active") {
    return { outcome: "skipped", reason: "connection_not_active" };
  }
  const chatwoot = deps.chatwootFor(connection);
  if (!chatwoot) {
    throw new ShadowWorkerError(
      "CHATWOOT_NOT_CONFIGURED",
      "no Chatwoot client is configured for this connection's account; failing closed",
    );
  }

  const app = deps.app();
  const adapter: SupportAdapter = app.adapter;
  const ctx: ToolContext = { tenantId, principal: SHADOW_WORKER_PRINCIPAL };
  const caseId = caseIdForConversation(conversationId);
  const writeNote = (body: string) =>
    chatwoot.createCaseNote(ctx, { caseId, body, idempotencyKey: `osas_note_${eventId}` });

  const messages = await chatwoot.getRecentCustomerMessages(ctx, caseId, 3);
  if (messages.length === 0) return { outcome: "ignored", reason: "no_customer_message" };
  const text = messages.map((m) => m.content).join("\n");

  // Injection is screened before any model sees the text.
  if (detectInjection(text)) {
    await audit(
      adapter,
      ctx,
      {
        caseId,
        eventType: "prompt_injection_blocked",
        actorType: "system",
        actorId: SHADOW_WORKER_PRINCIPAL.actorId,
        detail: { eventId, source: "chatwoot" },
      },
      app.auditStore,
    );
    await writeNote(composeInjectionNote(eventId));
    return { outcome: "injection_blocked" };
  }

  const kase = await chatwoot.getCase(ctx, caseId);
  const customer = await chatwoot.getCustomer(ctx, kase.customerId);
  const modelMessages = [
    {
      role: "system" as const,
      content: JSON.stringify({ tenantId, caseId, profile: "core", source: "chatwoot" }),
    },
    { role: "user" as const, content: text },
  ];

  let classification;
  let response;
  try {
    classification = await app.gateway.complete({
      tier: "classify",
      task: "classify",
      messages: modelMessages,
      caseId,
      tenantId,
    });
    await recordModelCall(adapter, ctx, app.usageStore, app.auditStore, caseId, classification.telemetry);
    response = await app.gateway.complete({
      tier: "standard",
      task: "propose",
      messages: modelMessages,
      caseId,
      tenantId,
    });
    await recordModelCall(adapter, ctx, app.usageStore, app.auditStore, caseId, response.telemetry);
  } catch (err) {
    if (err instanceof BudgetExceededError || (err as { name?: string }).name === "BudgetExceededError") {
      await audit(
        adapter,
        ctx,
        {
          caseId,
          eventType: "budget_exceeded",
          actorType: "system",
          actorId: SHADOW_WORKER_PRINCIPAL.actorId,
          detail: { eventId },
        },
        app.auditStore,
      );
      await writeNote(`[OSAS shadow] No suggestion: automation budget reached.\nRefs: event ${eventId}`);
      return { outcome: "budget_exceeded" };
    }
    throw new ShadowWorkerError("MODEL_CALL_FAILED", err instanceof Error ? err.message : String(err));
  }

  const draft = draftFromModel(response.parsed, {
    tenantId,
    caseId,
    eventId,
    provider: response.telemetry.provider,
    model: response.telemetry.model,
  });
  // A plain-text answer means the model found no actionable request. Say nothing:
  // a note on every chat message would bury the ones that matter.
  if (!draft) return { outcome: "no_action" };

  let lookup: OrderLookup | undefined;
  if (deps.shopify && isOrderAction(draft.actionType)) {
    lookup = await lookupOrderEvidence(deps.shopify, stores, adapter, ctx, {
      orderIdParam: draft.params.orderId,
      customer,
      caseId,
    });
    if (lookup.checked) draft.evidenceIds = lookup.evidence.map((e) => e.id);
  }

  const proposal = await adapter.createActionProposal(ctx, draft);
  await audit(
    adapter,
    ctx,
    {
      caseId,
      proposalId: proposal.id,
      eventType: "proposal_created",
      actorType: "model",
      actorId: response.telemetry.provider,
      detail: { actionType: proposal.actionType, source: "chatwoot", eventId },
    },
    app.auditStore,
  );

  // Evaluate directly: the case and customer live in Chatwoot, not in the
  // adapter that stores proposals, so runEvaluation's getCase would not resolve.
  const policy = await resolveActivePolicy(adapter, app.policyStore, ctx, tenantId);
  const recentProposals = await adapter.listProposals(ctx, { caseId });
  const decision = evaluateProposal(proposal, {
    customer,
    evidence: lookup?.checked ? lookup.evidence : [],
    policy,
    recentProposals,
    injectionSuspected: detectInjection(JSON.stringify(proposal.params ?? {})),
  });
  const run = planShadowRun(proposal, decision, { id: `shadow_${randomUUID()}` });
  await app.shadowRunStore.create(run);
  await audit(
    adapter,
    ctx,
    {
      caseId,
      proposalId: proposal.id,
      eventType: "shadow_run_created",
      actorType: "policy_engine",
      actorId: SHADOW_WORKER_PRINCIPAL.actorId,
      policyVersion: decision.policyVersion,
      detail: {
        shadowRunId: run.id,
        decision: decision.decision,
        reasons: decision.reasons,
        wouldAutoExecute: run.wouldAutoExecute,
        eventId,
        ...(lookup ? { orderLookup: lookup.checked ? "checked" : lookup.reason } : {}),
      },
    },
    app.auditStore,
  );

  await writeNote(
    composeShadowNote({
      proposal,
      decision,
      run,
      evidenceSummary: lookup ? lookup.summary : "none attached (Chatwoot holds no order data)",
      orderChecked: lookup?.checked === true,
    }),
  );
  return {
    outcome: "suggested",
    proposalId: proposal.id,
    shadowRunId: run.id,
    decision: decision.decision,
    wouldAutoExecute: run.wouldAutoExecute,
  };
}
