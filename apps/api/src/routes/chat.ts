import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireAdapterCapability, type SupportAdapter, type ToolContext } from "@osas/adapter";
import type { ActionProposal, Case, Profile } from "@osas/core";
import { detectInjection, FINANCIAL_ACTION_TYPES } from "@osas/core";
import { BudgetExceededError } from "@osas/model-gateway";
import type { ModelTelemetry, UsageStore } from "@osas/model-gateway";
import { SchemaInvalidError } from "../plugins.js";
import type { AuditSink } from "../domain.js";
import { audit, resolveActivePolicy, runEvaluation, runExecution } from "../domain.js";
import { ctxFor } from "./basic.js";

// §8/Milestone 2: every model call is persisted to the UsageStore and the
// audit stream. costUsd is omitted entirely when unknown — never fabricated.
async function recordModelCall(
  adapter: SupportAdapter,
  ctx: ToolContext,
  usageStore: UsageStore,
  sink: AuditSink | undefined,
  caseId: string | undefined,
  telemetry: ModelTelemetry,
): Promise<void> {
  await usageStore.record({
    tenantId: ctx.tenantId,
    ...(caseId ? { caseId } : {}),
    provider: telemetry.provider,
    model: telemetry.model,
    tier: telemetry.tier,
    task: telemetry.task,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    latencyMs: telemetry.latencyMs,
    ...(telemetry.costUsd !== undefined ? { costUsd: telemetry.costUsd } : {}),
    truncated: telemetry.truncated,
    createdAt: new Date().toISOString(),
  });
  await audit(adapter, ctx, {
    caseId,
    eventType: "model_call_recorded",
    actorType: "model",
    actorId: telemetry.provider,
    modelInfo: {
      provider: telemetry.provider,
      model: telemetry.model,
      tier: telemetry.tier,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      latencyMs: telemetry.latencyMs,
      ...(telemetry.costUsd !== undefined ? { costUsd: telemetry.costUsd } : {}),
    },
    detail: { task: telemetry.task, truncated: telemetry.truncated },
  }, sink);
}

// A real agent gathers evidence via tools before proposing; the mock provider
// cannot, so the API captures fresh evidence for the referenced record.
async function captureProposalEvidence(
  adapter: SupportAdapter,
  ctx: ToolContext,
  input: { caseId: string; params: Record<string, unknown> },
): Promise<string[]> {
  const params = input.params;
  const capture = async (
    kind: "order" | "subscription" | "other",
    recordType: string,
    recordId: string,
    data: object,
    summary: string,
  ): Promise<string> => {
    const ev = await adapter.captureEvidence(ctx, {
      tenantId: ctx.tenantId,
      caseId: input.caseId,
      kind,
      source: { system: "osas-api", recordType, recordId },
      summary,
      data: data as Record<string, unknown>,
      retrievedAt: new Date().toISOString(),
    });
    return ev.id;
  };
  try {
    if (typeof params.orderId === "string") {
      const order = await adapter.getOrder(ctx, params.orderId);
      return [
        await capture("order", "order", order.id, order, `Order ${order.id} status=${order.status}`),
      ];
    }
    if (typeof params.subscriptionId === "string") {
      const sub = await adapter.getSubscription(ctx, params.subscriptionId);
      return [
        await capture(
          "subscription",
          "subscription",
          sub.id,
          sub,
          `Subscription ${sub.id} status=${sub.status}`,
        ),
      ];
    }
    if (typeof params.customerId === "string") {
      const balance = await adapter.getCreditBalance(ctx, params.customerId);
      return [
        await capture(
          "other",
          "credit-balance",
          balance.id,
          balance,
          `Credit balance for ${params.customerId}`,
        ),
      ];
    }
  } catch {
    // record not retrievable — the policy engine will decide on empty evidence
  }
  return [];
}

interface ChatBody {
  caseId?: string;
  message?: string;
  profile?: Profile;
}

