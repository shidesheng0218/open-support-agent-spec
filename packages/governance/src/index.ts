/**
 * @osas/governance — provider-neutral governance control plane (M0/M1).
 *
 * Layering: OSAS Spec -> Governance Runtime (this package) -> Adapters ->
 * Hosted Control Plane. See docs/adr/0001-platform-scope.md.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./deps.js";
export * from "./roles.js";
export * from "./actor.js";
export * from "./case-machine.js";
export * from "./ports.js";
export * from "./memory.js";
export * from "./connections.js";
export * from "./inbox.js";
export * from "./jobs.js";
export * from "./runtime.js";
