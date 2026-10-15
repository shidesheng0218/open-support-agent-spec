import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ToolContext } from "@osas/adapter";
import { buildApp } from "./app.js";
import { ConfigError } from "./config.js";
import { loadSlackConfig } from "./slack/config.js";
import { createSlackClient, type SlackHttp, type SlackHttpRequest } from "./slack/client.js";
import { approvalCard, parseButtonValue } from "./slack/card.js";
import { signSlackRequest, verifySlackSignature } from "./slack/signature.js";

const TENANT = "tenant_demo";
const SECRET = "slack-signing-secret-for-tests";
const CHANNEL = "C0123ABCD";
const APPROVER = "U0APPROVER1";
const ENV = {
  OSAS_EXECUTION_MODE: "sandbox",
  SLACK_BOT_TOKEN: "xoxb-test-token-not-real",
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_APPROVAL_CHANNEL: CHANNEL,
  OSAS_SLACK_APPROVERS: `${APPROVER}=${TENANT}:alice,U0OTHERTEN=tenant_other:bob`,
};
const ctx: ToolContext = {
  tenantId: TENANT,
  principal: { actorType: "system", actorId: "vitest", permission: "execute" },
};

interface Call {
  method: string;
  body: Record<string, any>;
  req: SlackHttpRequest;
}

function fakeSlack(opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  const http: SlackHttp = async (req) => {
    if (opts.fail) throw new Error("network down");
    const method = req.url.replace("https://slack.com/api/", "");
    calls.push({ method, body: JSON.parse(req.body), req });
    return { status: 200, body: { ok: true, ts: "1700000000.000100", channel: CHANNEL } };
  };
  return { calls, http, by: (m: string) => calls.filter((c) => c.method === m) };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(slack = fakeSlack(), env: Record<string, string> = ENV) {
  app = await buildApp({
    logger: false,
    env,
    slack: {
      config: loadSlackConfig(env)!,
      client: createSlackClient(env.SLACK_BOT_TOKEN!, slack.http),
    },
  });
  return { app, slack };
}

let seq = 0;
async function pendingApproval(a: FastifyInstance) {
  seq += 1;
  const orderId = "ord_large"; // fixture order; one proposal per fresh app
  const ev = await a.adapter.captureEvidence(ctx, {
    tenantId: TENANT,
    caseId: "case_refund",
    kind: "order",
    source: { system: "vitest", recordType: "order", recordId: orderId },
    summary: "evidence",
    data: { orderId },
    retrievedAt: new Date().toISOString(),
  });
  const created = await a.inject({
    method: "POST",
    url: "/v1/proposals",
    payload: {
      caseId: "case_refund",
      profile: "ecommerce",
      actionType: "refund",
      reasonCode: "damaged",
      params: { orderId },
      requestedPermission: "request-approval",
      requestedBy: { actorType: "human", actorId: "agent_1" },
      amount: { currency: "USD", minorUnits: 90000 },
      evidenceIds: [ev.id],
      idempotencyKey: `idem_slack_${Date.now()}_${seq}`,
    },
  });
  expect(created.statusCode).toBe(201);
  const proposal = created.json() as { id: string };
  const evaluated = await a.inject({ method: "POST", url: `/v1/proposals/${proposal.id}/evaluate`, payload: {} });
  expect(evaluated.statusCode).toBe(200);
  expect(evaluated.json().decision.decision).toBe("require_approval");
  const list = (await a.inject({ method: "GET", url: "/v1/approvals?status=pending" })).json() as Array<{
    id: string;
    proposalId: string;
    actionDigest: string;
  }>;
  const approval = list.find((x) => x.proposalId === proposal.id)!;
  expect(approval).toBeDefined();
  return { proposalId: proposal.id, approval };
}

const approvalStatus = async (a: FastifyInstance, id: string) =>
  ((await a.inject({ method: "GET", url: "/v1/approvals" })).json() as Array<{ id: string; status: string }>).find(
    (x) => x.id === id,
  )?.status;

function click(
  a: FastifyInstance,
  value: string,
  over: { user?: string; channel?: string; team?: string; secret?: string; ts?: string; sig?: string } = {},
) {
  const payload = {
    type: "block_actions",
    team: { id: over.team ?? "T0TEAM" },
    user: { id: over.user ?? APPROVER },
    channel: { id: over.channel ?? CHANNEL },
    message: { ts: "1700000000.000100" },
    actions: [{ action_id: "osas_approval_approve", value }],
  };
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
  return a.inject({
    method: "POST",
    url: "/v1/webhooks/slack/interactivity",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": over.sig ?? signSlackRequest(over.secret ?? SECRET, ts, raw),
    },
    payload: raw,
  });
}

