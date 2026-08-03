import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentCliId,
  WorkflowDefinition,
  WorkflowSaveInput,
  WorkflowStatus,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowTriggerType,
} from "@contracts";
import {
  cliLabels,
  cliOptions,
  stepKindMeta,
  stepKinds,
  triggerMeta,
  triggerTypes,
} from "./workflow-ui";

type DraftStep = Omit<WorkflowStepDefinition, "id" | "order"> & { id?: string; key: string };

type DraftState = {
  name: string;
  description: string;
  status: WorkflowStatus;
  owner: string;
  projectPath: string;
  favorite: boolean;
  triggerType: WorkflowTriggerType;
  triggerSchedule: string;
  triggerDetail: string;
  integrations: string;
  steps: DraftStep[];
};

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `draft-${keyCounter}`;
}

function toDraftStep(step: WorkflowStepDefinition): DraftStep {
  return { ...step, key: nextKey() };
}

function blankStep(): DraftStep {
  return {
    key: nextKey(),
    name: "Investigate",
    kind: "investigate",
    summary: "",
    cliId: "claude",
    model: "claude-sonnet-4.5",
    instruction: "Investigate the task: gather context, find root cause, and report findings with file references.",
    shellCommand: "",
    timeoutSeconds: 600,
    requiresApproval: false,
    continueOnError: false,
    enabled: true,
  };
}

function buildInitialState(workflow: WorkflowDefinition | null): DraftState {
  if (!workflow) {
    return {
      name: "",
      description: "",
      status: "draft",
      owner: "You",
      projectPath: "",
      favorite: false,
      triggerType: "manual",
      triggerSchedule: "",
      triggerDetail: "",
      integrations: "",
      steps: [blankStep()],
    };
  }

  return {
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    owner: workflow.owner,
    projectPath: workflow.projectPath ?? "",
    favorite: workflow.favorite,
    triggerType: workflow.trigger.type,
    triggerSchedule: workflow.trigger.schedule ?? "",
    triggerDetail: workflow.trigger.detail ?? "",
    integrations: workflow.integrations.join(", "),
    steps: workflow.steps.map(toDraftStep),
  };
}

