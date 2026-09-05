import { describe, expect, it } from "vitest";
import {
  AdapterNotFoundError,
  AdapterPermissionError,
  hasPermission,
  requirePermission,
  type Principal,
} from "./index.js";

describe("adapter errors", () => {
  it("AdapterNotFoundError carries code NOT_FOUND", () => {
    const err = new AdapterNotFoundError("case_x missing");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdapterNotFoundError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.name).toBe("AdapterNotFoundError");
    expect(err.message).toBe("case_x missing");
  });

  it("AdapterPermissionError carries code PERMISSION_DENIED", () => {
    const err = new AdapterPermissionError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdapterPermissionError);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.name).toBe("AdapterPermissionError");
  });

  it("default messages exist", () => {
    expect(new AdapterNotFoundError().message).toBeTruthy();
    expect(new AdapterPermissionError().message).toBeTruthy();
  });
});

describe("requirePermission", () => {
  const withPerm = (permission: Principal["permission"]): Principal => ({
    actorType: "model",
    actorId: "tester",
    permission,
  });

  it("accepts equal and higher permissions across the ladder", () => {
    expect(() => requirePermission(withPerm("read"), "read")).not.toThrow();
    expect(() => requirePermission(withPerm("draft"), "read")).not.toThrow();
    expect(() => requirePermission(withPerm("request-approval"), "draft")).not.toThrow();
    expect(() => requirePermission(withPerm("execute"), "request-approval")).not.toThrow();
    expect(() => requirePermission(withPerm("execute"), "execute")).not.toThrow();
  });

  it("rejects lower permissions with AdapterPermissionError", () => {
    expect(() => requirePermission(withPerm("read"), "draft")).toThrowError(
      AdapterPermissionError,
    );
    expect(() => requirePermission(withPerm("draft"), "request-approval")).toThrowError(
      AdapterPermissionError,
    );
    expect(() => requirePermission(withPerm("request-approval"), "execute")).toThrowError(
      AdapterPermissionError,
    );
  });

  it("models capped at request-approval cannot execute", () => {
    const model: Principal = { actorType: "model", actorId: "m1", permission: "request-approval" };
    expect(hasPermission(model, "draft")).toBe(true);
    expect(hasPermission(model, "execute")).toBe(false);
    expect(() => requirePermission(model, "execute")).toThrowError(/lacks required permission/);
  });
});
