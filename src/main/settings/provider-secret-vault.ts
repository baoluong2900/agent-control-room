import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type VaultEntry = {
  encryptedValue: string;
  updatedAt: string;
};

type VaultFile = Record<string, VaultEntry>;

/**
 * The slice of Electron's `safeStorage` this vault depends on. Injected rather
 * than imported so the vault can be unit-tested outside an Electron process.
 */
export type SecretStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export class ProviderSecretVault {
  private readonly filePath: string;

  constructor(
    userDataPath: string,
    private readonly storage: SecretStorage,
  ) {
    this.filePath = path.join(userDataPath, "provider-secrets.json");
  }

  save(secret: string, existingReference?: string): string {
    const trimmed = secret.trim();
    if (!trimmed) throw new Error("Secret cannot be empty.");
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error("Local encrypted storage is unavailable on this OS session.");
    }

    const reference = existingReference?.trim() || `provider-secret:${randomUUID()}`;
    const vault = this.readVault();
    vault[reference] = {
      encryptedValue: this.storage.encryptString(trimmed).toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    this.writeVault(vault);
    return reference;
  }

  read(reference?: string): string | undefined {
    if (!reference) return undefined;
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error("Local encrypted storage is unavailable on this OS session.");
    }
    const entry = this.readVault()[reference];
    if (!entry) return undefined;
    return this.storage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
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
