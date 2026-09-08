import { describe, expect, it } from "vitest";
import type { ToolContext } from "@osas/adapter";
import { AdapterCapabilityError, AdapterNotFoundError } from "@osas/adapter";
import { chatwootConfigFromEnv } from "./config.js";
import { ChatwootCustomerIdUnavailableError, ChatwootNotConfiguredError } from "./errors.js";
import type { HttpClient, HttpRequest, HttpResponse } from "./http.js";
import { ChatwootAdapter } from "./chatwoot-adapter.js";
import { mapConversationToCase, type ChatwootConversation } from "./mappers.js";

const ctx: ToolContext = {
  tenantId: "tenant_demo",
  principal: { actorType: "system", actorId: "test", permission: "execute" },
};

const config = {
  baseUrl: "https://chat.acme.example",
  accountId: "7",
  apiToken: "test-token",
  escalationTeamId: "12",
};

const conversation = {
  id: 456,
  status: "open",
  priority: "high",
  inbox_id: 3,
  assignee_id: null,
  team_id: 12,
  labels: ["vip"],
  additional_attributes: { mail_subject: "Where is my order?" },
  meta: {
    channel: "Channel::Email",
    sender: { id: 888, name: "Jane Doe", email: "jane@example.com" },
    assignee: null,
    team: { id: 12 },
  },
  created_at: 1768035600, // 2026-01-10T09:00:00Z
  updated_at: 1768039200, // 2026-01-10T10:00:00Z
};

