import { describe, expect, it } from "vitest";
import type { ToolContext } from "@osas/adapter";
import { AdapterCapabilityError, AdapterNotFoundError } from "@osas/adapter";
import { zendeskConfigFromEnv } from "./config.js";
import { ZendeskNotConfiguredError } from "./errors.js";
import type { HttpClient, HttpRequest, HttpResponse } from "./http.js";
import { ZendeskAdapter } from "./zendesk-adapter.js";

const ctx: ToolContext = {
  tenantId: "tenant_demo",
  principal: { actorType: "system", actorId: "test", permission: "execute" },
};

const config = {
  baseUrl: "https://acme.zendesk.com",
  email: "agent@acme.example",
  apiToken: "test-token",
  escalationGroupId: "4242",
};

const ticket = {
  id: 123,
  subject: "Where is my order?",
  status: "open",
  priority: "high",
  requester_id: 777,
  assignee_id: null,
  tags: ["vip"],
  via: { channel: "mail" },
  created_at: "2026-01-10T09:00:00Z",
  updated_at: "2026-01-10T10:00:00Z",
};

const user = {
  id: 777,
  name: "Jane Doe",
  email: "jane@example.com",
  locale: "en-US",
  tags: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

interface RecordedRequest extends HttpRequest {}

function mockHttp(
  handler: (req: RecordedRequest) => HttpResponse,
): { http: HttpClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const http: HttpClient = async (req) => {
    requests.push(req);
    return handler(req);
  };
  return { http, requests };
}

const okHandler =
  (over: Partial<Record<string, HttpResponse>> = {}) =>
  (req: RecordedRequest): HttpResponse => {
    const key = `${req.method} ${req.url}`;
    if (over[key]) return over[key]!;
    if (req.url.endsWith("/api/v2/tickets/123.json") && req.method === "GET") {
      return { status: 200, body: { ticket } };
    }
    if (req.url.endsWith("/api/v2/users/777.json")) {
      return { status: 200, body: { user } };
    }
    if (req.url.includes("/api/v2/search.json")) {
      return { status: 200, body: { results: [ticket] } };
    }
    if (req.method === "PUT" && req.url.endsWith("/api/v2/tickets/123.json")) {
      return { status: 200, body: { ticket: { ...ticket, updated_at: "2026-01-10T11:00:00Z" } } };
    }
    return { status: 404, body: { error: "RecordNotFound" } };
  };

describe("zendeskConfigFromEnv (fail closed)", () => {
  it("throws ZENDESK_NOT_CONFIGURED when credentials are missing", () => {
    expect(() => zendeskConfigFromEnv({})).toThrow(ZendeskNotConfiguredError);
    expect(() =>
      zendeskConfigFromEnv({ ZENDESK_BASE_URL: "https://acme.zendesk.com" }),
    ).toThrow(ZendeskNotConfiguredError);
    expect(() =>
      zendeskConfigFromEnv({
        ZENDESK_BASE_URL: "https://acme.zendesk.com",
        ZENDESK_EMAIL: "a@b.c",
      }),
    ).toThrow(/ZENDESK_API_TOKEN/);
  });

  it("builds baseUrl from subdomain and keeps explicit baseUrl", () => {
    expect(
      zendeskConfigFromEnv({
        ZENDESK_SUBDOMAIN: "acme",
        ZENDESK_EMAIL: "a@b.c",
        ZENDESK_API_TOKEN: "t",
      }).baseUrl,
    ).toBe("https://acme.zendesk.com");
    expect(
      zendeskConfigFromEnv({
        ZENDESK_BASE_URL: "https://acme.example.com/zd/",
        ZENDESK_EMAIL: "a@b.c",
        ZENDESK_API_TOKEN: "t",
        ZENDESK_ESCALATION_GROUP_ID: "9",
      }),
    ).toMatchObject({ baseUrl: "https://acme.example.com/zd", escalationGroupId: "9" });
  });
});

describe("ZendeskAdapter reads + mapping", () => {
  it("maps a ticket to an OSAS Case with the ticket id as identity", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const kase = await adapter.getCase(ctx, "zd_ticket_123");
    expect(kase).toMatchObject({
      id: "zd_ticket_123",
      customerId: "zd_user_777",
      subject: "Where is my order?",
      status: "open",
      priority: "high",
      channel: "email",
      assigneeType: "none",
      tags: ["vip"],
    });
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("https://acme.zendesk.com/api/v2/tickets/123.json");
    // Auth header present, token never echoed elsewhere.
    expect(requests[0]?.headers?.authorization).toMatch(/^Basic /);
  });

  it("maps the requester to an OSAS Customer (identity never fabricated as verified)", async () => {
    const { http } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const customer = await adapter.getCustomer(ctx, "zd_user_777");
    expect(customer.id).toBe("zd_user_777");
    expect(customer.displayName).toBe("Jane Doe");
    expect(customer.identityVerification.status).toBe("unverified");
  });

  it("searches tickets with type:ticket and requester scoping", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const cases = await adapter.searchCases(ctx, { customerId: "zd_user_777" });
    expect(cases).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(decodeURIComponent(url.search)).toContain("type:ticket");
    expect(decodeURIComponent(url.search)).toContain("requester:777");
  });

  it("maps 404 to AdapterNotFoundError and other failures to ZendeskApiError (no secrets leaked)", async () => {
    const { http } = mockHttp(() => ({ status: 401, body: { error: "bad token" } }));
    const adapter = new ZendeskAdapter({ config, http });
    await expect(adapter.getCase(ctx, "zd_ticket_123")).rejects.toMatchObject({
      name: "ZendeskApiError",
      status: 401,
    });
    const { http: http404 } = mockHttp(() => ({ status: 404, body: {} }));
    await expect(
      new ZendeskAdapter({ config, http: http404 }).getCase(ctx, "zd_ticket_123"),
    ).rejects.toBeInstanceOf(AdapterNotFoundError);
    try {
      await adapter.getCase(ctx, "zd_ticket_123");
    } catch (err) {
      expect(String(err)).not.toContain("test-token");
    }
  });
});

