import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  CircleCheck,
  FolderOpen,
  Loader2,
  RefreshCw,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import type {
  AgentCliDescriptor,
  AgentCliId,
  AgentModelOption,
  AgentPingResult,
  AgentProfile,
  AgentProfileInput,
  ProviderConnection,
} from "@contracts";
import { useEffect, useMemo, useState } from "react";
import { useAgentsStore } from "../stores/agents-store";
import { getProviderCatalogEntry } from "../settings/provider-catalog";

const roleSuggestions = [
  "Senior Developer",
  "Data Scientist",
  "Research Specialist",
  "QA Engineer",
  "DevOps Engineer",
  "Technical Writer",
  "Code Reviewer",
  "Refactor Specialist",
];

export function AgentBuilderModal({
  defaultCwd,
  editing,
  onClose,
  onPickFolder,
}: {
  defaultCwd?: string;
  editing?: AgentProfile | null;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
}) {
  const { catalog, pings, models, pingOne, loadModels, saveProfile } = useAgentsStore();

  const [cliId, setCliId] = useState<AgentCliId>(editing?.cliId ?? "kiro");
  const [name, setName] = useState(editing?.name ?? "");
  const [role, setRole] = useState(editing?.role ?? "Senior Developer");
  const [model, setModel] = useState(editing?.model ?? "");
  const [customModel, setCustomModel] = useState("");
  const [cwd, setCwd] = useState(editing?.cwd ?? defaultCwd ?? "");
  const [providerConnectionId, setProviderConnectionId] = useState(editing?.providerConnectionId ?? "");
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? "");
  const [extraArgs, setExtraArgs] = useState(editing?.extraArgs ?? "");
  const [commandOverride, setCommandOverride] = useState(editing?.commandOverride ?? "");
  const [interactive, setInteractive] = useState(editing?.interactive ?? true);
  const [forceTty, setForceTty] = useState(editing?.forceTty ?? false);
  const [autoApprove, setAutoApprove] = useState(editing?.autoApprove ?? false);
  const [advanced, setAdvanced] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [providerConnections, setProviderConnections] = useState<ProviderConnection[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const descriptor = useMemo(
    () => catalog.find((entry) => entry.id === cliId),
    [catalog, cliId],
  );
  const ping: AgentPingResult | undefined = pings[cliId];
  const probe = models[cliId];
  const modelOptions: AgentModelOption[] = probe?.models ?? descriptor?.models ?? [];

  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    void loadModels(cliId)
      .then((result) => {
        if (cancelled) return;
        setModel((current) => {
          if (current && result.models.some((option) => option.id === current)) return current;
          const recommended = result.models.find((option) => option.recommended) ?? result.models[0];
          return recommended?.id ?? current;
        });
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cliId, loadModels]);

  useEffect(() => {
    let cancelled = false;
    window.agentic.settings
      .listProviderConnections()
      .then((items) => {
        if (cancelled) return;
        setProviderConnections(items);
        setProviderConnectionId((current) => {
          if (current) return current;
          if (editing?.providerConnectionId) return editing.providerConnectionId;
          return items.find((item) => item.status === "connected")?.id ?? "";
        });
      })
      .catch(() => {
        if (!cancelled) setProviderConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [editing?.providerConnectionId]);

  useEffect(() => {
    if (!name && descriptor) {
      setName(`${descriptor.displayName.split(" ")[0]} Agent`);
    }
  }, [descriptor, name]);

  const runPing = async () => {
    setPinging(true);
    try {
      await pingOne(cliId, commandOverride || undefined);
    } finally {
      setPinging(false);
    }
  };

  const reloadModels = async () => {
    setLoadingModels(true);
    try {
      const probeResult = await window.agentic.agents.models(cliId);
      useAgentsStore.setState((state) => ({ models: { ...state.models, [cliId]: probeResult } }));
    } finally {
      setLoadingModels(false);
    }
  };

  const pickFolder = async () => {
    const picked = await onPickFolder();
    if (picked) setCwd(picked);
  };

  const submit = async () => {
    const resolvedModel = customModel.trim() || model.trim();
    if (!name.trim()) {
      setFormError("Agent name is required.");
      return;
    }
    if (!resolvedModel) {
      setFormError("Pick a model or type a custom model id.");
      return;
    }

    const payload: AgentProfileInput = {
      id: editing?.id,
      name: name.trim(),
      role: role.trim() || "Agent",
      cliId,
      model: resolvedModel,
      providerConnectionId: providerConnectionId.trim() || undefined,
      accent: descriptor?.accent,
      cwd: cwd.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      extraArgs: extraArgs.trim() || undefined,
      commandOverride: commandOverride.trim() || undefined,
      promptMode: descriptor?.promptMode,
      interactive,
      forceTty,
      autoApprove,
      enabled: editing?.enabled ?? true,
      tags: [descriptor?.vendor ?? "local", resolvedModel],
    };

    setSaving(true);
    setFormError(null);
    try {
      await saveProfile(payload);
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agent-modal-backdrop" role="dialog" aria-modal="true" aria-label="Create agent">
      <div className="agent-modal">
        <header className="agent-modal-head">
          <div>
            <span className="eyebrow">
              <Zap size={12} />
              Local CLI agent
            </span>
            <h2>{editing ? "Edit agent" : "New agent"}</h2>
            <p>Pick a terminal CLI, verify it is installed, then choose the model it should run.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>

        <div className="agent-modal-body">
          <section className="modal-section">
            <div className="section-head">
              <h3>1. Agent CLI</h3>
              <button className="ghost-button" onClick={runPing} disabled={pinging}>
                {pinging ? <Loader2 className="spin" size={13} /> : <Activity size={13} />}
                Ping CLI
              </button>
            </div>
            <div className="cli-grid">
              {catalog.map((entry) => (
                <CliOption
                  key={entry.id}
                  descriptor={entry}
                  ping={pings[entry.id]}
                  selected={entry.id === cliId}
                  onSelect={() => setCliId(entry.id)}
                />
              ))}
            </div>
            {ping && (
              <p className={`ping-line ${ping.installed ? (ping.ok ? "ok" : "warn") : "bad"}`}>
                {ping.installed ? <CircleCheck size={13} /> : <AlertTriangle size={13} />}
                <span>{ping.detail}</span>
                <em>{ping.latencyMs}ms</em>
                {ping.command && <code>{ping.command}</code>}
              </p>
            )}
          </section>

          <section className="modal-section">
            <div className="section-head">
              <h3>2. Model</h3>
              <button className="ghost-button" onClick={reloadModels} disabled={loadingModels}>
                {loadingModels ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                Refresh models
              </button>
            </div>
            <div className="model-grid">
              {modelOptions.map((option) => (
                <button
                  key={option.id}
                  className={`model-chip ${model === option.id && !customModel ? "selected" : ""}`}
                  onClick={() => {
                    setModel(option.id);
                    setCustomModel("");
                  }}
                >
                  <strong>{option.label}</strong>
                  {option.note && <small>{option.note}</small>}
                  {option.recommended && <span className="chip-flag">default</span>}
                  {model === option.id && !customModel && <Check className="chip-check" size={14} />}
                </button>
              ))}
            </div>
            <label className="field">
              Custom model id
              <input
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                placeholder="e.g. claude-sonnet-4-5 / gpt-5-codex / ollama/qwen2.5-coder"
              />
            </label>
            {probe && <p className="hint-line">{probe.detail}</p>}
          </section>

          <section className="modal-section">
            <div className="section-head">
              <h3>3. Identity</h3>
            </div>
            <div className="field-row">
              <label className="field">
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Local Agent" />
              </label>
              <label className="field">
                Role
                <input
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder="Senior Developer"
                  list="agent-role-suggestions"
                />
                <datalist id="agent-role-suggestions">
                  {roleSuggestions.map((suggestion) => (
                    <option key={suggestion} value={suggestion} />
                  ))}
                </datalist>
              </label>
            </div>
            <label className="field">
              AI provider connection
              <select
                value={providerConnectionId}
                onChange={(event) => setProviderConnectionId(event.target.value)}
              >
                <option value="">No provider selected</option>
                {providerConnections.map((connection) => {
                  const descriptor = getProviderCatalogEntry(connection.provider);
                  return (
                    <option key={connection.id} value={connection.id}>
                      {descriptor.label} · {connection.accountLabel ?? "Unnamed account"} · {connection.status}
                    </option>
                  );
                })}
              </select>
              {providerConnections.length === 0 && (
                <span className="hint-line">Add provider connections in Settings &rarr; AI Providers.</span>
              )}
            </label>
            <label className="field">
              Working folder
              <span className="input-with-button">
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/project" />
                <button className="ghost-button" onClick={pickFolder}>
                  <FolderOpen size={14} />
                  Browse
                </button>
              </span>
            </label>
            <label className="field">
              System / default prompt
              <textarea
                rows={3}
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                placeholder="You are a senior developer. Keep diffs small and run tests."
              />
            </label>
          </section>

          <section className="modal-section">
            <button className="section-toggle" onClick={() => setAdvanced((value) => !value)}>
              <ChevronDown size={14} className={advanced ? "rotated" : ""} />
              Advanced terminal options
            </button>
            {advanced && (
              <div className="advanced-grid">
                <label className="switch">
                  <input type="checkbox" checked={interactive} onChange={(event) => setInteractive(event.target.checked)} />
                  <span>
                    <strong>Interactive session</strong>
                    <small>Keep the CLI alive so you can keep typing in the terminal.</small>
                  </span>
                </label>
                <label className="switch">
                  <input type="checkbox" checked={forceTty} onChange={(event) => setForceTty(event.target.checked)} />
                  <span>
                    <strong>Force TTY (script)</strong>
                    <small>Wrap in a pseudo terminal for CLIs that need one. macOS/Linux.</small>
                  </span>
                </label>
                <label className="switch">
                  <input type="checkbox" checked={autoApprove} onChange={(event) => setAutoApprove(event.target.checked)} />
                  <span>
                    <strong>Auto-approve prompts</strong>
                    <small>Answer trust prompts automatically where the CLI supports a flag.</small>
                  </span>
                </label>
                <label className="field">
                  Extra CLI args
                  <input
                    value={extraArgs}
                    onChange={(event) => setExtraArgs(event.target.value)}
                    placeholder="--trust-all-tools --verbose"
                  />
                </label>
                <label className="field">
                  Command override
                  <input
                    value={commandOverride}
                    onChange={(event) => setCommandOverride(event.target.value)}
                    placeholder="/usr/local/bin/kiro"
                  />
                </label>
              </div>
            )}
          </section>

          {formError && (
            <p className="modal-error">
              <AlertTriangle size={14} />
              {formError}
            </p>
          )}
        </div>

        <footer className="agent-modal-foot">
          <span className="preview-command">
            <Terminal size={13} />
            <code>{previewCommand(descriptor, model || customModel, extraArgs, commandOverride, interactive)}</code>
          </span>
          <div className="foot-actions">
            <button className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-action" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
              {editing ? "Save agent" : "Create agent"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function CliOption({
  descriptor,
  ping,
  selected,
  onSelect,
}: {
  descriptor: AgentCliDescriptor;
  ping?: AgentPingResult;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = ping ? (ping.installed ? "installed" : "missing") : "unknown";

  return (
    <button className={`cli-option ${selected ? "selected" : ""}`} onClick={onSelect} style={{ ["--cli-accent" as string]: descriptor.accent }}>
      <span className="cli-avatar">{initials(descriptor.displayName)}</span>
      <span className="cli-copy">
        <strong>{descriptor.displayName}</strong>
        <small>{descriptor.vendor}</small>
      </span>
      <span className={`cli-state ${state}`}>
        {state === "installed" ? "ready" : state === "missing" ? "not found" : "?"}
      </span>
    </button>
  );
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function previewCommand(
  descriptor: AgentCliDescriptor | undefined,
  model: string,
  extraArgs: string,
  commandOverride: string,
  interactive: boolean,
): string {
  if (!descriptor) return "select a CLI";
  const binary = commandOverride.trim() || descriptor.commandCandidates[0] || descriptor.id;
  const parts = [binary, ...(interactive ? descriptor.interactiveArgs : descriptor.baseArgs)];
  if (model && descriptor.modelFlag) parts.push(descriptor.modelFlag, model);
  if (extraArgs.trim()) parts.push(extraArgs.trim());
  if (!interactive && descriptor.promptFlag) parts.push(descriptor.promptFlag, '"<task>"');
  else if (!interactive) parts.push('"<task>"');
  return parts.join(" ");
}
