import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { GenerateKeyPairResult, JWK } from "jose";
import { buildApp } from "./app.js";
import { AuthConfigError, loadAuthConfig, type AuthConfig } from "./auth.js";

const ISSUER = "https://issuer.test";
const AUDIENCE = "osas-api";

// Local in-process JWKS endpoint — fully offline (loopback only).
let jwksServer: Server;
let jwksUrl: string;
let keys: GenerateKeyPairResult;
let publicJwk: JWK;

beforeAll(async () => {
  keys = await generateKeyPair("ES256");
  publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = "test-key-1";
  publicJwk.alg = "ES256";
  jwksServer = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const { port } = jwksServer.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`;
});

afterAll(async () => {
  await new Promise((resolve) => jwksServer.close(resolve));
});

const jwtConfig: AuthConfig = {
  mode: "jwt",
  nodeEnv: "test",
  jwksUrl: "",
  jwtIssuer: ISSUER,
  jwtAudience: AUDIENCE,
};

function cfg(): AuthConfig {
  return { ...jwtConfig, jwksUrl };
}

async function sign(claims: Record<string, unknown>, opts: { kid?: string } = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: opts.kid ?? "test-key-1" })
    .setSubject(typeof claims.sub === "string" ? claims.sub : "user-test")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(keys.privateKey);
}

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function jwtApp(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false, auth: cfg() });
  apps.push(app);
  return app;
}

describe("auth config (fail closed)", () => {
  it("rejects demo mode in production", () => {
    expect(() =>
      loadAuthConfig({ NODE_ENV: "production", OSAS_AUTH_MODE: "demo" }),
    ).toThrowError(AuthConfigError);
  });

  it("demo is the default outside production", () => {
    expect(loadAuthConfig({}).mode).toBe("demo");
  });

  it("rejects an unknown auth mode", () => {
    expect(() => loadAuthConfig({ OSAS_AUTH_MODE: "none" })).toThrowError(AuthConfigError);
  });

  it("jwt mode requires JWKS url, issuer and audience", () => {
    expect(() => loadAuthConfig({ OSAS_AUTH_MODE: "jwt" })).toThrowError(AuthConfigError);
    expect(() =>
      loadAuthConfig({
        OSAS_AUTH_MODE: "jwt",
        OSAS_JWKS_URL: "https://example.test/jwks.json",
        OSAS_JWT_ISSUER: ISSUER,
        OSAS_JWT_AUDIENCE: AUDIENCE,
      }),
    ).not.toThrow();
  });

  it("buildApp fails closed on production + demo", async () => {
    await expect(
      buildApp({ logger: false, env: { NODE_ENV: "production", OSAS_AUTH_MODE: "demo" } }),
    ).rejects.toThrowError(AuthConfigError);
  });
});

describe("demo mode", () => {
  it("defaults to support_agent on the default tenant", async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/v1/cases" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects unknown demo roles", async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/cases",
      headers: { "x-osas-role": "superadmin" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses to grant system_executor to external requests", async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/cases",
      headers: { "x-osas-role": "system_executor" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("enforces tenant match between header and path parameter", async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/policies/tenant_demo/versions",
      headers: { "x-tenant-id": "tenant_other" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TENANT_MISMATCH");
  });
});

describe("jwt mode", () => {
  it("rejects requests without a bearer token", async () => {
    const app = await jwtApp();
    const res = await app.inject({ method: "GET", url: "/v1/cases" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("keeps /health anonymous for liveness probes", async () => {
    const app = await jwtApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("rejects tokens with a wrong audience", async () => {
    const app = await jwtApp();
    const token = await new SignJWT({ tenant_id: "tenant_a", roles: ["support_agent"] })
      .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
      .setSubject("agent-1")
      .setIssuer(ISSUER)
      .setAudience("someone-else")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(keys.privateKey);
    const res = await app.inject({
      method: "GET",
      url: "/v1/cases",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects tokens missing tenant_id or roles", async () => {
    const app = await jwtApp();
    const noTenant = await sign({ roles: ["support_agent"] }, {});
    // sub missing too
    const res1 = await app.inject({
      method: "GET",
      url: "/v1/cases",
      headers: { authorization: `Bearer ${noTenant}` },
    });
    expect(res1.statusCode).toBe(401);
    const noRoles = await sign({ tenant_id: "tenant_a" });
    const res2 = await app.inject({
      method: "GET",
      url: "/v1/cases",
      headers: { authorization: `Bearer ${noRoles}` },
    });
    expect(res2.statusCode).toBe(401);
  });

  it("rejects external tokens carrying system_executor", async () => {
    const app = await jwtApp();
    const token = await sign({ tenant_id: "tenant_a", roles: ["system_executor"] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/cases",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("scopes requests to the token tenant and ignores x-tenant-id", async () => {
    const app = await jwtApp();
    const token = await sign({ tenant_id: "tenant_a", roles: ["policy_admin"] });
    const auth = { authorization: `Bearer ${token}` };

    // Header claiming another tenant is ignored; the policy list is tenant_a's.
    const list = await app.inject({
      method: "GET",
      url: "/v1/policies/tenant_a/versions",
      headers: { ...auth, "x-tenant-id": "tenant_b" },
    });
    expect(list.statusCode).toBe(200);

    // ...but the path parameter may not target another tenant.
    const cross = await app.inject({
      method: "GET",
      url: "/v1/policies/tenant_b/versions",
      headers: auth,
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error.code).toBe("TENANT_MISMATCH");
  });

  it("enforces policy_admin from token roles", async () => {
    const app = await jwtApp();
    const agentToken = await sign({ tenant_id: "tenant_a", roles: ["support_agent"] });
    const draft = {
      version: "9.9.9",
      effectiveFrom: new Date().toISOString(),
      duplicateWindowSeconds: 86400,
      maxEvidenceAgeSeconds: 604800,
      defaultDecision: "block",
      rules: [],
    };
    const denied = await app.inject({
      method: "POST",
      url: "/v1/policies/tenant_a/drafts",
      headers: { authorization: `Bearer ${agentToken}`, "x-osas-role": "policy_admin" },
      payload: draft,
    });
    expect(denied.statusCode).toBe(403);

    const adminToken = await sign({ tenant_id: "tenant_a", roles: ["policy_admin"] });
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/policies/tenant_a/drafts",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: draft,
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("cannot read another tenant's audit stream", async () => {
    const app = await jwtApp();
    const tokenA = await sign({ tenant_id: "tenant_a", roles: ["auditor", "policy_admin"] });
    // create some activity in tenant_a
    await app.inject({
      method: "GET",
      url: "/v1/policies/tenant_a/versions",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const audit = await app.inject({
      method: "GET",
      url: "/v1/audit",
      headers: { authorization: `Bearer ${tokenA}`, "x-tenant-id": "tenant_b" },
    });
    expect(audit.statusCode).toBe(200);
    for (const event of audit.json() as Array<{ tenantId: string }>) {
      expect(event.tenantId).toBe("tenant_a");
    }
  });
});
