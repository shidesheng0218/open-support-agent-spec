import { createDemoFixtures } from "@osas/mock-backend";

type Any = Record<string, unknown>;

function asArray(v: unknown): Any[] {
  if (Array.isArray(v)) return v as Any[];
  if (v && typeof v === "object") return Object.values(v as Any) as Any[];
  return [];
}

export interface DemoData {
  policy: Any;
  customers: Any[];
  evidence: Any[];
  proposals: Any[];
  cases: Any[];
  orders: Any[];
}

/** Normalize createDemoFixtures() output (§11) into list-based access. */
export function loadDemo(): DemoData {
  const f = createDemoFixtures() as unknown as Any;
  const policy = (f.policy ?? asArray(f.policies)[0]) as Any | undefined;
  if (!policy) throw new Error("createDemoFixtures(): no demo TenantPolicy found");
  return {
    policy,
    customers: asArray(f.customers),
    evidence: asArray(f.evidence ?? f.evidences),
    proposals: asArray(f.proposals),
    cases: asArray(f.cases),
    orders: asArray(f.orders),
  };
}

export function customerById(demo: DemoData, id: string): Any {
  const c = demo.customers.find((x) => x.id === id);
  if (!c) throw new Error(`demo fixtures: customer ${id} not found`);
  return c;
}

/** Fresh (unexpired) evidence referencing ord_small. */
export function freshEvidence(demo: DemoData): Any {
  const now = Date.now();
  const ev = demo.evidence.find((e) => {
    const exp = e.expiresAt as string | undefined;
    return e.kind === "order" && (!exp || Date.parse(exp) > now);
  });
  if (!ev) throw new Error("demo fixtures: no fresh order evidence found");
  return ev;
}

/** Expired evidence fixture (ev_expired, §11). */
export function expiredEvidence(demo: DemoData): Any {
  const now = Date.now();
  const ev = demo.evidence.find(
    (e) => typeof e.expiresAt === "string" && Date.parse(e.expiresAt) <= now,
  );
  if (!ev) throw new Error("demo fixtures: no expired evidence (ev_expired) found");
  return ev;
}

let seq = 0;

/** Minimal contract-correct ActionProposal (§2), overridable per case. */
export function makeProposal(overrides: Any = {}): Any {
  const n = ++seq;
  const now = new Date().toISOString();
  return {
    id: `prop_compat_${n}`,
    specVersion: "0.1",
    tenantId: "tenant_demo",
    caseId: "case_refund",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_small" },
    requestedPermission: "request-approval",
    requestedBy: { actorType: "model", actorId: "model_mock-local" },
    amount: { currency: "USD", minorUnits: 2500 },
    evidenceIds: [],
    idempotencyKey: `ik_compat_${n}_${Date.now()}`,
    status: "proposed",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function reasonCodes(decision: Any): string[] {
  const reasons = (decision.reasons ?? []) as Any[];
  return reasons.map((r) => String(r.code));
}
