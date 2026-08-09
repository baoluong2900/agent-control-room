import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  CircleCheck,
  Cpu,
  FolderOpen,
  Gauge,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Shield,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { buildOptionArgs } from "@contracts";
import type {
  AgentCliDescriptor,
  AgentCliId,
  AgentCliOption,
  AgentModuleId,
  AgentModelOption,
  AgentOptionValue,
  AgentOptionValues,
  AgentPingResult,
  AgentProfile,
  AgentProfileInput,
  ProviderConnection,
} from "@contracts";
import { useEffect, useMemo, useState } from "react";
import { useAgentsStore } from "../stores/agents-store";
import { compatibleProviderForCli } from "../settings/provider-compat";
import { getProviderCatalogEntry } from "../settings/provider-catalog";
import {
  agentModules,
  getAgentModule,
  moduleTag,
  resolveModuleSeed,
  type AgentModuleDefinition,
} from "./agent-modules";

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
  // Per-field selectors: this modal only needs the catalog and probe results, and
  // a whole-store destructure re-rendered it on every streamed output chunk.
  const catalog = useAgentsStore((state) => state.catalog);
  const pings = useAgentsStore((state) => state.pings);
  const models = useAgentsStore((state) => state.models);
  const pingOne = useAgentsStore((state) => state.pingOne);
  const loadModels = useAgentsStore((state) => state.loadModels);
  const saveProfile = useAgentsStore((state) => state.saveProfile);
  const initialModule = resolveModuleSeed(
    editing ? { moduleId: editing.module, tags: editing.tags, cliId: editing.cliId } : {},
  );

  const [moduleId, setModuleId] = useState<AgentModuleId>(initialModule.moduleId);
  const [cliId, setCliId] = useState<AgentCliId>(editing?.cliId ?? initialModule.defaultCliId);
  const [name, setName] = useState(editing?.name ?? initialModule.name);
  const [role, setRole] = useState(editing?.role ?? initialModule.role);
  const [model, setModel] = useState(editing?.model ?? "");
  const [customModel, setCustomModel] = useState("");
  const [cwd, setCwd] = useState(editing?.cwd ?? defaultCwd ?? "");
  const [providerConnectionId, setProviderConnectionId] = useState(editing?.providerConnectionId ?? "");
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? initialModule.defaultPrompt);
  const [extraArgs, setExtraArgs] = useState(editing?.extraArgs ?? "");
  const [commandOverride, setCommandOverride] = useState(editing?.commandOverride ?? "");
  const [interactive, setInteractive] = useState(editing?.interactive ?? true);
  const [forceTty, setForceTty] = useState(editing?.forceTty ?? false);
  const [autoApprove, setAutoApprove] = useState(editing?.autoApprove ?? false);
  const [optionValues, setOptionValues] = useState<AgentOptionValues>(editing?.options ?? {});
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
  const selectedModule = useMemo(() => getAgentModule(moduleId), [moduleId]);
  const ping: AgentPingResult | undefined = pings[cliId];
  const probe = models[cliId];
  const modelOptions: AgentModelOption[] = probe?.models ?? descriptor?.models ?? [];
  const compatibleProviders = useMemo(() => compatibleProviderForCli(cliId), [cliId]);
  const compatibleProviderConnections = useMemo(
    () =>
      providerConnections.filter(
        (connection) => compatibleProviders.length === 0 || compatibleProviders.includes(connection.provider),
      ),
    [compatibleProviders, providerConnections],
  );

  useEffect(() => {
    if (!descriptor?.autoApproveArgs?.length) setAutoApprove(false);
    setOptionValues((current) => sanitizeOptionValues(descriptor, current));
  }, [descriptor]);

  useEffect(() => {
    if (!compatibleProviderConnections.length) {
      setProviderConnectionId("");
      return;
    }
    setProviderConnectionId((current) => {
      if (current && compatibleProviderConnections.some((connection) => connection.id === current)) {
        return current;
      }
      if (editing?.providerConnectionId && compatibleProviderConnections.some((connection) => connection.id === editing.providerConnectionId)) {
        return editing.providerConnectionId;
      }
      return compatibleProviderConnections.find((connection) => connection.status === "connected")?.id ?? compatibleProviderConnections[0].id;
    });
  }, [compatibleProviderConnections, editing?.providerConnectionId]);
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
      // The store already records the message for the shared banner; keep the
      // descriptor's built-in model list as the fallback and stop the reject here.
      .catch(() => {})
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
      })
      .catch(() => {
        if (!cancelled) setProviderConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!name && descriptor) {
      setName(selectedModule.name);
    }
  }, [descriptor, name, selectedModule.name]);

  const visibleOptions = descriptor?.options?.filter((option) => !option.advanced) ?? [];
  const advancedOptions = descriptor?.options?.filter((option) => option.advanced) ?? [];

  const setCliOption = (option: AgentCliOption, value: AgentOptionValue) => {
    setOptionValues((current) => ({ ...current, [option.id]: value }));
    setFormError(null);
  };

  const runPing = async () => {
    setPinging(true);
    setFormError(null);
    try {
      await pingOne(cliId, commandOverride || undefined);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPinging(false);
    }
  };

  const reloadModels = async () => {
    setLoadingModels(true);
    setFormError(null);
    try {
      const probeResult = await window.agentic.agents.models(cliId);
      useAgentsStore.setState((state) => ({ models: { ...state.models, [cliId]: probeResult } }));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingModels(false);
    }
  };

  const pickFolder = async () => {
    const picked = await onPickFolder();
    if (picked) setCwd(picked);
  };

  const applyModulePreset = (nextModuleId: AgentModuleId) => {
    const preset = resolveModuleSeed({ moduleId: nextModuleId });
    setModuleId(preset.moduleId);
    setCliId(preset.defaultCliId);
    setRole(preset.role);
    setSystemPrompt(preset.defaultPrompt);
    setName((current) => current.trim() || preset.name);
    setCustomModel("");
    setFormError(null);
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

    try {
      if (descriptor) buildOptionArgs(descriptor, optionValues, { interactive });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      return;
    }

    const payload: AgentProfileInput = {
      id: editing?.id,
      name: name.trim(),
      role: role.trim() || "Agent",
      cliId,
      module: moduleId,
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
      options: optionValues,
      enabled: editing?.enabled ?? true,
      tags: [descriptor?.vendor ?? "local", moduleTag(moduleId), resolvedModel],
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
            <p>Pick a module preset first, then verify the CLI and model the agent should run.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>

        <div className="agent-modal-body">
          <section className="modal-section">
            <div className="section-head">
              <h3>1. Agent module</h3>
              <span className="module-selected-pill" style={{ ["--module-accent" as string]: selectedModule.accent }}>
                {selectedModule.label} module
              </span>
            </div>
            <div className="module-grid">
              {agentModules.map((entry) => (
                <ModuleOption
                  key={entry.id}
                  module={entry}
                  selected={entry.id === moduleId}
                  onSelect={() => applyModulePreset(entry.id)}
                />
              ))}
            </div>
          </section>

          <section className="modal-section">
            <div className="section-head">
              <h3>2. Agent CLI</h3>
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
              <h3>3. Model</h3>
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

          {visibleOptions.length > 0 && (
            <section className="modal-section cli-config-section">
              <div className="section-head">
                <h3>4. CLI config</h3>
                <span className="module-selected-pill">{descriptor?.displayName} flags</span>
              </div>
              <div className="option-grid">
                {visibleOptions.map((option) => (
                  <CliOptionControl
                    key={option.id}
                    option={option}
                    value={optionValues[option.id] ?? option.defaultValue}
                    onChange={(value) => setCliOption(option, value)}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="modal-section">
            <div className="section-head">
              <h3>{visibleOptions.length > 0 ? "5. Identity" : "4. Identity"}</h3>
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
                {compatibleProviderConnections.map((connection) => {
                  const descriptor = getProviderCatalogEntry(connection.provider);
                  return (
                    <option key={connection.id} value={connection.id}>
                      {descriptor.label} · {connection.accountLabel ?? "Unnamed account"} · {connection.status}
                    </option>
                  );
                })}
              </select>
              {compatibleProviderConnections.length === 0 && (
                <span className="hint-line">Add a compatible provider connection in Settings &rarr; AI Providers.</span>
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
                {descriptor?.autoApproveArgs?.length && (
                  <label className="switch">
                    <input type="checkbox" checked={autoApprove} onChange={(event) => setAutoApprove(event.target.checked)} />
                    <span>
                      <strong>Auto-approve prompts</strong>
                      <small>Uses {descriptor.autoApproveArgs.join(" ")} for this CLI.</small>
                    </span>
                  </label>
                )}
                {advancedOptions.map((option) => (
                  <CliOptionControl
                    key={option.id}
                    option={option}
                    value={optionValues[option.id] ?? option.defaultValue}
                    onChange={(value) => setCliOption(option, value)}
                  />
                ))}
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
            <code>{previewCommand(descriptor, model || customModel, extraArgs, commandOverride, interactive, autoApprove, systemPrompt, optionValues)}</code>
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

function ModuleOption({
  module,
  selected,
  onSelect,
}: {
  module: AgentModuleDefinition;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`module-option ${selected ? "selected" : ""}`}
      onClick={onSelect}
      style={{ ["--module-accent" as string]: module.accent }}
    >
      <span className="module-avatar">{moduleIcon(module.id)}</span>
      <span className="module-copy">
        <strong>{module.label}</strong>
        <small>{module.role}</small>
        <em>{module.summary}</em>
      </span>
      <span className="module-cli">{module.defaultCliId}</span>
    </button>
  );
}

function CliOptionControl({
  option,
  value,
  onChange,
}: {
  option: AgentCliOption;
  value: AgentOptionValue | undefined;
  onChange: (value: AgentOptionValue) => void;
}) {
  const hint = option.hint ? <small className="option-hint">{option.hint}</small> : null;

  if (option.kind === "toggle") {
    return (
      <label className="switch cli-option-control">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>
          <strong>{option.label}</strong>
          {hint}
        </span>
      </label>
    );
  }

  if (option.kind === "select") {
    return (
      <label className="field cli-option-control">
        {option.label}
        <select value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
          {(option.choices ?? []).map((choice) => (
            <option key={choice.value || "__default"} value={choice.value}>
              {choice.label}{choice.note ? ` · ${choice.note}` : ""}
            </option>
          ))}
        </select>
        {hint}
      </label>
    );
  }

  if (option.kind === "list") {
    const text = Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
    return (
      <label className="field cli-option-control">
        {option.label}
        <textarea
          rows={3}
          value={text}
          onChange={(event) => onChange(event.target.value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))}
          placeholder={option.placeholder}
        />
        {hint}
      </label>
    );
  }

  return (
    <label className="field cli-option-control">
      {option.label}
      <input
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder={option.placeholder}
      />
      {hint}
    </label>
  );
}

function sanitizeOptionValues(
  descriptor: AgentCliDescriptor | undefined,
  values: AgentOptionValues,
): AgentOptionValues {
  if (!descriptor?.options?.length) return {};
  const allowed = new Map(descriptor.options.map((option) => [option.id, option]));
  const next: AgentOptionValues = {};
  for (const [key, value] of Object.entries(values)) {
    const option = allowed.get(key);
    if (!option) continue;
    if (option.kind === "toggle" && typeof value === "boolean") next[key] = value;
    else if ((option.kind === "select" || option.kind === "text") && typeof value === "string") next[key] = value;
    else if (option.kind === "list") {
      if (Array.isArray(value)) next[key] = value.filter((entry): entry is string => typeof entry === "string");
      else if (typeof value === "string") next[key] = value;
    }
  }
  return next;
}

function moduleIcon(moduleId: AgentModuleId) {
  switch (moduleId) {
    case "planner":
      return <Boxes size={15} />;
    case "coder":
      return <Bot size={15} />;
    case "reviewer":
      return <Search size={15} />;
    case "tester":
      return <Activity size={15} />;
    case "research":
      return <Cpu size={15} />;
    case "ops":
      return <Terminal size={15} />;
    case "builder":
      return <Zap size={15} />;
    case "security":
      return <Shield size={15} />;
    case "local":
      return <Gauge size={15} />;
    case "custom":
      return <Pencil size={15} />;
  }
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
  autoApprove: boolean,
  systemPrompt: string,
  optionValues: AgentOptionValues,
): string {
  if (!descriptor) return "select a CLI";
  const binary = commandOverride.trim() || descriptor.commandCandidates[0] || descriptor.id;
  const parts = [binary, ...(interactive ? descriptor.interactiveArgs : descriptor.baseArgs)];
  const sentinelModels = new Set(["none", "default", "cli default"]);
  if (model && descriptor.modelFlag && !sentinelModels.has(model.toLowerCase())) parts.push(descriptor.modelFlag, model);
  if (extraArgs.trim()) parts.push(extraArgs.trim());
  if (autoApprove && descriptor.autoApproveArgs?.length) parts.push(...descriptor.autoApproveArgs);
  if (systemPrompt.trim() && descriptor.systemPromptFlag) parts.push(descriptor.systemPromptFlag, quotePreview(systemPrompt.trim()));
  try {
    parts.push(...buildOptionArgs(descriptor, optionValues, { interactive }).map(quotePreview));
  } catch {
    parts.push("<invalid CLI option>");
  }
  if (!interactive && descriptor.promptFlag) parts.push(descriptor.promptFlag, '"<task>"');
  else if (!interactive) parts.push('"<task>"');
  return parts.join(" ");
}

function quotePreview(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
