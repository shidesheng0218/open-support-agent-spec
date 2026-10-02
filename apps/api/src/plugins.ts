import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Principal, SupportAdapter } from "@osas/adapter";
import type { AuthHook, AuthPrincipal } from "./auth.js";
import { ForbiddenError, TenantMismatchError, UnauthenticatedError } from "./auth.js";
import {
  AdapterCapabilityError,
  AdapterNotFoundError,
  AdapterPermissionError,
} from "@osas/adapter";
import { IllegalTransitionError } from "@osas/core";
import {
  GovernanceConflictError,
  GovernanceForbiddenError,
  GovernanceNotFoundError,
  GovernanceSecretRefusedError,
  GovernanceTenantError,
  GovernanceTransitionError,
  GovernanceValidationError,
  IntegrationSignatureError,
  type GovernanceRuntime,
} from "@osas/governance";
import type { ExecutionStore, PolicyStore } from "@osas/policy-engine";
import type { ModelGateway } from "@osas/model-gateway";
import type { UsageStore } from "@osas/model-gateway";

export const SPEC_VERSION = "0.2";
export const API_VERSION = "0.2.1";
// Canonical home is auth.ts (the auth hook owns tenant resolution).
export { DEFAULT_TENANT } from "./auth.js";

// API backend principal: only the policy engine / API layer may execute (§3).
export const SYSTEM_PRINCIPAL: Principal = {
  actorType: "system",
  actorId: "osas-api",
  permission: "execute",
};

// Spec §9: log pipelines MUST redact at least the authorization header,
// email, phone, and free-text bodies. `*.body` covers nested request/response
// payloads; the explicit req/res paths keep the intent readable. Behaviour is
// pinned by src/log-redaction.test.ts.
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "*.email",
  "*.phone",
  "req.body",
  "res.body",
  "*.body",
] as const;

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [...LOG_REDACT_PATHS],
    censor: "[redacted]",
  },
};

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
    /** Authenticated principal (demo headers or verified JWT claims). */
    principal: AuthPrincipal;
  }
  interface FastifyInstance {
    adapter: SupportAdapter;
    executionStore: ExecutionStore;
    policyStore: PolicyStore;
    /** Milestone 3: ShadowRun persistence (memory or Postgres). */
    shadowRunStore: import("@osas/ecommerce-shadow").ShadowRunStore;
    /** v0.2 defaults to shadow; v0.3 sandbox is synthetic-only. */
    executionMode: import("@osas/ecommerce-shadow").ExecutionModeConfig;
    executionAttemptStore: import("@osas/ecommerce-shadow").ExecutionAttemptStore;
    executionReceiptStore: import("@osas/ecommerce-shadow").ExecutionReceiptStore;
    reconciliationStore: import("@osas/ecommerce-shadow").ReconciliationStore;
    providerEventStore: import("@osas/ecommerce-shadow").ProviderEventStore;
    providerEventKey?: string;
    gateway: ModelGateway;
    usageStore: UsageStore;
    /** Present when OSAS_STORAGE=postgres (audit stream mirror). */
    auditStore?: { append(event: import("@osas/core").AuditEvent): Promise<void> };
    /** Present when OSAS_STORAGE=postgres; enables transactional execution. */
    pgPool?: import("@osas/store-postgres").Pool;
    authConfig: import("./auth.js").AuthConfig;
    /** Milestone 4: conformance mode (test-only reset/fixture/snapshot). */
    conformanceConfig: import("./config.js").ConformanceConfig;
    compatReportPath?: string;
    afterSalesStore: import("./routes/after-sales.js").AfterSalesStore;
    /** M1 governance control plane (provider-neutral). */
    governance: GovernanceRuntime;
    /** Absent = integration-event ingestion disabled (fail closed). */
    governanceEventKey?: string;
  }
}

export class SchemaInvalidError extends Error {
  override name = "SchemaInvalidError";
  constructor(
    public details: unknown,
    message = "Request body failed schema validation",
  ) {
    super(message);
  }
}

export class ConflictError extends Error {
  override name = "ConflictError";
}

/** Policy lifecycle operations require the policy_admin role (any auth mode). */
export class PolicyAdminRequiredError extends Error {
  override name = "PolicyAdminRequiredError";
  constructor() {
    super(
      "policy lifecycle operations require the policy_admin role " +
        "(demo: header x-osas-role; jwt: roles claim)",
    );
  }
}

