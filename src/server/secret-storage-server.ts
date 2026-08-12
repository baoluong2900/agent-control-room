import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretStorage } from "../main/settings/provider-secret-vault";

export class ServerSecretStorage implements SecretStorage {
  private key: Buffer;

  constructor(dataDir: string) {
    const envKey = process.env.AGENTIC_SECRET_KEY;
    if (envKey) {
      this.key = Buffer.from(envKey, "hex");
      if (this.key.length !== 32) {
        throw new Error("AGENTIC_SECRET_KEY env variable must be a 32-byte hex string.");
      }
      return;
    }

    const keyPath = process.env.AGENTIC_SECRET_KEY_FILE || path.join(dataDir, "secret.key");
    if (fs.existsSync(keyPath)) {
      const content = fs.readFileSync(keyPath, "utf8").trim();
      this.key = Buffer.from(content, "hex");
      if (this.key.length !== 32) {
        throw new Error(`Secret key in ${keyPath} must be a 32-byte hex string.`);
      }
    } else {
      // Generate a new 32-byte key
      this.key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, this.key.toString("hex"), { encoding: "utf8", mode: 0o600 });
    }
  }

  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(plainText: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // Format: iv (12 bytes) + tag (16 bytes) + encrypted payload
    return Buffer.concat([iv, tag, encrypted]);
  }

  decryptString(encrypted: Buffer): string {
    if (encrypted.length < 28) {
      throw new Error("Invalid encrypted payload length.");
    }
    const iv = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(12, 28);
    const payload = encrypted.subarray(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(payload) + decipher.final("utf8");
  }
}
