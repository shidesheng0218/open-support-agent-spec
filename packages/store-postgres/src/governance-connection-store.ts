import { GOVERNANCE_SPEC_VERSION } from "@osas/governance";
import type { Connection, ConnectionPatch, ConnectionStore } from "@osas/governance";
import { GovernanceConflictError, GovernanceNotFoundError } from "@osas/governance";
import { ensureTenant, type Queryable } from "./pool.js";

/** PostgreSQL connection store (M1). Compare-and-set on `version`. */

interface ConnectionRow {
  tenant_id: string;
  connection_id: string;
  provider: string;
  external_account_id: string;
  display_name: string;
  status: Connection["status"];
  capabilities: string[];
  scopes: string[];
  api_version: string | null;
  credential_ref: string | null;
  last_verified_at: Date | null;
  last_error_at: Date | null;
  last_error_code: string | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

function toConnection(r: ConnectionRow): Connection {
  const connection: Connection = {
    id: r.connection_id,
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: r.tenant_id,
    provider: r.provider,
    externalAccountId: r.external_account_id,
    displayName: r.display_name,
    status: r.status,
    capabilities: r.capabilities,
    scopes: r.scopes,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
  if (r.api_version) connection.apiVersion = r.api_version;
  if (r.credential_ref) connection.credentialRef = r.credential_ref;
  if (r.last_verified_at) connection.lastVerifiedAt = r.last_verified_at.toISOString();
  if (r.last_error_at) connection.lastErrorAt = r.last_error_at.toISOString();
  if (r.last_error_code) connection.lastErrorCode = r.last_error_code;
  if (r.revoked_at) connection.revokedAt = r.revoked_at.toISOString();
  return connection;
}

const PATCH_KEYS = [
  "displayName",
  "status",
  "capabilities",
  "scopes",
  "apiVersion",
  "credentialRef",
  "lastVerifiedAt",
  "lastErrorAt",
  "lastErrorCode",
  "revokedAt",
] as const;

export class PostgresConnectionStore implements ConnectionStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresConnectionStore {
    return new PostgresConnectionStore(db);
  }

  async createIfAbsent(connection: Connection) {
    await ensureTenant(this.db, connection.tenantId);
    const inserted = await this.db.query<ConnectionRow>(
      `INSERT INTO connections
         (tenant_id, connection_id, provider, external_account_id, display_name, status,
          capabilities, scopes, api_version, credential_ref, last_verified_at,
          last_error_at, last_error_code, version, created_by, created_at, updated_at,
          revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        connection.tenantId,
        connection.id,
        connection.provider,
        connection.externalAccountId,
        connection.displayName,
        connection.status,
        JSON.stringify(connection.capabilities),
        JSON.stringify(connection.scopes),
        connection.apiVersion ?? null,
        connection.credentialRef ?? null,
        connection.lastVerifiedAt ?? null,
        connection.lastErrorAt ?? null,
        connection.lastErrorCode ?? null,
        connection.version,
        connection.createdBy,
        connection.createdAt,
        connection.updatedAt,
        connection.revokedAt ?? null,
      ],
    );
    if (inserted.rows.length === 1) {
      return { inserted: true, connection: toConnection(inserted.rows[0]!) };
    }
    const byId = await this.get(connection.tenantId, connection.id);
    if (byId) return { inserted: false, connection: byId };
    // The only other conflict is the live-account unique index.
    const { rows } = await this.db.query<{ connection_id: string }>(
      `SELECT connection_id FROM connections
        WHERE tenant_id = $1 AND provider = $2 AND external_account_id = $3 AND status <> 'revoked'`,
      [connection.tenantId, connection.provider, connection.externalAccountId],
    );
    throw new GovernanceConflictError(
      `tenant "${connection.tenantId}" already has a live ${connection.provider} connection for "${connection.externalAccountId}"`,
      "connection",
      rows[0]?.connection_id,
    );
  }

  async get(tenantId: string, id: string) {
    const { rows } = await this.db.query<ConnectionRow>(
      "SELECT * FROM connections WHERE tenant_id = $1 AND connection_id = $2",
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toConnection(row) : undefined;
  }

  async list(tenantId: string, filter?: { status?: Connection["status"]; provider?: string }) {
    const { rows } = await this.db.query<ConnectionRow>(
      `SELECT * FROM connections
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR provider = $3)
        ORDER BY created_at ASC, connection_id ASC`,
      [tenantId, filter?.status ?? null, filter?.provider ?? null],
    );
    return rows.map(toConnection);
  }

  async update(
    tenantId: string,
    id: string,
    patch: ConnectionPatch,
    expectedVersion: number,
  ) {
    const json: Record<string, unknown> = {};
    for (const key of PATCH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        json[key] = (patch as Record<string, unknown>)[key] ?? null;
      }
    }
    const { rows } = await this.db.query<ConnectionRow>(
      `UPDATE connections SET
         display_name     = CASE WHEN $4::jsonb ? 'displayName' THEN $4::jsonb->>'displayName' ELSE display_name END,
         status           = CASE WHEN $4::jsonb ? 'status' THEN $4::jsonb->>'status' ELSE status END,
         capabilities     = CASE WHEN $4::jsonb ? 'capabilities' THEN $4::jsonb->'capabilities' ELSE capabilities END,
         scopes           = CASE WHEN $4::jsonb ? 'scopes' THEN $4::jsonb->'scopes' ELSE scopes END,
         api_version      = CASE WHEN $4::jsonb ? 'apiVersion' THEN $4::jsonb->>'apiVersion' ELSE api_version END,
         credential_ref   = CASE WHEN $4::jsonb ? 'credentialRef' THEN $4::jsonb->>'credentialRef' ELSE credential_ref END,
         last_verified_at = CASE WHEN $4::jsonb ? 'lastVerifiedAt' THEN ($4::jsonb->>'lastVerifiedAt')::timestamptz ELSE last_verified_at END,
         last_error_at    = CASE WHEN $4::jsonb ? 'lastErrorAt' THEN ($4::jsonb->>'lastErrorAt')::timestamptz ELSE last_error_at END,
         last_error_code  = CASE WHEN $4::jsonb ? 'lastErrorCode' THEN $4::jsonb->>'lastErrorCode' ELSE last_error_code END,
         revoked_at       = CASE WHEN $4::jsonb ? 'revokedAt' THEN ($4::jsonb->>'revokedAt')::timestamptz ELSE revoked_at END,
         version = version + 1,
         updated_at = $5
       WHERE tenant_id = $1 AND connection_id = $2 AND version = $3
       RETURNING *`,
      [tenantId, id, expectedVersion, JSON.stringify(json), new Date().toISOString()],
    );
    const row = rows[0];
    if (row) return toConnection(row);
    const current = await this.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("connection", id);
    throw new GovernanceConflictError(
      `connection "${id}" was modified (expected version ${expectedVersion}, found ${current.version})`,
      "connection",
      id,
    );
  }

  async remove(tenantId: string, id: string) {
    const { rows } = await this.db.query<{ connection_id: string }>(
      "DELETE FROM connections WHERE tenant_id = $1 AND connection_id = $2 RETURNING connection_id",
      [tenantId, id],
    );
    return rows.length > 0;
  }
}
