import type { AgentCliId, AgentProfile, ProviderConnection } from "@contracts";
import { buildProviderRuntimeEnv, selectProviderConnection } from "./provider-runtime-env";
import type { ProviderSecretVault } from "../settings/provider-secret-vault";

/**
 * The database surface a resolver needs. Declared structurally so both the agent
 * manager and the workflow service can pass their own `DesktopDatabase` without
 * either module importing the other.
 */
export type ProviderResolverDatabase = {
  listAgentProfiles(): AgentProfile[];
  listProviderConnections(): ProviderConnection[];
};

export type ProviderEnvRequest = {
  cliId: AgentCliId;
  /** Profile whose saved connection is used when no id is passed explicitly. */
  profileId?: string;
  /** Explicit connection id, taking precedence over the profile's. */
  providerConnectionId?: string;
};

/**
 * Resolves the credential environment for one CLI invocation.
 *
 * Both spawn paths — interactive agent runs and workflow steps — go through this
 * so a profile's provider connection reaches the child process identically. A run
 * that names a connection explicitly fails loudly when it cannot be resolved,
 * because silently spawning an unauthenticated CLI is the harder failure to debug.
 */
export function resolveProviderEnv(
  db: ProviderResolverDatabase,
  secretVault: ProviderSecretVault | undefined,
  request: ProviderEnvRequest,
): NodeJS.ProcessEnv {
  const profile = request.profileId
    ? db.listAgentProfiles().find((entry) => entry.id === request.profileId)
    : undefined;
  const requestedConnectionId = request.providerConnectionId ?? profile?.providerConnectionId;
  const connection = selectProviderConnection(request.cliId, db.listProviderConnections(), requestedConnectionId);

  if (!connection) {
    if (requestedConnectionId) {
      throw new Error("Provider connection is missing or not connected.");
    }
    return {};
  }

  const secret = connection.tokenReference ? secretVault?.read(connection.tokenReference) : undefined;
  return buildProviderRuntimeEnv({ connection, secret });
}
