import type { GovernanceStores } from "@osas/governance";
import { PostgresOrganizationStore, PostgresWorkspaceStore, PostgresMembershipStore } from "./governance-identity-store.js";
import { PostgresConnectionStore } from "./governance-connection-store.js";
import { PostgresIntegrationEventStore } from "./governance-event-store.js";
import { PostgresJobStore } from "./governance-job-store.js";
import {
  PostgresGovernanceUsageStore,
  PostgresGovernedCaseStore,
  PostgresGovernanceReconciliationStore,
} from "./governance-case-store.js";
import type { Queryable } from "./pool.js";

/**
 * Every governance store bound to one query surface (a Pool, or a transaction
 * client when the caller needs the whole control-plane write to be atomic).
 */
export function postgresGovernanceStores(db: Queryable): GovernanceStores {
  return {
    organizations: new PostgresOrganizationStore(db),
    workspaces: new PostgresWorkspaceStore(db),
    memberships: new PostgresMembershipStore(db),
    connections: new PostgresConnectionStore(db),
    integrationEvents: new PostgresIntegrationEventStore(db),
    jobs: new PostgresJobStore(db),
    reconciliations: new PostgresGovernanceReconciliationStore(db),
    cases: new PostgresGovernedCaseStore(db),
    usage: new PostgresGovernanceUsageStore(db),
  };
}
