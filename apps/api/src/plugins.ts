import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Principal, SupportAdapter } from "@osas/adapter";
import {
  AdapterCapabilityError,
  AdapterNotFoundError,
  AdapterPermissionError,
} from "@osas/adapter";
import { IllegalTransitionError } from "@osas/core";
import type { ExecutionStore, PolicyStore } from "@osas/policy-engine";
import type { ModelGateway } from "@osas/model-gateway";

export const SPEC_VERSION = "0.1";
export const API_VERSION = "0.1.1";
export const DEFAULT_TENANT = "tenant_demo";

// API backend principal: only the policy engine / API layer may execute (§3).
export const SYSTEM_PRINCIPAL: Principal = {
  actorType: "system",
  actorId: "osas-api",
  permission: "execute",
};

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "*.email", "*.phone"],
    censor: "[redacted]",
  },
};

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
  interface FastifyInstance {
    adapter: SupportAdapter;
    executionStore: ExecutionStore;
    policyStore: PolicyStore;
    gateway: ModelGateway;
    compatReportPath?: string;
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

/** Demo-mode RBAC: policy lifecycle operations require the policy_admin role. */
export class PolicyAdminRequiredError extends Error {
  override name = "PolicyAdminRequiredError";
  constructor() {
    super("policy lifecycle operations require the policy_admin role (header x-osas-role)");
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

export async function tenantHook(req: FastifyRequest): Promise<void> {
  const header = req.headers["x-tenant-id"];
  const value = Array.isArray(header) ? header[0] : header;
  req.tenantId = value && value.trim() ? value.trim() : DEFAULT_TENANT;
}

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, code: string, message: string, details?: unknown) =>
    reply
      .code(status)
      .send({ error: details === undefined ? { code, message } : { code, message, details } });

  if (err instanceof AdapterNotFoundError || err.name === "AdapterNotFoundError") {
    return send(404, "NOT_FOUND", err.message);
  }
  if (err.name === "PolicyVersionNotFoundError") {
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
  if (err instanceof SchemaInvalidError || err.name === "SchemaInvalidError") {
    return send(422, "SCHEMA_INVALID", err.message, (err as unknown as SchemaInvalidError).details);
  }
  if (err instanceof PolicyImmutableError || err.name === "PolicyImmutableError") {
    return send(409, "POLICY_IMMUTABLE", err.message);
  }
  if (
    err instanceof IllegalTransitionError ||
    err instanceof ConflictError ||
    err.name === "IllegalTransitionError" ||
    err.name === "ConflictError" ||
    err.name === "ExecutionStatusError" || // policy-engine §5 status guards
    err.name === "ReconcileStatusError" ||
    err.name === "PolicyVersionConflictError"
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

export function registerPlugins(app: FastifyInstance): void {
  app.addHook("preHandler", tenantHook);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` } }),
  );
}
