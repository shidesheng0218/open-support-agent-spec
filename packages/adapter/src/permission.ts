import { AdapterPermissionError } from "./errors.js";
import type { Permission, Principal } from "./types.js";

// Ordered permission ladder (CONTRACTS.md §3): read < draft < request-approval < execute.
// Mirrored locally so @osas/adapter carries no runtime dependency on @osas/core.
export const PERMISSION_LADDER: readonly Permission[] = [
  "read",
  "draft",
  "request-approval",
  "execute",
];

export function permissionRank(p: Permission): number {
  return PERMISSION_LADDER.indexOf(p);
}

export function hasPermission(principal: Principal, needed: Permission): boolean {
  return permissionRank(principal.permission) >= permissionRank(needed);
}

/** Throws AdapterPermissionError when the principal's permission is below `needed`. */
export function requirePermission(principal: Principal, needed: Permission): void {
  if (!hasPermission(principal, needed)) {
    throw new AdapterPermissionError(
      `Principal ${principal.actorType}:${principal.actorId} with permission "${principal.permission}" lacks required permission "${needed}"`,
    );
  }
}
