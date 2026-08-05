import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Cpu,
  Filter,
  FolderOpen,
  Gauge,
  GitBranch,
  Gamepad2,
  ListChecks,
  Network,
  PlayCircle,
  RefreshCw,
  Route,
  Search,
  Settings,
  Sparkles,
  Square,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import type {
  AgentCliId,
  AgentRunRecord,
  AgentStatus,
  ProjectSummary,
  SystemDiagnostics,
  TaskDifficulty,
  TaskRecord,
  TaskStatus,
  WorkflowStepKind,
} from "@contracts";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TerminalPanel } from "../terminal/TerminalPanel";
import type { TerminalLine } from "../stores/workspace-store";
import { cliLabels, cliOptions, stepKindMeta } from "../workflows/workflow-ui";
import "./tasks.css";

type TaskPriority = "high" | "medium" | "low";
type TaskMode = "Developer" | "Coding" | "Knowledge" | "Testing" | "Deployment" | "Settings";

type TaskBlueprint = {
  id: string;
  agentName: string;
  mission: string;
  title: string;
  role: string;
  summary: string;
  prompt: string;
  priority: TaskPriority;
  eta: string;
  mode: TaskMode;
  kind: WorkflowStepKind;
  accent: "blue" | "cyan" | "purple" | "amber" | "green" | "orange" | "red";
  files: string[];
  tags: string[];
  cliCandidates: AgentCliId[];
  model: string;
  modelByCli?: Partial<Record<AgentCliId, string>>;
};

type TaskItem = TaskBlueprint & {
  status: TaskStatus;
  source: "saved" | "template";
  record?: TaskRecord;
};

const taskSeeds: TaskBlueprint[] = [
  {
    id: "task-api-schema",
    agentName: "Kiro Architect",
    mission: "Map IPC contracts before code changes land.",
    title: "Audit IPC Contracts",
    role: "Developer Lead",
    summary: "Verify renderer, preload, IPC, and SQLite contracts stay aligned before changing behavior.",
    prompt: "Map active IPC channels, request/response contracts, validation gaps, and database ownership for the desktop app.",
    priority: "high",
    eta: "10m",
    mode: "Developer",
    kind: "investigate",
    accent: "blue",
    files: ["src/contracts", "src/preload/preload.ts", "src/main/ipc/register-ipc.ts"],
    tags: ["ipc", "contracts", "planning"],
    cliCandidates: ["kiro", "claude", "codex", "gemini"],
    model: "claude-sonnet-4-5",
    modelByCli: {
      kiro: "claude-sonnet-4-5",
      claude: "sonnet",
      codex: "gpt-5-codex",
      gemini: "gemini-2.5-pro",
    },
  },
  {
    id: "task-agent-safety",
    agentName: "Codex Forge",
    mission: "Keep agent runtime stable under pressure.",
    title: "Harden Agent Runs",
    role: "Coding Lead",
    summary: "Inspect agent process lifecycle, missing CLI failures, stop behavior, and terminal persistence.",
    prompt: "Investigate agent run start/stop/error paths and identify the smallest implementation changes that prevent silent failures or lost terminal output.",
    priority: "high",
    eta: "25m",
    mode: "Coding",
    kind: "investigate",
    accent: "cyan",
    files: ["src/main/processes/agent-process-manager.ts", "src/renderer/agents/AgentTerminal.tsx", "src/main/agents/commands.ts"],
    tags: ["agents", "terminal", "lifecycle"],
    cliCandidates: ["codex", "agy", "claude", "kiro"],
    model: "gpt-5-codex",
    modelByCli: {
      codex: "gpt-5-codex",
      agy: "default",
      claude: "sonnet",
      kiro: "claude-sonnet-4-5",
    },
  },
  {
    id: "task-architecture-doc",
    agentName: "Claude Scribe",
    mission: "Turn the workspace into a readable route map.",
    title: "Architecture Doc",
    role: "Knowledge Keeper",
    summary: "Confirm the app structure and document the orchestration model.",
    prompt: "Investigate the architecture and produce a concise map of renderer, preload, main process, and SQLite boundaries.",
    priority: "medium",
    eta: "Done",
    mode: "Knowledge",
    kind: "analyze",
    accent: "green",
    files: ["README.md", "src/main", "src/renderer"],
    tags: ["docs", "architecture", "knowledge"],
    cliCandidates: ["claude", "gemini", "codex"],
    model: "sonnet",
    modelByCli: {
      claude: "sonnet",
      gemini: "gemini-2.5-pro",
      codex: "gpt-5-codex",
    },
  },
  {
    id: "task-e2e-tests",
    agentName: "Agy Test Pilot",
    mission: "Run the verification gauntlet and keep the signal clean.",
    title: "Run E2E Tests",
    role: "QA Runner",
    summary: "Investigate failing UI paths and make sure terminal output streams without app interruption.",
    prompt: "Investigate the desktop UI harness, identify failure points, and report fixes needed for stable E2E execution.",
    priority: "high",
    eta: "15m",
    mode: "Testing",
    kind: "test",
    accent: "purple",
    files: ["scripts/agent-e2e-harness.ts", "scripts/screenshot-harness.ts", "tests"],
    tags: ["e2e", "electron", "terminal"],
    cliCandidates: ["agy", "codex", "claude", "shell"],
    model: "gpt-5-codex",
    modelByCli: {
      agy: "default",
      codex: "gpt-5-codex",
      claude: "sonnet",
      shell: "none",
    },
  },
  {
    id: "task-deploy-prod",
    title: "Package Desktop App",
    agentName: "Shell Deployer",
    mission: "Ship the build and keep the runway clear.",
    role: "Release Engineer",
    summary: "Investigate package output, build health, and release readiness for the Electron desktop app.",
    prompt: "Investigate Electron Forge package output, renderer/preload/main build health, and release risks. Return a go/no-go report.",
    priority: "medium",
    eta: "8m",
    mode: "Deployment",
    kind: "deploy",
    accent: "orange",
    files: ["forge.config.ts", "vite.renderer.config.ts", "package.json"],
    tags: ["package", "build", "release"],
    cliCandidates: ["shell", "codex", "claude", "agy"],
    model: "gpt-5-codex",
    modelByCli: {
      shell: "none",
      codex: "gpt-5-codex",
      claude: "sonnet",
      agy: "default",
    },
  },
  {
    id: "task-error-rate",
    agentName: "Settings Sentinel",
    mission: "Guard the control room and recover from misconfig.",
    title: "Guard Workspace Settings",
    role: "Settings Operator",
    summary: "Investigate app exits, renderer errors, and command failures before users lose context.",
    prompt: "Investigate why the desktop app could close, reload, or lose state. Focus on Electron process lifecycle, renderer errors, and agent process exits.",
    priority: "high",
    eta: "18m",
    mode: "Settings",
    kind: "review",
    accent: "red",
    files: ["src/main/main.ts", "src/main/windows", "src/renderer/App.tsx"],
    tags: ["settings", "lifecycle", "stability"],
    cliCandidates: ["claude", "codex", "kiro", "shell"],
    model: "sonnet",
    modelByCli: {
      claude: "sonnet",
      codex: "gpt-5-codex",
      kiro: "claude-sonnet-4-5",
      shell: "none",
    },
  },
];

