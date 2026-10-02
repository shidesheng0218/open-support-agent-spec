import type { GovernanceCapability, GovernanceRole } from "./types.js";

/**
 * Control-plane RBAC (M0).
 *
 * Design rules, each pinned by a test:
 *
 * - **Separation of duties.** An "operator" runs cases and cannot decide
 *   approvals; an "approver" decides approvals and cannot mutate connections
 *   or members. No single non-owner role can both route work and authorize it.
 * - **Least privilege by default.** An unknown or missing role resolves to the
 *   empty capability set. Roles are additive; there are no implicit grants.
 * - **Read-only audit.** "auditor" can see everything and change nothing.
 * - **No execution capability exists here.** Nothing in this matrix can make
 *   an adapter execute an action. That remains gated by the policy engine and
 *   the server-internal system principal (see OSAS CONTRACTS.md §3).
 */

const ALL_CAPABILITIES: readonly GovernanceCapability[] = [
  "organization:read",
  "organization:write",
  "workspace:read",
  "workspace:write",
  "member:read",
  "member:write",
  "connection:read",
  "connection:write",
  "connection:rotate",
  "case:read",
  "case:write",
  "event:read",
  "event:write",
  "job:read",
  "job:operate",
  "approval:read",
  "approval:decide",
  "reconciliation:read",
  "reconciliation:resolve",
  "audit:read",
  "usage:read",
];

const READ_ONLY: readonly GovernanceCapability[] = [
  "organization:read",
  "workspace:read",
  "member:read",
  "connection:read",
  "case:read",
  "event:read",
  "job:read",
  "approval:read",
  "reconciliation:read",
  "audit:read",
  "usage:read",
];

export const ROLE_CAPABILITIES: Readonly<Record<GovernanceRole, readonly GovernanceCapability[]>> = {
  // The only role that may rewrite the organization boundary itself.
  owner: ALL_CAPABILITIES,
  // Everything except organization:write (renaming/rewriting the org boundary).
  admin: ALL_CAPABILITIES.filter((c) => c !== "organization:write"),
  // Runs the queue: intake, cases, events, jobs. Cannot authorize or approve.
  operator: [
    "workspace:read",
    "organization:read",
    "member:read",
    "connection:read",
    "case:read",
    "case:write",
    "event:read",
    "event:write",
    "job:read",
    "approval:read",
    "reconciliation:read",
    "audit:read",
    "usage:read",
  ],
  // Authorizes and reconciles. Cannot change connections, members, or cases.
  approver: [
    "workspace:read",
    "organization:read",
    "member:read",
    "connection:read",
    "case:read",
    "event:read",
    "job:read",
    "approval:read",
    "approval:decide",
    "reconciliation:read",
    "reconciliation:resolve",
    "audit:read",
    "usage:read",
  ],
  auditor: READ_ONLY,
  viewer: [
    "workspace:read",
    "case:read",
    "approval:read",
    "audit:read",
  ],
};

export function roleCapabilities(role: GovernanceRole): readonly GovernanceCapability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}

/** Capabilities are additive across all of a principal's role bindings. */
export function effectiveCapabilities(
  roles: readonly GovernanceRole[],
): ReadonlySet<GovernanceCapability> {
  const out = new Set<GovernanceCapability>();
  for (const role of roles) {
    for (const capability of roleCapabilities(role)) out.add(capability);
  }
  return out;
}

export function can(
  roles: readonly GovernanceRole[],
  capability: GovernanceCapability,
): boolean {
  return effectiveCapabilities(roles).has(capability);
}

export function requireCapability(
  roles: readonly GovernanceRole[],
  capability: GovernanceCapability,
  actorId = "unknown",
): void {
  if (!can(roles, capability)) {
    throw new GovernanceForbiddenError(actorId, capability);
  }
}

export class GovernanceForbiddenError extends Error {
  override name = "GovernanceForbiddenError";
  constructor(
    public readonly actorId: string,
    public readonly capability: GovernanceCapability,
    public readonly roles: readonly GovernanceRole[] = [],
  ) {
    super(
      `Principal "${actorId}" lacks governance capability "${capability}"` +
        (roles.length > 0 ? ` (roles: ${roles.join(", ")})` : " (no role binding)"),
    );
  }
}
