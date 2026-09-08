import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Principal } from "@osas/adapter";
import { MockSupportAdapter } from "@osas/mock-backend";
import { buildMcpServer } from "./server.js";
import { TOOL_DEFINITIONS } from "./tool-definitions.js";

const DEMO_PRINCIPAL: Principal = {
  actorType: "model",
  actorId: "test-model",
  permission: "request-approval",
};

type ToolContent = { type: string; text: string }[];
const textContent = (result: unknown): ToolContent =>
  (result as { content: unknown }).content as ToolContent;

async function connectedClient(principal: Principal = DEMO_PRINCIPAL) {
  const adapter = new MockSupportAdapter();
  const server = buildMcpServer(adapter, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { adapter, server, client };
}

describe("buildMcpServer", () => {
  it("constructs an McpServer without connecting", () => {
    const server = buildMcpServer(new MockSupportAdapter(), DEMO_PRINCIPAL);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  it("lists all 20 tools over the wire", async () => {
    const { client, server } = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      TOOL_DEFINITIONS.map((d) => d.name).sort(),
    );
    const getCase = tools.find((t) => t.name === "osas_core_get_case");
    expect(getCase?.inputSchema).toMatchObject({ type: "object", required: ["id"] });
    expect(tools.some((t) => t.name.toLowerCase().includes("execute"))).toBe(false);
    await server.close();
  });

  it("invokes osas_core_get_case and returns case data", async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({
      name: "osas_core_get_case",
      arguments: { id: "case_refund" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.id).toBe("case_refund");
    expect(data.customerId).toBe("cus_verified");
    expect(textContent(result)[0]).toMatchObject({ type: "text" });
    expect(textContent(result)[0]!.text).toContain('"case_refund"');
    await server.close();
  });

  it("invokes a proposal shortcut and creates a proposed credit_apply proposal", async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({
      name: "osas_saas_create_credit_request",
      arguments: {
        caseId: "case_credit",
        customerId: "cus_verified",
        amount: { currency: "USD", minorUnits: 2500 },
        reasonCode: "service_outage",
        idempotencyKey: "idem-credit-1",
      },
    });
    expect(result.isError).toBeFalsy();
    const proposal = result.structuredContent as Record<string, unknown>;
    expect(proposal.actionType).toBe("credit_apply");
    expect(proposal.status).toBe("proposed");
    expect(proposal.requestedPermission).toBe("request-approval");
    expect(proposal.profile).toBe("saas");
    expect(proposal.id).toMatch(/^prop_\d+$/);
    await server.close();
  });

  it("enforces permissionRequired for the principal", async () => {
    const readOnly: Principal = { actorType: "model", actorId: "ro", permission: "read" };
    const { client, server } = await connectedClient(readOnly);
    const result = await client.callTool({
      name: "osas_core_create_case_note",
      arguments: { caseId: "case_refund", body: "hi", idempotencyKey: "k1" },
    });
    expect(result.isError).toBe(true);
    expect(textContent(result)[0]!.text).toContain("PERMISSION_DENIED");
    await server.close();
  });

  it("surfaces adapter NOT_FOUND errors as tool errors", async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({
      name: "osas_core_get_case",
      arguments: { id: "case_missing" },
    });
    expect(result.isError).toBe(true);
    expect(textContent(result)[0]!.text).toContain("NOT_FOUND");
    await server.close();
  });

  it("rejects tools whose capability is not declared (CAPABILITY_UNSUPPORTED)", async () => {
    // Read-only implementation: declares only the core read capabilities.
    const adapter = new MockSupportAdapter();
    const full = await adapter.getCapabilities!({
      tenantId: "tenant_demo",
      principal: DEMO_PRINCIPAL,
    });
    adapter.getCapabilities = async () => ({
      ...full,
      profiles: [
        {
          name: "core" as const,
          capabilities: ["case.read" as const, "customer.read" as const, "knowledge.read" as const, "evidence.read" as const],
        },
      ],
    });
    const server = buildMcpServer(adapter, DEMO_PRINCIPAL);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Declared capability still works.
    const ok = await client.callTool({ name: "osas_core_get_case", arguments: { id: "case_refund" } });
    expect(ok.isError).toBeFalsy();

    // Undeclared capabilities are refused before touching the adapter.
    const note = await client.callTool({
      name: "osas_core_create_case_note",
      arguments: { caseId: "case_refund", body: "hi", idempotencyKey: "k1" },
    });
    expect(note.isError).toBe(true);
    expect(textContent(note)[0]!.text).toContain("CAPABILITY_UNSUPPORTED");

    const order = await client.callTool({ name: "osas_ecom_get_order", arguments: { id: "ord_small" } });
    expect(order.isError).toBe(true);
    expect(textContent(order)[0]!.text).toContain("CAPABILITY_UNSUPPORTED");

    await server.close();
  });

  it("adapters without a capability provider stay permissive (backward compat)", async () => {
    const adapter = new MockSupportAdapter();
    Object.defineProperty(adapter, "getCapabilities", { value: undefined });
    const server = buildMcpServer(adapter, DEMO_PRINCIPAL);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({ name: "osas_core_get_case", arguments: { id: "case_refund" } });
    expect(result.isError).toBeFalsy();
    await server.close();
  });

  it("serves the after-sales reads from the mock backend", async () => {
    const { client, server } = await connectedClient();
    const incident = await client.callTool({
      name: "osas_ecom_get_shipment_incident",
      arguments: { id: "inc_dnr_large" },
    });
    expect(incident.isError).toBeFalsy();
    expect((incident.structuredContent as Record<string, unknown>).incidentType).toBe(
      "delivered_not_received",
    );

    const refunds = await client.callTool({
      name: "osas_ecom_get_refund_status",
      arguments: { orderId: "ord_refunded" },
    });
    expect(refunds.isError).toBeFalsy();
    const items = (refunds.structuredContent as Record<string, unknown>).items as unknown[];
    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).status).toBe("succeeded");
    await server.close();
  });

  it("creates a submitted ItemClaim via the proposal shortcut", async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({
      name: "osas_ecom_create_item_claim_request",
      arguments: {
        caseId: "case_refund",
        orderId: "ord_small",
        lineId: "line_1",
        claimType: "damaged",
        quantity: 1,
        idempotencyKey: "idem-claim-1",
      },
    });
    expect(result.isError).toBeFalsy();
    const claim = result.structuredContent as Record<string, unknown>;
    expect(claim.status).toBe("submitted");
    expect(claim.claimType).toBe("damaged");
    await server.close();
  });

  it("drafts an exchange_request proposal that never executes", async () => {
    const { client, server } = await connectedClient();
    const result = await client.callTool({
      name: "osas_ecom_create_exchange_request",
      arguments: {
        caseId: "case_refund",
        orderId: "ord_small",
        originalLineId: "line_1",
        replacementSku: "sku_mug_v2",
        idempotencyKey: "idem-exchange-1",
      },
    });
    expect(result.isError).toBeFalsy();
    const proposal = result.structuredContent as Record<string, unknown>;
    expect(proposal.actionType).toBe("exchange_request");
    expect(proposal.profile).toBe("ecommerce");
    expect(proposal.status).toBe("proposed");
    expect(proposal.requestedPermission).toBe("request-approval");
    await server.close();
  });

  it("fails closed with CAPABILITY_UNSUPPORTED when the adapter lacks an after-sales method", async () => {
    const adapter = new MockSupportAdapter();
    Object.defineProperty(adapter, "getCapabilities", { value: undefined });
    Object.defineProperty(adapter, "getShipmentIncident", { value: undefined });
    const server = buildMcpServer(adapter, DEMO_PRINCIPAL);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({
      name: "osas_ecom_get_shipment_incident",
      arguments: { id: "inc_dnr_large" },
    });
    expect(result.isError).toBe(true);
    expect(textContent(result)[0]!.text).toContain("CAPABILITY_UNSUPPORTED");
    await server.close();
  });
});
