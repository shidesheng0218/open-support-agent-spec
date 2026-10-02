import type { Clock, IdFactory } from "./deps.js";
import { GOVERNANCE_SPEC_VERSION, type Connection, type ConnectionPatch } from "./types.js";
import type { ConnectionStore } from "./ports.js";
import {
  GovernanceConflictError,
  GovernanceNotFoundError,
  GovernanceSecretRefusedError,
  GovernanceValidationError,
} from "./errors.js";
import { requireCapability } from "./roles.js";
import { assertTenantAccess, type GovernanceActor } from "./actor.js";

/**
 * Connection lifecycle service (M1).
 *
 * Fail-closed rules enforced here, each pinned by a test:
 *
 * - **Credentials are never stored.** Only an opaque *reference* with a scheme
 *   prefix is accepted (`vault:...`, `env:...`, `aws-sm:...`). A raw token
 *   is refused with GovernanceSecretRefusedError, so a leaked request body can
 *   never become a leaked database row.
 * - **New connections are paused.** Nothing may use a connection until a
 *   verifier has proven it works; verification failure parks it in "error".
 * - **A connection that was never verified cannot be resumed.**
 * - **Only revoked connections can be deleted**, so an active integration is
 *   never removed out from under in-flight work.
 * - **Write capabilities require a credential reference** — you cannot declare
 *   the ability to write and have no way to authenticate.
 */

/** Write capabilities must end in `.execute` or `.write` (dotted id). */
export const WRITE_CAPABILITY_SUFFIXES = [".execute", ".write"] as const;

export function isWriteCapability(capability: string): boolean {
  return WRITE_CAPABILITY_SUFFIXES.some((suffix) => capability.endsWith(suffix));
}

export function writeCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.filter(isWriteCapability);
}

const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function assertCapabilitySyntax(capabilities: readonly string[]): void {
  if (capabilities.length === 0) {
    throw new GovernanceValidationError("capabilities", "at least one capability is required");
  }
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (!CAPABILITY_PATTERN.test(capability)) {
      throw new GovernanceValidationError(
        "capabilities",
        `"${capability}" must be a dotted lower-case id such as "ecommerce.order.read"`,
      );
    }
    if (seen.has(capability)) {
      throw new GovernanceValidationError("capabilities", `"${capability}" is listed twice`);
    }
    seen.add(capability);
  }
}

/** Token shapes we refuse to persist even if the caller insists. */
const SECRET_SHAPES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^(shpat|shpca|shppa|shpss|ghp|gho|ghs|github_pat)[_-]/i, label: "a provider access token" },
  { pattern: /^xox[baprs]-/i, label: "a Slack token" },
  { pattern: /^sk-[A-Za-z0-9]/i, label: "an API secret key" },
  { pattern: /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, label: "a JWT" },
  { pattern: /^Bearer\s/i, label: "an Authorization header value" },
  { pattern: /^AKIA[0-9A-Z]{16}$/, label: "an AWS access key id" },
];

const REFERENCE_SCHEME = /^[a-z][a-z0-9+.-]*:/;

/**
 * A credential reference must be a pointer, not a secret. Requiring a URI
 * scheme makes "this is a pointer" structurally checkable instead of relying on
 * entropy heuristics.
 */
export function assertOpaqueCredentialRef(value: string, field = "credentialRef"): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new GovernanceValidationError(field, "must not be empty when provided");
  }
  if (trimmed.length > 512) {
    throw new GovernanceSecretRefusedError(field, "value is longer than 512 characters");
  }
  if (/\s/.test(trimmed)) {
    throw new GovernanceSecretRefusedError(field, "value contains whitespace");
  }
  for (const { pattern, label } of SECRET_SHAPES) {
    if (pattern.test(trimmed)) {
      throw new GovernanceSecretRefusedError(field, `value looks like ${label}, not a reference`);
    }
  }
  if (!REFERENCE_SCHEME.test(trimmed)) {
    throw new GovernanceSecretRefusedError(
      field,
      'value must be a reference with a scheme, e.g. "vault:secret/data/osas/acme" or "env:ACME_TOKEN"',
    );
  }
}

export interface CreateConnectionInput {
  tenantId: string;
  provider: string;
  externalAccountId: string;
  displayName?: string;
  capabilities: string[];
  scopes?: string[];
  apiVersion?: string;
  credentialRef?: string;
}