// `blocked` and `failed` are deliberately different tones: blocked waits on the
// user to fix a precondition, failed exhausted its retries and offers a button.
const statusMeta: Record<TaskStatus, { label: string; tone: string }> = {
  open: { label: "Open", tone: "blue" },
  investigating: { label: "Investigating", tone: "purple" },
  blocked: { label: "Blocked", tone: "red" },
  failed: { label: "Failed", tone: "orange" },
  done: { label: "Done", tone: "green" },
};

const priorityMeta: Record<TaskPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const difficultyMeta: Record<TaskDifficulty, { label: string; priority: TaskPriority; tone: "blue" | "cyan" | "purple" | "green" | "red" }> = {
  small: { label: "Small", priority: "low", tone: "green" },
  medium: { label: "Medium", priority: "medium", tone: "cyan" },
  large: { label: "Large", priority: "high", tone: "purple" },
  epic: { label: "Epic", priority: "high", tone: "red" },
};

const statusFilters: Array<TaskStatus | "all"> = ["all", "open", "investigating", "blocked", "failed", "done"];
const schedulerCliOptions = cliOptions.filter((cliId) => cliId !== "custom");

export function TasksModule({
  activeRunId,
  activeStatus,
  clearTerminal,
  diagnostics,
  history,
  onPickFolder,
  project,
  startAgent,
  stopAgent,
  terminalLines,
}: {
  activeRunId: string | null;
  activeStatus: AgentStatus;
  clearTerminal: () => void;
  diagnostics: SystemDiagnostics | null;
  history: AgentRunRecord[];
  onPickFolder: () => Promise<string | null>;
  project: ProjectSummary | null;
  startAgent: (input: { cliId: AgentCliId; model: string; prompt: string; shellCommand?: string; taskId?: string }) => Promise<void>;
  stopAgent: (runId: string) => Promise<void>;
  terminalLines: TerminalLine[];
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(taskSeeds[0].id);
  const [taskRecords, setTaskRecords] = useState<TaskRecord[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [planTitle, setPlanTitle] = useState("");
  const [planRequest, setPlanRequest] = useState("");
  const [planDueAt, setPlanDueAt] = useState(() => toDateTimeLocal(new Date(Date.now() + 60 * 60_000)));
  const [planCliId, setPlanCliId] = useState<AgentCliId>("codex");
  const [planModel, setPlanModel] = useState(defaultModelForCli("codex"));
  const [planningTask, setPlanningTask] = useState(false);
  const [runningDue, setRunningDue] = useState(false);

  const loadTasks = useCallback(async () => {
    setLoadingTasks(true);
    try {
      const records = await window.agentic.tasks.list(project?.path ?? null);
      setTaskRecords(records);
      setSelectedId((current) => {
        if (current && (records.some((task) => task.id === current) || taskSeeds.some((task) => task.id === current))) {
          return current;
        }
        return records[0]?.id ?? taskSeeds[0].id;
      });
    } catch (error) {
      setNotice(`Could not load tasks: ${formatError(error)}`);
    } finally {
      setLoadingTasks(false);
    }
  }, [project?.path]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTasks();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  // The scheduler runs on its own timer in the main process, so surface what it
  // did instead of waiting for the next 15s poll to reveal a status change.
  useEffect(() => {
    return window.agentic.events.subscribeTask((event) => {
      setNotice(event.message);
      if (event.type === "task:started") {
        setSelectedId(event.taskId);
      }
      void loadTasks();
    });
  }, [loadTasks]);

  const installedCliIds = useMemo(() => {
    return new Set(
      diagnostics?.tools
        .filter((tool) => tool.installed)
        .map((tool) => tool.id)
        .filter((id): id is AgentCliId => id !== "git" && id !== "docker") ?? [],
    );
  }, [diagnostics]);

  useEffect(() => {
    if (cliReadyState(planCliId, installedCliIds)) return;
    const preferred = schedulerCliOptions.find((cliId) => cliReadyState(cliId, installedCliIds)) ?? "shell";
    setPlanCliId(preferred);
    setPlanModel(defaultModelForCli(preferred));
  }, [installedCliIds, planCliId]);

  const tasks = useMemo(() => taskRecords.map(decorateTaskRecord), [taskRecords]);
  const templateTasks = useMemo(() => taskSeeds.map(decorateTemplateTask), []);
  const displayedTasks = tasks.length > 0 ? tasks : templateTasks;

  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return displayedTasks.filter((task) => {
      const matchesStatus = statusFilter === "all" || task.status === statusFilter;
      const matchesQuery =
        !needle ||
        [
          task.title,
          task.agentName,
          task.role,
          task.mode,
          task.mission,
          task.summary,
          task.tags.join(" "),
          task.files.join(" "),
          task.cliCandidates.join(" "),
          Object.values(task.modelByCli ?? {}).join(" "),
          task.model,
          task.record?.assignedCliId ?? "",
          task.record?.assignedModel ?? "",
          task.record?.difficulty ?? "",
          task.record?.dueAt ?? "",
          task.record?.parentTaskId ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return matchesStatus && matchesQuery;
    });
  }, [displayedTasks, query, statusFilter]);

  const selected = displayedTasks.find((task) => task.id === selectedId) ?? displayedTasks[0];
  const selectedCli = resolveCli(selected, installedCliIds);
  const cliReady = selectedCli ? selectedCli === "shell" || installedCliIds.has(selectedCli) : false;
  const selectedModel = resolveTaskModel(selected, selectedCli);
  const canInvestigate = Boolean(project && selectedCli && cliReady && !activeRunId && !busyTaskId);
  const throughput = useMemo(() => buildThroughput(history), [history]);
  const modelRoster = useMemo(
    () => buildModelRoster(displayedTasks, installedCliIds, diagnostics),
    [diagnostics, displayedTasks, installedCliIds],
  );
  const parentTask = selected.record?.parentTaskId
    ? displayedTasks.find((task) => task.id === selected.record?.parentTaskId) ?? null
    : null;
  const childTasks = selected.record
    ? displayedTasks.filter((task) => task.record?.parentTaskId === selected.record?.id)
    : [];
  const scheduledTasks = displayedTasks.filter((task) => Boolean(task.record?.automationEnabled && task.record?.dueAt));
  const dueTasks = displayedTasks.filter(
    (task) => Boolean(task.record?.automationEnabled && task.record?.dueAt && Date.parse(task.record.dueAt) <= Date.now()),
  );

  const stats = {
    total: displayedTasks.length,
    scheduled: scheduledTasks.length,
    due: dueTasks.length,
    open: displayedTasks.filter((task) => task.status === "open").length,
    investigating: displayedTasks.filter((task) => task.status === "investigating").length,
    blocked: displayedTasks.filter((task) => task.status === "blocked").length,
    failed: displayedTasks.filter((task) => task.status === "failed").length,
    done: displayedTasks.filter((task) => task.status === "done").length,
  };

  async function investigate(task = selected) {
    if (busyTaskId || activeRunId) return;

    setSelectedId(task.id);
    setNotice(null);

    if (!project) {
      setNotice("Select a project folder before starting an investigation.");
      return;
    }

    const cliId = resolveCli(task, installedCliIds);
    if (!cliId) {
      setNotice("No investigation-capable CLI is installed on PATH.");
      return;
    }
    const model = resolveTaskModel(task, cliId);

    setBusyTaskId(task.id);
    clearTerminal();
    let savedTask: TaskRecord | null = null;
    try {
      savedTask = await ensureSavedTask(task, project.path);
      setSelectedId(savedTask.id);
      await window.agentic.tasks.setStatus(savedTask.id, "investigating");
      await loadTasks();
      await startAgent({
        cliId,
        model,
        prompt: buildInvestigationPrompt(task, project, cliId, model),
        shellCommand: cliId === "shell" ? `printf '%s\\n' ${JSON.stringify(buildShellInvestigation(task))}` : undefined,
        taskId: savedTask.id,
      });
      await loadTasks();
      setNotice(`Investigation started with ${cliLabels[cliId]} using ${model}.`);
    } catch (error) {
      setNotice(`Could not start investigation: ${formatError(error)}`);
    } finally {
      setBusyTaskId(null);
    }
  }

  async function ensureSavedTask(task: TaskItem, projectPath: string): Promise<TaskRecord> {
    if (task.record) return task.record;
    const cliId = resolveCli(task, installedCliIds);
    return window.agentic.tasks.save({
      projectPath,
      title: task.title,
      prompt: task.prompt,
      status: "open",
      assignedCliId: cliId,
      assignedModel: resolveTaskModel(task, cliId),
      automationEnabled: false,
    });
  }

  async function createScheduledPlan() {
    if (!project) {
      setNotice("Select a project folder before scheduling a plan.");
      return;
    }
    const request = planRequest.trim();
    if (!request) {
      setNotice("Add a request before scheduling.");
      return;
    }

    const dueAt = toIsoDate(planDueAt);
    if (!dueAt) {
      setNotice("Set a valid due time.");
      return;
    }

    setPlanningTask(true);
    setNotice(null);
    try {
      const result = await window.agentic.tasks.plan({
        projectPath: project.path,
        title: planTitle.trim() || undefined,
        request,
        dueAt,
        preferredCliId: planCliId,
        model: planModel.trim() || undefined,
        automationEnabled: true,
      });
      await loadTasks();
      setSelectedId(result.parent.id);
      // Say what the plan actually is. The steps come from a fixed template chosen
      // by request length and keyword hits — no codebase analysis happens — and
      // reading it as "AI planning" makes a deterministic tool look like a bad model.
      const parts = [
        `Template plan: ${result.subtasks.length} subtasks for ${difficultyMeta[result.summary.difficulty].label} work.`,
      ];
      if (result.summary.noAgentsAvailable) {
        parts.push("No agent CLI was found, so every step is assigned to the local shell.");
      } else if (result.summary.reassignedSteps?.length) {
        // A plan that silently changed shape is worse than one that says so.
        parts.push(`Reassigned to installed CLIs — ${result.summary.reassignedSteps.join(", ")}.`);
      }
      setNotice(parts.join(" "));
      setPlanRequest("");
      setPlanTitle("");
    } catch (error) {
      setNotice(`Could not schedule task: ${formatError(error)}`);
    } finally {
      setPlanningTask(false);
    }
  }

  async function runDueTasks() {
    setRunningDue(true);
    setNotice(null);
    try {
      const result = await window.agentic.tasks.runDue();
      await loadTasks();
      setNotice(
        result.started.length > 0 || result.failed.length > 0
          ? `Started ${result.started.length} due task${result.started.length === 1 ? "" : "s"}`
          : "No due tasks to run.",
      );
      if (result.failed.length > 0) {
        setNotice(
          `${result.started.length} started, ${result.failed.length} blocked. ${result.failed[0]?.message ?? ""}`.trim(),
        );
      }
    } catch (error) {
      setNotice(`Could not run due tasks: ${formatError(error)}`);
    } finally {
      setRunningDue(false);
    }
  }

  async function removeTask(task: TaskItem) {
    const savedTask = task.record;
    if (!savedTask) {
      setNotice("Presets are not saved yet, so there is nothing to delete.");
      return;
    }
    if (!window.confirm(`Delete "${savedTask.title}"? Subtasks stay but lose their parent link.`)) return;

    try {
      await window.agentic.tasks.remove(savedTask.id);
      setTaskRecords((current) => current.filter((item) => item.id !== savedTask.id));
      setSelectedId((current) => (current === savedTask.id ? null : current));
      await loadTasks();
      setNotice(`Deleted "${savedTask.title}".`);
    } catch (error) {
      setNotice(`Could not delete task: ${formatError(error)}`);
    }
  }

  async function setTaskStatus(task: TaskItem, status: TaskStatus) {
    if (!project && task.source === "template") {
      setNotice("Select a project folder before creating a task.");
      return;
    }
    try {
      const savedTask = task.record ?? (project ? await ensureSavedTask(task, project.path) : null);
      if (!savedTask) return;
      const updated = await window.agentic.tasks.setStatus(savedTask.id, status);
      setTaskRecords((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      setSelectedId(updated.id);
    } catch (error) {
      setNotice(`Could not update task status: ${formatError(error)}`);
    }
  }

  /**
   * Clears the attempt budget and asks the scheduler to run now. Only offered on
   * a `failed` task: an `open` one is already going to be picked up on its own.
   */
  async function retryTaskNow(task: TaskItem) {
    const savedTask = task.record;
    if (!savedTask) return;
    setNotice(null);
    try {
      const result = await window.agentic.tasks.retryNow(savedTask.id);
      await loadTasks();
      setNotice(
        result.started.length > 0
          ? `Retrying "${savedTask.title}".`
          : `Reset "${savedTask.title}" — it will run on the next scheduler tick.`,
      );
    } catch (error) {
      setNotice(`Could not retry task: ${formatError(error)}`);
    }
  }

  return (
    <div className="tasks-page">
      <section className="tasks-hero">
        <div>
          <span className="tasks-eyebrow">
            <ListChecks size={13} />
            Task command center
          </span>
          <h1>Tasks</h1>
          <p>Investigate, route, and run agent tasks without leaving the desktop workspace.</p>
        </div>
        <div className="tasks-hero-actions">
          <label className="tasks-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks..." />
          </label>
          <button className="tasks-ghost" onClick={() => void onPickFolder()}>
            <FolderOpen size={14} />
            {project ? project.name : "Pick Project"}
          </button>
          <button className="tasks-primary" onClick={() => void investigate(selected)} disabled={!canInvestigate}>
            <Zap size={15} />
            {busyTaskId === selected.id ? "Starting..." : "Investigate"}
          </button>
        </div>
      </section>

      {notice && (
        <p className="tasks-notice">
          <AlertTriangle size={14} />
          {notice}
        </p>
      )}

      <TaskSchedulerPanel
        canPlan={Boolean(project && planRequest.trim() && planDueAt && !planningTask)}
        diagnostics={diagnostics}
        dueAt={planDueAt}
        installedCliIds={installedCliIds}
        model={planModel}
        onChangeCli={(cliId) => {
          setPlanCliId(cliId);
          setPlanModel(defaultModelForCli(cliId));
        }}
        onChangeDueAt={setPlanDueAt}
        onChangeModel={setPlanModel}
        onChangeRequest={setPlanRequest}
        onChangeTitle={setPlanTitle}
        onCreatePlan={() => void createScheduledPlan()}
        onRunDue={() => void runDueTasks()}
        planCliId={planCliId}
        planning={planningTask}
        project={project}
        request={planRequest}
        runningDue={runningDue}
        title={planTitle}
      />

      <TaskAgentOverview
        activeRunId={activeRunId}
        activeStatus={activeStatus}
        diagnostics={diagnostics}
        installedCliIds={installedCliIds}
        modelRoster={modelRoster}
        onSelect={setSelectedId}
        selectedId={selected.id}
        tasks={displayedTasks}
      />

      <section className="task-stat-strip" aria-label="Task queue summary">
        <TaskStat icon={<ListChecks size={15} />} label="Total Tasks" value={stats.total} tone="blue" />
        <TaskStat icon={<CalendarClock size={15} />} label="Scheduled" value={stats.scheduled} tone="cyan" />
        <TaskStat icon={<PlayCircle size={15} />} label="Due Now" value={stats.due} tone="red" />
        <TaskStat icon={<Search size={15} />} label="Investigating" value={stats.investigating} tone="purple" />
        <TaskStat icon={<AlertTriangle size={15} />} label="Blocked" value={stats.blocked} tone="red" />
        <TaskStat icon={<CheckCircle2 size={15} />} label="Done" value={stats.done} tone="green" />
      </section>

      <div className="tasks-layout">
        <section className="tasks-board">
          <header>
            <div>
              <h2>Task Queue</h2>
              <p>
                {loadingTasks
                  ? "Loading saved tasks..."
                  : project
                    ? `${tasks.length} saved task${tasks.length === 1 ? "" : "s"} in ${project.path}`
                    : `${tasks.length} saved task${tasks.length === 1 ? "" : "s"} across recent projects`}
              </p>
            </div>
            <label className="tasks-filter">
              <Filter size={13} />
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")}>
                {statusFilters.map((filter) => (
                  <option key={filter} value={filter}>
                    {filter === "all" ? "All statuses" : statusMeta[filter].label}
                  </option>
                ))}
              </select>
            </label>
          </header>

          <div className="tasks-tab-row">
            {statusFilters.map((filter) => (
              <button
                key={filter}
                className={statusFilter === filter ? "active" : ""}
                onClick={() => setStatusFilter(filter)}
              >
                {filter === "all" ? "All" : statusMeta[filter].label}
                <span>
                  {filter === "all" ? displayedTasks.length : displayedTasks.filter((task) => task.status === filter).length}
                </span>
              </button>
            ))}
          </div>

          <div className="task-card-grid">
            {tasks.length === 0 && (
              <p className="task-empty">Preset agent tasks are shown until this project has saved task status.</p>
            )}
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                selected={task.id === selected.id}
                cliId={resolveCli(task, installedCliIds)}
                diagnostics={diagnostics}
                onSelect={() => setSelectedId(task.id)}
              />
            ))}
            {filteredTasks.length === 0 && <p className="task-empty">No tasks match this filter.</p>}
          </div>
        </section>

        <aside className="task-inspector" aria-label="Selected task inspector">
          <section className="task-detail">
            <header>
              <div>
                <small>{selected.source === "template" ? "Agent Preset" : "Saved Task"}</small>
                <h2>{selected.title}</h2>
              </div>
              <span className={`task-status status-${selected.source === "template" ? "blue" : statusMeta[selected.status].tone}`}>
                {selected.source === "template" ? "Preset" : statusMeta[selected.status].label}
              </span>
            </header>

            <div className={`task-agent-identity accent-${selected.accent}`}>
              <span>{agentInitials(selected.agentName)}</span>
              <div>
                <strong>{selected.agentName}</strong>
                <small>
                  {selected.mode} · {selected.role}
                </small>
              </div>
              <em>{selected.mission}</em>
            </div>

            <p className="task-detail-summary">{selected.summary}</p>

            <div className="task-meta-grid">
              <span>
                <strong>{selected.record?.difficulty ? difficultyMeta[selected.record.difficulty].label : priorityMeta[selected.priority]}</strong>
                {selected.record?.difficulty ? "Difficulty" : "Priority"}
              </span>
              <span>
                <strong>{formatEstimate(selected)}</strong>
                ETA
              </span>
              <span>
                <strong>{selectedCli ? cliDisplayName(selectedCli, diagnostics) : "Missing"}</strong>
                Agent CLI
              </span>
              <span>
                <strong>{selectedModel}</strong>
                Model
              </span>
              <span>
                <strong>{formatDue(selected.record?.dueAt)}</strong>
                Due
              </span>
              <span>
                <strong>{selected.record?.automationEnabled ? "Auto" : "Manual"}</strong>
                Schedule
              </span>
            </div>

            {selected.record?.lastError && (
              <p className="task-retry-note">
                <AlertTriangle size={13} />
                <span>
                  <strong>
                    Attempt {selected.record.attemptCount}/{selected.record.maxAttempts}
                    {selected.record.nextRetryAt ? ` · next try ${formatDue(selected.record.nextRetryAt)}` : ""}
                  </strong>
                  {selected.record.lastError}
                </span>
              </p>
            )}

            {parentTask && (
              <p className="task-parent-link">
                <Network size={13} />
                Subtask of <strong>{parentTask.title}</strong>
              </p>
            )}

            {childTasks.length > 0 && (
              <div className="task-subtask-list">
                <strong>Subtask breakdown</strong>
                {childTasks.map((task, index) => {
                  const taskCli = resolveCli(task, installedCliIds);
                  return (
                    <button key={task.id} onClick={() => setSelectedId(task.id)} type="button">
                      <span>{index + 1}</span>
                      <div>
                        <b>{task.title}</b>
                        <small>
                          {taskCli ? cliDisplayName(taskCli, diagnostics) : "No CLI"} · {formatDue(task.record?.dueAt)}
                        </small>
                      </div>
                      <em className={`status-${statusMeta[task.status].tone}`}>{statusMeta[task.status].label}</em>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="task-prompt-box">
              <strong>Investigation prompt</strong>
              <p>{selected.prompt}</p>
            </div>

            <div className="task-file-list">
              <strong>Focus files</strong>
              <div>
                {(selected.files.length > 0 ? selected.files : ["Project root"]).map((file) => (
                  <span key={file}>{file}</span>
                ))}
              </div>
            </div>

            <ul className="task-checklist">
              <li>Find likely ownership and affected files.</li>
              <li>Report risks before code changes.</li>
              <li>Return next steps and validation commands.</li>
            </ul>

            <div className="task-actions">
              {!project && (
                <button className="tasks-ghost" onClick={() => void onPickFolder()}>
                  <FolderOpen size={14} />
                  Pick Project
                </button>
              )}
              <button className="tasks-primary" disabled={!canInvestigate} onClick={() => void investigate(selected)}>
                <Search size={14} />
                {busyTaskId === selected.id ? "Starting..." : "Investigate Task"}
              </button>
              <button className="tasks-ghost" onClick={() => void setTaskStatus(selected, "open")}>
                <Clock3 size={14} />
                Open
              </button>
              {selected.record?.status === "failed" && (
                <button className="tasks-ghost" onClick={() => void retryTaskNow(selected)}>
                  <RefreshCw size={14} />
                  Retry Now
                </button>
              )}
              <button className="tasks-ghost" onClick={() => void setTaskStatus(selected, "blocked")}>
                <AlertTriangle size={14} />
                Block
              </button>
              <button className="tasks-ghost" onClick={() => void setTaskStatus(selected, "done")}>
                <CheckCircle2 size={14} />
                Done
              </button>
              <button className="tasks-ghost" disabled={!activeRunId} onClick={() => activeRunId && void stopAgent(activeRunId)}>
                <Square size={14} />
                Stop
              </button>
              <button
                className="tasks-ghost tasks-danger"
                disabled={!selected.record}
                onClick={() => void removeTask(selected)}
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>

            <p className="task-run-state">
              <Bot size={13} />
              Current run: <strong>{activeStatus}</strong>
              {activeRunId && <em>{activeRunId.slice(0, 8)}</em>}
            </p>
          </section>

          <section className="task-routing">
            <header>
              <h2>Investigation Routing</h2>
              <span>{cliReady ? "Ready" : "Needs CLI"}</span>
            </header>
            <div className="routing-steps">
              {["Collect context", "Inspect files", "Map risks", "Recommend next action"].map((step, index) => (
                <span key={step}>
                  <i>{index + 1}</i>
                  {step}
                </span>
              ))}
            </div>
            <div className="routing-loadout">
              <strong>CLI / Model Loadout</strong>
              {selected.cliCandidates.map((cliId) => (
                <span className={cliReadyState(cliId, installedCliIds) ? "ready" : "missing"} key={cliId}>
                  <b>{cliDisplayName(cliId, diagnostics)}</b>
                  <small>{resolveTaskModel(selected, cliId)}</small>
                </span>
              ))}
            </div>
          </section>

          <section className="task-history">
            <header>
              <h2>Recent Agent Runs</h2>
              <GitBranch size={14} />
            </header>
            <div className="task-history-list">
              {history.slice(0, 5).map((run) => (
                <article key={run.id}>
                  <span>
                    <strong>{cliLabels[run.cliId]}</strong>
                    <small>{new Date(run.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</small>
                  </span>
                  <p>{run.prompt}</p>
                  <em>{run.status}</em>
                </article>
              ))}
              {history.length === 0 && <p>No agent runs yet.</p>}
            </div>
          </section>
        </aside>
      </div>

      <div className="task-terminal-row">
        <TerminalPanel activeRunId={activeRunId} lines={terminalLines} onClear={clearTerminal} />
        <section className="task-throughput-panel">
          <header>
            <div>
              <h2>Task Throughput</h2>
              <p>Last 24 hours</p>
            </div>
            <Timer size={15} />
          </header>
          <strong>{throughput.current}</strong>
          <span>{throughput.delta >= 0 ? "+" : ""}{throughput.delta.toFixed(1)}%</span>
          <svg viewBox="0 0 260 90" role="img" aria-label="Task throughput trend">
            <path d={throughput.path} />
            <circle cx={throughput.lastPoint.x} cy={throughput.lastPoint.y} r="4" />
          </svg>
        </section>
      </div>
    </div>
  );
}

function TaskStat({
  icon,
  label,
  tone,
  value,
}: {
  icon: ReactNode;
  label: string;
  tone: "blue" | "cyan" | "purple" | "green" | "red";
  value: number;
}) {
  return (
    <article className={`task-stat tone-${tone}`}>
      <span>{icon}</span>
      <strong>{value}</strong>
      <small>{label}</small>
    </article>
  );
}

function TaskSchedulerPanel({
  canPlan,
  diagnostics,
  dueAt,
  installedCliIds,
  model,
  onChangeCli,
  onChangeDueAt,
  onChangeModel,
  onChangeRequest,
  onChangeTitle,
  onCreatePlan,
  onRunDue,
  planCliId,
  planning,
  project,
  request,
  runningDue,
  title,
}: {
  canPlan: boolean;
  diagnostics: SystemDiagnostics | null;
  dueAt: string;
  installedCliIds: Set<AgentCliId>;
  model: string;
  onChangeCli: (cliId: AgentCliId) => void;
  onChangeDueAt: (value: string) => void;
  onChangeModel: (value: string) => void;
  onChangeRequest: (value: string) => void;
  onChangeTitle: (value: string) => void;
  onCreatePlan: () => void;
  onRunDue: () => void;
  planCliId: AgentCliId;
  planning: boolean;
  project: ProjectSummary | null;
  request: string;
  runningDue: boolean;
  title: string;
}) {
  const ready = cliReadyState(planCliId, installedCliIds);

  return (
    <section className="task-scheduler-panel" aria-label="Scheduled task planner">
      <div className="task-scheduler-main">
        <header>
          <span>
            <CalendarClock size={16} />
          </span>
          <div>
            <h2>Task Scheduler</h2>
            <p>{project ? project.path : "No project selected"}</p>
          </div>
          <em className={ready ? "ready" : "missing"}>{ready ? "Ready" : "Needs CLI"}</em>
        </header>
        {/*
          Sets the expectation before the user clicks. The split is a fixed template
          picked by request length and keyword hits — it does not read the codebase.
          Read as a template it is a useful, instant, offline tool; read as AI
          planning it looks like a weak model.
        */}
        <p className="task-scheduler-hint">
          Splits the request into a template plan sized by length and keywords, and assigns each step to an installed
          CLI. It does not analyse your codebase.
        </p>

        <div className="task-scheduler-grid">
          <label className="task-scheduler-field">
            <span>Title</span>
            <input value={title} placeholder="Optional task title" onChange={(event) => onChangeTitle(event.target.value)} />
          </label>
          <label className="task-scheduler-field">
            <span>Due time</span>
            <input type="datetime-local" value={dueAt} onChange={(event) => onChangeDueAt(event.target.value)} />
          </label>
          <label className="task-scheduler-field">
            <span>Lead agent</span>
            <select value={planCliId} onChange={(event) => onChangeCli(event.target.value as AgentCliId)}>
              {schedulerCliOptions.map((cliId) => (
                <option key={cliId} value={cliId}>
                  {cliDisplayName(cliId, diagnostics)}
                </option>
              ))}
            </select>
          </label>
          <label className="task-scheduler-field">
            <span>Model</span>
            <input value={model} onChange={(event) => onChangeModel(event.target.value)} />
          </label>
          <label className="task-scheduler-field task-scheduler-request">
            <span>Request</span>
            <textarea
              value={request}
              rows={4}
              placeholder="Paste the full requirement to split and schedule"
              onChange={(event) => onChangeRequest(event.target.value)}
            />
          </label>
        </div>

        <div className="task-scheduler-actions">
          <button className="tasks-primary" disabled={!canPlan} onClick={onCreatePlan}>
            <Sparkles size={15} />
            {planning ? "Scheduling..." : "Split & Schedule"}
          </button>
          <button className="tasks-ghost" disabled={runningDue} onClick={onRunDue}>
            <PlayCircle size={15} />
            {runningDue ? "Checking..." : "Run Due"}
          </button>
        </div>
      </div>

      <aside className="task-scheduler-rail">
        <article>
          <Gauge size={16} />
          <strong>Difficulty</strong>
          <small>Auto-scored from scope and risk keywords</small>
        </article>
        <article>
          <Network size={16} />
          <strong>Subtasks</strong>
          <small>Generated with staggered due times</small>
        </article>
        <article>
          <Bot size={16} />
          <strong>Agents</strong>
          <small>Assigned per investigation, execution, test, review</small>
        </article>
      </aside>
    </section>
  );
}

type TaskModelRosterItem = {
  accent: TaskBlueprint["accent"];
  agents: string[];
  cliId: AgentCliId;
  cliName: string;
  key: string;
  model: string;
  ready: boolean;
  tasks: string[];
};

function TaskAgentOverview({
  activeRunId,
  activeStatus,
  diagnostics,
  installedCliIds,
  modelRoster,
  onSelect,
  selectedId,
  tasks,
}: {
  activeRunId: string | null;
  activeStatus: AgentStatus;
  diagnostics: SystemDiagnostics | null;
  installedCliIds: Set<AgentCliId>;
  modelRoster: TaskModelRosterItem[];
  onSelect: (id: string) => void;
  selectedId: string;
  tasks: TaskItem[];
}) {
  const slots = tasks.slice(0, 6);
  const readyAgents = slots.filter((task) => {
    const cliId = resolveCli(task, installedCliIds) ?? task.cliCandidates[0];
    return cliId ? cliReadyState(cliId, installedCliIds) : false;
  }).length;
  const activeLabel = activeRunId ? `${activeStatus} · ${activeRunId.slice(0, 8)}` : "ready";

  return (
    <section className="task-agent-command" aria-label="AI agent task deck">
      <div className="task-agent-stage">
        <header className="task-agent-stage-head">
          <span>
            <Gamepad2 size={14} />
            Agent Task Deck
          </span>
          <div>
            <strong>{slots.length} playable agents</strong>
            <small>{readyAgents}/{Math.max(slots.length, 1)} CLI loadouts ready</small>
          </div>
          <em>{activeLabel}</em>
        </header>

        <div className="task-agent-arena">
          <div className="task-route-ring" aria-hidden="true" />
          <div className="task-route-cross one" aria-hidden="true" />
          <div className="task-route-cross two" aria-hidden="true" />

          <div className="task-arena-core">
            <span>
              <Route size={19} />
            </span>
            <strong>Workflow Engine</strong>
            <small>routes tasks, code, settings</small>
          </div>

          {slots.map((task, index) => {
            const cliId = resolveCli(task, installedCliIds) ?? task.cliCandidates[0] ?? null;
            const model = resolveTaskModel(task, cliId);
            const ready = cliId ? cliReadyState(cliId, installedCliIds) : false;
            return (
              <button
                className={`agent-slot slot-${index + 1} accent-${task.accent} ${selectedId === task.id ? "selected" : ""}`}
                key={task.id}
                onClick={() => onSelect(task.id)}
                type="button"
              >
                <span className="agent-slot-rank">{String(index + 1).padStart(2, "0")}</span>
                <span className="agent-slot-avatar">{agentInitials(task.agentName)}</span>
                <span className="agent-slot-copy">
                  <strong>{task.agentName}</strong>
                  <small>
                    {task.mode} · {task.role}
                  </small>
                </span>
                <em>{task.mission}</em>
                <span className="agent-slot-loadout">
                  <b>{cliId ? cliDisplayName(cliId, diagnostics) : "No CLI"}</b>
                  <i>{model}</i>
                  <small>{ready ? "ready" : "missing"}</small>
                </span>
              </button>
            );
          })}

          {slots.length === 0 && (
            <p className="task-empty task-agent-empty">No agent tasks available for this workspace.</p>
          )}
        </div>
      </div>

      <aside className="task-model-overview">
        <header>
          <span>
            <Cpu size={15} />
          </span>
          <div>
            <h2>Overview Models Working</h2>
            <p>Current task routing by CLI and model</p>
          </div>
        </header>

        <div className="task-mode-strip" aria-label="Agent modes">
          {["Developer", "Coding", "Testing", "Settings"].map((mode) => (
            <span key={mode}>
              {mode === "Settings" ? <Settings size={12} /> : <Bot size={12} />}
              {mode}
            </span>
          ))}
        </div>

        <div className="task-model-list">
          {modelRoster.map((item) => (
            <article className={`task-model-row accent-${item.accent}`} key={item.key}>
              <span className="task-model-icon">{item.cliName.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{item.model}</strong>
                <small>
                  {item.cliName} · {item.agents.slice(0, 2).join(", ")}
                  {item.agents.length > 2 ? ` +${item.agents.length - 2}` : ""}
                </small>
              </div>
              <em className={item.ready ? "ready" : "missing"}>{item.ready ? "Ready" : "Needs CLI"}</em>
            </article>
          ))}
          {modelRoster.length === 0 && <p className="task-empty">No model assignments yet.</p>}
        </div>
      </aside>
    </section>
  );
}

function decorateTaskRecord(record: TaskRecord): TaskItem {
  const blueprint = taskSeeds.find((task) => task.title === record.title) ?? defaultBlueprint(record);
  const assignedCliId = record.assignedCliId ?? null;
  const model = assignedCliId ? record.assignedModel ?? defaultModelForCli(assignedCliId) : blueprint.model;
  const modelByCli = assignedCliId
    ? { ...blueprint.modelByCli, [assignedCliId]: model }
    : blueprint.modelByCli;

  return {
    ...blueprint,
    id: record.id,
    agentName: assignedCliId ? agentNameForCli(assignedCliId) : blueprint.agentName,
    role: assignedCliId ? roleForCli(assignedCliId) : blueprint.role,
    mission: record.automationEnabled
      ? "Run automatically at the scheduled due time."
      : blueprint.mission,
    summary: summarizePrompt(record.prompt),
    prompt: record.prompt,
    priority: record.difficulty ? difficultyMeta[record.difficulty].priority : blueprint.priority,
    eta: record.estimatedMinutes ? `${record.estimatedMinutes}m` : blueprint.eta,
    mode: assignedCliId ? modeForCli(assignedCliId) : blueprint.mode,
    kind: kindForRecord(record, blueprint.kind),
    accent: assignedCliId ? accentForCli(assignedCliId) : blueprint.accent,
    tags: taskTagsFor(record, blueprint.tags),
    cliCandidates: assignedCliId ? [assignedCliId, ...blueprint.cliCandidates.filter((cliId) => cliId !== assignedCliId)] : blueprint.cliCandidates,
    model,
    modelByCli,
    status: record.status,
    source: "saved",
    record,
  };
}

function decorateTemplateTask(template: TaskBlueprint): TaskItem {
  return {
    ...template,
    status: "open",
    source: "template",
  };
}

function defaultBlueprint(record: TaskRecord): TaskBlueprint {
  const assignedCliId = record.assignedCliId ?? "codex";
  const model = record.assignedModel ?? defaultModelForCli(assignedCliId);

  return {
    id: record.id,
    agentName: agentNameForCli(assignedCliId),
    mission: record.automationEnabled
      ? "Run automatically at the scheduled due time."
      : "Investigate the saved task and propose the next move.",
    title: record.title,
    role: roleForCli(assignedCliId),
    summary: summarizePrompt(record.prompt),
    prompt: record.prompt,
    priority: record.difficulty ? difficultyMeta[record.difficulty].priority : "medium",
    eta: record.estimatedMinutes ? `${record.estimatedMinutes}m` : "—",
    mode: modeForCli(assignedCliId),
    kind: kindForRecord(record, "investigate"),
    accent: accentForCli(assignedCliId),
    files: [],
    tags: taskTagsFor(record, ["task"]),
    cliCandidates: [assignedCliId, ...["codex", "claude", "kiro", "gemini", "shell"].filter((cliId) => cliId !== assignedCliId)] as AgentCliId[],
    model,
    modelByCli: {
      codex: "gpt-5-codex",
      claude: "sonnet",
      kiro: "claude-sonnet-4-5",
      gemini: "gemini-2.5-pro",
      shell: "none",
      [assignedCliId]: model,
    },
  };
}

function buildThroughput(history: AgentRunRecord[]): {
  current: number;
  delta: number;
  path: string;
  lastPoint: { x: number; y: number };
} {
  const now = Date.now();
  const current = countRuns(history, now - 86_400_000, now);
  const previous = countRuns(history, now - 172_800_000, now - 86_400_000);
  const delta = previous === 0 ? (current > 0 ? 100 : 0) : ((current - previous) / previous) * 100;
  const values = Array.from({ length: 12 }, (_, index) => {
    const bucketMs = 86_400_000 / 12;
    const start = now - 86_400_000 + bucketMs * index;
    return countRuns(history, start, start + bucketMs);
  });
  return {
    current,
    delta,
    path: pointsFor(values, 260, 90),
    lastPoint: lastPointFor(values, 260, 90),
  };
}

function countRuns(history: AgentRunRecord[], start: number, end: number): number {
  return history.filter((run) => {
    const started = Date.parse(run.startedAt);
    return Number.isFinite(started) && started >= start && started < end;
  }).length;
}

function pointsFor(values: number[], width: number, height: number): string {
  const max = Math.max(...values, 1);
  return values
    .map((value, index) => {
      const x = 4 + (index / Math.max(values.length - 1, 1)) * (width - 8);
      const y = height - 8 - (value / max) * (height - 20);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function lastPointFor(values: number[], width: number, height: number): { x: number; y: number } {
  const max = Math.max(...values, 1);
  const value = values.at(-1) ?? 0;
  return {
    x: width - 4,
    y: height - 8 - (value / max) * (height - 20),
  };
}

function TaskCard({
  cliId,
  diagnostics,
  onSelect,
  selected,
  task,
}: {
  cliId: AgentCliId | null;
  diagnostics: SystemDiagnostics | null;
  onSelect: () => void;
  selected: boolean;
  task: TaskItem;
}) {
  const Icon = stepKindMeta[task.kind].icon;
  const model = resolveTaskModel(task, cliId);

  return (
    <article className={`task-card ${selected ? "selected" : ""} accent-${task.accent}`} onClick={onSelect}>
      <header>
        <span className="task-kind-icon">
          <Icon size={16} />
        </span>
        <div>
          <h3>{task.title}</h3>
          <small>
            {task.agentName} · {task.role}
          </small>
        </div>
        <span className={`task-priority priority-${task.priority}`}>{priorityMeta[task.priority]}</span>
      </header>
      <p>{task.summary}</p>
      <footer>
        <span className={`task-status status-${task.source === "template" ? "blue" : statusMeta[task.status].tone}`}>
          {task.source === "template" ? "Preset" : statusMeta[task.status].label}
        </span>
        <span>{task.mode}</span>
        <span>{task.eta}</span>
        {task.record?.parentTaskId && <span>Subtask</span>}
        {task.record?.automationEnabled && <span>{formatDue(task.record?.dueAt)}</span>}
        {task.record?.difficulty && <span>{difficultyMeta[task.record.difficulty].label}</span>}
        {(task.record?.attemptCount ?? 0) > 0 && (
          <span>
            Attempt {task.record?.attemptCount}/{task.record?.maxAttempts}
          </span>
        )}
        <span>{cliId ? cliDisplayName(cliId, diagnostics) : "No CLI"}</span>
        <span>{model}</span>
      </footer>
      <div className="task-tags">
        {task.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
    </article>
  );
}

function resolveCli(task: TaskItem, installedCliIds: Set<AgentCliId>): AgentCliId | null {
  if (task.record?.assignedCliId) return task.record.assignedCliId;
  return task.cliCandidates.find((candidate) => candidate === "shell" || installedCliIds.has(candidate)) ?? null;
}

function cliReadyState(cliId: AgentCliId, installedCliIds: Set<AgentCliId>): boolean {
  return cliId === "shell" || installedCliIds.has(cliId);
}

function resolveTaskModel(task: TaskItem, cliId: AgentCliId | null): string {
  if (!cliId) return task.model;
  if (task.record?.assignedCliId === cliId && task.record.assignedModel) return task.record.assignedModel;
  return task.modelByCli?.[cliId] ?? task.model;
}

function cliDisplayName(cliId: AgentCliId, diagnostics: SystemDiagnostics | null): string {
  const tool = diagnostics?.tools.find((entry) => entry.id === cliId);
  return tool?.displayName ?? cliLabels[cliId] ?? cliId;
}

function agentInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .padEnd(2, "A");
}

function defaultModelForCli(cliId: AgentCliId): string {
  const models: Record<AgentCliId, string> = {
    claude: "sonnet",
    kiro: "claude-sonnet-4-5",
    codex: "gpt-5-codex",
    gemini: "gemini-2.5-pro",
    agy: "default",
    grok: "grok-4.5",
    amazonq: "default",
    aider: "default",
    opencode: "default",
    cursor: "default",
    copilot: "default",
    qwen: "default",
    ollama: "default",
    shell: "none",
    custom: "default",
  };
  return models[cliId];
}

function agentNameForCli(cliId: AgentCliId): string {
  const names: Partial<Record<AgentCliId, string>> = {
    claude: "Claude Planner",
    kiro: "Kiro Investigator",
    codex: "Codex Implementer",
    gemini: "Gemini Analyst",
    agy: "Agy Operator",
    shell: "Shell Runner",
  };
  return names[cliId] ?? `${cliLabels[cliId]} Agent`;
}

function roleForCli(cliId: AgentCliId): string {
  const roles: Partial<Record<AgentCliId, string>> = {
    claude: "Planning Agent",
    kiro: "Investigation Agent",
    codex: "Implementation Agent",
    gemini: "Analysis Agent",
    agy: "Automation Agent",
    shell: "Verification Agent",
  };
  return roles[cliId] ?? "Agent";
}

function modeForCli(cliId: AgentCliId): TaskMode {
  if (cliId === "codex" || cliId === "aider" || cliId === "opencode" || cliId === "cursor") return "Coding";
  if (cliId === "shell") return "Testing";
  if (cliId === "gemini" || cliId === "claude") return "Knowledge";
  if (cliId === "amazonq") return "Deployment";
  return "Developer";
}

function accentForCli(cliId: AgentCliId): TaskBlueprint["accent"] {
  const accents: Partial<Record<AgentCliId, TaskBlueprint["accent"]>> = {
    claude: "green",
    kiro: "blue",
    codex: "cyan",
    gemini: "purple",
    agy: "amber",
    shell: "orange",
  };
  return accents[cliId] ?? "blue";
}

function kindForRecord(record: TaskRecord, fallback: WorkflowStepKind): WorkflowStepKind {
  const text = `${record.title} ${record.prompt}`.toLowerCase();
  if (/\b(test|verify|validation|typecheck|lint)\b/.test(text)) return "test";
  if (/\b(review|audit|risk)\b/.test(text)) return "review";
  if (/\b(deploy|package|release|ship)\b/.test(text)) return "deploy";
  if (/\b(implement|execute|build|code|fix)\b/.test(text)) return "execute";
  if (/\b(plan|break down|split|schedule)\b/.test(text)) return "plan";
  if (/\b(analyze|analysis|synthesize)\b/.test(text)) return "analyze";
  return fallback;
}

function taskTagsFor(record: TaskRecord, baseTags: string[]): string[] {
  const tags = [
    ...baseTags,
    record.automationEnabled ? "scheduled" : null,
    record.parentTaskId ? "subtask" : null,
    record.difficulty,
    record.assignedCliId,
  ].filter((tag): tag is string => Boolean(tag));
  return [...new Set(tags)].slice(0, 6);
}

function summarizePrompt(prompt: string): string {
  const summary = prompt.replace(/\s+/g, " ").trim();
  return summary.length > 170 ? `${summary.slice(0, 167)}...` : summary;
}

function formatEstimate(task: TaskItem): string {
  return task.record?.estimatedMinutes ? `${task.record.estimatedMinutes}m` : task.eta;
}

function formatDue(input?: string | null): string {
  if (!input) return "—";
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) return input;
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDateTimeLocal(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join("T");
}

function toIsoDate(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function buildModelRoster(
  tasks: TaskItem[],
  installedCliIds: Set<AgentCliId>,
  diagnostics: SystemDiagnostics | null,
): TaskModelRosterItem[] {
  const rows = new Map<string, TaskModelRosterItem>();

  for (const task of tasks) {
    const cliId = resolveCli(task, installedCliIds) ?? task.cliCandidates[0];
    if (!cliId) continue;

    const model = resolveTaskModel(task, cliId);
    const key = `${cliId}:${model}`;
    const existing = rows.get(key);
    if (existing) {
      existing.agents.push(task.agentName);
      existing.tasks.push(task.title);
      continue;
    }

    rows.set(key, {
      accent: task.accent,
      agents: [task.agentName],
      cliId,
      cliName: cliDisplayName(cliId, diagnostics),
      key,
      model,
      ready: cliReadyState(cliId, installedCliIds),
      tasks: [task.title],
    });
  }

  return [...rows.values()].slice(0, 6);
}

function buildInvestigationPrompt(task: TaskItem, project: ProjectSummary, cliId: AgentCliId, model: string): string {
  return [
    `Investigate task: ${task.title}`,
    `Project: ${project.name} (${project.path})`,
    `Agent: ${task.agentName}`,
    `Role: ${task.role}`,
    `Mode: ${task.mode}`,
    `Mission: ${task.mission}`,
    `Selected CLI: ${cliLabels[cliId]}`,
    `Selected model: ${model}`,
    `Priority: ${priorityMeta[task.priority]}`,
    task.record?.difficulty ? `Difficulty: ${difficultyMeta[task.record.difficulty].label}` : null,
    task.record?.dueAt ? `Due: ${task.record.dueAt}` : null,
    task.record?.parentTaskId ? `Parent task: ${task.record.parentTaskId}` : null,
    task.record?.lastRunId ? `Previous run: ${task.record.lastRunId}` : null,
    `Summary: ${task.summary}`,
    `Instruction: ${task.prompt}`,
    `Focus files: ${task.files.join(", ")}`,
    "",
    "Return a concise investigation report with observed behavior, relevant files, risks, next implementation steps, and validation commands.",
    "Do not close, restart, or stop the Electron desktop app. Do not modify files unless explicitly requested.",
  ].filter(Boolean).join("\n");
}

function buildShellInvestigation(task: TaskItem): string {
  return [
    `Investigation requested for ${task.title} by ${task.agentName}.`,
    task.record?.dueAt ? `Due: ${task.record.dueAt}` : null,
    task.record?.difficulty ? `Difficulty: ${difficultyMeta[task.record.difficulty].label}` : null,
    "Use an AI CLI such as Codex, Claude, Kiro, Agy, or Gemini for repo-aware analysis.",
  ].filter(Boolean).join("\n");
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
