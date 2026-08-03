import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopDatabase } from "../src/main/database/desktop-database.ts";
import {
  ProviderSecretVault,
  type SecretStorage,
} from "../src/main/settings/provider-secret-vault.ts";
import {
  SettingsService,
  type ExternalLinkOpener,
} from "../src/main/settings/settings-service.ts";

const vaultFileName = "provider-secrets.json";

/** Reversible stand-in for Electron's safeStorage, so tests can assert round-trips. */
function createStorage(overrides: Partial<SecretStorage> = {}): SecretStorage & { encryptCalls: string[]; decryptCalls: Buffer[] } {
  const encryptCalls: string[] = [];
  const decryptCalls: Buffer[] = [];
  return {
    encryptCalls,
    decryptCalls,
    isEncryptionAvailable: () => true,
    encryptString(plainText: string) {
      encryptCalls.push(plainText);
      return Buffer.from(`enc:${plainText}`, "utf8");
    },
    decryptString(encrypted: Buffer) {
      decryptCalls.push(encrypted);
      return encrypted.toString("utf8").replace(/^enc:/, "");
    },
    ...overrides,
  };
}

function createLinkOpener(): ExternalLinkOpener & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async openExternal(url: string) {
      opened.push(url);
    },
  };
}

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentic-${label}-`));
}

function readVaultFile(dir: string): Record<string, { encryptedValue: string; updatedAt: string }> {
  return JSON.parse(fs.readFileSync(path.join(dir, vaultFileName), "utf8"));
}

test("vault encrypts secrets under a generated reference and never stores plaintext", () => {
  const dir = tempDir("vault-save");
  const storage = createStorage();
  const vault = new ProviderSecretVault(dir, storage);

  const reference = vault.save("  sk-live-secret  ");

  assert.match(reference, /^provider-secret:[0-9a-f-]{36}$/);
  assert.deepEqual(storage.encryptCalls, ["sk-live-secret"], "secret is trimmed before encryption");

  const raw = fs.readFileSync(path.join(dir, vaultFileName), "utf8");
  assert.ok(!raw.includes("sk-live-secret"), "plaintext secret must not reach disk");

  const entry = readVaultFile(dir)[reference];
  assert.equal(Buffer.from(entry.encryptedValue, "base64").toString("utf8"), "enc:sk-live-secret");
  assert.ok(Date.parse(entry.updatedAt) > 0);
});

test("vault reuses an existing reference on rotation instead of orphaning entries", () => {
  const dir = tempDir("vault-rotate");
  const vault = new ProviderSecretVault(dir, createStorage());

  const reference = vault.save("first-token");
  const rotated = vault.save("second-token", reference);

  assert.equal(rotated, reference);
  const entries = readVaultFile(dir);
  assert.equal(Object.keys(entries).length, 1, "rotation overwrites rather than appends");
  assert.equal(
    Buffer.from(entries[reference].encryptedValue, "base64").toString("utf8"),
    "enc:second-token",
  );
});

test("vault decrypts saved secrets by reference for runtime injection", () => {
  const dir = tempDir("vault-read");
  const storage = createStorage();
  const vault = new ProviderSecretVault(dir, storage);

  const reference = vault.save("runtime-token");

  assert.equal(vault.read(reference), "runtime-token");
  assert.equal(storage.decryptCalls.length, 1);
  assert.equal(vault.read("provider-secret:missing"), undefined);
});

test("vault rejects empty secrets and unavailable OS encryption", () => {
  const dir = tempDir("vault-reject");

  const vault = new ProviderSecretVault(dir, createStorage());
  assert.throws(() => vault.save("   "), /Secret cannot be empty/);

  const unavailable = new ProviderSecretVault(
    dir,
    createStorage({ isEncryptionAvailable: () => false }),
  );
  assert.throws(() => unavailable.save("token"), /Local encrypted storage is unavailable/);

  assert.ok(!fs.existsSync(path.join(dir, vaultFileName)), "failed saves write nothing");
});

test("vault delete is a no-op for missing and undefined references", () => {
  const dir = tempDir("vault-delete");
  const vault = new ProviderSecretVault(dir, createStorage());

  vault.delete(undefined);
  vault.delete("provider-secret:never-existed");
  assert.ok(!fs.existsSync(path.join(dir, vaultFileName)), "no-op deletes do not create the vault");

  const reference = vault.save("token");
  vault.delete(reference);
  assert.deepEqual(readVaultFile(dir), {});
});

test("vault recovers from a corrupt file instead of throwing", () => {
  const dir = tempDir("vault-corrupt");
  fs.writeFileSync(path.join(dir, vaultFileName), "{ not json", "utf8");
  const vault = new ProviderSecretVault(dir, createStorage());

  const reference = vault.save("token");

  assert.deepEqual(Object.keys(readVaultFile(dir)), [reference]);
});

test("saving a connection persists a vault reference and drops the plaintext token", async () => {
  const dir = tempDir("settings-save");
  const db = await DesktopDatabase.open(dir);
  const storage = createStorage();
  const service = new SettingsService(db, new ProviderSecretVault(dir, storage), createLinkOpener());

  const connection = service.saveProviderConnection({
    provider: "custom-api",
    accountLabel: "internal gateway",
    tokenSecret: "sk-custom-123",
  });

  assert.ok(connection.tokenReference, "connection points at the vault");
  assert.equal(connection.authMode, "api-key");
  assert.equal(connection.status, "connected");
  assert.equal((connection as { tokenSecret?: string }).tokenSecret, undefined);
  assert.deepEqual(storage.encryptCalls, ["sk-custom-123"]);
  assert.deepEqual(Object.keys(readVaultFile(dir)), [connection.tokenReference]);

  db.close();
});

test("rotating a connection token keeps one reference and one vault entry", async () => {
  const dir = tempDir("settings-rotate");
  const db = await DesktopDatabase.open(dir);
  const service = new SettingsService(db, new ProviderSecretVault(dir, createStorage()), createLinkOpener());

  const created = service.saveProviderConnection({
    provider: "kiro",
    tokenSecret: "token-v1",
  });
  const rotated = service.saveProviderConnection({
    id: created.id,
    provider: "kiro",
    tokenReference: created.tokenReference,
    tokenSecret: "token-v2",
  });

  assert.equal(rotated.tokenReference, created.tokenReference);
  assert.equal(service.listProviderConnections().length, 1);

  const entries = readVaultFile(dir);
  assert.equal(Object.keys(entries).length, 1);
  assert.equal(
    Buffer.from(entries[created.tokenReference!].encryptedValue, "base64").toString("utf8"),
    "enc:token-v2",
  );

  db.close();
});

test("saving without a token secret leaves the stored reference intact", async () => {
  const dir = tempDir("settings-metadata");
  const db = await DesktopDatabase.open(dir);
  const storage = createStorage();
  const service = new SettingsService(db, new ProviderSecretVault(dir, storage), createLinkOpener());

  const created = service.saveProviderConnection({ provider: "claude-code", tokenSecret: "token" });
  const relabelled = service.saveProviderConnection({
    id: created.id,
    provider: "claude-code",
    accountLabel: "work account",
  });

  assert.equal(relabelled.tokenReference, created.tokenReference);
  assert.equal(relabelled.accountLabel, "work account");
  assert.equal(storage.encryptCalls.length, 1, "metadata-only saves do not re-encrypt");

  db.close();
});

test("deleting a connection also removes its secret from the vault", async () => {
  const dir = tempDir("settings-delete");
  const db = await DesktopDatabase.open(dir);
  const service = new SettingsService(db, new ProviderSecretVault(dir, createStorage()), createLinkOpener());

  const kept = service.saveProviderConnection({ provider: "kiro", tokenSecret: "keep-me" });
  const removed = service.saveProviderConnection({ provider: "github-copilot", tokenSecret: "drop-me" });

  service.deleteProviderConnection(removed.id);

  assert.deepEqual(
    service.listProviderConnections().map((entry) => entry.id),
    [kept.id],
  );
  assert.deepEqual(Object.keys(readVaultFile(dir)), [kept.tokenReference]);

  db.close();
});

test("provider auth opens a known console url and reports unsupported providers", async () => {
  const dir = tempDir("settings-auth");
  const db = await DesktopDatabase.open(dir);
  const linkOpener = createLinkOpener();
  const service = new SettingsService(db, new ProviderSecretVault(dir, createStorage()), linkOpener);

  const opened = await service.openProviderAuth({ provider: "openai-codex" });
  assert.deepEqual(opened, {
    provider: "openai-codex",
    opened: true,
    url: "https://platform.openai.com/",
  });

  const unsupported = await service.openProviderAuth({ provider: "custom-api" });
  assert.deepEqual(unsupported, { provider: "custom-api", opened: false });
  assert.deepEqual(linkOpener.opened, ["https://platform.openai.com/"], "no browser for api-key providers");

  db.close();
});

test("identity save defaults to signed-in and round-trips through the database", async () => {
  const dir = tempDir("settings-identity");
  const db = await DesktopDatabase.open(dir);
  const service = new SettingsService(db, new ProviderSecretVault(dir, createStorage()), createLinkOpener());

  assert.equal(service.getIdentity().status, "signed-out");

  const saved = service.saveIdentity({
    email: "bao@example.com",
    displayName: "Bao",
    loginMethod: "github",
  });

  assert.equal(saved.status, "signed-in");
  assert.equal(saved.email, "bao@example.com");
  assert.deepEqual(service.getIdentity(), saved);

  db.close();
});
