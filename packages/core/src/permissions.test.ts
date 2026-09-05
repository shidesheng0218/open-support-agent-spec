import { describe, expect, it } from "vitest";
import { PERMISSIONS, permissionAtLeast } from "./index.js";

describe("permission ladder", () => {
  it("is ordered read < draft < request-approval < execute", () => {
    expect(PERMISSIONS).toEqual(["read", "draft", "request-approval", "execute"]);
  });

  it("permissionAtLeast compares ladder positions", () => {
    expect(permissionAtLeast("execute", "read")).toBe(true);
    expect(permissionAtLeast("request-approval", "draft")).toBe(true);
    expect(permissionAtLeast("read", "read")).toBe(true);
    expect(permissionAtLeast("read", "draft")).toBe(false);
    expect(permissionAtLeast("draft", "request-approval")).toBe(false);
    expect(permissionAtLeast("request-approval", "execute")).toBe(false);
  });

  it("model cap: request-approval is below execute", () => {
    expect(permissionAtLeast("request-approval", "request-approval")).toBe(true);
    expect(permissionAtLeast("request-approval", "execute")).toBe(false);
  });
});
