import type {
  AgentCliId,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderVerificationOutcome,
} from "@contracts";
import { providerByCli } from "../agents/provider-runtime-env";

/**
 * What a verification pass is allowed to conclude, and why it is deliberately
 * modest: the app never sends a credential to a provider's API to test it. Doing
 * so would spend quota and leak a token to the network on a mere settings save.
 * Instead it establishes two locally-checkable facts:
 *
 *   1. a credential actually exists for connections whose auth mode needs one,
 *   2. the provider's CLI is installed, since every run goes through that CLI.
 *
 * A "verified" result therefore means "this connection can plausibly be used",
 * not "this token is valid" — the status copy in the UI says the same.
 */
export type ProviderVerificationInput = {
  connection: ProviderConnection;
  /** The decrypted secret, when the vault holds one for this connection. */
  secret?: string;
  /** Resolves a CLI id to its binary, or null when it is not on PATH. */
  probeCli: (cliId: AgentCliId) => Promise<{ installed: boolean; detail?: string }>;
};

export type ProviderVerification = {
  outcome: ProviderVerificationOutcome;
  status: ProviderConnectionStatus;
  detail: string;
};

/** The CLI that a given provider's runs are executed through. */
const cliByProvider = new Map<ProviderConnection["provider"], AgentCliId>(
  (Object.entries(providerByCli) as Array<[AgentCliId, ProviderConnection["provider"]]>).map(([cliId, provider]) => [
    provider,
    cliId,
  ]),
);

export async function verifyProviderConnection(input: ProviderVerificationInput): Promise<ProviderVerification> {
  const { connection, secret, probeCli } = input;

  // api-key connections are useless without the key itself. oauth/device
  // connections are driven by the CLI's own login state, so a missing vault
  // secret is expected and not a failure.
  if (connection.authMode === "api-key" && !secret?.trim()) {
    return {
      outcome: "missing-credential",
      status: "disconnected",
      detail: "No API key is stored for this connection. Add the key and verify again.",
    };
  }

  const cliId = cliByProvider.get(connection.provider);
  if (!cliId) {
    // custom-api has no first-party CLI, so a stored key is all there is to check.
    return {
      outcome: secret?.trim() ? "verified" : "unsupported",
      status: secret?.trim() ? "connected" : "disconnected",
      detail: secret?.trim()
        ? "API key is stored locally. This provider has no CLI to probe, so the key was not called."
        : "This provider has no CLI to probe and no stored key to check.",
    };
  }

  const probe = await probeCli(cliId);
  if (!probe.installed) {
    return {
      outcome: "cli-missing",
      status: "disconnected",
      detail: probe.detail
        ? `${cliId} CLI was not found on PATH: ${probe.detail}`
        : `${cliId} CLI was not found on PATH. Install it to use this connection.`,
    };
  }

  return {
    outcome: "verified",
    status: "connected",
    detail: secret?.trim()
      ? `${cliId} CLI is installed and a credential is stored. The credential itself was not sent to the provider.`
      : `${cliId} CLI is installed. It supplies its own ${connection.authMode} login, so no local credential is needed.`,
  };
}