function composeReply(decision: string, replayed: boolean): string {
  if (decision === "auto_execute") {
    return replayed
      ? "This request was already completed earlier — no duplicate action was taken."
      : "Done — I processed your request automatically.";
  }
  if (decision === "require_approval") {
    return "I've prepared this action, but it needs human approval. An agent will review it shortly.";
  }
  return "I'm unable to process this request automatically and have handed it off to a human agent.";
}

async function buildModelContext(
  adapter: SupportAdapter,
  ctx: ToolContext,
  body: Required<Pick<ChatBody, "message">> & ChatBody,
): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    caseId: body.caseId,
    profile: body.profile,
  };
  if (!body.caseId) return context;
  try {
    const kase: Case = await adapter.getCase(ctx, body.caseId);
    context.customerId = kase.customerId;
    context.profile = kase.profile;
    context.evidenceIds = kase.evidenceIds;
    if (kase.profile === "ecommerce") {
      const orders = await adapter.listOrders(ctx, kase.customerId).catch(() => []);
      context.orderIds = orders.map((o) => o.id);
    }
  } catch {
    // unknown case — the mock provider still parses IDs from the message text
  }
  return context;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  app.post("/v1/chat", async (req) => {
    const ctx = ctxFor(req);
    const body = (req.body ?? {}) as ChatBody;
    if (!body.message || typeof body.message !== "string") {
      throw new SchemaInvalidError([{ message: "body must be { caseId?, message: string, profile? }" }]);
    }
    const message = body.message;

    // §8: injection in the user message -> block + handoff, never call the policy engine.
    if (detectInjection(message)) {
      let handoff;
      if (body.caseId) {
        handoff = await adapter.createHandoff(ctx, {
          tenantId: ctx.tenantId,
          caseId: body.caseId,
          reason: "prompt_injection_suspected",
          notes: `Blocked injected message: ${message.slice(0, 200)}`,
        });
        await audit(adapter, ctx, {
          caseId: body.caseId,
          eventType: "handoff_created",
          actorType: "system",
          actorId: "osas-api",
          detail: { handoffId: handoff.id, reason: handoff.reason },
        }, app.auditStore);
      }
      await audit(adapter, ctx, {
        caseId: body.caseId,
        eventType: "prompt_injection_blocked",
        actorType: "system",
        actorId: "osas-api",
        detail: { messagePreview: message.slice(0, 200) },
      }, app.auditStore);
      return {
        reply:
          "I can't act on that message — it looks like a prompt-injection attempt. I've handed this conversation to a human agent.",
        handoff,
      };
    }

    const context = await buildModelContext(adapter, ctx, { ...body, message });
    const messages = [
      { role: "system" as const, content: JSON.stringify(context) },
      { role: "user" as const, content: message },
    ];

    // Milestone 2: provider failure, structured-output failure, or budget
    // exhaustion degrade to a human handoff / safe template — never execute.
    const degrade = async (err: unknown, stage: "classify" | "propose") => {
      const messageText = err instanceof Error ? err.message : String(err);
      if (err instanceof BudgetExceededError || (err as { name?: string }).name === "BudgetExceededError") {
        await audit(adapter, ctx, {
          caseId: body.caseId,
          eventType: "budget_exceeded",
          actorType: "system",
          actorId: "osas-api",
          detail: { stage, message: messageText },
        }, app.auditStore);
        return {
          reply:
            "This request can't be processed automatically right now (automation budget reached). A human agent will follow up.",
        };
      }
      let handoff;
      if (body.caseId) {
        handoff = await adapter.createHandoff(ctx, {
          tenantId: ctx.tenantId,
          caseId: body.caseId,
          reason: "other",
          notes: `Model call failed at ${stage}: ${messageText.slice(0, 300)}`,
        });
        await audit(adapter, ctx, {
          caseId: body.caseId,
          eventType: "handoff_created",
          actorType: "system",
          actorId: "osas-api",
          detail: { handoffId: handoff.id, reason: handoff.reason, stage },
        }, app.auditStore);
      }
      return {
        reply:
          "I'm unable to process this automatically at the moment, so I've handed your request to a human agent.",
        ...(handoff ? { handoff } : {}),
      };
    };

    // §8 flow: classify first, then propose (the mock replies with plain text
    // when the message maps to no action scenario).
    let classification;
    try {
      classification = await app.gateway.complete({
        tier: "classify",
        task: "classify",
        messages,
        caseId: body.caseId,
        tenantId: ctx.tenantId,
      });
    } catch (err) {
      return degrade(err, "classify");
    }
    await recordModelCall(adapter, ctx, app.usageStore, app.auditStore, body.caseId, classification.telemetry);

    let response;
    try {
      response = await app.gateway.complete({
        tier: "standard",
        task: "propose",
        messages,
        caseId: body.caseId,
        tenantId: ctx.tenantId,
      });
    } catch (err) {
      return degrade(err, "propose");
    }
    await recordModelCall(adapter, ctx, app.usageStore, app.auditStore, body.caseId, response.telemetry);
    const telemetry: ModelTelemetry = response.telemetry;

    const parsed = response.parsed as Partial<ActionProposal> | undefined;
    if (!parsed || typeof parsed !== "object" || !parsed.actionType) {
      return { reply: response.text, classification: classification.text };
    }

    // Persist the model-drafted proposal, then evaluate (and maybe execute) per §4/§5.
    const input = {
      tenantId: ctx.tenantId,
      caseId: parsed.caseId ?? body.caseId,
      profile: parsed.profile ?? body.profile ?? context.profile,
      actionType: parsed.actionType,
      reasonCode: parsed.reasonCode ?? "other",
      params: parsed.params ?? {},
      requestedPermission: parsed.requestedPermission ?? "request-approval",
      requestedBy: {
        actorType: "model",
        actorId: telemetry.provider,
        model: { provider: telemetry.provider, model: telemetry.model },
      },
      amount: parsed.amount,
      // The mock provider emits evidenceIds: []; fall back to the case's
      // evidence, then to freshly captured evidence for the referenced record,
      // so financial proposals can pass §4 evidence checks.
      evidenceIds:
        parsed.evidenceIds && parsed.evidenceIds.length > 0
          ? parsed.evidenceIds
          : ((context.evidenceIds as string[] | undefined) ?? []),
      idempotencyKey: parsed.idempotencyKey ?? `idem_chat_${randomUUID()}`,
    } as Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">;

    if (!input.caseId || !input.profile) {
      return { reply: response.text, classification: classification.text };
    }

    if (
      input.evidenceIds.length === 0 &&
      (FINANCIAL_ACTION_TYPES as readonly string[]).includes(input.actionType)
    ) {
      input.evidenceIds = await captureProposalEvidence(adapter, ctx, input);
    }

    await requireAdapterCapability(adapter, ctx, "proposal.write");
    const proposal = await adapter.createActionProposal(ctx, input);
    await audit(adapter, ctx, {
      caseId: proposal.caseId,
      proposalId: proposal.id,
      eventType: "proposal_created",
      actorType: "model",
      actorId: telemetry.provider,
      detail: { actionType: proposal.actionType, source: "chat" },
    }, app.auditStore);

    const evaluation = await runEvaluation(adapter, ctx, proposal, {
      injectionSuspected: detectInjection(JSON.stringify(proposal.params ?? {})),
      policy: await resolveActivePolicy(adapter, app.policyStore, ctx, ctx.tenantId),
      sink: app.auditStore,
    });

    let execution;
    if (evaluation.decision.decision === "auto_execute") {
      execution = await runExecution(adapter, ctx, app.executionStore, evaluation.proposal, {
        sink: app.auditStore,
        ...(app.pgPool ? { pgPool: app.pgPool } : {}),
      });
    }

    return {
      reply: composeReply(evaluation.decision.decision, Boolean(execution?.replayed)),
      proposal: execution?.proposal ?? evaluation.proposal,
      decision: evaluation.decision,
      execution,
      handoff: evaluation.handoffs[0],
    };
  });
}
