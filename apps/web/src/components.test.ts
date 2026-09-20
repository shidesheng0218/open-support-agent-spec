import { describe, expect, it } from "vitest";
import { badgeTone } from "./components";

describe("badgeTone", () => {
  it("maps the fail-safe denial status to bad", () => {
    expect(badgeTone("expired")).toBe("bad");
  });

  it("keeps the established mappings stable", () => {
    expect(badgeTone("auto_execute")).toBe("ok");
    expect(badgeTone("succeeded")).toBe("ok");
    expect(badgeTone("pending_approval")).toBe("warn");
    expect(badgeTone("reconciliation_required")).toBe("warn");
    expect(badgeTone("policy_rejected")).toBe("bad");
    expect(badgeTone("block")).toBe("bad");
    expect(badgeTone("something_new")).toBe("neutral");
  });
});