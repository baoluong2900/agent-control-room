import type {
  AgentCliId,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderVerificationOutcome,
} from "@contracts";
import { providerByCli, resolveConnectionBaseUrl } from "../agents/provider-runtime-env";

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
 *
 * Gateway providers are the one exception: a Hermes Agent connection points at a
 * loopback proxy the user runs themselves, so calling `GET /models` on it costs
 * no quota and sends nothing off the machine. There, reachability *is* the
 * useful fact, because the whole connection is dead when the proxy is not up.
 */
export type ProviderVerificationInput = {
  connection: ProviderConnection;
  /** The decrypted secret, when the vault holds one for this connection. */
  secret?: string;
  /** Resolves a CLI id to its binary, or null when it is not on PATH. */
  probeCli: (cliId: AgentCliId) => Promise<{ installed: boolean; detail?: string }>;
  /** Calls a local gateway endpoint. Injected so tests never open a socket. */
  probeEndpoint?: EndpointProbe;
};

/** Result of asking a local OpenAI-compatible endpoint whether it is alive. */
export type EndpointProbeResult = {
  reachable: boolean;
  /** HTTP status when the endpoint answered at all. */
  statusCode?: number;
  detail?: string;
};

export type EndpointProbe = (baseUrl: string) => Promise<EndpointProbeResult>;

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

/** Providers that are themselves an endpoint rather than a vendor CLI. */
const gatewayProviders = new Set<ProviderConnection["provider"]>(["hermes-agent"]);

const ENDPOINT_PROBE_TIMEOUT_MS = 2500;

/** Real probe: a short `GET <baseUrl>/models` against the local gateway. */
export const defaultEndpointProbe: EndpointProbe = async (baseUrl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENDPOINT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      signal: controller.signal,
      // Any bearer is accepted by the proxy; it swaps in the real credential.
      headers: { authorization: "Bearer hermes-proxy" },
    });
    return { reachable: true, statusCode: response.status };
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};

export async function verifyProviderConnection(input: ProviderVerificationInput): Promise<ProviderVerification> {
  const { connection, secret, probeCli, probeEndpoint = defaultEndpointProbe } = input;

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

  if (gatewayProviders.has(connection.provider)) {
    return verifyGateway(connection, probeEndpoint);
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

/**
 * Checks a local OpenAI-compatible gateway by asking it for its model list. An
 * unreachable endpoint is reported as disconnected because nothing routed
 * through it can run; an auth rejection still proves the proxy is up, which is
 * the part this app controls.
 */
async function verifyGateway(
  connection: ProviderConnection,
  probeEndpoint: EndpointProbe,
): Promise<ProviderVerification> {
  const baseUrl = resolveConnectionBaseUrl(connection);
  if (!baseUrl) {
    return {
      outcome: "unsupported",
      status: "disconnected",
      detail: "No endpoint is configured for this gateway connection.",
    };
  }

  const probe = await probeEndpoint(baseUrl);
  if (!probe.reachable) {
    return {
      outcome: "cli-missing",
      status: "disconnected",
      detail: probe.detail
        ? `${baseUrl} did not answer: ${probe.detail}. Start it with \`hermes proxy start\`.`
        : `${baseUrl} did not answer. Start it with \`hermes proxy start\`.`,
    };
  }

  if (probe.statusCode && probe.statusCode >= 500) {
    return {
      outcome: "cli-missing",
      status: "expired",
      detail: `${baseUrl} answered ${probe.statusCode}. The gateway is running but is failing to serve requests.`,
    };
  }

  if (probe.statusCode === 401 || probe.statusCode === 403) {
    return {
      outcome: "missing-credential",
      status: "expired",
      detail: `${baseUrl} is running but rejected the request (${probe.statusCode}). Re-run \`hermes proxy status\` and log the upstream provider back in.`,
    };
  }

  return {
    outcome: "verified",
    status: "connected",
    detail: `${baseUrl} answered${probe.statusCode ? ` ${probe.statusCode}` : ""}. The gateway attaches its own upstream credentials, so no local key is needed.`,
  };
}
