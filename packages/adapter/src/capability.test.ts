import { describe, expect, it } from "vitest";
import { CAPABILITIES, type CapabilityManifest } from "@osas/core";
import {
  AdapterCapabilityError,
  AdapterNotFoundError,
  AdapterPermissionError,
} from "./errors.js";
import { manifestAllows, requireCapability } from "./capability.js";

function manifestWith(capabilities: string[]): CapabilityManifest {
  return {
    specVersion: "0.2",
    implementationId: "test-impl",
    implementationVersion: "0.2.0",
    profiles: [{ name: "core", capabilities: capabilities as CapabilityManifest["profiles"][number]["capabilities"] }],
    transports: ["http"],
    executionModes: ["proposal_only"],
    adapterVersion: "0.2.0",
  };
}

describe("AdapterCapabilityError", () => {
  it("carries code CAPABILITY_UNSUPPORTED", () => {
    const err = new AdapterCapabilityError("case.read");
    expect(err.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(err.name).toBe("AdapterCapabilityError");
    expect(err.message).toContain("case.read");
  });

  it("existing error codes are unchanged", () => {
    expect(new AdapterNotFoundError().code).toBe("NOT_FOUND");
    expect(new AdapterPermissionError().code).toBe("PERMISSION_DENIED");
  });
});

describe("manifestAllows / requireCapability", () => {
  it("allows a capability granted in any profile", () => {
    const m = manifestWith(["case.read"]);
    expect(manifestAllows(m, "case.read")).toBe(true);
    expect(manifestAllows(m, "customer.read")).toBe(false);
  });

  it("rejects every one of the 16 spec capabilities when undeclared", () => {
    const empty = manifestWith([]);
    for (const cap of CAPABILITIES) {
      expect(() => requireCapability(empty, cap), cap).toThrowError(AdapterCapabilityError);
    }
  });

  it("a read-only manifest grants exactly the core read capabilities", async () => {
    const readOnly = manifestWith(["case.read", "customer.read", "knowledge.read", "evidence.read"]);
    for (const cap of ["case.read", "customer.read", "knowledge.read", "evidence.read"] as const) {
      expect(() => requireCapability(readOnly, cap)).not.toThrow();
    }
    expect(() => requireCapability(readOnly, "note.write")).toThrowError(AdapterCapabilityError);
    expect(() => requireCapability(readOnly, "proposal.write")).toThrowError(AdapterCapabilityError);
  });
});
