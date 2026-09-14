import { describe, expect, it } from "vitest";
import { applyParamTransforms } from "./param-transforms.js";

describe("applyParamTransforms", () => {
  it("redacts a top-level key with the default replacement", () => {
    const { params, applied } = applyParamTransforms(
      { orderId: "ord_1", email: "a@b.c" },
      [{ path: "/email", op: "redact" }],
    );
    expect(params).toEqual({ orderId: "ord_1", email: "***" });
    expect(applied).toHaveLength(1);
  });

  it("redacts with an explicit replacement", () => {
    const { params } = applyParamTransforms(
      { note: "call me", reason: "damaged" },
      [{ path: "/note", op: "redact", replacement: "[redacted]" }],
    );
    expect(params).toEqual({ note: "[redacted]", reason: "damaged" });
  });

  it("redacts nested object keys and array indices", () => {
    const { params, applied } = applyParamTransforms(
      {
        customer: { email: "a@b.c", name: "Ann" },
        items: [{ sku: "SKU-1", note: "x" }, { sku: "SKU-2" }],
      },
      [
        { path: "/customer/email", op: "redact" },
        { path: "/items/0/note", op: "redact" },
      ],
    );
    expect(params).toEqual({
      customer: { email: "***", name: "Ann" },
      items: [{ sku: "SKU-1", note: "***" }, { sku: "SKU-2" }],
    });
    expect(applied).toHaveLength(2);
  });

  it("unescapes RFC 6901 ~0 and ~1 pointer segments", () => {
    const { params } = applyParamTransforms(
      { "a/b": { "~x": "secret" } },
      [{ path: "/a~1b/~0x", op: "redact" }],
    );
    expect(params).toEqual({ "a/b": { "~x": "***" } });
  });

  it("is a no-op when the path does not resolve", () => {
    const input = { orderId: "ord_1", customer: { name: "Ann" } };
    const { params, applied } = applyParamTransforms(input, [
      { path: "/missing", op: "redact" },
      { path: "/customer/missing", op: "redact" },
      { path: "/customer/name/deeper", op: "redact" }, // string is not a container
      { path: "/items/9/sku", op: "redact" }, // missing array
    ]);
    expect(params).toEqual(input);
    expect(applied).toEqual([]);
  });

  it("is a no-op for non-pointer paths and the empty whole-document path", () => {
    const input = { email: "a@b.c" };
    const { params, applied } = applyParamTransforms(input, [
      { path: "email", op: "redact" }, // missing leading "/"
      { path: "", op: "redact" }, // whole-document replacement unsupported
    ]);
    expect(params).toEqual(input);
    expect(applied).toEqual([]);
  });

  it("never invents keys: redaction only rewrites existing values", () => {
    const { params, applied } = applyParamTransforms(
      { orderId: "ord_1" },
      [{ path: "/email", op: "redact" }],
    );
    expect(params).toEqual({ orderId: "ord_1" });
    expect(applied).toEqual([]);
  });

  it("does not mutate the input params", () => {
    const input = { customer: { email: "a@b.c" } };
    const { params } = applyParamTransforms(input, [
      { path: "/customer/email", op: "redact" },
    ]);
    expect(params).not.toBe(input);
    expect(params.customer).not.toBe(input.customer);
    expect(input.customer.email).toBe("a@b.c");
  });

  it("returns an unchanged deep clone when no transforms are given", () => {
    const input = { a: 1 };
    const { params, applied } = applyParamTransforms(input, undefined);
    expect(params).toEqual(input);
    expect(params).not.toBe(input);
    expect(applied).toEqual([]);
  });
});
