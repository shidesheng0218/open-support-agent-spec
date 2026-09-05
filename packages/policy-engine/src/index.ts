export * from "./types.js";
export * from "./stable-stringify.js";
export * from "./money.js";
export * from "./evaluate.js";
export * from "./execution.js";
export * from "./audit-chain.js";
export * from "./policy-store.js";

// Re-export the §2 proposal state machine for API-layer consumers.
export {
  PROPOSAL_TRANSITIONS,
  canTransitionProposal,
  transitionProposal,
  IllegalTransitionError,
} from "@osas/core";
