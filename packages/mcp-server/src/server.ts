import {
  AdapterNotFoundError,
  AdapterPermissionError,
  requirePermission,
  type Principal,
  type SupportAdapter,
  type ToolContext,
} from "@osas/adapter";
import type { ActionProposal } from "@osas/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tool-definitions.js";

type Args = Record<string, unknown>;

type ProposalInput = Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">;

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing or invalid required argument "${field}"`);
  }
  return value;
};

/** Build a `proposed`-bound proposal input per CONTRACTS.md §7 (never executes). */
function proposalInput(
  ctx: ToolContext,
  principal: Principal,
  args: Args,
  fields: { profile: ProposalInput["profile"]; actionType: ProposalInput["actionType"]; params: Record<string, unknown> },
): ProposalInput {
  return {
    tenantId: ctx.tenantId,
    caseId: asString(args.caseId, "caseId"),
    profile: fields.profile,
    actionType: fields.actionType,
    reasonCode: typeof args.reasonCode === "string" && args.reasonCode ? args.reasonCode : "other",
    params: fields.params,
    requestedPermission: "request-approval",
    requestedBy: { actorType: principal.actorType, actorId: principal.actorId },
    ...(args.amount !== undefined ? { amount: args.amount as ProposalInput["amount"] } : {}),
    evidenceIds: Array.isArray(args.evidenceIds) ? (args.evidenceIds as string[]) : [],
    idempotencyKey: asString(args.idempotencyKey, "idempotencyKey"),
  };
}

async function invoke(
  def: ToolDefinition,
  adapter: SupportAdapter,
  ctx: ToolContext,
  principal: Principal,
  args: Args,
): Promise<unknown> {
  // Proposal-shortcut tools (CONTRACTS.md §7): build an ActionProposal via
  // createActionProposal; they never execute.
  switch (def.name) {
    case "osas_core_create_action_proposal":
      return adapter.createActionProposal(
        ctx,
        proposalInput(ctx, principal, args, {
          profile: asString(args.profile, "profile") as ProposalInput["profile"],
          actionType: asString(args.actionType, "actionType") as ProposalInput["actionType"],
          params: (args.params ?? {}) as Record<string, unknown>,
        }),
      );
    case "osas_saas_create_credit_request":
      return adapter.createActionProposal(
        ctx,
        proposalInput(ctx, principal, args, {
          profile: "saas",
          actionType: "credit_apply",
          params: { customerId: asString(args.customerId, "customerId") },
        }),
      );
    case "osas_saas_create_cancellation_request":
      return adapter.createActionProposal(
        ctx,
        proposalInput(ctx, principal, args, {
          profile: "saas",
          actionType: "subscription_cancel",
          params: { subscriptionId: asString(args.subscriptionId, "subscriptionId") },
        }),
      );
    case "osas_saas_create_plan_change_request":
      return adapter.createActionProposal(
        ctx,
        proposalInput(ctx, principal, args, {
          profile: "saas",
          actionType: "plan_change",
          params: {
            subscriptionId: asString(args.subscriptionId, "subscriptionId"),
            newPlan: asString(args.newPlan, "newPlan"),
          },
        }),
      );
    default:
      break;
  }

  switch (def.adapterMethod) {
    case "getCase":
      return adapter.getCase(ctx, asString(args.id, "id"));
    case "searchCases":
      return adapter.searchCases(ctx, {
        ...(args.customerId !== undefined ? { customerId: asString(args.customerId, "customerId") } : {}),
        ...(args.status !== undefined ? { status: args.status as never } : {}),
        ...(args.q !== undefined ? { q: asString(args.q, "q") } : {}),
      });
    case "getCustomer":
      return adapter.getCustomer(ctx, asString(args.id, "id"));
    case "searchKnowledge":
      return adapter.searchKnowledge(ctx, {
        q: asString(args.q, "q"),
        ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
      });
    case "createCaseNote":
      return adapter.createCaseNote(ctx, {
        caseId: asString(args.caseId, "caseId"),
        body: asString(args.body, "body"),
        ...(Array.isArray(args.evidenceIds) ? { evidenceIds: args.evidenceIds as string[] } : {}),
        idempotencyKey: asString(args.idempotencyKey, "idempotencyKey"),
      });
    case "createEscalation":
      return adapter.createEscalation(ctx, {
        caseId: asString(args.caseId, "caseId"),
        reason: asString(args.reason, "reason"),
        idempotencyKey: asString(args.idempotencyKey, "idempotencyKey"),
      });
    case "getOrder":
      return adapter.getOrder(ctx, asString(args.id, "id"));
    case "listOrders":
      return adapter.listOrders(ctx, asString(args.customerId, "customerId"));
    case "getShipment":
      return adapter.getShipment(ctx, asString(args.id, "id"));
    case "getSubscription":
      return adapter.getSubscription(ctx, asString(args.id, "id"));
    case "listInvoices":
      return adapter.listInvoices(ctx, asString(args.customerId, "customerId"));
    case "getCreditBalance":
      return adapter.getCreditBalance(ctx, asString(args.customerId, "customerId"));
    default:
      throw new Error(`Tool ${def.name} has no dispatch for adapter method ${def.adapterMethod}`);
  }
}

/**
 * Build an MCP server exposing the 16 OSAS tools (CONTRACTS.md §7) backed by
 * the given SupportAdapter. `executeAction` is deliberately NEVER registered
 * as a tool — execution belongs to the policy engine/API only.
 *
 * Registration uses the SDK's McpServer with handlers on its underlying Server
 * so tool input schemas stay plain JSON Schema (the repo is Ajv-only, no zod).
 */
export function buildMcpServer(adapter: SupportAdapter, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "osas-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const low = server.server;

  low.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema as { type: "object" },
    })),
  }));

  low.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === request.params.name);
    if (!def) {
      return {
        content: [{ type: "text" as const, text: `UNKNOWN_TOOL: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      requirePermission(principal, def.permissionRequired);
      const ctx: ToolContext = {
        tenantId:
          typeof request.params.arguments?.tenantId === "string"
            ? request.params.arguments.tenantId
            : "tenant_demo",
        principal,
      };
      const result = await invoke(def, adapter, ctx, principal, request.params.arguments ?? {});
      const structuredContent =
        typeof result === "object" && result !== null && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { items: result };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent,
      };
    } catch (err) {
      if (err instanceof AdapterNotFoundError || err instanceof AdapterPermissionError) {
        return {
          content: [{ type: "text" as const, text: `${err.code}: ${err.message}` }],
          isError: true,
        };
      }
      throw err;
    }
  });

  return server;
}