export function WorkflowEditorDrawer({
  workflow,
  onClose,
  onSave,
}: {
  workflow: WorkflowDefinition | null;
  onClose: () => void;
  onSave: (input: WorkflowSaveInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftState>(() => buildInitialState(workflow));
  const [activeStepKey, setActiveStepKey] = useState<string>(draft.steps[0]?.key ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = buildInitialState(workflow);
    setDraft(next);
    setActiveStepKey(next.steps[0]?.key ?? "");
    setError(null);
  }, [workflow]);

  const activeStep = useMemo(
    () => draft.steps.find((step) => step.key === activeStepKey) ?? draft.steps[0],
    [draft.steps, activeStepKey],
  );

  function patch(partial: Partial<DraftState>) {
    setDraft((prev) => ({ ...prev, ...partial }));
  }

  function patchStep(key: string, partial: Partial<DraftStep>) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((step) => (step.key === key ? { ...step, ...partial } : step)),
    }));
  }

  function addStep() {
    const step = blankStep();
    setDraft((prev) => ({ ...prev, steps: [...prev.steps, step] }));
    setActiveStepKey(step.key);
  }

  function removeStep(key: string) {
    setDraft((prev) => {
      const steps = prev.steps.filter((step) => step.key !== key);
      return { ...prev, steps };
    });
  }

  function moveStep(key: string, direction: -1 | 1) {
    setDraft((prev) => {
      const index = prev.steps.findIndex((step) => step.key === key);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= prev.steps.length) return prev;
      const steps = [...prev.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...prev, steps };
    });
  }

  async function handleSave() {
    if (!draft.name.trim()) {
      setError("Workflow name is required.");
      return;
    }
    if (draft.steps.length === 0) {
      setError("Add at least one step.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const input: WorkflowSaveInput = {
        id: workflow?.id,
        name: draft.name.trim(),
        description: draft.description.trim(),
        status: draft.status,
        favorite: draft.favorite,
        owner: draft.owner.trim() || "You",
        projectPath: draft.projectPath.trim() || null,
        trigger: {
          type: draft.triggerType,
          schedule: draft.triggerSchedule.trim() || undefined,
          detail: draft.triggerDetail.trim() || undefined,
        },
        integrations: draft.integrations
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        steps: draft.steps.map((step) => ({
          id: step.id,
          name: step.name.trim() || stepKindMeta[step.kind].label,
          kind: step.kind,
          summary: step.summary.trim(),
          cliId: step.cliId,
          model: step.model.trim(),
          instruction: step.instruction.trim(),
          shellCommand: step.shellCommand?.trim() || undefined,
          timeoutSeconds: Number.isFinite(step.timeoutSeconds) ? step.timeoutSeconds : 600,
          requiresApproval: step.requiresApproval,
          continueOnError: step.continueOnError,
          enabled: step.enabled,
        })),
      };
      await onSave(input);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wf-drawer-scrim" role="dialog" aria-modal="true" aria-label="Workflow editor">
      <div className="wf-drawer" onClick={(event) => event.stopPropagation()}>
        <header className="wf-drawer-head">
          <div>
            <span className="wf-drawer-eyebrow">{workflow ? "Edit workflow" : "New workflow"}</span>
            <h2>{draft.name || "Untitled workflow"}</h2>
          </div>
          <button className="wf-icon-btn" aria-label="Close editor" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="wf-drawer-body">
          <section className="wf-form-section">
            <h3>Workflow details</h3>
            <div className="wf-field-grid">
              <label className="wf-field wf-col-2">
                <span>Name</span>
                <input
                  value={draft.name}
                  placeholder="e.g. Bug Triage Flow"
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </label>
              <label className="wf-field wf-col-2">
                <span>Description</span>
                <input
                  value={draft.description}
                  placeholder="What does this workflow do?"
                  onChange={(event) => patch({ description: event.target.value })}
                />
              </label>
              <label className="wf-field">
                <span>Status</span>
                <select value={draft.status} onChange={(event) => patch({ status: event.target.value as WorkflowStatus })}>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="error">Error</option>
                </select>
              </label>
              <label className="wf-field">
                <span>Owner</span>
                <input value={draft.owner} onChange={(event) => patch({ owner: event.target.value })} />
              </label>
              <label className="wf-field wf-col-2">
                <span>Project folder (optional)</span>
                <input
                  value={draft.projectPath}
                  placeholder="/absolute/path/to/project"
                  onChange={(event) => patch({ projectPath: event.target.value })}
                />
              </label>
              <label className="wf-field wf-col-2">
                <span>Linked agents &amp; integrations (comma separated)</span>
                <input
                  value={draft.integrations}
                  placeholder="Claude CLI, GitHub, Slack"
                  onChange={(event) => patch({ integrations: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="wf-form-section">
            <h3>Trigger</h3>
            <div className="wf-field-grid">
              <label className="wf-field">
                <span>Type</span>
                <select
                  value={draft.triggerType}
                  onChange={(event) => patch({ triggerType: event.target.value as WorkflowTriggerType })}
                >
                  {triggerTypes.map((type) => (
                    <option key={type} value={type}>
                      {triggerMeta[type].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wf-field">
                <span>Schedule</span>
                <input
                  value={draft.triggerSchedule}
                  placeholder="Daily, 9:00 AM"
                  onChange={(event) => patch({ triggerSchedule: event.target.value })}
                />
              </label>
              <label className="wf-field wf-col-2">
                <span>Detail</span>
                <input
                  value={draft.triggerDetail}
                  placeholder="GitHub • main, Jira • BUG board…"
                  onChange={(event) => patch({ triggerDetail: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="wf-form-section">
            <div className="wf-section-head">
              <h3>Agent steps</h3>
              <button className="wf-add-step" onClick={addStep}>
                <Plus size={14} /> Add step
              </button>
            </div>

            <div className="wf-step-editor">
              <ul className="wf-step-rail">
                {draft.steps.map((step, index) => {
                  const meta = stepKindMeta[step.kind];
                  const Icon = meta.icon;
                  return (
                    <li key={step.key}>
                      <button
                        className={`wf-step-chip accent-${meta.accent} ${step.key === activeStepKey ? "selected" : ""} ${step.enabled ? "" : "disabled"}`}
                        onClick={() => setActiveStepKey(step.key)}
                      >
                        <span className="wf-step-index">{index + 1}</span>
                        <Icon size={15} />
                        <span className="wf-step-chip-copy">
                          <strong>{step.name || meta.label}</strong>
                          <small>{cliLabels[step.cliId]}</small>
                        </span>
                      </button>
                      <div className="wf-step-move">
                        <button aria-label="Move step up" disabled={index === 0} onClick={() => moveStep(step.key, -1)}>
                          <ArrowUp size={12} />
                        </button>
                        <button
                          aria-label="Move step down"
                          disabled={index === draft.steps.length - 1}
                          onClick={() => moveStep(step.key, 1)}
                        >
                          <ArrowDown size={12} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {activeStep && (
                <div className="wf-step-form">
                  <div className="wf-field-grid">
                    <label className="wf-field">
                      <span>Step name</span>
                      <input
                        value={activeStep.name}
                        onChange={(event) => patchStep(activeStep.key, { name: event.target.value })}
                      />
                    </label>
                    <label className="wf-field">
                      <span>What the agent does</span>
                      <select
                        value={activeStep.kind}
                        onChange={(event) => {
                          const kind = event.target.value as WorkflowStepKind;
                          patchStep(activeStep.key, {
                            kind,
                            name: activeStep.name || stepKindMeta[kind].label,
                          });
                        }}
                      >
                        {stepKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {stepKindMeta[kind].label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wf-field">
                      <span>AI agent (CLI)</span>
                      <select
                        value={activeStep.cliId}
                        onChange={(event) => patchStep(activeStep.key, { cliId: event.target.value as AgentCliId })}
                      >
                        {cliOptions.map((cli) => (
                          <option key={cli} value={cli}>
                            {cliLabels[cli]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="wf-field">
                      <span>Model</span>
                      <input
                        value={activeStep.model}
                        placeholder="claude-sonnet-4.5"
                        onChange={(event) => patchStep(activeStep.key, { model: event.target.value })}
                      />
                    </label>
                    <label className="wf-field wf-col-2">
                      <span>Summary (shown in step breakdown)</span>
                      <input
                        value={activeStep.summary}
                        placeholder="Reproduce and locate root cause"
                        onChange={(event) => patchStep(activeStep.key, { summary: event.target.value })}
                      />
                    </label>
                    <label className="wf-field wf-col-2">
                      <span>Instruction / prompt for the agent</span>
                      <textarea
                        rows={5}
                        value={activeStep.instruction}
                        placeholder="Describe exactly what this agent should do in this step…"
                        onChange={(event) => patchStep(activeStep.key, { instruction: event.target.value })}
                      />
                    </label>
                    {activeStep.cliId === "shell" && (
                      <label className="wf-field wf-col-2">
                        <span>Shell command</span>
                        <input
                          value={activeStep.shellCommand ?? ""}
                          placeholder="npm run typecheck"
                          onChange={(event) => patchStep(activeStep.key, { shellCommand: event.target.value })}
                        />
                      </label>
                    )}
                    <label className="wf-field">
                      <span>Timeout (seconds)</span>
                      <input
                        type="number"
                        min={1}
                        value={activeStep.timeoutSeconds}
                        onChange={(event) =>
                          patchStep(activeStep.key, { timeoutSeconds: Number(event.target.value) || 600 })
                        }
                      />
                    </label>
                    <div className="wf-toggle-row">
                      <label className="wf-toggle">
                        <input
                          type="checkbox"
                          checked={activeStep.enabled}
                          onChange={(event) => patchStep(activeStep.key, { enabled: event.target.checked })}
                        />
                        <span>Enabled</span>
                      </label>
                      <label className="wf-toggle">
                        <input
                          type="checkbox"
                          checked={activeStep.requiresApproval}
                          onChange={(event) => patchStep(activeStep.key, { requiresApproval: event.target.checked })}
                        />
                        <span>Requires approval</span>
                      </label>
                      <label className="wf-toggle">
                        <input
                          type="checkbox"
                          checked={activeStep.continueOnError}
                          onChange={(event) => patchStep(activeStep.key, { continueOnError: event.target.checked })}
                        />
                        <span>Continue on error</span>
                      </label>
                    </div>
                  </div>

                  <div className="wf-step-form-foot">
                    <button
                      className="wf-danger-btn"
                      disabled={draft.steps.length <= 1}
                      onClick={() => removeStep(activeStep.key)}
                    >
                      <Trash2 size={14} /> Remove step
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="wf-drawer-foot">
          {error && <span className="wf-error">{error}</span>}
          <div className="wf-drawer-foot-actions">
            <button className="wf-ghost-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="wf-primary-btn" disabled={saving} onClick={handleSave}>
              <Save size={15} /> {saving ? "Saving…" : "Save workflow"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
