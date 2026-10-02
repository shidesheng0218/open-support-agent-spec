import { GOVERNANCE_SPEC_VERSION } from "@osas/governance";
import type {
  Membership,
  MembershipStore,
  Organization,
  OrganizationStore,
  Workspace,
  WorkspaceStore,
} from "@osas/governance";
import { GovernanceConflictError, GovernanceNotFoundError } from "@osas/governance";
import { ensureTenant, type Queryable } from "./pool.js";

/**
 * PostgreSQL governance identity stores (M1).
 *
 * Behavioural parity with the in-memory reference is the requirement, so the
 * shared rules are enforced in the database too rather than only in a service:
 * one workspace per tenant, one membership per (org, principal, workspace).
 */

interface OrganizationRow {
  organization_id: string;
  name: string;
  status: Organization["status"];
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface WorkspaceRow {
  workspace_id: string;
  organization_id: string;
  tenant_id: string;
  name: string;
  status: Workspace["status"];
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  membership_id: string;
  organization_id: string;
  workspace_id: string | null;
  principal_id: string;
  role: Membership["role"];
  created_by: string;
  created_at: Date;
}

const toOrganization = (r: OrganizationRow): Organization => ({
  id: r.organization_id,
  specVersion: GOVERNANCE_SPEC_VERSION,
  name: r.name,
  status: r.status,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.workspace_id,
  specVersion: GOVERNANCE_SPEC_VERSION,
  organizationId: r.organization_id,
  tenantId: r.tenant_id,
  name: r.name,
  status: r.status,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toMembership = (r: MembershipRow): Membership => {
  const membership: Membership = {
    id: r.membership_id,
    specVersion: GOVERNANCE_SPEC_VERSION,
    organizationId: r.organization_id,
    principalId: r.principal_id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
  if (r.workspace_id) membership.workspaceId = r.workspace_id;
  return membership;
};

/**
 * Build the JSONB patch payload. Presence is checked with hasOwnProperty so an
 * explicitly-undefined field is sent as JSON null and CLEARS the column —
 * COALESCE-style updates cannot express "clear this", and silently keeping a
 * stale last_error_code would be a lie.
 */
function toPatchJson<T extends object>(patch: T, keys: readonly string[]): string {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = (patch as Record<string, unknown>)[key] ?? null;
    }
  }
  return JSON.stringify(out);
}

export class PostgresOrganizationStore implements OrganizationStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresOrganizationStore {
    return new PostgresOrganizationStore(db);
  }

  async createIfAbsent(org: Organization) {
    const inserted = await this.db.query<OrganizationRow>(
      `INSERT INTO organizations (organization_id, name, status, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [org.id, org.name, org.status, org.version, org.createdAt, org.updatedAt],
    );
    if (inserted.rows.length === 1) {
      return { inserted: true, organization: toOrganization(inserted.rows[0]!) };
    }
    const existing = await this.get(org.id);
    if (!existing) {
      throw new GovernanceConflictError(`organization "${org.id}" could not be created`, "organization", org.id);
    }
    return { inserted: false, organization: existing };
  }

  async get(id: string) {
    const { rows } = await this.db.query<OrganizationRow>(
      "SELECT * FROM organizations WHERE organization_id = $1",
      [id],
    );
    const row = rows[0];
    return row ? toOrganization(row) : undefined;
  }

  async list() {
    const { rows } = await this.db.query<OrganizationRow>(
      "SELECT * FROM organizations ORDER BY created_at ASC, organization_id ASC",
    );
    return rows.map(toOrganization);
  }

  async update(
    id: string,
    patch: { name?: string; status?: Organization["status"] },
    expectedVersion: number,
  ) {
    const { rows } = await this.db.query<OrganizationRow>(
      `UPDATE organizations SET
         name   = CASE WHEN $3::jsonb ? 'name' THEN $3::jsonb->>'name' ELSE name END,
         status = CASE WHEN $3::jsonb ? 'status' THEN $3::jsonb->>'status' ELSE status END,
         version = version + 1,
         updated_at = $4
       WHERE organization_id = $1 AND version = $2
       RETURNING *`,
      [id, expectedVersion, toPatchJson(patch, ["name", "status"]), new Date().toISOString()],
    );
    const row = rows[0];
    if (row) return toOrganization(row);
    const current = await this.get(id);
    if (!current) throw new GovernanceNotFoundError("organization", id);
    throw new GovernanceConflictError(
      `organization "${id}" was modified (expected version ${expectedVersion}, found ${current.version})`,
      "organization",
      id,
    );
  }
}

export class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresWorkspaceStore {
    return new PostgresWorkspaceStore(db);
  }

  async createIfAbsent(ws: Workspace) {
    await ensureTenant(this.db, ws.tenantId);
    const inserted = await this.db.query<WorkspaceRow>(
      `INSERT INTO workspaces (workspace_id, organization_id, tenant_id, name, status, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [ws.id, ws.organizationId, ws.tenantId, ws.name, ws.status, ws.version, ws.createdAt, ws.updatedAt],
    );
    if (inserted.rows.length === 1) {
      return { inserted: true, workspace: toWorkspace(inserted.rows[0]!) };
    }
    const byId = await this.get(ws.id);
    if (byId) return { inserted: false, workspace: byId };
    const taken = await this.getByTenantId(ws.tenantId);
    throw new GovernanceConflictError(
      `tenant "${ws.tenantId}" already belongs to workspace "${taken?.id ?? "unknown"}"`,
      "workspace",
      ws.id,
    );
  }

  async get(id: string) {
    const { rows } = await this.db.query<WorkspaceRow>(
      "SELECT * FROM workspaces WHERE workspace_id = $1",
      [id],
    );
    const row = rows[0];
    return row ? toWorkspace(row) : undefined;
  }

  async getByTenantId(tenantId: string) {
    const { rows } = await this.db.query<WorkspaceRow>(
      "SELECT * FROM workspaces WHERE tenant_id = $1",
      [tenantId],
    );
    const row = rows[0];
    return row ? toWorkspace(row) : undefined;
  }

  async listByOrganization(organizationId: string) {
    const { rows } = await this.db.query<WorkspaceRow>(
      "SELECT * FROM workspaces WHERE organization_id = $1 ORDER BY created_at ASC, workspace_id ASC",
      [organizationId],
    );
    return rows.map(toWorkspace);
  }

  async update(
    id: string,
    patch: { name?: string; status?: Workspace["status"] },
    expectedVersion: number,
  ) {
    const { rows } = await this.db.query<WorkspaceRow>(
      `UPDATE workspaces SET
         name   = CASE WHEN $3::jsonb ? 'name' THEN $3::jsonb->>'name' ELSE name END,
         status = CASE WHEN $3::jsonb ? 'status' THEN $3::jsonb->>'status' ELSE status END,
         version = version + 1,
         updated_at = $4
       WHERE workspace_id = $1 AND version = $2
       RETURNING *`,
      [id, expectedVersion, toPatchJson(patch, ["name", "status"]), new Date().toISOString()],
    );
    const row = rows[0];
    if (row) return toWorkspace(row);
    const current = await this.get(id);
    if (!current) throw new GovernanceNotFoundError("workspace", id);
    throw new GovernanceConflictError(
      `workspace "${id}" was modified (expected version ${expectedVersion}, found ${current.version})`,
      "workspace",
      id,
    );
  }
}

export class PostgresMembershipStore implements MembershipStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresMembershipStore {
    return new PostgresMembershipStore(db);
  }

  async put(membership: Membership) {
    const { rows } = await this.db.query<MembershipRow>(
      `INSERT INTO workspace_members
         (membership_id, organization_id, workspace_id, principal_id, role, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, principal_id, COALESCE(workspace_id, '*'))
       DO UPDATE SET role = EXCLUDED.role, created_by = EXCLUDED.created_by
       RETURNING *`,
      [
        membership.id,
        membership.organizationId,
        membership.workspaceId ?? null,
        membership.principalId,
        membership.role,
        membership.createdBy,
        membership.createdAt,
      ],
    );
    return toMembership(rows[0]!);
  }

  async listByPrincipal(principalId: string) {
    const { rows } = await this.db.query<MembershipRow>(
      "SELECT * FROM workspace_members WHERE principal_id = $1 ORDER BY created_at ASC, membership_id ASC",
      [principalId],
    );
    return rows.map(toMembership);
  }

  async listByOrganization(organizationId: string) {
    const { rows } = await this.db.query<MembershipRow>(
      "SELECT * FROM workspace_members WHERE organization_id = $1 ORDER BY created_at ASC, membership_id ASC",
      [organizationId],
    );
    return rows.map(toMembership);
  }

  async remove(principalId: string, organizationId: string, workspaceId?: string) {
    const { rows } = await this.db.query<{ membership_id: string }>(
      `DELETE FROM workspace_members
        WHERE organization_id = $1 AND principal_id = $2
          AND COALESCE(workspace_id, '*') = COALESCE($3, '*')
        RETURNING membership_id`,
      [organizationId, principalId, workspaceId ?? null],
    );
    return rows.length > 0;
  }
}
