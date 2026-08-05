import { useEffect, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import type { WebhookEndpointStatus } from "@contracts";

/**
 * Shows where to POST a webhook and the token required to do it.
 *
 * The endpoint only exists while an active webhook workflow is saved, so a
 * not-yet-saved draft correctly shows "not listening" rather than inventing a URL
 * the sender would fail against.
 */
export function WebhookEndpointPanel({ hookName }: { hookName: string }) {
  const [status, setStatus] = useState<WebhookEndpointStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.agentic.workflows
      .webhookStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function rotate() {
    setBusy(true);
    try {
      setStatus(await window.agentic.workflows.rotateWebhookToken());
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, which: "url" | "token") {
    await navigator.clipboard.writeText(value);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  if (!status) return null;

  if (status.error) {
    return (
      <p className="wf-field-hint wf-col-2 wf-webhook-error">
        Webhook listener could not start: {status.error}
      </p>
    );
  }

  if (!status.running) {
    return (
      <p className="wf-field-hint wf-col-2">
        The listener starts once this workflow is saved and active. No port is open until then.
      </p>
    );
  }

  const url = `${status.baseUrl}/${hookName || "<hook-name>"}`;

  return (
    <div className="wf-webhook-panel wf-col-2">
      <div className="wf-webhook-row">
        <span className="wf-webhook-label">POST</span>
        <code>{url}</code>
        <button type="button" onClick={() => void copy(url, "url")} disabled={!hookName}>
          <Copy size={13} />
          {copied === "url" ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="wf-webhook-row">
        <span className="wf-webhook-label">Token</span>
        {/* Shown rather than masked: it is only usable by something already on this
            machine, and hiding it would just mean rotating to read it. */}
        <code className="wf-webhook-token">{status.token}</code>
        <button type="button" onClick={() => void copy(status.token ?? "", "token")}>
          <Copy size={13} />
          {copied === "token" ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={() => void rotate()} disabled={busy}>
          <RefreshCw size={13} className={busy ? "spin" : ""} />
          Rotate
        </button>
      </div>

      <p className="wf-field-hint">
        Send it as <code>Authorization: Bearer &lt;token&gt;</code> or <code>X-Webhook-Token</code>. The listener binds
        127.0.0.1 only, so nothing on your network can reach it — expose it deliberately with a tunnel
        (<code>ssh -R</code>, <code>cloudflared</code>) if a remote provider needs to deliver.
      </p>
    </div>
  );
}
