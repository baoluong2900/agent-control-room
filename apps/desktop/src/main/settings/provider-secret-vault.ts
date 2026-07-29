import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

type VaultEntry = {
  encryptedValue: string;
  updatedAt: string;
};

type VaultFile = Record<string, VaultEntry>;

export class ProviderSecretVault {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "provider-secrets.json");
  }

  save(secret: string, existingReference?: string): string {
    const trimmed = secret.trim();
    if (!trimmed) throw new Error("Secret cannot be empty.");
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Local encrypted storage is unavailable on this OS session.");
    }

    const reference = existingReference?.trim() || `provider-secret:${randomUUID()}`;
    const vault = this.readVault();
    vault[reference] = {
      encryptedValue: safeStorage.encryptString(trimmed).toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    this.writeVault(vault);
    return reference;
  }

  delete(reference?: string): void {
    if (!reference) return;
    const vault = this.readVault();
    if (!vault[reference]) return;
    delete vault[reference];
    this.writeVault(vault);
  }

  private readVault(): VaultFile {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as VaultFile) : {};
    } catch {
      return {};
    }
  }

  private writeVault(vault: VaultFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(vault, null, 2), "utf8");
  }
}
