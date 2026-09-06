import { CAPABILITIES } from "@osas/core";
import { validate } from "@osas/schema-validator";
import { HttpClient, errorCode, isKnownProfile, isObject } from "./client.js";
import type {
  CompatRunReport,
  RunnerCheck,
  RunnerOptions,
  RunnerSuite,
} from "./types.js";

/**
 * Black-box OSAS compatibility runner (Milestone 4): drives a target
 * implementation over HTTP only — no imports from the target's code. Read-only
 * checks always run; the stateful suite (writes) runs only when a conformance
 * key is configured (OSAS_CONFORMANCE_MODE=true + OSAS_CONFORMANCE_KEY, or
 * --conformance-key), and the target must expose the conformance endpoints.
 */

class Collector {
  private readonly suites = new Map<string, RunnerCheck[]>();
  private current = "";

  suite(name: string): void {
    this.current = name;
    if (!this.suites.has(name)) this.suites.set(name, []);
  }

  skip(suite: string, name: string, detail: string): void {
    this.suite(suite);
    this.suites.get(suite)!.push({ name, status: "skip", detail });
  }

  async check(name: string, fn: () => void | string | Promise<void | string>): Promise<boolean> {
    const list = this.suites.get(this.current)!;
    try {
      const detail = await fn();
      list.push({ name, status: "pass", ...(typeof detail === "string" ? { detail } : {}) });
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      list.push({ name, status: "fail", detail });
      return false;
    }
  }

