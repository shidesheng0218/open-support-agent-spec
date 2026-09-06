import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupportAdapter, ToolContext } from "@osas/adapter";
import { verifyAuditChain } from "@osas/policy-engine";
import { createDemoFixtures, type DemoFixtures } from "@osas/mock-backend";
import { ForbiddenError } from "../auth.js";
import { SchemaInvalidError } from "../plugins.js";
import { ctxFor } from "./basic.js";

/**
 * Conformance Mode endpoints (Milestone 4) — TEST ONLY.
 *
 * Registered exclusively when OSAS_CONFORMANCE_MODE=true (which fails closed
 * with NODE_ENV=production and requires OSAS_CONFORMANCE_KEY). They give the
 * black-box compat runner (packages/compat-runner) a deterministic base
 * state: reset, fixture load, and a state snapshot. Every endpoint requires
 * the X-OSAS-Conformance-Key header. NEVER enable in production — see
 * docs/conformance.md.
 */

const CONFORMANCE_KEY_HEADER = "x-osas-conformance-key";

function keyMatches(presented: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual never leaks the expected length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function requireConformanceKey(req: FastifyRequest, expected: string): void {
  const raw = req.headers[CONFORMANCE_KEY_HEADER];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (!presented || !keyMatches(presented, expected)) {
    throw new ForbiddenError(
      `Missing or invalid ${CONFORMANCE_KEY_HEADER} header for conformance endpoint`,
    );
  }
}

type Resettable = { reset(fixtures?: DemoFixtures): unknown };

function emptyFixtures(): DemoFixtures {
  return {
    ...createDemoFixtures(),
    customers: [],
    orders: [],
    shipments: [],
    subscriptions: [],
    invoices: [],
    creditBalances: [],
    knowledgeArticles: [],
    cases: [],
    evidence: [],
    proposals: [],
  };
}

async function snapshot(app: FastifyInstance, ctx: ToolContext) {
  const adapter: SupportAdapter = app.adapter;
  const [cases, proposals, handoffs, auditEvents, policyVersions, shadowRuns, usage] =
    await Promise.all([
      adapter.searchCases(ctx, {}),
      adapter.listProposals(ctx, {}),
      adapter.listHandoffs(ctx, {}),
      adapter.listAuditEvents(ctx, {}),
      app.policyStore.list(ctx.tenantId),
      app.shadowRunStore.list(ctx.tenantId),
      app.usageStore.query({ tenantId: ctx.tenantId }),
    ]);
  return {
    tenantId: ctx.tenantId,
    counts: {
      cases: cases.length,
      proposals: proposals.length,
      handoffs: handoffs.length,
      auditEvents: auditEvents.length,
      policyVersions: policyVersions.length,
      shadowRuns: shadowRuns.length,
      usageRecords: usage.length,
    },
    auditChain: verifyAuditChain(auditEvents),
  };
}

async function resetAll(app: FastifyInstance, fixtures: DemoFixtures): Promise<void> {
  const adapter = app.adapter as SupportAdapter & Partial<Resettable>;
  if (typeof adapter.reset !== "function") {
    throw new SchemaInvalidError([
      { message: "the configured adapter does not support conformance reset" },
    ]);
  }
  adapter.reset(fixtures);

  if (app.pgPool) {
    // PostgreSQL-backed stores: clear the rows (adapter state above is still
    // the in-memory mock). Table set mirrors migrations 0001/0002.
    await app.pgPool.query(
      "DELETE FROM execution_records; DELETE FROM shadow_runs; " +
        "DELETE FROM model_usage; DELETE FROM audit_events; DELETE FROM policy_versions",
    );
    return;
  }
  for (const store of [app.executionStore, app.policyStore, app.shadowRunStore, app.usageStore]) {
    (store as Partial<Resettable>).reset?.();
  }
}

export async function conformanceRoutes(app: FastifyInstance): Promise<void> {
  const key = app.conformanceConfig?.key;
  if (!app.conformanceConfig?.enabled || !key) {
    throw new Error("conformanceRoutes registered without a conformance key — this is a bug");
  }

  app.addHook("preHandler", async (req) => requireConformanceKey(req, key));

  app.post("/v1/conformance/reset", async (req) => {
    await resetAll(app, createDemoFixtures());
    return { reset: true, fixture: "demo", snapshot: await snapshot(app, ctxFor(req)) };
  });

  app.post("/v1/conformance/fixtures/load", async (req) => {
    const body = (req.body ?? {}) as { name?: string };
    if (body.name !== "demo" && body.name !== "empty") {
      throw new SchemaInvalidError([
        { message: 'body must be { name: "demo" | "empty" }' },
      ]);
    }
    const fixtures = body.name === "demo" ? createDemoFixtures() : emptyFixtures();
    await resetAll(app, fixtures);
    return { loaded: body.name, snapshot: await snapshot(app, ctxFor(req)) };
  });

  app.get("/v1/conformance/snapshot", async (req) => snapshot(app, ctxFor(req)));
}