const contact = {
  id: 888,
  name: "Jane Doe",
  email: "jane@example.com",
  phone_number: "+15551234567",
  additional_attributes: { country_code: "us" },
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

const BASE = "https://chat.acme.example/api/v1/accounts/7";

const okHandler =
  (over: Partial<Record<string, HttpResponse>> = {}) =>
  (req: RecordedRequest): HttpResponse => {
    const key = `${req.method} ${req.url}`;
    if (over[key]) return over[key]!;
    if (req.url === `${BASE}/conversations/456` && req.method === "GET") {
      return { status: 200, body: conversation };
    }
    if (req.url === `${BASE}/contacts/888`) {
      return { status: 200, body: contact };
    }
    if (req.url === `${BASE}/contacts/888/conversations`) {
      return { status: 200, body: { payload: [conversation] } };
    }
    if (req.url.includes("/conversations/search")) {
      return { status: 200, body: { payload: [conversation] } };
    }
    if (req.url === `${BASE}/conversations`) {
      return { status: 200, body: { data: { meta: {}, payload: [conversation] } } };
    }
    if (req.method === "POST" && req.url === `${BASE}/conversations/456/messages`) {
      return { status: 200, body: { id: 9001 } };
    }
    if (req.method === "POST" && req.url === `${BASE}/conversations/456/assignments`) {
      return { status: 200, body: { id: 12 } };
    }
    return { status: 404, body: { error: "Resource not found" } };
  };

describe("chatwootConfigFromEnv (fail closed)", () => {
  it("throws CHATWOOT_NOT_CONFIGURED when credentials are missing", () => {
    expect(() => chatwootConfigFromEnv({})).toThrow(ChatwootNotConfiguredError);
    expect(() =>
      chatwootConfigFromEnv({ CHATWOOT_BASE_URL: "https://chat.acme.example" }),
    ).toThrow(ChatwootNotConfiguredError);
    expect(() =>
      chatwootConfigFromEnv({
        CHATWOOT_BASE_URL: "https://chat.acme.example",
        CHATWOOT_ACCOUNT_ID: "7",
      }),
    ).toThrow(/CHATWOOT_API_TOKEN/);
  });

  it("strips trailing slashes from baseUrl and keeps the escalation team", () => {
    const cfg = chatwootConfigFromEnv({
      CHATWOOT_BASE_URL: "https://chat.acme.example/",
      CHATWOOT_ACCOUNT_ID: "7",
      CHATWOOT_API_TOKEN: "t",
      CHATWOOT_ESCALATION_TEAM_ID: "12",
    });
    expect(cfg).toMatchObject({
      baseUrl: "https://chat.acme.example",
      accountId: "7",
      escalationTeamId: "12",
    });
  });
});

describe("ChatwootAdapter reads + mapping", () => {
  it("maps a conversation to an OSAS Case with the conversation id as identity", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const kase = await adapter.getCase(ctx, "cw_conv_456");
    expect(kase).toMatchObject({
      id: "cw_conv_456",
      customerId: "cw_contact_888",
      subject: "Where is my order?",
      status: "open",
      priority: "high",
      channel: "email",
      assigneeType: "none",
      tags: ["vip"],
      createdAt: "2026-01-10T09:00:00.000Z",
      updatedAt: "2026-01-10T10:00:00.000Z",
    });
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(`${BASE}/conversations/456`);
    // Auth header present, token never echoed elsewhere.
    expect(requests[0]?.headers?.api_access_token).toBe("test-token");
  });

  it("maps snoozed/resolved statuses and defaults priority to normal", async () => {
    const { http } = mockHttp(okHandler({
      [`GET ${BASE}/conversations/456`]: {
        status: 200,
        body: { ...conversation, status: "snoozed", priority: null },
      },
    }));
    const adapter = new ChatwootAdapter({ config, http });
    const kase = await adapter.getCase(ctx, "cw_conv_456");
    expect(kase.status).toBe("pending_agent");
    expect(kase.priority).toBe("normal");
    expect(kase.closedAt).toBeUndefined();
  });

  it("sets closedAt when the conversation is resolved", async () => {
    const { http } = mockHttp(okHandler({
      [`GET ${BASE}/conversations/456`]: {
        status: 200,
        body: { ...conversation, status: "resolved" },
      },
    }));
    const adapter = new ChatwootAdapter({ config, http });
    const kase = await adapter.getCase(ctx, "cw_conv_456");
    expect(kase.status).toBe("resolved");
    expect(kase.closedAt).toBe("2026-01-10T10:00:00.000Z");
  });

  it("maps a contact to an OSAS Customer (identity never fabricated as verified)", async () => {
    const { http } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const customer = await adapter.getCustomer(ctx, "cw_contact_888");
    expect(customer.id).toBe("cw_contact_888");
    expect(customer.displayName).toBe("Jane Doe");
    expect(customer.phone).toBe("+15551234567");
    expect(customer.region).toBe("US");
    expect(customer.identityVerification.status).toBe("unverified");
  });

  it("searches conversations scoped by contact, free text, or plain list", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });

    const byCustomer = await adapter.searchCases(ctx, { customerId: "cw_contact_888" });
    expect(byCustomer).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${BASE}/contacts/888/conversations`);

    const byText = await adapter.searchCases(ctx, { q: "order" });
    expect(byText).toHaveLength(1);
    expect(requests[1]?.url).toContain("/conversations/search?q=order");

    const filtered = await adapter.searchCases(ctx, { status: "resolved" });
    expect(filtered).toHaveLength(0); // fixture conversation is open
    expect(requests[2]?.url).toBe(`${BASE}/conversations`);
  });

  it("maps 404 to AdapterNotFoundError and other failures to ChatwootApiError (no secrets leaked)", async () => {
    const { http } = mockHttp(() => ({ status: 401, body: { error: "bad token" } }));
    const adapter = new ChatwootAdapter({ config, http });
    await expect(adapter.getCase(ctx, "cw_conv_456")).rejects.toMatchObject({
      name: "ChatwootApiError",
      status: 401,
    });
    const { http: http404 } = mockHttp(() => ({ status: 404, body: {} }));
    await expect(
      new ChatwootAdapter({ config, http: http404 }).getCase(ctx, "cw_conv_456"),
    ).rejects.toBeInstanceOf(AdapterNotFoundError);
    try {
      await adapter.getCase(ctx, "cw_conv_456");
    } catch (err) {
      expect(String(err)).not.toContain("test-token");
    }
  });
});

describe("ChatwootAdapter writes (idempotent, private-only)", () => {
  it("creates a private note via POST messages with private:true and the idempotency key header", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const note = await adapter.createCaseNote(ctx, {
      caseId: "cw_conv_456",
      body: "Customer verified via order lookup",
      idempotencyKey: "note-key-1",
    });
    expect(note.caseId).toBe("cw_conv_456");
    const post = requests.find((r) => r.method === "POST")!;
    expect(post.url).toBe(`${BASE}/conversations/456/messages`);
    expect(post.body).toEqual({
      content: "Customer verified via order lookup",
      message_type: "outgoing",
      private: true,
    });
    expect(post.headers?.["x-idempotency-key"]).toBe("note-key-1");
  });

  it("replays the cached note for a repeated idempotency key (no second HTTP write)", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const first = await adapter.createCaseNote(ctx, {
      caseId: "cw_conv_456",
      body: "b",
      idempotencyKey: "dup-key",
    });
    const second = await adapter.createCaseNote(ctx, {
      caseId: "cw_conv_456",
      body: "b",
      idempotencyKey: "dup-key",
    });
    expect(second).toEqual(first);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("escalates by assigning the configured team with a private note", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const esc = await adapter.createEscalation(ctx, {
      caseId: "cw_conv_456",
      reason: "Refund over threshold",
      idempotencyKey: "esc-key-1",
    });
    expect(esc.reason).toBe("Refund over threshold");
    const assign = requests.find((r) => r.url.endsWith("/assignments"))!;
    expect(assign.body).toEqual({ team_id: "12" });
    expect(assign.headers?.["x-idempotency-key"]).toBe("esc-key-1:assignment");
    const note = requests.find((r) => r.url.endsWith("/messages"))!;
    expect(note.body).toEqual({
      content: "[OSAS escalation] Refund over threshold",
      message_type: "outgoing",
      private: true,
    });
    expect(note.headers?.["x-idempotency-key"]).toBe("esc-key-1:note");
  });

  it("fails closed on escalation when no default team is configured", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({
      config: { baseUrl: config.baseUrl, accountId: config.accountId, apiToken: config.apiToken },
      http,
    });
    await expect(
      adapter.createEscalation(ctx, { caseId: "cw_conv_456", reason: "r", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(ChatwootNotConfiguredError);
    expect(requests).toHaveLength(0);
  });
});

describe("ChatwootAdapter never fabricates a customer id", () => {
  it("getCase rejects with CUSTOMER_ID_UNAVAILABLE when the conversation has no sender", async () => {
    const { http, requests } = mockHttp(okHandler({
      [`GET ${BASE}/conversations/456`]: {
        status: 200,
        body: { ...conversation, meta: { channel: "Channel::Api" } },
      },
    }));
    const adapter = new ChatwootAdapter({ config, http });
    const err = await adapter.getCase(ctx, "cw_conv_456").catch((e) => e);
    expect(err).toBeInstanceOf(ChatwootCustomerIdUnavailableError);
    expect(err.code).toBe("CUSTOMER_ID_UNAVAILABLE");
    expect(String(err)).not.toContain("cw_contact_0");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("getCase rejects when the sender is present but its id is empty/absent", async () => {
    const { http } = mockHttp(okHandler({
      [`GET ${BASE}/conversations/456`]: {
        status: 200,
        body: { ...conversation, meta: { ...conversation.meta, sender: { name: "Jane" } } },
      },
    }));
    const adapter = new ChatwootAdapter({ config, http });
    await expect(adapter.getCase(ctx, "cw_conv_456")).rejects.toMatchObject({
      name: "ChatwootCustomerIdUnavailableError",
      code: "CUSTOMER_ID_UNAVAILABLE",
    });
  });

  it("searchCases propagates CUSTOMER_ID_UNAVAILABLE instead of returning a fake customer", async () => {
    const senderless = { ...conversation, meta: { channel: "Channel::Api" } };
    const { http } = mockHttp(okHandler({
      [`GET ${BASE}/conversations`]: {
        status: 200,
        body: { data: { meta: {}, payload: [senderless] } },
      },
    }));
    const adapter = new ChatwootAdapter({ config, http });
    await expect(adapter.searchCases(ctx, {})).rejects.toBeInstanceOf(
      ChatwootCustomerIdUnavailableError,
    );
  });

  it("mapConversationToCase throws for every invalid sender id and never yields cw_contact_0", () => {
    const base: ChatwootConversation = { id: 456, status: "open" };
    const invalidSenders: unknown[] = [0, -7, Number.NaN, 1.5, "888", null];
    for (const id of invalidSenders) {
      const conv = {
        ...base,
        meta: { sender: { id } },
      } as unknown as ChatwootConversation;
      expect(() => mapConversationToCase(conv, "tenant_demo")).toThrow(
        ChatwootCustomerIdUnavailableError,
      );
    }
    expect(() => mapConversationToCase(base, "tenant_demo")).toThrow(
      ChatwootCustomerIdUnavailableError,
    );
    const valid = mapConversationToCase(
      { ...base, meta: { sender: { id: 888 } } },
      "tenant_demo",
    );
    expect(valid.customerId).toBe("cw_contact_888");
    expect(valid.customerId).not.toBe("cw_contact_0");
  });
});

describe("ChatwootAdapter escalation partial failure", () => {
  const noteFlaky = () => {
    let noteAttempts = 0;
    return (req: RecordedRequest): HttpResponse => {
      if (req.method === "POST" && req.url.endsWith("/messages")) {
        noteAttempts += 1;
        if (noteAttempts === 1) return { status: 500, body: { error: "boom" } };
        return { status: 200, body: { id: 9001 } };
      }
      return okHandler()(req);
    };
  };

  it("assignment succeeds + note fails → partial_success with both legs' detail, one assignment call", async () => {
    const { http, requests } = mockHttp(noteFlaky());
    const adapter = new ChatwootAdapter({ config, http });
    const esc = await adapter.createEscalation(ctx, {
      caseId: "cw_conv_456",
      reason: "Refund over threshold",
      idempotencyKey: "esc-partial",
    });
    expect(esc.status).toBe("partial_success");
    expect(esc.assignment).toEqual({ teamId: "12", response: { id: 12 } });
    expect(esc.noteError).toContain("ChatwootApiError");
    expect(esc.noteError).toContain("HTTP 500");
    expect(requests.filter((r) => r.url.endsWith("/assignments"))).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith("/messages"))).toHaveLength(1);
  });

  it("a retry with the same key resumes the note leg only and transitions to success", async () => {
    const { http, requests } = mockHttp(noteFlaky());
    const adapter = new ChatwootAdapter({ config, http });
    const input = { caseId: "cw_conv_456", reason: "r", idempotencyKey: "esc-resume" };
    const partial = await adapter.createEscalation(ctx, input);
    expect(partial.status).toBe("partial_success");
    const done = await adapter.createEscalation(ctx, input);
    expect(done.status).toBe("success");
    expect(done.noteError).toBeUndefined();
    expect(done.id).toBe(partial.id);
    expect(done.assignment).toEqual(partial.assignment);
    expect(requests.filter((r) => r.url.endsWith("/assignments"))).toHaveLength(1);
    const notePosts = requests.filter((r) => r.url.endsWith("/messages"));
    expect(notePosts).toHaveLength(2);
    expect(notePosts[1]?.headers?.["x-idempotency-key"]).toBe("esc-resume:note");
  });

  it("the cached partial record is inspectable for reconciliation", async () => {
    const { http } = mockHttp(noteFlaky());
    const adapter = new ChatwootAdapter({ config, http });
    const partial = await adapter.createEscalation(ctx, {
      caseId: "cw_conv_456",
      reason: "r",
      idempotencyKey: "esc-inspect",
    });
    expect(partial).toMatchObject({
      specVersion: partial.specVersion,
      tenantId: "tenant_demo",
      caseId: "cw_conv_456",
      reason: "r",
      status: "partial_success",
      assignment: { teamId: "12", response: { id: 12 } },
    });
    expect(typeof partial.noteError).toBe("string");
  });

  it("a duplicate retry after complete success performs zero HTTP calls", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const input = { caseId: "cw_conv_456", reason: "r", idempotencyKey: "esc-dup" };
    const first = await adapter.createEscalation(ctx, input);
    expect(first.status).toBe("success");
    const count = requests.length;
    const second = await adapter.createEscalation(ctx, input);
    expect(second).toEqual(first);
    expect(requests).toHaveLength(count);
  });

  it("if the assignment leg fails, nothing is cached or written and the error propagates", async () => {
    const { http, requests } = mockHttp(okHandler({
      [`POST ${BASE}/conversations/456/assignments`]: { status: 502, body: {} },
    }));
    const adapter = new ChatwootAdapter({ config, http });
    const input = { caseId: "cw_conv_456", reason: "r", idempotencyKey: "esc-assign-fail" };
    await expect(adapter.createEscalation(ctx, input)).rejects.toMatchObject({
      name: "ChatwootApiError",
      status: 502,
    });
    expect(requests.filter((r) => r.url.endsWith("/messages"))).toHaveLength(0);
    // Not cached as partial: a retry re-attempts the assignment leg.
    await expect(adapter.createEscalation(ctx, input)).rejects.toMatchObject({ status: 502 });
    expect(requests.filter((r) => r.url.endsWith("/assignments"))).toHaveLength(2);
  });
});

describe("ChatwootAdapter evidence", () => {
  it("captures conversation evidence with conversation id + agent URL as source", async () => {
    const { http } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const ev = await adapter.captureConversationEvidence(ctx, "cw_conv_456");
    expect(ev.kind).toBe("conversation");
    expect(ev.caseId).toBe("cw_conv_456");
    expect(ev.source).toEqual({
      system: "chatwoot",
      recordType: "conversation",
      recordId: "456",
      url: "https://chat.acme.example/app/accounts/7/conversations/456",
    });
    expect((await adapter.getEvidence(ctx, ev.id)).id).toBe(ev.id);
    expect(await adapter.listEvidence(ctx, { caseId: "cw_conv_456" })).toHaveLength(1);
  });

  it("captures contact evidence with the contact id as source", async () => {
    const { http } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    const ev = await adapter.captureContactEvidence(ctx, "cw_contact_888");
    expect(ev.kind).toBe("identity");
    expect(ev.source.recordType).toBe("contact");
    expect(ev.source.recordId).toBe("888");
    expect(ev.source.url).toBe("https://chat.acme.example/app/accounts/7/contacts/888");
  });
});

describe("ChatwootAdapter capability surface", () => {
  it("declares inbox capabilities only, shadow execution mode", async () => {
    const { http } = mockHttp(okHandler());
    const manifest = await new ChatwootAdapter({ config, http }).getCapabilities(ctx);
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
    expect(granted).not.toContain("knowledge.read");
    expect(granted).not.toContain("ecommerce.refund.execute");
    expect(granted).not.toContain("proposal.write");
    expect(manifest.executionModes).toEqual(["shadow"]);
  });

  it("unsupported operations fail closed with CAPABILITY_UNSUPPORTED", async () => {
    const { http, requests } = mockHttp(okHandler());
    const adapter = new ChatwootAdapter({ config, http });
    await expect(adapter.executeAction()).rejects.toBeInstanceOf(AdapterCapabilityError);
    await expect(adapter.searchKnowledge()).rejects.toBeInstanceOf(AdapterCapabilityError);
    await expect(adapter.getOrder()).rejects.toBeInstanceOf(AdapterCapabilityError);
    await expect(adapter.getPolicy()).rejects.toBeInstanceOf(AdapterCapabilityError);
    expect(requests).toHaveLength(0); // fail closed: no HTTP attempted
  });
});
