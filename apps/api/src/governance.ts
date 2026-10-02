import type { FastifyRequest } from "fastify";
import {
  GovernanceRuntime,
  createRecordOnlyEventConsumer,
  inMemoryGovernanceStores,
  systemActor,
  type GovernanceActor,
  type GovernanceRole,
  type GovernanceStores,
} from "@osas/governance";
import { postgresGovernanceStores, type Pool } from "@osas/store-postgres";
import type { OsasRole } from "./auth.js";
import { GovernanceValidationError } from "@osas/governance";
import { loadStorageConfig, type StorageConfig } from "./config.js";
import { ConfigError } from "./config.js";

/**
 * Governance control-plane wiring for the reference API (M1).
 *
 * The control plane is provider-neutral: nothing in this file names a vendor.
 * Vendor-specific behaviour belongs in adapters, and the only integration point
 * the runtime offers is an injected job handler.
 */

/**
 * Bridge from the existing auth axis to the governance axis.
 *
 * These are two independent systems and must stay that way:
 * - `OsasRole` decides what the adapter permission ladder allows
 *   (read < draft < request-approval < execute).
 * - `GovernanceRole` decides what control-plane resources may be touched.
 *
 * A governance role can never raise the adapter permission, and no OSAS role
 * maps to "system_executor" here: that principal is server-internal only.
 */
export const OSAS_ROLE_TO_GOVERNANCE_ROLES: Readonly<Record<OsasRole, readonly GovernanceRole[]>> = {
  // The policy administrator is the human accountable for policy and for the
  // decisions taken under it. A deployment that requires strict separation of
  // duties issues separate principals via IdP roles: give the approver
  // "policy_admin" alone (which does not grant connection:write) or map a
  // dedicated approver principal in the IdP.
  policy_admin: ["admin", "approver"],
  support_agent: ["operator"],
  auditor: ["auditor"],
  system_executor: [],
};

const GOVERNANCE_ROLES: readonly GovernanceRole[] = [
  "owner",
  "admin",
  "operator",
  "approver",
  "auditor",
  "viewer",
];

const isGovernanceRole = (value: string): value is GovernanceRole =>
  (GOVERNANCE_ROLES as readonly string[]).includes(value);

/**
 * Demo-only override so the control plane can be exercised with precise roles
 * locally. Ignored for authenticated (JWT) principals, matching the existing
 * rule that demo headers never influence a verified identity.
 */
const DEMO_GOVERNANCE_ROLE_HEADER = "x-osas-governance-role";

export function governanceRolesForRequest(req: FastifyRequest): GovernanceRole[] {
  const principal = req.principal;
  const derived = new Set<GovernanceRole>();
  for (const role of principal.roles) {
    for (const governanceRole of OSAS_ROLE_TO_GOVERNANCE_ROLES[role] ?? []) {
      derived.add(governanceRole);
    }
  }
  if (!principal.authenticated) {
    const raw = req.headers[DEMO_GOVERNANCE_ROLE_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && value.trim()) {
      const requested = value
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      const invalid = requested.filter((r) => !isGovernanceRole(r));
      if (invalid.length > 0) {
        throw new GovernanceValidationError(
          DEMO_GOVERNANCE_ROLE_HEADER,
          `unknown role(s) [${invalid.join(", ")}]; expected one of ${GOVERNANCE_ROLES.join(", ")}`,
        );
      }
      return requested as GovernanceRole[];
    }
  }
  return [...derived];
}

export function governanceActorForRequest(req: FastifyRequest): GovernanceActor {
  const principal = req.principal;
  return {
    actorId: principal.actorId,
    roles: governanceRolesForRequest(req),
    tenantId: req.tenantId,
    authenticated: principal.authenticated,
  };
}

/** Server-internal actor for background sweeps (never request-derived). */
export function governanceWorkerActor(): GovernanceActor {
  return systemActor("osas-governance-worker");
}

/**
 * Optional internal key for integration-event ingestion. Absent = endpoint
 * disabled, matching the Provider Event convention: an unauthenticated ingest
 * path is worse than a disabled one.
 */
export function loadGovernanceEventKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.OSAS_GOVERNANCE_EVENT_KEY?.trim();
  return key || undefined;
}

/**
 * The reference API ships a *record-only* event consumer, and only when
 * explicitly enabled. It advances the inbox state machine and performs no
 * business action, so it must never be switched on by accident:
 * a deployment replaces it with a handler that does real work.
 */
export function loadGovernanceEventConsumer(
  env: NodeJS.ProcessEnv = process.env,
): "record-only" | "none" {
  const raw = (env.OSAS_GOVERNANCE_EVENT_CONSUMER ?? "none").trim().toLowerCase();
  if (!raw || raw === "none") return "none";
  if (raw === "record-only") return "record-only";
  throw new ConfigError(
    `OSAS_GOVERNANCE_EVENT_CONSUMER must be "none" or "record-only"; got "${raw}"`,
  );
}

export interface GovernanceWiring {
  runtime: GovernanceRuntime;
  eventKey?: string;
  consumer: "record-only" | "none";
}

export function buildGovernance(
  options: {
    pool?: Pool;
    storage?: StorageConfig;
    env?: NodeJS.ProcessEnv;
    clock?: () => Date;
  } = {},
): GovernanceWiring {
  const env = options.env ?? process.env;
  const storage = options.storage ?? loadStorageConfig(env);
  const stores: GovernanceStores =
    storage.mode === "postgres" && options.pool
      ? postgresGovernanceStores(options.pool)
      : inMemoryGovernanceStores();
  if (storage.mode === "postgres" && !options.pool) {
    throw new ConfigError(
      "OSAS_STORAGE=postgres requires a connected pool before governance wiring",
    );
  }
  const consumer = loadGovernanceEventConsumer(env);
  const runtime = GovernanceRuntime.create({
    stores,
    ...(options.clock ? { clock: { now: options.clock } } : {}),
    ...(consumer === "record-only" ? { handlers: {} } : {}),
  });
  if (consumer === "record-only") {
    // Rebuild with the handler bound to this runtime's own intake instance.
    return {
      runtime: GovernanceRuntime.create({
        stores,
        ...(options.clock ? { clock: { now: options.clock } } : {}),
        handlers: {
          "integration_event.process": createRecordOnlyEventConsumer(runtime.intake),
        },
      }),
      ...(loadGovernanceEventKey(env) ? { eventKey: loadGovernanceEventKey(env)! } : {}),
      consumer,
    };
  }
  return {
    runtime,
    ...(loadGovernanceEventKey(env) ? { eventKey: loadGovernanceEventKey(env)! } : {}),
    consumer,
  };
}
