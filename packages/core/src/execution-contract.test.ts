import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES, EXECUTION_MODES } from "./enums.js";

describe("controlled execution contract", () => {
  it("publishes sandbox as a supported execution mode", () => {
    expect(EXECUTION_MODES).toEqual(["proposal_only", "shadow", "sandbox", "live"]);
  });

  it("publishes provider-event and execution-attempt audit events", () => {
    expect(AUDIT_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "execution_attempt_created",
        "provider_event_received",
        "reconciliation_opened",
        "reconciliation_resolved",
      ]),
    );
  });
});