  build(options: RunnerOptions, stateful: boolean): CompatRunReport {
    const suites: RunnerSuite[] = [...this.suites.entries()].map(([name, checks]) => ({
      name,
      passed: checks.filter((c) => c.status === "pass").length,
      failed: checks.filter((c) => c.status === "fail").length,
      skipped: checks.filter((c) => c.status === "skip").length,
      checks,
    }));
    const totals = suites.reduce(
      (acc, s) => ({
        passed: acc.passed + s.passed,
        failed: acc.failed + s.failed,
        skipped: acc.skipped + s.skipped,
      }),
      { passed: 0, failed: 0, skipped: 0 },
    );
    return {
      specVersion: "0.1",
      generator: "@osas/compat-runner@0.1.1",
      target: options.target,
      runAt: new Date().toISOString(),
      mode: { stateful },
      ok: totals.failed === 0,
      totals,
      suites,
    };
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function expectStatus(actual: number, expected: number | number[], what: string, body?: unknown): void {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  if (!ok) {
    const code = errorCode(body);
    fail(`${what}: expected HTTP ${Array.isArray(expected) ? expected.join("/") : expected}, got ${actual}${code ? ` (${code})` : ""}`);
  }
}

function validateAgainst(schemaName: string, data: unknown): boolean {
  const result = validate(schemaName, data) as { valid: boolean } | boolean;
  return typeof result === "boolean" ? result : result.valid;
}

const usd = (minorUnits: number) => ({ currency: "USD", minorUnits });

/** Policy body the runner drafts on the target (deterministic lifecycle test). */
function runnerPolicy() {
  return {
    effectiveFrom: new Date().toISOString(),
    duplicateWindowSeconds: 86400,
    maxEvidenceAgeSeconds: 604800,
    defaultDecision: "block",
    rules: [
      {
        actionType: "refund",
        decision: "auto_execute",
        maxAmount: usd(5000),
        reasonCodes: ["damaged", "wrong_item", "not_received", "other"],
        requireVerifiedIdentity: true,
        identityMaxAgeSeconds: 7776000,
        allowedRegions: ["US", "CA", "GB", "DE", "FR", "JP", "AU"],
        blockedRegions: ["IR", "KP", "CU"],
      },
      { actionType: "create_note", decision: "auto_execute" },
    ],
  };
}

function refundSimulation(amountMinor: number, evidenceId: string) {
  return {
    caseId: "case_refund",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_small" },
    amount: usd(amountMinor),
    evidenceIds: [evidenceId],
  };
}

const freshEvidence = (id: string) => ({
  id,
  kind: "order",
  source: { system: "compat-runner", recordType: "order", recordId: "ord_small" },
  summary: "Order ord_small delivered, total $25.00 USD",
  data: { orderId: "ord_small", status: "delivered" },
  retrievedAt: new Date().toISOString(),
});

export async function runCompat(options: RunnerOptions): Promise<CompatRunReport> {
  const client = new HttpClient(options);
  const c = new Collector();
  const tenant = options.tenant ?? "tenant_demo";
  const conformanceKey = options.conformanceKey;
  const stateful = Boolean(conformanceKey);

  /* ---------------- discovery (read-only) ---------------- */
  c.suite("discovery");

  let wellKnown: unknown;
  await c.check("GET /.well-known/osas responds 200 with a JSON object", async () => {
    const res = await client.get("/.well-known/osas");
    expectStatus(res.status, 200, "well-known", res.body);
    if (!isObject(res.body)) fail("well-known response is not a JSON object");
    wellKnown = res.body;
  });

  await c.check('specVersion is "0.1"', async () => {
    if (!isObject(wellKnown)) fail("no well-known document to inspect");
    if (wellKnown.specVersion !== "0.1") {
      fail(`specVersion is ${JSON.stringify(wellKnown.specVersion)}, expected "0.1"`);
    }
    return `specVersion=${wellKnown.specVersion}`;
  });

  let manifest: unknown;
  await c.check("CapabilityManifest is published and validates against core/capability-manifest", async () => {
    if (isObject(wellKnown) && isObject(wellKnown.capabilities)) {
      manifest = wellKnown.capabilities;
    } else {
      const res = await client.get("/v1/capabilities");
      expectStatus(res.status, 200, "GET /v1/capabilities", res.body);
      manifest = res.body;
    }
    if (!validateAgainst("core/capability-manifest", manifest)) {
      fail("CapabilityManifest failed core/capability-manifest validation");
    }
  });

  await c.check("manifest declares known Profiles and spec-known capabilities", async () => {
    if (!isObject(manifest) || !Array.isArray(manifest.profiles)) fail("no manifest to inspect");
    const profiles = manifest.profiles as Record<string, unknown>[];
    if (profiles.length === 0) fail("manifest declares zero profiles");
    const unknown: string[] = [];
    for (const p of profiles) {
      if (!isKnownProfile(p.name)) unknown.push(`profile ${String(p.name)}`);
      for (const cap of (p.capabilities as string[]) ?? []) {
        if (!(CAPABILITIES as readonly string[]).includes(cap)) unknown.push(`capability ${cap}`);
      }
    }
    if (unknown.length > 0) fail(`unknown entries: ${unknown.join(", ")}`);
    return `profiles=${profiles.map((p) => String(p.name)).join(",")}`;
  });

  /* ---------------- schemas & tools (read-only) ---------------- */
  c.suite("schemas-tools");

  await c.check("GET /v1/schemas lists the schema manifest", async () => {
    const res = await client.get("/v1/schemas");
    expectStatus(res.status, 200, "GET /v1/schemas", res.body);
    if (!isObject(res.body) || !Array.isArray(res.body.schemas)) fail("schema manifest has no schemas array");
    const names = (res.body.schemas as { name?: string }[]).map((s) => s.name);
    if (!names.includes("core/action-proposal")) fail("schema manifest lacks core/action-proposal");
  });

  await c.check("GET /v1/schemas/core/action-proposal returns a JSON Schema", async () => {
    const res = await client.get(`/v1/schemas/${encodeURIComponent("core/action-proposal")}`);
    expectStatus(res.status, 200, "GET schema", res.body);
    if (!isObject(res.body) || (res.body.type !== "object" && !isObject(res.body.properties))) {
      fail("response does not look like a JSON Schema");
    }
  });

  await c.check("GET /v1/meta/tools lists tools with schema + capability mapping", async () => {
    const res = await client.get("/v1/meta/tools");
    expectStatus(res.status, 200, "GET /v1/meta/tools", res.body);
    if (!Array.isArray(res.body) || res.body.length === 0) fail("tool list is empty");
    for (const tool of res.body as Record<string, unknown>[]) {
      if (typeof tool.name !== "string" || !isObject(tool.inputSchema)) {
        fail(`tool ${JSON.stringify(tool.name)} lacks name/inputSchema`);
      }
      if (
        typeof tool.capabilityRequired !== "string" ||
        !(CAPABILITIES as readonly string[]).includes(tool.capabilityRequired)
      ) {
        fail(`tool ${String(tool.name)} has unknown capabilityRequired ${String(tool.capabilityRequired)}`);
      }
    }
    return `tools=${(res.body as unknown[]).length}`;
  });

  const now = new Date().toISOString();
  const validProposal = {
    id: "prop_validate_probe",
    specVersion: "0.1",
    tenantId: tenant,
    caseId: "case_probe",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_probe" },
    requestedPermission: "request-approval",
    requestedBy: { actorType: "human", actorId: "compat-runner" },
    amount: usd(2500),
    evidenceIds: [],
    idempotencyKey: "idem_validate_probe",
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };

  await c.check("POST /v1/validate accepts a valid ActionProposal", async () => {
    const res = await client.post("/v1/validate", { schemaName: "core/action-proposal", data: validProposal });
    expectStatus(res.status, 200, "POST /v1/validate", res.body);
    if (!isObject(res.body) || res.body.valid !== true) {
      fail(`valid proposal reported invalid: ${JSON.stringify(res.body)}`);
    }
  });

  await c.check("POST /v1/validate rejects an invalid ActionProposal", async () => {
    const res = await client.post("/v1/validate", {
      schemaName: "core/action-proposal",
      data: { ...validProposal, actionType: "not_an_action" },
    });
    expectStatus(res.status, 200, "POST /v1/validate", res.body);
    if (!isObject(res.body) || res.body.valid !== false) fail("invalid proposal reported valid");
  });

  /* ---------------- policy surface (read-only) ---------------- */
  c.suite("policy-read");

  await c.check("GET /v1/policies/:tenant returns the active TenantPolicy", async () => {
    const res = await client.get(`/v1/policies/${tenant}`);
    expectStatus(res.status, 200, "GET active policy", res.body);
    if (!validateAgainst("core/tenant-policy", res.body)) {
      fail("active policy failed core/tenant-policy validation");
    }
  });

  await c.check("POST /v1/policies/:tenant/simulate with an unknown version is rejected (404)", async () => {
    const res = await client.post(`/v1/policies/${tenant}/simulate`, {
      version: "0.0.0-nonexistent",
      proposal: refundSimulation(2500, "ev_probe"),
    });
    expectStatus(res.status, 404, "simulate unknown version", res.body);
  });

  /* ---------------- stateful suite (conformance mode only) ---------------- */
  c.suite("stateful");

  if (!stateful) {
    c.skip(
      "stateful",
      "all stateful checks",
      "conformance key not configured (set OSAS_CONFORMANCE_MODE=true + OSAS_CONFORMANCE_KEY or --conformance-key)",
    );
    return c.build(options, false);
  }

  await c.check("conformance endpoints reject a wrong key (403)", async () => {
    const res = await client.post("/v1/conformance/reset", undefined, { conformanceKey: "definitely-wrong" });
    expectStatus(res.status, [401, 403], "wrong conformance key", res.body);
  });

  const resetOk = await c.check("POST /v1/conformance/reset restores the demo fixture state", async () => {
    const res = await client.post("/v1/conformance/reset", undefined, { conformanceKey });
    expectStatus(res.status, 200, "conformance reset", res.body);
    if (!isObject(res.body) || !isObject(res.body.snapshot) || !isObject(res.body.snapshot.counts)) {
      fail("reset response has no snapshot.counts");
    }
    const counts = res.body.snapshot.counts as Record<string, number>;
    if ((counts.cases ?? 0) < 1) {
      fail("reset did not restore demo cases");
    }
  });

  if (!resetOk) {
    c.skip("stateful", "remaining stateful checks", "conformance reset failed — target may not support conformance mode");
    return c.build(options, true);
  }

  await c.check("GET /v1/conformance/snapshot reports an intact audit chain", async () => {
    const res = await client.get("/v1/conformance/snapshot", { conformanceKey });
    expectStatus(res.status, 200, "conformance snapshot", res.body);
    if (!isObject(res.body) || !isObject(res.body.auditChain) || res.body.auditChain.intact !== true) {
      fail("snapshot.auditChain is not intact");
    }
  });

  // --- policy simulation + lifecycle state machine ---
  let draftVersion = "";
  await c.check("policy lifecycle: draft -> simulate -> approve -> activate -> retire", async () => {
    const draft = await client.post(`/v1/policies/${tenant}/drafts`, runnerPolicy());
    expectStatus(draft.status, 201, "create draft", draft.body);
    if (!isObject(draft.body) || typeof draft.body.version !== "string") fail("draft has no version");
    draftVersion = draft.body.version;

    const simulate = async (proposal: unknown, customer: string, evidence: unknown[]) => {
      const res = await client.post(`/v1/policies/${tenant}/simulate`, {
        version: draftVersion,
        proposal,
        customer,
        evidence,
      });
      expectStatus(res.status, 200, "simulate", res.body);
      if (!isObject(res.body) || !isObject(res.body.decision)) fail("simulate response has no decision");
      return (res.body.decision as Record<string, unknown>).decision;
    };

    const small = await simulate(refundSimulation(2500, "ev_conf_small"), "cus_verified", [freshEvidence("ev_conf_small")]);
    if (small !== "auto_execute") fail(`small verified refund: expected auto_execute, got ${String(small)}`);
    const large = await simulate(refundSimulation(90000, "ev_conf_large"), "cus_verified", [freshEvidence("ev_conf_large")]);
    if (large !== "require_approval") fail(`over-threshold refund: expected require_approval, got ${String(large)}`);
    const unverified = await simulate(refundSimulation(2500, "ev_conf_unv"), "cus_unverified", [freshEvidence("ev_conf_unv")]);
    if (unverified !== "block") fail(`unverified-identity refund: expected block, got ${String(unverified)}`);

    const approve = await client.post(`/v1/policies/${tenant}/versions/${draftVersion}/approve`);
    expectStatus(approve.status, 200, "approve", approve.body);
    const activate = await client.post(`/v1/policies/${tenant}/versions/${draftVersion}/activate`);
    expectStatus(activate.status, 200, "activate", activate.body);
    const active = await client.get(`/v1/policies/${tenant}`);
    if (!isObject(active.body) || active.body.version !== draftVersion) {
      fail(`active policy version is ${isObject(active.body) ? String(active.body.version) : "?"}, expected ${draftVersion}`);
    }
    const retire = await client.post(`/v1/policies/${tenant}/versions/${draftVersion}/retire`);
    expectStatus(retire.status, 200, "retire", retire.body);
    return `version=${draftVersion}`;
  });

  await c.check("policy state machine rejects illegal transitions (approve before simulate -> 409)", async () => {
    const draft = await client.post(`/v1/policies/${tenant}/drafts`, runnerPolicy());
    expectStatus(draft.status, 201, "create second draft", draft.body);
    const version = isObject(draft.body) ? String(draft.body.version) : "";
    const res = await client.post(`/v1/policies/${tenant}/versions/${version}/approve`);
    expectStatus(res.status, 409, "approve without simulate", res.body);
  });

  await c.check("the active policy is immutable (PUT -> 409 POLICY_IMMUTABLE)", async () => {
    const res = await client.put(`/v1/policies/${tenant}`, runnerPolicy());
    expectStatus(res.status, 409, "PUT active policy", res.body);
    if (errorCode(res.body) !== "POLICY_IMMUTABLE") fail(`expected POLICY_IMMUTABLE, got ${String(errorCode(res.body))}`);
  });

  // --- idempotent execution ---
  await c.check("execution is idempotent: same idempotencyKey replays instead of re-executing", async () => {
    const idem = `idem_compat_${Date.now()}`;
    const created = await client.post("/v1/proposals", {
      caseId: "case_refund",
      profile: "ecommerce",
      actionType: "refund",
      reasonCode: "damaged",
      params: { orderId: "ord_small" },
      requestedPermission: "request-approval",
      requestedBy: { actorType: "human", actorId: "compat-runner" },
      amount: usd(2500),
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: idem,
    });
    expectStatus(created.status, 201, "create proposal", created.body);
    const id = isObject(created.body) ? String(created.body.id) : fail("proposal has no id");

    const evaluated = await client.post(`/v1/proposals/${id}/evaluate`);
    expectStatus(evaluated.status, 200, "evaluate", evaluated.body);
    const decision = isObject(evaluated.body) && isObject(evaluated.body.decision)
      ? evaluated.body.decision.decision
      : undefined;
    if (decision !== "auto_execute") fail(`expected auto_execute, got ${String(decision)}`);

    const first = await client.post(`/v1/proposals/${id}/execute`);
    expectStatus(first.status, 200, "first execute", first.body);
    if (!isObject(first.body) || first.body.replayed === true) fail("first execution must not be a replay");

    const second = await client.post(`/v1/proposals/${id}/execute`);
    expectStatus(second.status, 200, "second execute", second.body);
    if (!isObject(second.body) || second.body.replayed !== true) {
      fail("second execution with the same idempotencyKey was not replayed");
    }
  });

  // --- permissions ---
  await c.check("support_agent cannot administer policies (403 POLICY_ADMIN_REQUIRED)", async () => {
    const res = await client.post(`/v1/policies/${tenant}/drafts`, runnerPolicy(), { role: "support_agent" });
    expectStatus(res.status, 403, "draft as support_agent", res.body);
  });

  await c.check("cross-tenant access is rejected (403 TENANT_MISMATCH)", async () => {
    const res = await client.get("/v1/policies/tenant_other");
    expectStatus(res.status, 403, "cross-tenant policy read", res.body);
  });

  // --- audit chain ---
  await c.check("audit chain verifies and records the lifecycle events", async () => {
    const verify = await client.get("/v1/audit/verify");
    expectStatus(verify.status, 200, "audit verify", verify.body);
    if (!isObject(verify.body) || verify.body.intact !== true) fail("audit chain is not intact");
    const events = await client.get("/v1/audit");
    expectStatus(events.status, 200, "audit list", events.body);
    const types = new Set(
      (Array.isArray(events.body) ? (events.body as Record<string, unknown>[]) : []).map((e) => e.eventType),
    );
    for (const required of ["policy_draft_created", "policy_activated", "execution_succeeded"]) {
      if (!types.has(required)) fail(`audit stream lacks ${required} (has: ${[...types].join(", ")})`);
    }
  });

  await c.check("cleanup: final conformance reset leaves a clean demo state", async () => {
    const res = await client.post("/v1/conformance/reset", undefined, { conformanceKey });
    expectStatus(res.status, 200, "final reset", res.body);
  });

  return c.build(options, true);
}
