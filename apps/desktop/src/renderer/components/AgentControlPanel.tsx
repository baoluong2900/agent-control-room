import { Bot, Play, Square, XOctagon } from "lucide-react";
import type { AgentCliId, AgentProcess, AgentStatus, ProjectSummary, SystemDiagnostics } from "@contracts";
import { useMemo, useState } from "react";

const cliOptions: Array<{ id: AgentCliId; label: string }> = [
  { id: "claude", label: "Claude CLI" },
  { id: "kiro", label: "Kiro CLI" },
  { id: "codex", label: "Codex CLI" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "shell", label: "Shell" },
];

const modelOptions = [
  "CLI default",
  "Claude Sonnet",
  "GPT-5 Codex",
  "Gemini Pro",
  "Local model",
];

export function AgentControlPanel({
  activeRunId,
  activeStatus,
  diagnostics,
  project,
  onStart,
  onStop,
}: {
  activeRunId: string | null;
  activeStatus: AgentStatus;
  diagnostics: SystemDiagnostics | null;
  project: ProjectSummary | null;
  onStart: (input: { cliId: AgentCliId; model: string; prompt: string; shellCommand?: string }) => Promise<AgentProcess | void>;
  onStop: (runId: string) => Promise<void>;
}) {
  const [cliId, setCliId] = useState<AgentCliId>("codex");
  const [model, setModel] = useState("CLI default");
  const [prompt, setPrompt] = useState("Review this project and propose the next smallest implementation step.");
  const [shellCommand, setShellCommand] = useState("npm test");
  const [busy, setBusy] = useState(false);

  const selectedToolInstalled = useMemo(() => {
    if (cliId === "shell") return true;
    return diagnostics?.tools.find((tool) => tool.id === cliId)?.installed ?? false;
  }, [cliId, diagnostics]);

  const canStart = Boolean(project && prompt.trim() && selectedToolInstalled && !busy);

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    try {
      await onStart({
        cliId,
        model,
        prompt,
        shellCommand: cliId === "shell" ? shellCommand : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="analytics-card agent-command-card">
      <header>
        <div>
          <h2>Create Agent</h2>
          <p>Choose CLI/model and assign a prompt</p>
        </div>
        <Bot size={17} />
      </header>

      <label>
        CLI
        <select value={cliId} onChange={(event) => setCliId(event.target.value as AgentCliId)}>
          {cliOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Model
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {modelOptions.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>

      {cliId === "shell" && (
        <label>
          Shell command
          <input value={shellCommand} onChange={(event) => setShellCommand(event.target.value)} placeholder="npm test" />
        </label>
      )}

      <label>
        Task prompt
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
      </label>

      {!project && <p className="warning-note">Select a project folder before starting an agent.</p>}
      {project && !selectedToolInstalled && cliId !== "shell" && <p className="warning-note">Selected CLI is not installed on PATH.</p>}

      <div className="agent-actions">
        <button className="primary-action" disabled={!canStart} onClick={start}>
          <Play size={15} />
          Start
        </button>
        <button disabled={!activeRunId} onClick={() => activeRunId && onStop(activeRunId)}>
          <Square size={15} />
          Stop
        </button>
        <button disabled={!activeRunId} onClick={() => activeRunId && onStop(activeRunId)}>
          <XOctagon size={15} />
          Cancel
        </button>
      </div>

      <div className="run-state">
        <small>Current state</small>
        <strong>{activeStatus}</strong>
      </div>
    </section>
  );
}