export class PolicyImmutableError extends Error {
  override name = "PolicyImmutableError";
  constructor(tenantId: string) {
    super(
      `Active policy for tenant ${tenantId} cannot be overwritten in place. ` +
        "Create a draft via POST /v1/policies/:tenantId/drafts and activate it instead.",
    );
  }
}

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, code: string, message: string, details?: unknown) =>
    reply
      .code(status)
      .send({ error: details === undefined ? { code, message } : { code, message, details } });

  if (err instanceof UnauthenticatedError || err.name === "UnauthenticatedError") {
    return send(401, "UNAUTHENTICATED", err.message);
  }
  if (err instanceof TenantMismatchError || err.name === "TenantMismatchError") {
    return send(403, "TENANT_MISMATCH", err.message);
  }
  if (err instanceof ForbiddenError || err.name === "ForbiddenError") {
    return send(403, "FORBIDDEN", err.message);
  }
  if (err instanceof AdapterNotFoundError || err.name === "AdapterNotFoundError") {
    return send(404, "NOT_FOUND", err.message);
  }
  if (err.name === "PolicyVersionNotFoundError") {
    return send(404, "NOT_FOUND", err.message);
  }
  if (err.name === "ShadowRunNotFoundError") {
    return send(404, "NOT_FOUND", err.message);
  }
  if (err instanceof AdapterPermissionError || err.name === "AdapterPermissionError") {
    return send(403, "FORBIDDEN", err.message);
  }
  if (err instanceof AdapterCapabilityError || err.name === "AdapterCapabilityError") {
    return send(403, "CAPABILITY_UNSUPPORTED", err.message);
  }
  if (err instanceof PolicyAdminRequiredError || err.name === "PolicyAdminRequiredError") {
    return send(403, "POLICY_ADMIN_REQUIRED", err.message);
  }
  if (err instanceof GovernanceForbiddenError || err.name === "GovernanceForbiddenError") {
    return send(403, "FORBIDDEN", err.message);
  }
  if (err instanceof GovernanceTenantError || err.name === "GovernanceTenantError") {
    return send(403, "TENANT_MISMATCH", err.message);
  }
  if (err instanceof IntegrationSignatureError || err.name === "IntegrationSignatureError") {
    // The delivery itself is untrusted; it is rejected before touching state.
    return send(401, "SIGNATURE_UNVERIFIED", err.message);
  }
  if (err instanceof GovernanceNotFoundError || err.name === "GovernanceNotFoundError") {
    return send(404, "NOT_FOUND", err.message);
  }
  if (err instanceof GovernanceSecretRefusedError || err.name === "GovernanceSecretRefusedError") {
    // Distinct code on purpose: a caller tried to store something that looks
    // like a credential, and that must be visible in logs and metrics.
    return send(400, "SECRET_REFUSED", err.message);
  }
  if (err instanceof GovernanceValidationError || err.name === "GovernanceValidationError") {
    return send(400, "VALIDATION_ERROR", err.message);
  }
  if (err instanceof GovernanceTransitionError || err.name === "GovernanceTransitionError") {
    return send(409, "ILLEGAL_TRANSITION", err.message);
  }
  if (err instanceof GovernanceConflictError || err.name === "GovernanceConflictError") {
    return send(409, "CONFLICT", err.message);
  }
  if (err instanceof SchemaInvalidError || err.name === "SchemaInvalidError") {
    return send(422, "SCHEMA_INVALID", err.message, (err as unknown as SchemaInvalidError).details);
  }
  if (err instanceof PolicyImmutableError || err.name === "PolicyImmutableError") {
    return send(409, "POLICY_IMMUTABLE", err.message);
  }
  if (err.name === "ActionBindingMismatchError") {
    // RFC 0008: the proposal no longer matches its approved action digest.
    return send(409, "ACTION_BINDING_MISMATCH", err.message);
  }
  if (
    err instanceof IllegalTransitionError ||
    err instanceof ConflictError ||
    err.name === "IllegalTransitionError" ||
    err.name === "ConflictError" ||
    err.name === "ExecutionStatusError" || // policy-engine §5 status guards
    err.name === "ReconcileStatusError" ||
    err.name === "PolicyVersionConflictError" ||
    err.name === "ShadowRunAlreadyReviewedError" // reviewed ShadowRuns are final
  ) {
    return send(409, "CONFLICT", err.message);
  }
  const statusCode = err.statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return send(statusCode, err.code ?? "BAD_REQUEST", err.message);
  }
  req.log.error(err);
  return send(500, "INTERNAL_ERROR", "Internal server error");
}

export function registerPlugins(app: FastifyInstance, authHook: AuthHook): void {
  app.addHook("preHandler", authHook);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` } }),
  );
}