const btn = (decision: "approved" | "rejected", id: string, digest: string) => `${decision}|${id}|${digest}`;

describe("slack approval cards", () => {
  it("posts one card with the digest, two buttons, and no customer text", async () => {
    const { app: a, slack } = await setup();
    const { approval } = await pendingApproval(a);
    const posts = slack.by("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.channel).toBe(CHANNEL);
    expect(posts[0]!.req.headers.authorization).toBe(`Bearer ${ENV.SLACK_BOT_TOKEN}`);
    const actions = posts[0]!.body.blocks.find((b: any) => b.type === "actions");
    expect(actions.elements).toHaveLength(2);
    const parsed = parseButtonValue(actions.elements[0].value);
    expect(parsed).toMatchObject({ decision: "approved", approvalId: approval.id, digest: approval.actionDigest });
    expect(JSON.stringify(posts[0]!.body)).toContain(approval.actionDigest.slice(0, 12));
  });

  it("approving from Slack decides, executes in sandbox, audits the mapped approver, and closes the card", async () => {
    const { app: a, slack } = await setup();
    const { approval, proposalId } = await pendingApproval(a);
    const res = await click(a, btn("approved", approval.id, approval.actionDigest));
    expect(res.statusCode).toBe(200);
    expect(await approvalStatus(a, approval.id)).toBe("approved");
    const updates = slack.by("chat.update");
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0]!.body.blocks)).toContain("Approved by");
    expect(updates[0]!.body.blocks.some((b: any) => b.type === "actions")).toBe(false);
    const events = (await a.inject({ method: "GET", url: `/v1/audit?proposalId=${proposalId}` })).json() as Array<{
      eventType: string;
      actorId: string;
    }>;
    expect(events.find((e) => e.eventType === "approval_decided")?.actorId).toBe("alice");
    expect(events.filter((e) => e.eventType === "execution_succeeded")).toHaveLength(1);
  });

  it("rejecting from Slack rejects the proposal and executes nothing", async () => {
    const { app: a, slack } = await setup();
    const { approval, proposalId } = await pendingApproval(a);
    await click(a, btn("rejected", approval.id, approval.actionDigest));
    expect(await approvalStatus(a, approval.id)).toBe("rejected");
    const events = (await a.inject({ method: "GET", url: `/v1/audit?proposalId=${proposalId}` })).json() as Array<{
      eventType: string;
    }>;
    expect(events.some((e) => e.eventType === "execution_succeeded")).toBe(false);
    expect(JSON.stringify(slack.by("chat.update")[0]!.body.blocks)).toContain("Rejected by");
  });

  it("a second click on a decided approval does nothing more", async () => {
    const { app: a, slack } = await setup();
    const { approval, proposalId } = await pendingApproval(a);
    const value = btn("approved", approval.id, approval.actionDigest);
    await click(a, value);
    await click(a, value);
    const events = (await a.inject({ method: "GET", url: `/v1/audit?proposalId=${proposalId}` })).json() as Array<{
      eventType: string;
    }>;
    expect(events.filter((e) => e.eventType === "approval_decided")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "execution_succeeded")).toHaveLength(1);
    expect(JSON.stringify(slack.by("chat.update")[1]!.body.blocks)).toContain("already");
  });

  it("refuses a bad or missing signature with a uniform 401 and leaves the approval pending", async () => {
    const { app: a } = await setup();
    const { approval } = await pendingApproval(a);
    const value = btn("approved", approval.id, approval.actionDigest);
    const wrong = await click(a, value, { secret: "another-secret-another-secret" });
    const stale = await click(a, value, { ts: String(Math.floor(Date.now() / 1000) - 3600) });
    const bad = await click(a, value, { sig: "v0=" + "0".repeat(64) });
    for (const r of [wrong, stale, bad]) expect(r.statusCode).toBe(401);
    expect(wrong.body).toBe(stale.body);
    expect(await approvalStatus(a, approval.id)).toBe("pending");
  });

  it("ignores clicks from Slack users who are not mapped approvers", async () => {
    const { app: a, slack } = await setup();
    const { approval } = await pendingApproval(a);
    await click(a, btn("approved", approval.id, approval.actionDigest), { user: "U0STRANGER" });
    expect(await approvalStatus(a, approval.id)).toBe("pending");
    expect(slack.by("chat.postEphemeral")).toHaveLength(1);
    expect(slack.by("chat.update")).toHaveLength(0);
  });

  it("an approver mapped to another tenant cannot decide this tenant's approval", async () => {
    const { app: a } = await setup();
    const { approval } = await pendingApproval(a);
    await click(a, btn("approved", approval.id, approval.actionDigest), { user: "U0OTHERTEN" });
    expect(await approvalStatus(a, approval.id)).toBe("pending");
  });

  it("refuses a button whose digest does not match the approval (action changed)", async () => {
    const { app: a, slack } = await setup();
    const { approval } = await pendingApproval(a);
    await click(a, btn("approved", approval.id, "a".repeat(64)));
    expect(await approvalStatus(a, approval.id)).toBe("pending");
    expect(JSON.stringify(slack.by("chat.update")[0]!.body.blocks)).toContain("action changed");
  });

  it("ignores clicks that come from a different channel or workspace", async () => {
    const env = { ...ENV, SLACK_TEAM_ID: "T0TEAM" };
    const { app: a } = await setup(fakeSlack(), env);
    const { approval } = await pendingApproval(a);
    const value = btn("approved", approval.id, approval.actionDigest);
    await click(a, value, { channel: "C0OTHER999" });
    await click(a, value, { team: "T0EVIL" });
    expect(await approvalStatus(a, approval.id)).toBe("pending");
  });

  it("a Slack outage never fails the evaluation that created the approval", async () => {
    const { app: a } = await setup(fakeSlack({ fail: true }));
    const { approval } = await pendingApproval(a);
    expect(await approvalStatus(a, approval.id)).toBe("pending");
  });

  it("posts nothing when the tenant has no mapped approver", async () => {
    const env = { ...ENV, OSAS_SLACK_APPROVERS: "U0OTHERTEN=tenant_other:bob" };
    const { app: a, slack } = await setup(fakeSlack(), env);
    await pendingApproval(a);
    expect(slack.by("chat.postMessage")).toHaveLength(0);
  });
});