/** Result of an out-of-band connectivity probe. */
export interface ConnectionProbeResult {
  ok: boolean;
  apiVersion?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type ConnectionProbe = (connection: Connection) => Promise<ConnectionProbeResult>;

export interface ConnectionServiceDeps {
  store: ConnectionStore;
  clock: Clock;
  ids: IdFactory;
  /** Deployment-supplied probe. Absent = verification always fails closed. */
  probe?: ConnectionProbe;
}

export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  private get now(): string {
    return this.deps.clock.now().toISOString();
  }

  async create(actor: GovernanceActor, input: CreateConnectionInput): Promise<Connection> {
    requireCapability([...actor.roles], "connection:write", actor.actorId);
    assertTenantAccess(actor, input.tenantId);
    const provider = input.provider?.trim();
    const externalAccountId = input.externalAccountId?.trim();
    if (!provider) throw new GovernanceValidationError("provider", "must not be empty");
    if (!externalAccountId) {
      throw new GovernanceValidationError("externalAccountId", "must not be empty");
    }
    assertCapabilitySyntax(input.capabilities);
    if (input.credentialRef !== undefined) {
      assertOpaqueCredentialRef(input.credentialRef);
    }
    if (writeCapabilities(input.capabilities).length > 0 && !input.credentialRef) {
      throw new GovernanceValidationError(
        "credentialRef",
        "a connection declaring a write capability must carry a credential reference",
      );
    }
    const timestamp = this.now;
    const connection: Connection = {
      id: this.deps.ids.next("conn"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: input.tenantId,
      provider,
      externalAccountId,
      displayName: input.displayName?.trim() || `${provider}:${externalAccountId}`,
      // Fail closed: a brand-new connection is unusable until verified.
      status: "paused",
      capabilities: [...input.capabilities],
      scopes: [...(input.scopes ?? [])],
      version: 1,
      createdBy: actor.actorId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (input.apiVersion) connection.apiVersion = input.apiVersion;
    if (input.credentialRef) connection.credentialRef = input.credentialRef;
    const { connection: stored } = await this.deps.store.createIfAbsent(connection);
    return stored;
  }

  async get(actor: GovernanceActor, tenantId: string, id: string): Promise<Connection> {
    requireCapability([...actor.roles], "connection:read", actor.actorId);
    assertTenantAccess(actor, tenantId);
    const found = await this.deps.store.get(tenantId, id);
    if (!found) throw new GovernanceNotFoundError("connection", id);
    return found;
  }

  async list(
    actor: GovernanceActor,
    tenantId: string,
    filter?: { status?: Connection["status"]; provider?: string },
  ): Promise<Connection[]> {
    requireCapability([...actor.roles], "connection:read", actor.actorId);
    assertTenantAccess(actor, tenantId);
    return this.deps.store.list(tenantId, filter);
  }

  /**
   * Probe the provider and only then activate. A failure parks the connection
   * in "error" and records the code — it never leaves it active.
   */
  async verify(actor: GovernanceActor, tenantId: string, id: string): Promise<Connection> {
    requireCapability([...actor.roles], "connection:write", actor.actorId);
    assertTenantAccess(actor, tenantId);
    const current = await this.deps.store.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("connection", id);
    if (current.status === "revoked") {
      throw new GovernanceConflictError(`connection "${id}" is revoked and cannot be verified`, "connection", id);
    }
    if (!this.deps.probe) {
      const parked = await this.deps.store.update(
        tenantId,
        id,
        {
          status: "error",
          lastErrorAt: this.now,
          lastErrorCode: "NO_PROBE_CONFIGURED",
        },
        current.version,
      );
      return parked;
    }
    let result: ConnectionProbeResult;
    try {
      result = await this.deps.probe(current);
    } catch (err) {
      result = {
        ok: false,
        errorCode: "PROBE_THREW",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    const patch: ConnectionPatch = result.ok
      ? {
          status: "active",
          lastVerifiedAt: this.now,
          ...(result.apiVersion ? { apiVersion: result.apiVersion } : {}),
        }
      : {
          status: "error",
          lastErrorAt: this.now,
          lastErrorCode: result.errorCode ?? "PROBE_FAILED",
        };
    return this.deps.store.update(tenantId, id, patch, current.version);
  }

  /** Pausing an already-paused or revoked connection is a no-op conflict. */
  async pause(actor: GovernanceActor, tenantId: string, id: string): Promise<Connection> {
    requireCapability([...actor.roles], "connection:write", actor.actorId);
    assertTenantAccess(actor, tenantId);
    const current = await this.deps.store.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("connection", id);
    if (current.status === "revoked") {
      throw new GovernanceConflictError(`connection "${id}" is revoked`, "connection", id);
    }
    if (current.status === "paused") return current;
    return this.deps.store.update(tenantId, id, { status: "paused" }, current.version);
  }

  /** Resuming requires a prior successful verification. */
  async resume(actor: GovernanceActor, tenantId: string, id: string): Promise<Connection> {
    requireCapability([...actor.roles], "connection:write", actor.actorId);
    assertTenantAccess(actor, tenantId);
    const current = await this.deps.store.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("connection", id);
    if (current.status === "revoked") {
      throw new GovernanceConflictError(`connection "${id}" is revoked`, "connection", id);
    }
    if (current.status === "active") return current;
    if (!current.lastVerifiedAt) {
      throw new GovernanceConflictError(
        `connection "${id}" has never been verified; run verification before resuming`,
        "connection",
        id,
      );
    }
    return this.deps.store.update(
      tenantId,
      id,
      { status: "active", lastErrorAt: undefined, lastErrorCode: undefined },
      current.version,
    );
  }

  /**
   * Rotate to a new credential reference. The connection goes back to
   * "paused" because the new credential is unproven.
   */
  async rotateCredential(
    actor: GovernanceActor,
    tenantId: string,
    id: string,
    credentialRef: string,
  ): Promise<Connection> {
    requireCapability([...actor.roles], "connection:rotate", actor.actorId);
    assertTenantAccess(actor, tenantId);
    assertOpaqueCredentialRef(credentialRef);
    const current = await this.deps.store.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("connection", id);
    if (current.status === "revoked") {
      throw new GovernanceConflictError(`connection "${id}" is revoked`, "connection", id);
    }
    return this.deps.store.update(
      tenantId,
      id,
      { credentialRef, status: "paused" },
      current.version,
    );
  }

  async revoke(actor: GovernanceActor, tenantId: string, id: string): Promise<Connection> {
    requireCapability([...actor.roles], "connection:write", actor.actorId);
    assertTenantAccess(actor, tenantId);
    const current = await this.deps.store.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("connection", id);
    if (current.status === "revoked") return current;
    return this.deps.store.update(
      tenantId,
      id,
      { status: "revoked", revokedAt: this.now },
      current.version,
    );
  }

  /** Hard delete, only after revocation. */
  async remove(actor: GovernanceActor, tenantId: string, id: string): Promise<void> {
    requireCapability([...actor.roles], "connection:write", actor.actorId);
    assertTenantAccess(actor, tenantId);
    const current = await this.deps.store.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("connection", id);
    if (current.status !== "revoked") {
      throw new GovernanceConflictError(
        `connection "${id}" must be revoked before deletion`,
        "connection",
        id,
      );
    }
    await this.deps.store.remove(tenantId, id);
  }

  /**
   * Gate used before any use of a connection. Only an active connection is
   * usable, and the requested capability must be declared on it.
   */
  async requireUsable(
    tenantId: string,
    id: string,
    capability: string,
  ): Promise<Connection> {
    const connection = await this.deps.store.get(tenantId, id);
    if (!connection) throw new GovernanceNotFoundError("connection", id);
    if (connection.status === "revoked") {
      throw new GovernanceConflictError(
        `connection "${id}" is revoked; it cannot perform "${capability}"`,
        "connection",
        id,
      );
    }
    if (connection.status !== "active") {
      throw new GovernanceConflictError(
        `connection "${id}" is ${connection.status}; only an active connection may perform "${capability}"`,
        "connection",
        id,
      );
    }
    if (!connection.capabilities.includes(capability)) {
      throw new GovernanceConflictError(
        `connection "${id}" does not declare capability "${capability}"`,
        "connection",
        id,
      );
    }
    return connection;
  }
}
