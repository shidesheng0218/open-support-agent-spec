import type { ParamTransform } from "@osas/core";

/**
 * Deterministic application of policy-decided param transforms
 * (CONTRACTS.md §4 step 11 / §5): the execution layer rewrites proposal
 * params — e.g. redacting PII — after the policy engine decided and BEFORE
 * the adapter sees them. Pure: params are deep-cloned, never mutated.
 *
 * Supported `path` subset (JSON-pointer style, RFC 6901):
 * - must start with "/" (e.g. "/customer/email"); each segment addresses one
 *   object key, with "~0"/"~1" unescaping applied per RFC 6901;
 * - a purely numeric segment addresses an array index;
 * - intermediate segments must already exist and be objects/arrays — this is
 *   a rewrite of the model's params, never a structural extension;
 * - paths that do not resolve (missing key/index, wrong container type, or a
 *   non-pointer path) are a NO-OP: redaction must never invent data, and an
 *   unmatched transform is surfaced via `applied` for auditability.
 * - the empty path "" (whole-document replacement) is intentionally NOT
 *   supported.
 */

export interface ParamTransformOutcome {
  /** Deep-cloned params with all applicable transforms applied. */
  params: Record<string, unknown>;
  /** Transforms that actually rewrote a value (missing paths excluded). */
  applied: ParamTransform[];
}

function parsePointer(path: string): string[] | undefined {
  if (path === "" || !path.startsWith("/")) return undefined;
  return path
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Container = Record<string, unknown> | unknown[];

function childOf(container: Container, seg: string): unknown {
  return Array.isArray(container)
    ? container[Number(seg)]
    : container[seg];
}

function isContainer(value: unknown): value is Container {
  return value !== null && typeof value === "object";
}

/** Applies one transform in place on the cloned tree. False = no-op. */
function applyOne(root: Record<string, unknown>, t: ParamTransform): boolean {
  const segs = parsePointer(t.path);
  if (!segs) return false;
  let current: unknown = root;
  for (const seg of segs.slice(0, -1)) {
    if (!isContainer(current)) return false;
    current = childOf(current, seg);
  }
  const last = segs[segs.length - 1]!;
  if (!isContainer(current)) return false;
  if (Array.isArray(current)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return false;
    current[idx] = t.replacement ?? "***";
    return true;
  }
  if (!(last in current)) return false;
  current[last] = t.replacement ?? "***";
  return true;
}

/**
 * Returns the post-transform params plus the list of transforms that rewrote
 * a value. `transforms` undefined/empty yields an unchanged deep clone and an
 * empty `applied` list.
 */
export function applyParamTransforms(
  params: Record<string, unknown>,
  transforms: readonly ParamTransform[] | undefined,
): ParamTransformOutcome {
  const out = structuredClone(params);
  const applied: ParamTransform[] = [];
  for (const t of transforms ?? []) {
    if (applyOne(out, t)) applied.push(t);
  }
  return { params: out, applied };
}