describe("slack config, signature and card helpers", () => {
  it("is disabled when no SLACK_* variable is set and fails closed when only some are", () => {
    expect(loadSlackConfig({})).toBeUndefined();
    expect(() => loadSlackConfig({ SLACK_BOT_TOKEN: "xoxb-x" })).toThrow(ConfigError);
    expect(() => loadSlackConfig({ ...ENV, SLACK_APPROVAL_CHANNEL: "general" })).toThrow(/channel id/);
    expect(() => loadSlackConfig({ ...ENV, SLACK_SIGNING_SECRET: "short" })).toThrow(/16/);
    expect(() => loadSlackConfig({ ...ENV, OSAS_SLACK_APPROVERS: "alice" })).toThrow(/entries must look like/);
  });

  it("verifies the documented v0 signature and rejects tampering", () => {
    const body = Buffer.from("payload=%7B%7D");
    const now = new Date();
    const ts = String(Math.floor(now.getTime() / 1000));
    const signature = signSlackRequest(SECRET, ts, body);
    expect(verifySlackSignature({ secret: SECRET, rawBody: body, timestamp: ts, signature, now }).ok).toBe(true);
    expect(
      verifySlackSignature({ secret: SECRET, rawBody: Buffer.from("payload=x"), timestamp: ts, signature, now }),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackSignature({ secret: SECRET, rawBody: body, timestamp: undefined, signature, now })).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("rejects malformed button values", () => {
    for (const v of ["", "approved|x", "approved|a|b|c", `maybe|a|${"a".repeat(64)}`, `approved|a b|${"a".repeat(64)}`, 5]) {
      expect(parseButtonValue(v)).toBeUndefined();
    }
  });

  it("escapes mrkdwn control characters in card text", () => {
    const card = approvalCard(
      {
        id: "prop_1",
        reasonCode: "<!channel> & co",
        actionType: "refund",
        params: { orderId: "<@U1>" },
      } as never,
      { id: "appr_1", tenantId: TENANT, actionDigest: "a".repeat(64) } as never,
    );
    const text = JSON.stringify(card.blocks);
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U1>");
    expect(text).toContain("&lt;!channel&gt;");
  });
});
