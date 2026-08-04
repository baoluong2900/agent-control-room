import type {
  AgentCliId,
  AppIdentity,
  AppIdentityInput,
  ProviderConnection,
  ProviderConnectionAuthRequest,
  ProviderConnectionAuthResult,
  ProviderConnectionInput,
  ProviderConnectionVerifyResult,
} from "@contracts";
import type { DesktopDatabase } from "../database/desktop-database";
import { pingAgentCli } from "../agents/probe";
import { ProviderSecretVault } from "./provider-secret-vault";
import { verifyProviderConnection } from "./provider-verification";

const providerAuthUrls: Record<ProviderConnection["provider"], string | undefined> = {
  "openai-codex": "https://platform.openai.com/",
  "claude-code": "https://claude.ai/",
  "github-copilot": "https://github.com/login",
  kiro: "https://kiro.dev/",
  "custom-api": undefined,
};

/**
 * The slice of Electron's `shell` this service depends on. Injected rather than
 * imported so the service can be unit-tested outside an Electron process.
 */
export type ExternalLinkOpener = {
  openExternal(url: string): Promise<void>;
};

/**
 * Probes whether a CLI is installed. Injected so verification can be tested
 * without spawning real binaries.
 */
export type CliProbe = (cliId: AgentCliId) => Promise<{ installed: boolean; detail?: string }>;

/** Real probe: runs `<cli> --version` through the shared agent prober. */
const defaultCliProbe: CliProbe = async (cliId) => {
  const ping = await pingAgentCli(cliId);
  return { installed: ping.installed, detail: ping.detail };
};

export class SettingsService {
  constructor(
    private readonly database: DesktopDatabase,
    private readonly secretVault: ProviderSecretVault,
    private readonly linkOpener: ExternalLinkOpener,
    private readonly cliProbe: CliProbe = defaultCliProbe,
  ) {}

  getIdentity(): AppIdentity {
    return this.database.getAppIdentity();
  }

  saveIdentity(input: AppIdentityInput): AppIdentity {
    return this.database.saveAppIdentity({
      ...input,
      status: input.status ?? "signed-in",
    });
  }

  listProviderConnections(): ProviderConnection[] {
    return this.database.listProviderConnections();
  }

  saveProviderConnection(input: ProviderConnectionInput): ProviderConnection {
    const existing = input.id
      ? this.database.listProviderConnections().find((entry) => entry.id === input.id)
      : undefined;
    const tokenReference = input.tokenSecret?.trim()
      ? this.secretVault.save(input.tokenSecret, input.tokenReference ?? existing?.tokenReference)
      : input.tokenReference?.trim();

    // A save is not a check. Status falls through to the database default
    // ("unverified" for a new connection), and a rotated credential invalidates
    // whatever the previous verification concluded.
    const credentialChanged = Boolean(input.tokenSecret?.trim());

    return this.database.saveProviderConnection({
      ...input,
      tokenReference,
      tokenSecret: undefined,
      status: input.status ?? (credentialChanged ? "unverified" : existing?.status),
      lastVerifiedAt: credentialChanged ? null : input.lastVerifiedAt,
      verificationDetail: credentialChanged
        ? "Credential changed since the last check. Verify this connection again."
        : input.verificationDetail,
    });
  }

  /**
   * Checks a connection as far as the app can locally: credential presence plus
   * provider CLI availability. See `provider-verification.ts` for why this stops
   * short of calling the provider's API.
   */
  async verifyProviderConnection(id: string): Promise<ProviderConnectionVerifyResult> {
    const connection = this.database.listProviderConnections().find((entry) => entry.id === id);
    if (!connection) throw new Error(`Provider connection ${id} was not found.`);

    const secret = connection.tokenReference ? this.secretVault.read(connection.tokenReference) : undefined;
    const verification = await verifyProviderConnection({
      connection,
      secret,
      probeCli: this.cliProbe,
    });

    const checkedAt = new Date().toISOString();
    const saved = this.database.saveProviderConnection({
      id: connection.id,
      provider: connection.provider,
      authMode: connection.authMode,
      status: verification.status,
      lastVerifiedAt: checkedAt,
      verificationDetail: verification.detail,
    });

    return {
      connectionId: connection.id,
      outcome: verification.outcome,
      status: verification.status,
      detail: verification.detail,
      checkedAt,
      connection: saved,
    };
  }

  deleteProviderConnection(id: string): void {
    const connection = this.database.listProviderConnections().find((entry) => entry.id === id);
    this.secretVault.delete(connection?.tokenReference);
    this.database.deleteProviderConnection(id);
  }

  async openProviderAuth(input: ProviderConnectionAuthRequest): Promise<ProviderConnectionAuthResult> {
    const url = providerAuthUrls[input.provider];
    if (!url) {
      return {
        provider: input.provider,
        opened: false,
      };
    }

    await this.linkOpener.openExternal(url);
    return {
      provider: input.provider,
      opened: true,
      url,
    };
  }
}
