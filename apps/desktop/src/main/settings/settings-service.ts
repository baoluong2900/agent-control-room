import { shell } from "electron";
import type {
  AppIdentity,
  AppIdentityInput,
  ProviderConnection,
  ProviderConnectionAuthRequest,
  ProviderConnectionAuthResult,
  ProviderConnectionInput,
} from "@contracts";
import type { DesktopDatabase } from "../database/desktop-database";
import { ProviderSecretVault } from "./provider-secret-vault";

const providerAuthUrls: Record<ProviderConnection["provider"], string | undefined> = {
  "openai-codex": "https://platform.openai.com/",
  "claude-code": "https://claude.ai/",
  "github-copilot": "https://github.com/login",
  kiro: "https://kiro.dev/",
  "custom-api": undefined,
};

export class SettingsService {
  constructor(
    private readonly database: DesktopDatabase,
    private readonly secretVault: ProviderSecretVault,
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
    const tokenReference = input.tokenSecret?.trim()
      ? this.secretVault.save(input.tokenSecret, input.tokenReference)
      : input.tokenReference?.trim();

    return this.database.saveProviderConnection({
      ...input,
      tokenReference,
      tokenSecret: undefined,
      status: input.status ?? "connected",
    });
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

    await shell.openExternal(url);
    return {
      provider: input.provider,
      opened: true,
      url,
    };
  }
}
