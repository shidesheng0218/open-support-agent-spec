import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from "jose";
import type { Permission } from "@osas/adapter";

export const DEFAULT_TENANT = "tenant_demo";

/**
 * Authentication & tenant isolation (Milestone 2).
 *
 * OSAS_AUTH_MODE=demo | jwt
 * - demo: header-driven principals (x-osas-role / x-osas-actor-id /
 *   x-tenant-id). Demo is for local development and tests only; combined with
 *   NODE_ENV=production startup fails closed.
 * - jwt: OIDC Bearer tokens verified against a JWKS endpoint
 *   (OSAS_JWKS_URL / OSAS_JWT_ISSUER / OSAS_JWT_AUDIENCE). Tenant and roles
 *   come exclusively from verified claims; x-tenant-id / x-osas-role headers
 *   are ignored.
 *
 * External requests can never obtain the "execute" permission: the
 * system_executor role is reserved for server-internal principals (see
 * SYSTEM_PRINCIPAL in plugins.ts); a token or header claiming it is rejected.
 */

export const OSAS_ROLES = [
  "support_agent",
  "policy_admin",
  "auditor",
  "system_executor",
] as const;
export type OsasRole = (typeof OSAS_ROLES)[number];

/** Highest adapter permission each role may hold (CONTRACTS.md §3 ladder). */
export const ROLE_PERMISSION: Readonly<Record<OsasRole, Permission>> = {
  auditor: "read",
  support_agent: "draft",
  policy_admin: "request-approval",
  system_executor: "execute",
};

export type AuthMode = "demo" | "jwt";

export interface AuthConfig {
  mode: AuthMode;
  nodeEnv: string;
  jwksUrl?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
}

export interface AuthPrincipal {
  actorId: string;
  tenantId: string;
  roles: OsasRole[];
  permission: Permission;
  /** Authenticated via JWT (claims) rather than demo headers. */
  authenticated: boolean;
}

export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

export class UnauthenticatedError extends Error {
  override name = "UnauthenticatedError";
}

export class ForbiddenError extends Error {
  override name = "ForbiddenError";
}

export class TenantMismatchError extends Error {
  override name = "TenantMismatchError";
  constructor(paramTenant: string, principalTenant: string) {
    super(
      `Tenant "${paramTenant}" does not match the authenticated principal's tenant "${principalTenant}"`,
    );
  }
}

const asSingle = (value: string | string[] | undefined): string | undefined => {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : undefined;
};

const isRole = (value: unknown): value is OsasRole =>
  typeof value === "string" && (OSAS_ROLES as readonly string[]).includes(value);

export function highestPermission(roles: readonly OsasRole[]): Permission {
  const rank: Permission[] = ["read", "draft", "request-approval", "execute"];
  return roles.reduce<Permission>(
    (acc, role) =>
      rank.indexOf(ROLE_PERMISSION[role]) > rank.indexOf(acc) ? ROLE_PERMISSION[role] : acc,
    "read",
  );
}

