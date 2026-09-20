import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ACTION_TYPES,
  APPROVAL_STATUSES,
  AUDIT_EVENT_TYPES,
  CAPABILITIES,
  CASE_STATUSES,
  EXECUTION_MODES,
  HANDOFF_REASONS,
  PERMISSIONS,
  PROFILES,
  PROPOSAL_STATUSES,
  SHADOW_RUN_OUTCOMES,
  TRANSPORTS,
} from "@osas/core";
import { TOOL_DEFINITIONS } from "@osas/mcp-server";
import { ReportCollector, runCase } from "./report.js";
import { schemasDir } from "./helpers.js";

/**
 * Cross-source consistency: the places where a value set exists twice — once
 * as a runtime constant in @osas/core, once as the authoritative JSON Schema
 * enum (or once as a TS tool definition and once as its schema) — are exactly
 * where drift used to go unnoticed. Every pair is asserted here so the compat
 * suite fails on divergence.
 *
 * Not introspectable at runtime (checked against the TS source instead):
 * the `AuditEventType` union in packages/core/src/types.ts.
 */

const SUITE = "cross-source-consistency";

const load = (rel: string): unknown =>
  JSON.parse(readFileSync(join(schemasDir(), rel), "utf8")) as unknown;

/** Resolve a dotted path in a schema (e.g. "properties.status.enum"). */
const at = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (node, key) =>
      node !== null && typeof node === "object"
        ? (node as Record<string, unknown>)[key]
        : undefined,
    obj,
  );

const repoRoot = resolve(schemasDir(), "..");

const ENUM_PAIRS: {
  what: string;
  values: readonly string[];
  schema: string;
  path: string;
}[] = [
  {
    what: "AUDIT_EVENT_TYPES matches core/audit-event eventType",
    values: AUDIT_EVENT_TYPES,
    schema: "core/audit-event.json",
    path: "properties.eventType.enum",
  },
  {
    what: "APPROVAL_STATUSES matches core/approval status",
    values: APPROVAL_STATUSES,
    schema: "core/approval.json",
    path: "properties.status.enum",
  },
  {
    what: "PROPOSAL_STATUSES matches core/action-proposal status",
    values: PROPOSAL_STATUSES,
    schema: "core/action-proposal.json",
    path: "properties.status.enum",
  },
  {
    what: "CASE_STATUSES matches core/case status",
    values: CASE_STATUSES,
    schema: "core/case.json",
    path: "properties.status.enum",
  },
  {
    what: "ACTION_TYPES matches core/common $defs.ActionType",
    values: ACTION_TYPES,
    schema: "core/common.json",
    path: "$defs.ActionType.enum",
  },
  {
    what: "CAPABILITIES matches core/capability-manifest $defs.Capability",
    values: CAPABILITIES,
    schema: "core/capability-manifest.json",
    path: "$defs.Capability.enum",
  },
  {
    what: "PERMISSIONS matches core/common $defs.Permission",
    values: PERMISSIONS,
    schema: "core/common.json",
    path: "$defs.Permission.enum",
  },
  {
    what: "PROFILES matches core/common $defs.Profile",
    values: PROFILES,
    schema: "core/common.json",
    path: "$defs.Profile.enum",
  },
  {
    what: "TRANSPORTS matches core/capability-manifest transports",
    values: TRANSPORTS,
    schema: "core/capability-manifest.json",
    path: "properties.transports.items.enum",
  },
  {
    what: "EXECUTION_MODES matches core/capability-manifest executionModes",
    values: EXECUTION_MODES,
    schema: "core/capability-manifest.json",
    path: "properties.executionModes.items.enum",
  },
  {
    what: "SHADOW_RUN_OUTCOMES matches core/shadow-run humanOutcome",
    values: SHADOW_RUN_OUTCOMES,
    schema: "core/shadow-run.json",
    path: "properties.humanOutcome.enum",
  },
];

export function registerConsistency(collector: ReportCollector): void {
  describe("cross-source consistency", () => {
    for (const pair of ENUM_PAIRS) {
      test(pair.what, async () => {
        await runCase(collector, SUITE, pair.what, () => {
          const schemaEnum = at(load(pair.schema), pair.path);
          expect(Array.isArray(schemaEnum), `${pair.schema} :: ${pair.path} is not an enum`).toBe(
            true,
          );
          expect(new Set(schemaEnum as string[])).toEqual(new Set(pair.values));
        });
      });
    }

    test("HANDOFF_REASONS matches core/human-handoff reason", async () => {
      await runCase(collector, SUITE, "HANDOFF_REASONS matches core/human-handoff reason", () => {
        const schemaEnum = at(load("core/human-handoff.json"), "properties.reason.enum");
        expect(new Set(schemaEnum as string[])).toEqual(new Set(HANDOFF_REASONS));
      });
    });

    test("AuditEventType union in types.ts matches AUDIT_EVENT_TYPES", async () => {
      await runCase(
        collector,
        SUITE,
        "AuditEventType union in types.ts matches AUDIT_EVENT_TYPES",
        () => {
          const source = readFileSync(join(repoRoot, "packages/core/src/types.ts"), "utf8");
          const match = /export type AuditEventType =([\s\S]*?);/.exec(source);
          expect(match, "AuditEventType union not found in types.ts").not.toBeNull();
          const union = [...(match?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
          expect(new Set(union)).toEqual(new Set(AUDIT_EVENT_TYPES));
        },
      );
    });

    for (const tool of TOOL_DEFINITIONS) {
      test(`tool ${tool.name} annotations match its schema`, async () => {
        await runCase(collector, SUITE, `tool ${tool.name}: annotations match schema`, () => {
          const schema = load(join("tools", `${tool.name}.json`));
          const required = at(schema, "annotations.required");
          expect(Array.isArray(required), `${tool.name}: schema annotations.required missing`).toBe(
            true,
          );
          expect(new Set(required as string[])).toEqual(new Set(Object.keys(tool.annotations)));
        });
      });
    }

    test("osas_core_create_action_proposal actionType enum matches $defs.ActionType", async () => {
      await runCase(
        collector,
        SUITE,
        "osas_core_create_action_proposal actionType enum matches $defs.ActionType",
        () => {
          const tool = TOOL_DEFINITIONS.find(
            (d) => d.name === "osas_core_create_action_proposal",
          );
          expect(tool, "proposal tool definition missing").toBeDefined();
          const tsEnum = at(tool!.inputSchema, "properties.actionType.enum");
          const schemaEnum = at(load("core/common.json"), "$defs.ActionType.enum");
          expect(new Set(tsEnum as string[])).toEqual(new Set(schemaEnum as string[]));
        },
      );
    });
  });
}