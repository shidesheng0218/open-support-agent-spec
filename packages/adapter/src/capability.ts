import type { Capability, CapabilityManifest } from "@osas/core";
import { AdapterCapabilityError } from "./errors.js";
import type { SupportAdapter, ToolContext } from "./types.js";

/** True when `capability` is granted by any profile in the manifest. */
export function manifestAllows(manifest: CapabilityManifest, capability: Capability): boolean {
  return manifest.profiles.some((p) => p.capabilities.includes(capability));
}

/** Throws AdapterCapabilityError (CAPABILITY_UNSUPPORTED) when not granted. */
export function requireCapability(manifest: CapabilityManifest, capability: Capability): void {
  if (!manifestAllows(manifest, capability)) {
    throw new AdapterCapabilityError(capability);
  }
}

/**
 * Enforce a declared capability against an adapter's optional capability
 * provider. Adapters without `getCapabilities` (pre-0.1.1 implementations)
 * are permissive — declarations are opt-in, but once declared they bind.
 */
export async function requireAdapterCapability(
  adapter: SupportAdapter,
  ctx: ToolContext,
  capability: Capability,
): Promise<void> {
  if (!adapter.getCapabilities) return;
  const manifest = await adapter.getCapabilities(ctx);
  requireCapability(manifest, capability);
}