describe("ZendeskAdapter writes (idempotent, internal-only)", () => {
  it("creates an internal note via PUT ticket comment public:false with the idempotency key header", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const note = await adapter.createCaseNote(ctx, {
      caseId: "zd_ticket_123",
      body: "Customer verified via order lookup",
      idempotencyKey: "note-key-1",
    });
    expect(note.caseId).toBe("zd_ticket_123");
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.body).toEqual({
      ticket: { comment: { body: "Customer verified via order lookup", public: false } },
    });
    expect(put.headers?.["x-idempotency-key"]).toBe("note-key-1");
  });

  it("replays the cached note for a repeated idempotency key (no second HTTP write)", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const first = await adapter.createCaseNote(ctx, {
      caseId: "zd_ticket_123",
      body: "b",
      idempotencyKey: "dup-key",
    });
    const second = await adapter.createCaseNote(ctx, {
      caseId: "zd_ticket_123",
      body: "b",
      idempotencyKey: "dup-key",
    });
    expect(second).toEqual(first);
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("escalates by assigning the configured group with an internal comment", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const esc = await adapter.createEscalation(ctx, {
      caseId: "zd_ticket_123",
      reason: "Refund over threshold",
      idempotencyKey: "esc-key-1",
    });
    expect(esc.reason).toBe("Refund over threshold");
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.body).toEqual({
      ticket: {
        group_id: "4242",
        comment: { body: "[OSAS escalation] Refund over threshold", public: false },
      },
    });
    expect(put.headers?.["x-idempotency-key"]).toBe("esc-key-1");
  });

  it("fails closed on escalation when no default group is configured", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({
      config: { baseUrl: config.baseUrl, email: config.email, apiToken: config.apiToken },
      http,
    });
    await expect(
      adapter.createEscalation(ctx, { caseId: "zd_ticket_123", reason: "r", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(ZendeskNotConfiguredError);
    expect(requests).toHaveLength(0);
  });
});

describe("ZendeskAdapter evidence", () => {
  it("captures ticket evidence with ticket id + agent URL as source", async () => {
    const { http } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const ev = await adapter.captureTicketEvidence(ctx, "zd_ticket_123");
    expect(ev.kind).toBe("conversation");
    expect(ev.caseId).toBe("zd_ticket_123");
    expect(ev.source).toEqual({
      system: "zendesk",
      recordType: "ticket",
      recordId: "123",
      url: "https://acme.zendesk.com/agent/tickets/123",
    });
    expect((await adapter.getEvidence(ctx, ev.id)).id).toBe(ev.id);
    expect(await adapter.listEvidence(ctx, { caseId: "zd_ticket_123" })).toHaveLength(1);
  });

  it("captures user evidence with the user id as source", async () => {
    const { http } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    const ev = await adapter.captureUserEvidence(ctx, "zd_user_777");
    expect(ev.kind).toBe("identity");
    expect(ev.source.recordType).toBe("user");
    expect(ev.source.recordId).toBe("777");
  });
});

describe("ZendeskAdapter capability surface", () => {
  it("declares ticketing capabilities only, shadow execution mode", async () => {
    const { http } = mockHttp(okHandler());
    const manifest = await new ZendeskAdapter({ config, http }).getCapabilities(ctx);
    const granted = manifest.profiles.flatMap((p) => p.capabilities);
    expect(granted).toEqual(
      expect.arrayContaining([
        "case.read",
        "customer.read",
        "evidence.read",
        "note.write",
        "escalation.write",
      ]),
    );
    expect(granted).not.toContain("ecommerce.refund.execute");
    expect(granted).not.toContain("proposal.write");
    expect(manifest.executionModes).toEqual(["shadow"]);
  });

  it("unsupported operations fail closed with CAPABILITY_UNSUPPORTED", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ZendeskAdapter({ config, http });
    await expect(adapter.executeAction()).rejects.toBeInstanceOf(AdapterCapabilityError);
    await expect(adapter.getOrder()).rejects.toBeInstanceOf(AdapterCapabilityError);
    await expect(adapter.getPolicy()).rejects.toBeInstanceOf(AdapterCapabilityError);
    expect(requests).toHaveLength(0); // fail closed: no HTTP attempted
  });
});
