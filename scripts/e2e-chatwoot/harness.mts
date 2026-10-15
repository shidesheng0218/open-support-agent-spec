// Boots the real OSAS API for scripts/e2e-chatwoot.sh: creates and activates a
// Chatwoot connection, registers the webhook secret, then listens.
// Not part of the shipped product. Reads everything from the environment.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appUrl = new URL("../../apps/api/src/app.ts", import.meta.url);
const { buildApp } = (await import(fileURLToPath(appUrl))) as typeof import("../../apps/api/src/app.js");

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`harness: ${k} is required`);
  return v;
};
const TENANT = "tenant_demo";
const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "_");

const app = await buildApp({ logger: { level: "info" } });
const admin = { actorId: "e2e-admin", roles: ["admin"], tenantId: TENANT, authenticated: true } as const;
const conn = await app.governance.connections.create(admin, {
  tenantId: TENANT,
  provider: "chatwoot",
  externalAccountId: need("CHATWOOT_ACCOUNT_ID"),
  capabilities: ["ticket.read"],
});
await app.governance.stores.connections.update(
  TENANT,
  conn.id,
  { status: "active", lastVerifiedAt: new Date().toISOString() },
  conn.version,
);
process.env[`OSAS_CHATWOOT_WEBHOOK_SECRET_${norm(TENANT)}__${norm(conn.id)}`] = need("E2E_WEBHOOK_SECRET");
writeFileSync(need("E2E_CONN_FILE"), conn.id);
await app.listen({ port: Number(process.env.E2E_OSAS_PORT ?? 3001), host: "127.0.0.1" });
console.log("E2E_READY", conn.id);
