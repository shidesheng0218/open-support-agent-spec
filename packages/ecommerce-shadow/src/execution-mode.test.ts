import { describe, expect, it } from "vitest";
import { loadExecutionMode } from "./execution-mode.js";

describe("controlled execution mode", () => {
  it("accepts sandbox without changing the shadow default", () => {
    expect(loadExecutionMode({}).mode).toBe("shadow");
    expect(loadExecutionMode({ OSAS_EXECUTION_MODE: "sandbox" }).mode).toBe("sandbox");
  });

  it("accepts proposal_only as a draft-only mode", () => {
    expect(loadExecutionMode({ OSAS_EXECUTION_MODE: "proposal_only" }).mode).toBe("proposal_only");
  });

  it("continues to fail closed for live", () => {
    expect(() => loadExecutionMode({ OSAS_EXECUTION_MODE: "live" })).toThrow(
      /not available/,
    );
  });
});
