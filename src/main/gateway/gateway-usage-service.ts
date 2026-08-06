import type {
  GatewayUsageResult,
  GatewayUsageSettings,
  GatewayUsageSettingsInput,
  GatewayUsageSnapshot,
} from "@contracts";
import type { ProviderSecretVault } from "../settings/provider-secret-vault";
import { fetchUsageSnapshot, normalizeBaseUrl, type GatewayUsageClientOptions } from "./gateway-usage-client";

/**
 * Owns the Pool API dashboard credential and turns it into usage snapshots.
 *
 * The split from `gateway-usage-client.ts` is deliberate: the client is pure HTTP
 * plus parsing and needs no storage, while this class is the only place that touches
 * the vault. That keeps "where does the key live" answerable in one file.
 *
 * The key is stored through the existing `ProviderSecretVault` (Electron
 * `safeStorage`) rather than in the settings table, because the settings table is
 * plaintext SQLite and is dumped wholesale by the diagnostics export. Only the
 * *reference* is written to settings.
 */

/** Settings keys holding the dashboard configuration, alongside SIDECAR_SETTING_KEYS. */
export const GATEWAY_USAGE_SETTING_KEYS = {
  baseUrl: "gateway.usage.baseUrl",
  /** Vault reference, not the key itself. */
  keyReference: "gateway.usage.keyReference",
  /** Display-safe tail, so Settings can show which key is saved. */
  keyHint: "gateway.usage.keyHint",
} as const;

/** Where Pool API listens unless told otherwise. */
export const DEFAULT_GATEWAY_BASE_URL = "http://localhost:5100";

/** The slice of the settings table this service needs. */
export type GatewaySettingsStore = {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
};

/**
 * Builds the display-safe hint shown in Settings.
 *
 * Keeps the `sk-` prefix and the last four characters — enough to tell two keys
 * apart, not enough to use. Short strings degrade to a fixed mask rather than
 * revealing a proportionally larger share of a short key.
 */
export function describeKeyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 12) return "sk-****";
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

export class GatewayUsageService {
  constructor(
    private readonly store: GatewaySettingsStore,
    private readonly secretVault: ProviderSecretVault,
    /** Injection seam for tests. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Configuration for the renderer. Never includes the key. */
  getSettings(): GatewayUsageSettings {
    const reference = this.store.getSetting(GATEWAY_USAGE_SETTING_KEYS.keyReference)?.trim();
    return {
      baseUrl: this.store.getSetting(GATEWAY_USAGE_SETTING_KEYS.baseUrl)?.trim() || DEFAULT_GATEWAY_BASE_URL,
      hasApiKey: Boolean(reference),
      keyHint: this.store.getSetting(GATEWAY_USAGE_SETTING_KEYS.keyHint)?.trim() || null,
    };
  }

  /**
   * Persists configuration, routing the key into the vault.
   *
   * An absent `apiKey` leaves the stored credential alone so the user can edit the
   * URL without re-pasting it; an explicit empty string clears it, which is the only
   * way to disconnect without a separate "forget key" channel.
   */
  saveSettings(input: GatewayUsageSettingsInput): GatewayUsageSettings {
    if (input.baseUrl !== undefined) {
      this.store.setSetting(GATEWAY_USAGE_SETTING_KEYS.baseUrl, normalizeBaseUrl(input.baseUrl));
    }

    if (input.apiKey !== undefined) {
      const trimmed = input.apiKey.trim();
      const existing = this.store.getSetting(GATEWAY_USAGE_SETTING_KEYS.keyReference)?.trim();

      if (!trimmed) {
        this.secretVault.delete(existing);
        this.store.setSetting(GATEWAY_USAGE_SETTING_KEYS.keyReference, "");
        this.store.setSetting(GATEWAY_USAGE_SETTING_KEYS.keyHint, "");
      } else {
        const reference = this.secretVault.save(trimmed, existing);
        this.store.setSetting(GATEWAY_USAGE_SETTING_KEYS.keyReference, reference);
        this.store.setSetting(GATEWAY_USAGE_SETTING_KEYS.keyHint, describeKeyHint(trimmed));
      }
    }

    return this.getSettings();
  }

  /**
   * Reads the stored key.
   *
   * Private on purpose: nothing outside this class should be able to obtain the
   * plaintext, and there is no IPC channel that returns it.
   */
  private readApiKey(): string {
    const reference = this.store.getSetting(GATEWAY_USAGE_SETTING_KEYS.keyReference)?.trim();
    if (!reference) return "";
    try {
      return this.secretVault.read(reference) ?? "";
    } catch {
      // The vault throws when the OS keychain is locked or unavailable. That is a
      // "cannot read the key right now" condition, not a missing key, but from the
      // caller's perspective both mean the same thing: no snapshot this tick.
      return "";
    }
  }

  /** Fetches one snapshot. Always resolves; failures come back as a typed error. */
  async getSnapshot(days?: number): Promise<GatewayUsageResult<GatewayUsageSnapshot>> {
    const settings = this.getSettings();
    const apiKey = this.readApiKey();

    if (!apiKey) {
      return {
        ok: false,
        error: {
          kind: "not-configured",
          message: "Add a Pool API key in Settings to see credit and usage.",
        },
      };
    }

    const options: GatewayUsageClientOptions = {
      baseUrl: settings.baseUrl,
      apiKey,
      fetchImpl: this.fetchImpl,
    };

    return fetchUsageSnapshot(options, days);
  }
}
