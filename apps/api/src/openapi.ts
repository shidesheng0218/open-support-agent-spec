/**
 * GET /v1/openapi.json — an OpenAPI 3.1 description of the stable v1 HTTP
 * surface, for REST integrators who do not use MCP.
 *
 * Zero-drift design: components.schemas are loaded from the authoritative
 * schemas/ manifest at request time (the same source the validator uses) —
 * they are never hand-copied. Relative $refs to common.json are rewritten to
 * internal component refs. Path items are declarative and stable API
 * contracts; when the HTTP surface grows, add the path here.
 */
import { listSchemas, loadSchema } from "@osas/schema-validator";
import { API_VERSION, SPEC_VERSION } from "./plugins.js";

const componentKey = (name: string): string => name.replaceAll("/", ".");

/** Rewrite file-relative $refs (./common.json#/..., ../../core/common.json#/...)
 * to internal OpenAPI component refs; keep in-document refs (#/$defs/...) as-is. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && /common\.json#/.test(v)) {
        out[k] = v.replace(/^.*common\.json#\//, "#/components/schemas/core.common/");
      } else {
        out[k] = rewriteRefs(v);
      }
    }
    return out;
  }
  return node;
}

function buildComponents(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const entry of listSchemas()) {
    if (!entry.name.startsWith("core/") && !entry.name.startsWith("profiles/")) continue;
    schemas[componentKey(entry.name)] = rewriteRefs(loadSchema(entry.name));
  }
  schemas.Error = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", description: "Machine-readable error code" },
          message: { type: "string" },
          details: {},
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
  return { schemas };
}

const ref = (schemaName: string) => ({ $ref: `#/components/schemas/${componentKey(schemaName)}` });
const ERROR_REF = { $ref: "#/components/schemas/Error" };

const jsonContent = (schema: unknown) => ({ "application/json": { schema } });
const ok = (description: string, schema?: unknown) => ({
  description,
  ...(schema ? { content: jsonContent(schema) } : {}),
});
const err = (code: number, description: string) => [
  String(code),
  { description, content: jsonContent(ERROR_REF) },
];
const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const queryParam = (name: string, description: string, extra: Record<string, unknown> = {}) => ({
  name,
  in: "query",
  required: false,
  schema: { type: "string", ...extra },
  description,
});

/** Request body for POST /v1/proposals: the authoritative proposal schema
 * minus server-assigned fields and its required list (the API accepts the
 * client-owned subset), with refs rewritten for component embedding. */
function proposalCreateSchema(): Record<string, unknown> {
  const s = rewriteRefs(loadSchema("core/action-proposal")) as Record<string, unknown>;
  delete s.$schema;
  delete s.$id;
  delete s.title;
  delete s.required;
  s.description =
    "ActionProposal without id/specVersion/status/createdAt/updatedAt (server-assigned). " +
    "Validated against core/action-proposal semantics; invalid payloads are 422 SCHEMA_INVALID and never execute.";
  return s;
}

/** One operation object with OSAS defaults applied. */
function op(
  tags: string[],
  summary: string,
  responses: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { tags, summary, responses, ...extras };
}

