import { GovernanceForbiddenError } from "./roles.js";
import type { GovernanceRole } from "./types.js";

/**
 * The control-plane caller.
 *
 * `tenantId` absent means a server-internal actor (the same shape as
 * SYSTEM_PRINCIPAL in the API): it is never derived from request input.
 * External actors always carry the tenant resolved by the auth hook, and every
 * tenant-scoped operation must check it — that check is what keeps a valid
 * token for tenant A from reading tenant B.
 */
export interface GovernanceActor {
  actorId: string;
  roles: readonly GovernanceRole[];
  tenantId?: string;
  authenticated: boolean;
}

export function systemActor(actorId = "osas-governance"): GovernanceActor {
  return { actorId, roles: ["owner"], authenticated: true };
}

export class GovernanceTenantError extends Error {
  override name = "GovernanceTenantError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Fail closed: an actor without a tenant binding cannot touch tenant data, and
 * an actor bound to another tenant is rejected with a message that does not
 * disclose whether the resource exists.
 */
export function assertTenantAccess(actor: GovernanceActor, tenantId: string): void {
  if (!actor.tenantId) {
    throw new GovernanceTenantError(
      `Principal "${actor.actorId}" has no tenant binding and cannot access tenant-scoped governance resources`,
    );
  }
  if (actor.tenantId !== tenantId) {
    throw new GovernanceTenantError(
      `Principal "${actor.actorId}" is not authorized for tenant "${tenantId}"`,
    );
  }
}

export function actorRoles(actor: GovernanceActor): readonly GovernanceRole[] {
  return actor.roles;
}

export { GovernanceForbiddenError };
