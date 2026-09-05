import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PERMISSIONS } from "@osas/core";
import { TOOL_DEFINITIONS } from "@osas/mcp-server";
import { MockSupportAdapter, createDemoFixtures } from "@osas/mock-backend";
import { ReportCollector, runCase } from "./report.js";
import { schemasDir, validateAgainst, loadFixture } from "./helpers.js";

const SUITE = "tools-mapping";

const EXPECTED_TOOLS = [
  "osas_core_get_case",
  "osas_core_search_cases",
  "osas_core_get_customer",
  "osas_core_search_knowledge",
  "osas_core_create_case_note",
  "osas_core_create_escalation",
  "osas_core_create_action_proposal",
  "osas_ecom_get_order",
  "osas_ecom_list_orders",
  "osas_ecom_get_shipment",
  "osas_saas_get_subscription",
  "osas_saas_list_invoices",
  "osas_saas_get_credit_balance",
  "osas_saas_create_credit_request",
  "osas_saas_create_cancellation_request",
  "osas_saas_create_plan_change_request",
] as const;

interface ToolDef {
  name: string;
  profile?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  adapterMethod: string;
  permissionRequired: string;
}

function makeAdapter(): Record<string, unknown> {
  return new MockSupportAdapter(createDemoFixtures()) as unknown as Record<string, unknown>;
}

function permissionRank(p: string): number {
  const order = PERMISSIONS as readonly string[];
  const i = order.indexOf(p);
  if (i === -1) throw new Error(`unknown permission '${p}'`);
  return i;
}

function isProposalCreating(def: ToolDef): boolean {
  return (
    def.adapterMethod === "createActionProposal" ||
    /create_(case_note|escalation|action_proposal|credit_request|cancellation_request|plan_change_request)$/.test(
      def.name,
    )
  );
}

export function registerToolsMapping(collector: ReportCollector): void {
  describe(SUITE, () => {
    const defs = TOOL_DEFINITIONS as unknown as ToolDef[];
    const adapter = makeAdapter();

    test("TOOL_DEFINITIONS has exactly the 16 contract tool names", () =>
      runCase(collector, SUITE, "exactly the 16 contract tool names", () => {
        expect(defs.map((d) => d.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
      }));

    test("executeAction appears in NO tool definition", () =>
      runCase(collector, SUITE, "executeAction appears in no tool definition", () => {
        for (const def of defs) {
          expect(def.adapterMethod, `${def.name}.adapterMethod`).not.toBe("executeAction");
          expect(def.name, def.name).not.toContain("execute");
        }
      }));

    test("proposal-creating tool schemas reject client-supplied requestedPermission/requestedBy", () =>
      runCase(
        collector,
        SUITE,
        "proposal tools reject client-chosen requestedPermission/requestedBy",
        () => {
          // §7: the server builds the ActionProposal from principal + shortcut
          // fields — clients must never pick requestedPermission/requestedBy.
          for (const def of defs.filter(isProposalCreating)) {
            const valid = loadFixture(def.name);
            if (!valid) throw new Error(`missing valid fixture for ${def.name}`);
            for (const field of ["requestedPermission", "requestedBy"]) {
              expect(
                validateAgainst(`tools/${def.name}`, { ...valid, [field]: "execute" }),
                `${def.name} accepted client-supplied ${field}`,
              ).toBe(false);
            }
          }
        },
      ));

    for (const name of EXPECTED_TOOLS) {
      test(`${name}: definition, schema file, adapter method line up`, () =>
        runCase(
          collector,
          SUITE,
          `${name}: 1:1 mapping`,
          () => {
            const def = defs.find((d) => d.name === name);
            if (!def) throw new Error(`TOOL_DEFINITIONS missing ${name}`);

            // schemas/tools/<name>.json exists and is a valid-looking JSON Schema
            const schemaPath = join(schemasDir(), "tools", `${name}.json`);
            expect(existsSync(schemaPath), `missing ${schemaPath}`).toBe(true);
            const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<
              string,
              unknown
            >;
            expect(schema.type === "object" || typeof schema.properties === "object").toBe(true);

            // required/properties must match the tool definition inputSchema
            // exactly — including proposal-shortcut tools, whose published
            // schema is the narrow shortcut shape (§7), never NewActionProposal.
            const schemaRequired = [...((schema.required as string[]) ?? [])].sort();
            const defRequired = [...((def.inputSchema.required as string[]) ?? [])].sort();
            const schemaProps = Object.keys(
              (schema.properties as Record<string, unknown>) ?? {},
            ).sort();
            const defProps = Object.keys(
              (def.inputSchema.properties as Record<string, unknown>) ?? {},
            ).sort();
            expect(defRequired).toEqual(schemaRequired);
            expect(defProps).toEqual(schemaProps);

            // adapterMethod exists on a SupportAdapter implementation
            expect(typeof adapter[def.adapterMethod], def.adapterMethod).toBe("function");

            // valid fixture passes the published tool schema
            const valid = loadFixture(name);
            if (valid) expect(validateAgainst(`tools/${name}`, valid)).toBe(true);
          },
        ));

      test(`${name}: permission discipline`, () =>
        runCase(collector, SUITE, `${name}: permission discipline`, () => {
          const def = defs.find((d) => d.name === name);
          if (!def) throw new Error(`TOOL_DEFINITIONS missing ${name}`);
          if (isProposalCreating(def)) {
            expect(
              permissionRank(def.permissionRequired),
              `${name} permissionRequired=${def.permissionRequired} exceeds request-approval`,
            ).toBeLessThanOrEqual(permissionRank("request-approval"));
          }
          // no tool may require "execute"
          expect(permissionRank(def.permissionRequired)).toBeLessThan(
            permissionRank("execute"),
          );
        }));
    }
  });
}