function buildPaths(): Record<string, unknown> {
  const arr = (items: unknown) => ({ type: "array", items });
  const proposalsByCase = queryParam("caseId", "Filter by case");
  return {
    "/health": {
      get: op(["meta"], "Liveness probe", {
        "200": ok("Service is healthy", {
          type: "object",
          properties: {
            status: { const: "ok" },
            specVersion: { const: SPEC_VERSION },
            version: { type: "string" },
          },
        }),
      }),
    },
    "/.well-known/osas": {
      get: op(["meta"], "Discovery document", { "200": ok("Spec version, capabilities, endpoints") }),
    },
    "/v1/openapi.json": {
      get: op(["meta"], "This OpenAPI 3.1 document", { "200": ok("OpenAPI document") }),
    },
    "/v1/capabilities": {
      get: op(["meta"], "CapabilityManifest of this implementation", {
        "200": ok("The declared capability manifest", ref("core/capability-manifest")),
        ...Object.fromEntries([err(404, "CAPABILITIES_NOT_DECLARED when undeclared")]),
      }),
    },
    "/v1/meta/tools": {
      get: op(["meta"], "The 20 MCP tool definitions (pure data)", { "200": ok("TOOL_DEFINITIONS") }),
    },
    "/v1/schemas": {
      get: op(["meta"], "Schema manifest", { "200": ok("Schema manifest") }),
    },
    "/v1/schemas/{name}": {
      get: op(["meta"], "One authoritative JSON Schema by name", {
        "200": ok("The schema document"),
        ...Object.fromEntries([err(404, "Unknown schema")]),
      }, { parameters: [pathParam("name", "Schema name, e.g. core/action-proposal")] }),
    },
    "/v1/validate": {
      post: op(["meta"], "Validate data against a named schema (dry run)", {
        "200": ok("Validation result", {
          type: "object",
          properties: { valid: { type: "boolean" }, errors: { type: "array" } },
        }),
      }, {
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["schemaName", "data"],
            properties: { schemaName: { type: "string" }, data: {} },
          }),
        },
      }),
    },
    "/v1/compat/report": {
      get: op(["meta"], "Latest white-box compat report (404 until generated)", {
        "200": ok("Machine-readable compat report"),
        ...Object.fromEntries([err(404, "Report not generated yet")]),
      }),
    },
    "/v1/cases": {
      get: op(["cases"], "Search cases", {
        "200": ok("Matching cases", arr(ref("core/case"))),
      }, {
        parameters: [
          queryParam("status", "Filter by CaseStatus"),
          queryParam("customerId", "Filter by customer"),
          queryParam("profile", "Filter by profile", { enum: ["core", "ecommerce", "saas"] }),
          queryParam("q", "Free-text search"),
        ],
      }),
    },
    "/v1/cases/{id}": {
      get: op(["cases"], "Case detail with customer and evidence", {
        "200": ok("Case bundle"),
        ...Object.fromEntries([err(404, "Case not found")]),
      }, { parameters: [pathParam("id", "Case id")] }),
    },
    "/v1/customers/{id}": {
      get: op(["cases"], "Customer detail", {
        "200": ok("The customer", ref("core/customer")),
        ...Object.fromEntries([err(404, "Customer not found")]),
      }, { parameters: [pathParam("id", "Customer id")] }),
    },
    "/v1/proposals": {
      get: op(["proposals"], "List action proposals", {
        "200": ok("Proposals", arr(ref("core/action-proposal"))),
      }, { parameters: [proposalsByCase, queryParam("status", "Filter by ProposalStatus")] }),
      post: op(["proposals"], "Create an action proposal (idempotent by idempotencyKey)", {
        "201": ok("Created proposal", ref("core/action-proposal")),
        "200": ok("Identical replay of an existing proposal", ref("core/action-proposal")),
        ...Object.fromEntries([
          err(409, "Idempotency key reused with different content"),
          err(422, "SCHEMA_INVALID"),
        ]),
      }, {
        requestBody: {
          required: true,
          content: jsonContent(proposalCreateSchema()),
        },
      }),
    },
    "/v1/proposals/{id}": {
      get: op(["proposals"], "Get one proposal", {
        "200": ok("The proposal", ref("core/action-proposal")),
        ...Object.fromEntries([err(404, "Not found")]),
      }, { parameters: [pathParam("id", "Proposal id")] }),
    },
    "/v1/proposals/{id}/evaluate": {
      post: op(["proposals"], "Run deterministic policy evaluation (spec section 5)", {
        "200": ok("Proposal plus its PolicyDecision"),
      }, { parameters: [pathParam("id", "Proposal id")] }),
    },
    "/v1/proposals/{id}/execute": {
      post: op(["proposals"], "Execute an approved proposal (idempotent; never for ShadowRun proposals)", {
        "200": ok("Execution result; replays return the stored result"),
        ...Object.fromEntries([err(409, "Not approved / has ShadowRun / ACTION_BINDING_MISMATCH")]),
      }, { parameters: [pathParam("id", "Proposal id")] }),
    },
    "/v1/proposals/{id}/reconcile": {
      post: op(["proposals"], "Human-driven reconciliation of an uncertain execution", {
        "200": ok("Updated proposal", ref("core/action-proposal")),
      }, {
        parameters: [pathParam("id", "Proposal id")],
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["outcome"],
            properties: {
              outcome: { enum: ["succeeded", "failed"] },
              note: { type: "string" },
            },
          }),
        },
      }),
    },
    "/v1/proposals/{id}/shadow-run": {
      post: op(["shadow"], "Simulate and record a ShadowRun (never executes)", {
        "201": ok("Created ShadowRun", ref("core/shadow-run")),
      }, { parameters: [pathParam("id", "Proposal id")] }),
    },
    "/v1/approvals": {
      get: op(["approvals"], "List approvals with embedded proposals (effective status)", {
        "200": ok("Approvals", arr(ref("core/approval"))),
      }, { parameters: [queryParam("status", "Filter by status")] }),
    },
    "/v1/approvals/{id}/decide": {
      post: op(["approvals"], "Approve or reject (deny-only after expiry; approved proposals auto-execute)", {
        "200": ok("Decision result; approved proposals execute inline"),
        ...Object.fromEntries([err(409, "APPROVAL_TIMED_OUT")]),
      }, {
        parameters: [pathParam("id", "Approval id")],
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["decision", "approverId"],
            properties: {
              decision: { enum: ["approved", "rejected"] },
              approverId: { type: "string" },
              comment: { type: "string" },
            },
          }),
        },
      }),
    },
    "/v1/handoffs": {
      get: op(["handoffs"], "List human handoffs", {
        "200": ok("Handoffs", arr(ref("core/human-handoff"))),
      }, { parameters: [queryParam("status", "Filter by status")] }),
    },
    "/v1/handoffs/{id}/claim": {
      post: op(["handoffs"], "Claim an open handoff", { "200": ok("Updated handoff", ref("core/human-handoff")) }, {
        parameters: [pathParam("id", "Handoff id")],
        requestBody: { content: jsonContent({ type: "object", properties: { assignee: { type: "string" } } }) },
      }),
    },
    "/v1/handoffs/{id}/resolve": {
      post: op(["handoffs"], "Resolve a handoff", { "200": ok("Updated handoff", ref("core/human-handoff")) }, {
        parameters: [pathParam("id", "Handoff id")],
        requestBody: { content: jsonContent({ type: "object", properties: { notes: { type: "string" } } }) },
      }),
    },
    "/v1/audit": {
      get: op(["audit"], "Query the audit trail", {
        "200": ok("Audit events", arr(ref("core/audit-event"))),
      }, { parameters: [proposalsByCase, queryParam("proposalId", "Filter by proposal")] }),
    },
    "/v1/audit/verify": {
      get: op(["audit"], "Recompute the per-tenant hash chain", {
        "200": ok("{ tenantId, chainLength, intact, firstError? }"),
      }),
    },
    "/v1/policies/{tenantId}": {
      get: op(["policies"], "Active TenantPolicy for a tenant", {
        "200": ok("Active policy", ref("core/tenant-policy")),
        ...Object.fromEntries([err(403, "TENANT_MISMATCH")]),
      }, { parameters: [pathParam("tenantId", "Tenant id")] }),
      put: op(["policies"], "Always 409 POLICY_IMMUTABLE — use the version lifecycle", {
        "409": ok("POLICY_IMMUTABLE", ERROR_REF),
      }, { parameters: [pathParam("tenantId", "Tenant id")] }),
    },
    "/v1/policies/{tenantId}/versions": {
      get: op(["policies"], "Policy version records (draft → simulated → approved → active → retired)", {
        "200": ok("Version records"),
      }, { parameters: [pathParam("tenantId", "Tenant id")] }),
    },
    "/v1/policies/{tenantId}/drafts": {
      post: op(["policies"], "Create a policy draft (policy_admin)", {
        "201": ok("Created draft"),
        ...Object.fromEntries([err(403, "POLICY_ADMIN_REQUIRED / TENANT_MISMATCH")]),
      }, { parameters: [pathParam("tenantId", "Tenant id")] }),
    },
    "/v1/policies/{tenantId}/simulate": {
      post: op(["policies"], "Pure policy simulation against a version (no side effects)", {
        "200": ok("Decision plus policyVersion"),
        ...Object.fromEntries([err(404, "Unknown version")]),
      }, { parameters: [pathParam("tenantId", "Tenant id")] }),
    },
    "/v1/policies/{tenantId}/versions/{version}/approve": {
      post: op(["policies"], "Approve a simulated policy version (policy_admin)", {
        "200": ok("Updated version record"),
        ...Object.fromEntries([err(409, "Illegal lifecycle transition")]),
      }, { parameters: [pathParam("tenantId", "Tenant id"), pathParam("version", "Policy version")] }),
    },
    "/v1/policies/{tenantId}/versions/{version}/activate": {
      post: op(["policies"], "Activate a policy version; retires the previous active one", {
        "200": ok("Updated version record"),
        ...Object.fromEntries([err(409, "Illegal lifecycle transition")]),
      }, { parameters: [pathParam("tenantId", "Tenant id"), pathParam("version", "Policy version")] }),
    },
    "/v1/policies/{tenantId}/versions/{version}/retire": {
      post: op(["policies"], "Retire a policy version", {
        "200": ok("Updated version record"),
        ...Object.fromEntries([err(409, "Illegal lifecycle transition")]),
      }, { parameters: [pathParam("tenantId", "Tenant id"), pathParam("version", "Policy version")] }),
    },
    "/v1/shadow-runs": {
      get: op(["shadow"], "List ShadowRuns with embedded proposal and evidence", {
        "200": ok("ShadowRuns", arr(ref("core/shadow-run"))),
      }),
    },
    "/v1/shadow-runs/metrics": {
      get: op(["shadow"], "Aggregated ShadowMetrics", {
        "200": ok("Shadow metrics", ref("core/shadow-metrics")),
      }, { parameters: [queryParam("periodStart", "ISO date-time"), queryParam("periodEnd", "ISO date-time")] }),
    },
    "/v1/shadow-runs/{id}": {
      get: op(["shadow"], "One ShadowRun with context", {
        "200": ok("ShadowRun", ref("core/shadow-run")),
        ...Object.fromEntries([err(404, "Not found")]),
      }, { parameters: [pathParam("id", "ShadowRun id")] }),
    },
    "/v1/shadow-runs/{id}/review": {
      post: op(["shadow"], "Human review: accepted | rejected | modified (final)", {
        "200": ok("Reviewed ShadowRun", ref("core/shadow-run")),
        ...Object.fromEntries([err(409, "Already reviewed")]),
      }, {
        parameters: [pathParam("id", "ShadowRun id")],
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["outcome"],
            properties: {
              outcome: { enum: ["accepted", "rejected", "modified"] },
              humanComment: { type: "string" },
              externalReference: { type: "string" },
            },
          }),
        },
      }),
    },
    "/v1/chat": {
      post: op(["demo"], "Demo driver: message in, reply + proposal + decision out", {
        "200": ok("Reply with optional proposal/decision/execution/handoff"),
      }, {
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["message"],
            properties: {
              message: { type: "string" },
              caseId: { type: "string" },
              profile: { enum: ["core", "ecommerce", "saas"] },
            },
          }),
        },
      }),
    },
    "/v1/usage": {
      get: op(["meta"], "Model usage records (policy_admin / auditor only)", {
        "200": ok("Usage records plus summary"),
        ...Object.fromEntries([err(403, "Forbidden role / TENANT_MISMATCH")]),
      }, {
        parameters: [
          queryParam("tenantId", "Tenant filter"),
          queryParam("date", "Day filter (YYYY-MM-DD)"),
          queryParam("model", "Model filter"),
          queryParam("task", "Task filter"),
        ],
      }),
    },
    "/v1/executions/{id}": {
      get: op(["controlled-execution"], "Execution attempt plus receipt (v0.3 sandbox)", {
        "200": ok("{ attempt, receipt? }"),
        ...Object.fromEntries([err(404, "Not found")]),
      }, { parameters: [pathParam("id", "Execution attempt id")] }),
    },
    "/v1/reconciliation": {
      get: op(["controlled-execution"], "Open or resolved reconciliation tasks", {
        "200": ok("Reconciliation tasks"),
      }, { parameters: [queryParam("status", "open | resolved", { enum: ["open", "resolved"] })] }),
    },
    "/v1/provider-events": {
      post: op(["controlled-execution"], "Internal provider-event ingestion (server key required; deduped)", {
        "200": ok("{ duplicate, event, proposal?, reconciliation? }"),
        ...Object.fromEntries([err(403, "Missing or wrong provider key")]),
      }),
    },

    /* ---------------- governance control plane (M1) ----------------
     * Provider-neutral: no path or schema here names a vendor. Every route is
     * tenant-scoped to the authenticated principal and gated by the governance
     * RBAC matrix.
     */
    "/v1/governance/health": {
      get: op(["governance"], "Control-plane snapshot: connections, inbox, queue, reconciliations, metering", {
        "200": ok("GovernanceHealth"),
        ...Object.fromEntries([err(403, "Missing governance capability"), err(404, "Workspace not provisioned")]),
      }),
    },
    "/v1/governance/workspaces": {
      post: op(["governance"], "Provision the organization/workspace pair for the caller's tenant (idempotent)", {
        "200": ok("{ organization, workspace, created }"),
        ...Object.fromEntries([err(403, "Requires workspace:write, or a foreign tenantId"), err(422, "SCHEMA_INVALID")]),
      }, {
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["organizationName", "workspaceName"],
            properties: {
              organizationName: { type: "string" },
              workspaceName: { type: "string" },
            },
          }),
        },
      }),
    },
    "/v1/governance/connections": {
      get: op(["governance"], "List this tenant's connections", {
        "200": ok("Connection[]"),
      }, {
        parameters: [
          queryParam("status", "active | paused | revoked | error"),
          queryParam("provider", "Provider key filter"),
        ],
      }),
      post: op(["governance"], "Create a connection; it starts paused until verified", {
        "200": ok("Connection"),
        ...Object.fromEntries([
          err(400, "SECRET_REFUSED when credentialRef looks like a raw secret"),
          err(409, "CONFLICT when a live connection already exists for the account"),
          err(403, "Requires connection:write"),
        ]),
      }, {
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["provider", "externalAccountId", "capabilities"],
            properties: {
              provider: { type: "string", description: "e.g. shopify, zendesk, mock" },
              externalAccountId: { type: "string" },
              capabilities: {
                type: "array",
                items: { type: "string" },
                description: "Dotted ids; write capabilities end in .execute or .write",
              },
              scopes: { type: "array", items: { type: "string" } },
              apiVersion: { type: "string" },
              credentialRef: {
                type: "string",
                description: "Opaque pointer with a scheme (vault:..., env:..., aws-sm:...). Never a credential.",
              },
              displayName: { type: "string" },
            },
          }),
        },
      }),
    },
    "/v1/governance/connections/{id}": {
      get: op(["governance"], "Read one connection", {
        "200": ok("Connection"),
        ...Object.fromEntries([err(404, "Not found in this tenant")]),
      }, { parameters: [pathParam("id", "Connection id")] }),
      delete: op(["governance"], "Delete a connection (must be revoked first)", {
        "204": { description: "Deleted" },
        ...Object.fromEntries([err(409, "CONFLICT when the connection is still live")]),
      }, { parameters: [pathParam("id", "Connection id")] }),
    },
    "/v1/governance/connections/{id}/verify": {
      post: op(["governance"], "Probe the provider; activates only on success", {
        "200": ok("Connection (active on success, error otherwise)"),
      }, { parameters: [pathParam("id", "Connection id")] }),
    },
    "/v1/governance/connections/{id}/pause": {
      post: op(["governance"], "Pause a connection", { "200": ok("Connection") }, {
        parameters: [pathParam("id", "Connection id")],
      }),
    },
    "/v1/governance/connections/{id}/resume": {
      post: op(["governance"], "Resume a connection (requires a prior successful verification)", {
        "200": ok("Connection"),
        ...Object.fromEntries([err(409, "CONFLICT when never verified")]),
      }, { parameters: [pathParam("id", "Connection id")] }),
    },
    "/v1/governance/connections/{id}/rotate": {
      post: op(["governance"], "Rotate the credential reference; the connection returns to paused", {
        "200": ok("Connection"),
        ...Object.fromEntries([err(400, "SECRET_REFUSED"), err(403, "Requires connection:rotate")]),
      }, {
        parameters: [pathParam("id", "Connection id")],
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["credentialRef"],
            properties: { credentialRef: { type: "string" } },
          }),
        },
      }),
    },
    "/v1/governance/connections/{id}/revoke": {
      post: op(["governance"], "Revoke a connection; all further use is refused", {
        "200": ok("Connection"),
      }, { parameters: [pathParam("id", "Connection id")] }),
    },
    "/v1/governance/integration-events": {
      get: op(["governance"], "Inbox records for this tenant", { "200": ok("IntegrationEvent[]") }, {
        parameters: [
          queryParam("connectionId", "Filter by connection"),
          queryParam("topic", "Filter by topic"),
          queryParam("status", "received | processing | processed | duplicate | failed | stale_ignored"),
        ],
      }),
      post: op(["governance"], "Internal event ingest (x-osas-governance-key; deduped; never executes inline)", {
        "200": ok("IntegrationEventIntakeResult: accepted | duplicate | out_of_order"),
        ...Object.fromEntries([
          err(403, "Missing or wrong governance event key"),
          err(409, "Ingestion is disabled (no key configured) or the connection is not active"),
        ]),
      }, {
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["connectionId", "topic", "externalEventId", "occurredAt"],
            properties: {
              connectionId: { type: "string" },
              topic: { type: "string" },
              externalEventId: { type: "string", description: "Provider event id; the dedupe key" },
              occurredAt: { type: "string", description: "ISO-8601 provider timestamp; ordering uses this" },
              payload: { type: "object", description: "Opaque provider snapshot" },
            },
          }),
        },
      }),
    },
    "/v1/governance/jobs": {
      get: op(["governance"], "Job queue for this tenant", { "200": ok("JobRun[]") }, {
        parameters: [
          queryParam("status", "queued | leased | succeeded | dead_letter | cancelled"),
          queryParam("kind", "integration_event.process | connection.verify | reconciliation.refetch"),
        ],
      }),
    },
    "/v1/governance/jobs/drain": {
      post: op(["governance"], "Run one worker sweep for this tenant (requires job:operate)", {
        "200": ok("RunOnceReport"),
        ...Object.fromEntries([err(403, "Requires job:operate")]),
      }, {
        requestBody: {
          required: false,
          content: jsonContent({
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
          }),
        },
      }),
    },
    "/v1/governance/reconciliations": {
      get: op(["governance"], "Reconciliation records; an uncertain outcome is never retried automatically", {
        "200": ok("Reconciliation[]"),
      }, {
        parameters: [
          queryParam("status", "open | resolved | dismissed"),
          queryParam("caseId", "Filter by case"),
        ],
      }),
    },
    "/v1/governance/reconciliations/{id}/decide": {
      post: op(["governance"], "Resolve or dismiss a reconciliation (compare-and-set, single shot)", {
        "200": ok("Reconciliation"),
        ...Object.fromEntries([err(403, "Requires reconciliation:resolve"), err(409, "Already decided or stale version")]),
      }, {
        parameters: [pathParam("id", "Reconciliation id")],
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            required: ["status", "resolution", "expectedVersion"],
            properties: {
              status: { enum: ["resolved", "dismissed"] },
              resolution: { type: "string" },
              expectedVersion: { type: "integer" },
            },
          }),
        },
      }),
    },
    "/v1/governance/usage": {
      get: op(["governance"], "Control-plane metering (governed objects, never tokens)", {
        "200": ok("{ records, summary }"),
      }, {
        parameters: [
          queryParam("kind", "case_intake | proposal_created | approval_decided | execution_attempted | reconciliation_opened"),
          queryParam("from", "ISO-8601 lower bound"),
          queryParam("to", "ISO-8601 upper bound"),
        ],
      }),
    },
  };
}

