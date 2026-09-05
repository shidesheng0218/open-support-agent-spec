// Stdio bootstrap for the OSAS MCP server (CONTRACTS.md §7).
// Run directly (`osas-mcp` bin / `pnpm start`): serves the demo
// MockSupportAdapter with a model principal capped at request-approval.
// Importing this package's index.ts has no side effects; this file is the
// executable entry point only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Principal } from "@osas/adapter";
import { MockSupportAdapter } from "@osas/mock-backend";
import { buildMcpServer } from "./server.js";

const principal: Principal = {
  actorType: "model",
  actorId: "stdio-model",
  permission: "request-approval",
};

const server = buildMcpServer(new MockSupportAdapter(), principal);
await server.connect(new StdioServerTransport());
console.error("osas-mcp-server listening on stdio");
