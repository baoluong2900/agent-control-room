import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSecretVault } from "../src/main/settings/provider-secret-vault.ts";
import {
  DEFAULT_GATEWAY_BASE_URL,
  GATEWAY_USAGE_SETTING_KEYS,
  GatewayUsageService,
  describeKeyHint,
} from "../src/main/gateway/gateway-usage-service.ts";

/**
 * These tests exist mainly to pin the secret-handling contract: the plaintext key
 * must reach the vault and nothing else, and no code path may return it to a
 * caller. Everything else about the service is thin delegation.
 */

/** In-memory stand-in for the settings table. */
function makeStore(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getSetting: (key: string) => values.get(key),
    setSetting: (key: string, value: string) => void values.set(key, value),
  };
}

/** In-memory stand-in for the safeStorage-backed vault. */
function makeVault() {
  const entries = new Map<string, string>();
  let counter = 0;
  const vault = {
    entries,
    save(secret: string, existing?: string) {
      const reference = existing?.trim() || `provider-secret:${++counter}`;
      entries.set(reference, secret);
      return reference;
    },
    read(reference?: string) {
      return reference ? entries.get(reference) : undefined;
    },
    delete(reference?: string) {
      if (reference) entries.delete(reference);
    },
  };
  return vault as unknown as ProviderSecretVault & typeof vault;
}

test("an unconfigured service reports the default url and no key", () => {
  const service = new GatewayUsageService(makeStore(), makeVault());
  const settings = service.getSettings();

  assert.equal(settings.baseUrl, DEFAULT_GATEWAY_BASE_URL);
  assert.equal(settings.hasApiKey, false);
  assert.equal(settings.keyHint, null);
});

test("saving a key puts the plaintext in the vault and only a reference in settings", () => {
  const store = makeStore();
  const vault = makeVault();
  const service = new GatewayUsageService(store, vault);

  service.saveSettings({ apiKey: "sk-live-secret-value-1234" });

  const persisted = [...store.values.values()].join(" ");
  assert.ok(!persisted.includes("sk-live-secret-value-1234"), "the settings table never holds the plaintext");
  assert.deepEqual([...vault.entries.values()], ["sk-live-secret-value-1234"]);
});

test("the returned settings never carry the key itself", () => {
  const service = new GatewayUsageService(makeStore(), makeVault());
  const settings = service.saveSettings({ apiKey: "sk-live-secret-value-1234" });

  assert.equal(settings.hasApiKey, true);
  assert.ok(!JSON.stringify(settings).includes("secret-value"), "only a masked hint crosses the bridge");
});

test("the key hint keeps a prefix and tail but not the body", () => {
  const hint = describeKeyHint("sk-abcdefghijklmnop9999");

  assert.match(hint, /^sk-/);
  assert.match(hint, /9999$/);
  assert.ok(!hint.includes("efghijklmn"));
});

test("a short key is masked entirely rather than proportionally exposed", () => {
  assert.equal(describeKeyHint("sk-short"), "sk-****");
});

test("saving a url alone leaves the stored key intact", () => {
  const store = makeStore();
  const vault = makeVault();
  const service = new GatewayUsageService(store, vault);

  service.saveSettings({ apiKey: "sk-live-secret-value-1234" });
  const settings = service.saveSettings({ baseUrl: "http://127.0.0.1:9000" });

  // Editing the URL must not force the user to re-paste the credential.
  assert.equal(settings.hasApiKey, true);
  assert.equal(settings.baseUrl, "http://127.0.0.1:9000");
  assert.equal(vault.entries.size, 1);
});

test("an explicit empty key clears the credential", () => {
  const store = makeStore();
  const vault = makeVault();
  const service = new GatewayUsageService(store, vault);

  service.saveSettings({ apiKey: "sk-live-secret-value-1234" });
  const settings = service.saveSettings({ apiKey: "" });

  assert.equal(settings.hasApiKey, false);
  assert.equal(settings.keyHint, null);
  assert.equal(vault.entries.size, 0, "the vault entry is deleted, not orphaned");
});

test("rotating a key reuses the reference instead of leaking vault entries", () => {
  const store = makeStore();
  const vault = makeVault();
  const service = new GatewayUsageService(store, vault);

  service.saveSettings({ apiKey: "sk-first-key-aaaaaaaa" });
  service.saveSettings({ apiKey: "sk-second-key-bbbbbbbb" });

  assert.equal(vault.entries.size, 1);
  assert.deepEqual([...vault.entries.values()], ["sk-second-key-bbbbbbbb"]);
});

test("a snapshot without a saved key reports not-configured and makes no request", async () => {
  let called = false;
  const service = new GatewayUsageService(makeStore(), makeVault(), (async () => {
    called = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch);

  const result = await service.getSnapshot();

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "not-configured");
  assert.equal(called, false);
});

test("a locked vault degrades to not-configured instead of throwing", async () => {
  const store = makeStore({ [GATEWAY_USAGE_SETTING_KEYS.keyReference]: "provider-secret:1" });
  const throwingVault = {
    save: () => "provider-secret:1",
    // Electron's safeStorage throws when the OS keychain is unavailable.
    read: () => {
      throw new Error("keychain locked");
    },
    delete: () => {},
  } as unknown as ProviderSecretVault;

  const service = new GatewayUsageService(store, throwingVault);
  const result = await service.getSnapshot();

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "not-configured");
});

test("a configured service sends the stored key to the gateway", async () => {
  const store = makeStore();
  const vault = makeVault();
  let seenAuth = "";

  const service = new GatewayUsageService(store, vault, (async (_url: string, init: RequestInit) => {
    seenAuth = (init.headers as Record<string, string>).authorization;
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  }) as unknown as typeof fetch);

  service.saveSettings({ apiKey: "sk-live-secret-value-1234" });
  const result = await service.getSnapshot();

  assert.equal(result.ok, true);
  assert.equal(seenAuth, "Bearer sk-live-secret-value-1234");
});

test("the base url is normalized on save so a trailing slash cannot double up", () => {
  const service = new GatewayUsageService(makeStore(), makeVault());
  const settings = service.saveSettings({ baseUrl: "http://localhost:5100/" });

  assert.equal(settings.baseUrl, "http://localhost:5100");
});
