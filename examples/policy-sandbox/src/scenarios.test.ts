import { describe, expect, it } from "vitest";
import {
  AUTO_LIMIT_MINOR,
  evaluateRefund,
  PRESETS,
  runPresets,
  sandboxPolicy,
} from "./scenarios.js";

/**
 * The sandbox's claims are only as good as the engine behind them, so every
 * headline outcome is asserted here rather than hard-coded in the UI.
 */
describe("policy sandbox scenarios", () => {
  it("keeps a hard-coded copy of the limit in sync with the policy", () => {
    const rule = sandboxPolicy().rules[0];
    expect(rule?.maxAmount?.minorUnits).toBe(AUTO_LIMIT_MINOR);
    expect(sandboxPolicy().defaultDecision).toBe("block");
  });

  it("auto-executes a small, well-evidenced refund", () => {
    const decision = evaluateRefund({ minorUnits: 2_500 });
    expect(decision.decision).toBe("auto_execute");
    expect(decision.reasons).toEqual([]);
  });

  it("escalates once the amount crosses the limit", () => {
    const under = evaluateRefund({ minorUnits: AUTO_LIMIT_MINOR });
    const over = evaluateRefund({ minorUnits: AUTO_LIMIT_MINOR + 1 });
    expect(under.decision).toBe("auto_execute");
    expect(over.decision).not.toBe("auto_execute");
    expect(over.reasons.map((r) => r.code)).toContain("OVER_THRESHOLD");
  });

  it("blocks a model that asks for execute", () => {
    const decision = evaluateRefund({ minorUnits: 2_500, requestedPermission: "execute" });
    expect(decision.decision).toBe("block");
    expect(decision.reasons.map((r) => r.code)).toContain("PERMISSION_OVERREACH");
  });

  it("blocks a prompt-injected request", () => {
    const decision = evaluateRefund({ minorUnits: 2_500, injectionSuspected: true });
    expect(decision.decision).toBe("block");
    expect(decision.reasons.map((r) => r.code)).toContain("PROMPT_INJECTION_SUSPECTED");
  });

  it("blocks on stale evidence", () => {
    const decision = evaluateRefund({ minorUnits: 2_500, evidenceAgeSeconds: 30 * 86_400 });
    expect(decision.decision).toBe("block");
    expect(decision.reasons.map((r) => r.code)).toContain("EVIDENCE_STALE");
  });

  it("evaluates every preset and reports the real reason codes", () => {
    const results = runPresets();
    expect(results).toHaveLength(PRESETS.length);
    const byId = Object.fromEntries(results.map((r) => [r.preset.id, r.decision.decision]));
    expect(byId).toEqual({
      small: "auto_execute",
      large: "require_approval",
      overreach: "block",
      injection: "block",
      stale: "block",
    });
    // Surface the actual reasons so the UI copy can be checked against reality.
    for (const { preset, decision } of results) {
      console.log(
        `  ${preset.id.padEnd(10)} -> ${decision.decision.padEnd(16)} ` +
          `[${decision.reasons.map((r) => r.code).join(", ") || "no reasons"}]`,
      );
    }
  });
});