let cached: Record<string, unknown> | undefined;

/** The OpenAPI 3.1 document for this deployment. Built once; schemas on disk
 * do not change at runtime. */
export function buildOpenApiDocument(): Record<string, unknown> {
  cached ??= {
    openapi: "3.1.0",
    info: {
      title: "OSAS Reference API",
      version: API_VERSION,
      summary: "Governed support agents: the model proposes, the policy engine decides.",
      description:
        "HTTP surface of the Open Support Agent Spec reference implementation " +
        "(specVersion " + SPEC_VERSION + "). components.schemas are the authoritative " +
        "JSON Schemas from schemas/ — the same source the runtime validator uses. " +
        "Auth: demo mode uses x-osas-role / x-osas-actor-id / x-tenant-id headers; " +
        "jwt mode uses OIDC Bearer tokens. All errors use the Error component.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "meta", description: "Discovery, schemas, validation, usage" },
      { name: "cases", description: "Cases and customers" },
      { name: "proposals", description: "ActionProposals: the only write path" },
      { name: "approvals", description: "Human approval lifecycle (fail-safe expiry)" },
      { name: "handoffs", description: "Human handoffs" },
      { name: "audit", description: "Hash-chained audit trail" },
      { name: "policies", description: "Immutable tenant policy versions" },
      { name: "shadow", description: "Shadow mode: record, review, never execute" },
      { name: "controlled-execution", description: "v0.3 sandbox execution and reconciliation" },
      { name: "demo", description: "Demo driver" },
    ],
    paths: buildPaths(),
    components: buildComponents(),
  };
  return cached;
}