/** Parse and validate auth-related env. Fail closed on unsafe combinations. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env.OSAS_AUTH_MODE ?? "demo").trim() || "demo";
  const nodeEnv = env.NODE_ENV ?? "development";
  if (mode !== "demo" && mode !== "jwt") {
    throw new AuthConfigError(
      `OSAS_AUTH_MODE must be "demo" or "jwt"; got "${mode}"`,
    );
  }
  if (mode === "demo" && nodeEnv === "production") {
    throw new AuthConfigError(
      "OSAS_AUTH_MODE=demo is not allowed with NODE_ENV=production. " +
        "Configure OSAS_AUTH_MODE=jwt with OSAS_JWKS_URL / OSAS_JWT_ISSUER / OSAS_JWT_AUDIENCE.",
    );
  }
  if (mode === "jwt") {
    const missing = [
      ["OSAS_JWKS_URL", env.OSAS_JWKS_URL],
      ["OSAS_JWT_ISSUER", env.OSAS_JWT_ISSUER],
      ["OSAS_JWT_AUDIENCE", env.OSAS_JWT_AUDIENCE],
    ]
      .filter(([, v]) => !v || !v.trim())
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new AuthConfigError(
        `OSAS_AUTH_MODE=jwt requires ${missing.join(", ")} to be set`,
      );
    }
    return {
      mode,
      nodeEnv,
      jwksUrl: env.OSAS_JWKS_URL!.trim(),
      jwtIssuer: env.OSAS_JWT_ISSUER!.trim(),
      jwtAudience: env.OSAS_JWT_AUDIENCE!.trim(),
    };
  }
  return { mode, nodeEnv };
}

function demoPrincipal(req: FastifyRequest): AuthPrincipal {
  const roleHeader = asSingle(req.headers["x-osas-role"]) ?? "support_agent";
  if (!isRole(roleHeader)) {
    throw new UnauthenticatedError(
      `Unknown role "${roleHeader}" in x-osas-role; expected one of ${OSAS_ROLES.join(", ")}`,
    );
  }
  if (roleHeader === "system_executor") {
    throw new ForbiddenError(
      "system_executor is a server-internal principal and cannot be assumed by external requests",
    );
  }
  return {
    actorId: asSingle(req.headers["x-osas-actor-id"]) ?? `demo-${roleHeader}`,
    tenantId: asSingle(req.headers["x-tenant-id"]) ?? DEFAULT_TENANT,
    roles: [roleHeader],
    permission: ROLE_PERMISSION[roleHeader],
    authenticated: false,
  };
}

interface JwtClaims {
  sub: string;
  tenant_id: string;
  roles: OsasRole[];
}

function parseClaims(payload: Record<string, unknown>): JwtClaims {
  const sub = typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
  const tenantId =
    typeof payload.tenant_id === "string" && payload.tenant_id.trim()
      ? payload.tenant_id.trim()
      : undefined;
  if (!sub || !tenantId) {
    throw new UnauthenticatedError("JWT must carry non-empty sub and tenant_id claims");
  }
  const rawRoles = payload.roles;
  if (!Array.isArray(rawRoles) || rawRoles.length === 0 || !rawRoles.every(isRole)) {
    throw new UnauthenticatedError(
      `JWT roles claim must be a non-empty array of ${OSAS_ROLES.join(", ")}`,
    );
  }
  const roles = rawRoles as OsasRole[];
  if (roles.includes("system_executor")) {
    throw new ForbiddenError(
      "system_executor is a server-internal principal and cannot be granted to external tokens",
    );
  }
  return { sub, tenant_id: tenantId, roles };
}

export interface AuthHook {
  (req: FastifyRequest): Promise<void>;
}

/** Build the preHandler hook that authenticates every request. */
export function createAuthHook(config: AuthConfig): AuthHook {
  // Liveness probes carry no credentials; /health stays anonymous + read-only.
  const anonymous: AuthPrincipal = {
    actorId: "anonymous",
    tenantId: DEFAULT_TENANT,
    roles: ["auditor"],
    permission: "read",
    authenticated: false,
  };
  const wrap = (inner: (req: FastifyRequest) => void | Promise<void>): AuthHook => {
    return async (req) => {
      if (req.routeOptions.url === "/health" || req.url === "/health") {
        req.principal = anonymous;
        req.tenantId = anonymous.tenantId;
        return;
      }
      await inner(req);
    };
  };
  if (config.mode === "demo") {
    return wrap(async (req) => {
      req.principal = demoPrincipal(req);
      req.tenantId = req.principal.tenantId;
    });
  }
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl!));
  const verifyOpts: JWTVerifyOptions = {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  };
  return wrap(async (req) => {
    const header = asSingle(req.headers.authorization);
    if (!header || !header.startsWith("Bearer ")) {
      throw new UnauthenticatedError("Missing Authorization: Bearer <token> header");
    }
    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(header.slice("Bearer ".length), jwks, verifyOpts);
      payload = verified.payload as Record<string, unknown>;
    } catch (err) {
      if (err instanceof UnauthenticatedError || err instanceof ForbiddenError) throw err;
      throw new UnauthenticatedError(
        `JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const claims = parseClaims(payload);
    req.principal = {
      actorId: claims.sub,
      tenantId: claims.tenant_id,
      roles: claims.roles,
      permission: highestPermission(claims.roles),
      authenticated: true,
    };
    // Tenant identity comes solely from verified claims; the x-tenant-id
    // header is ignored in jwt mode.
    req.tenantId = claims.tenant_id;
  });
}

/**
 * Route-level tenant isolation: a path/body tenant parameter must match the
 * authenticated principal's tenant.
 */
export function assertTenantAccess(req: FastifyRequest, tenantId: string): void {
  if (tenantId !== req.principal.tenantId) {
    throw new TenantMismatchError(tenantId, req.principal.tenantId);
  }
}

/** Require one of the given roles (e.g. policy_admin for policy lifecycle). */
export function requireRole(req: FastifyRequest, ...roles: OsasRole[]): AuthPrincipal {
  const principal = req.principal;
  if (!principal.roles.some((r) => roles.includes(r))) {
    throw new ForbiddenError(
      `This operation requires one of the roles [${roles.join(", ")}]; principal has [${principal.roles.join(", ")}]`,
    );
  }
  return principal;
}
