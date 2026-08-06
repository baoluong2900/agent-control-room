import type { GatewayUsageSettings } from "@contracts";
import { KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Settings block for the Pool API dashboard credential.
 *
 * The key is write-only from the renderer's side: it is posted once to the main
 * process and never read back. What comes back is a hint (`sk-…abcd`) so the user
 * can confirm *which* key is saved without the app holding the secret in renderer
 * state where a devtools inspection or a crash dump would expose it.
 *
 * The input is cleared immediately after a successful save for the same reason.
 */
export function GatewayUsageSettingsCard() {
  const [settings, setSettings] = useState<GatewayUsageSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const bridge = window.agentic?.gateway;
      if (!bridge) return;
      try {
        const next = await bridge.getUsageSettings();
        if (!active) return;
        setSettings(next);
        setBaseUrl(next.baseUrl);
      } catch {
        // A missing handler is not worth an error banner in Settings; the panel
        // itself reports the unavailable bridge.
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    const bridge = window.agentic?.gateway;
    if (!bridge) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await bridge.saveUsageSettings({
        baseUrl,
        // Omitted when blank so saving a URL edit does not wipe a stored key.
        ...(apiKey.trim() ? { apiKey } : {}),
      });
      setSettings(next);
      setBaseUrl(next.baseUrl);
      setApiKey("");
      setMessage({ tone: "ok", text: "Gateway settings saved." });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not save gateway settings.",
      });
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    const bridge = window.agentic?.gateway;
    if (!bridge) return;
    setBusy(true);
    setMessage(null);
    try {
      // Explicit empty string is the documented "forget it" signal.
      const next = await bridge.saveUsageSettings({ apiKey: "" });
      setSettings(next);
      setApiKey("");
      setMessage({ tone: "ok", text: "Stored key removed." });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not remove the stored key.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-provider-section">
      <header className="settings-section-head">
        <div>
          <h2>Pool API gateway</h2>
          <p>
            Point the workspace at your Pool API gateway to see credit, spend, and request history in Integrations.
            The key is stored with OS-level encryption and never leaves this machine.
          </p>
        </div>
      </header>

      <div className="settings-field-grid">
        <label className="settings-field">
          Gateway URL <span className="settings-field-hint">Default http://localhost:5100</span>
          <input
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://localhost:5100"
            type="url"
            value={baseUrl}
          />
        </label>

        <label className="settings-field">
          API key{" "}
          <span className="settings-field-hint">
            {settings?.hasApiKey ? `Saved: ${settings.keyHint ?? "sk-****"}` : "No key saved"}
          </span>
          <input
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings?.hasApiKey ? "Enter a new key to replace" : "sk-..."}
            type="password"
            value={apiKey}
          />
        </label>
      </div>

      <div className="settings-gateway-actions">
        <button
          className="settings-action settings-action-primary"
          disabled={busy}
          onClick={() => void save()}
          type="button"
        >
          {busy ? <Loader2 className="spin" size={13} /> : <KeyRound size={13} />}
          Save gateway settings
        </button>
        {settings?.hasApiKey && (
          <button
            className="settings-action settings-action-ghost"
            disabled={busy}
            onClick={() => void clearKey()}
            type="button"
          >
            Remove key
          </button>
        )}
      </div>

      {message && (
        <p className={`settings-banner ${message.tone === "error" ? "tone-error" : "tone-success"}`}>
          {message.text}
        </p>
      )}
    </section>
  );
}
