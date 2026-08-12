import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import type { WorkflowDefinition, WorkflowEvent, WorkflowTriggerType, EventBroadcaster } from "@contracts";
import { git } from "../git/git-service";
import { type IssueSummary, gh, listOpenIssues, parseIssueTrigger } from "./issue-poller";
import type { WorkflowService } from "./workflow-service";
import { parseSchedule, previousOccurrence } from "./workflow-schedule";

/** A workflow the `requireProject` filter has already proven has a project path. */
type WithProject = WorkflowDefinition & { projectPath: string };

type SchedulerOptions = {
  intervalMs?: number;
  /**
   * Runs each tick after the trigger passes. The webhook coordinator uses this to
   * open or close its port as webhook workflows are enabled, disabled, or deleted,
   * so those edits take effect without restarting the app.
   */
  onSync?: () => void | Promise<unknown>;
};

const FILE_CHANGE_DEBOUNCE_MS = 1_000;

/**
 * Quiet period after a ref-change run before that workflow can fire again.
 *
 * A workflow whose steps commit would otherwise observe its own commit on the next
 * tick and fire forever. The cooldown is longer than the poll interval so a
 * self-caused commit is always swallowed.
 */
const REF_CHANGE_COOLDOWN_MS = 90_000;

/**
 * Quiet period between webhook runs of the same workflow.
 *
 * Providers retry deliveries they consider failed, and "redeliver" is one click in
 * most dashboards, so the same logical event can arrive several times.
 */
const WEBHOOK_DEBOUNCE_MS = 2_000;

/**
 * Quiet period between issue-triggered runs of the same workflow.
 *
 * A burst of issues filed at once (a triage session, an importer) should start the
 * workflow, not start it once per issue.
 */
const ISSUE_COOLDOWN_MS = 60_000;

/**
 * Fires locally runnable workflow triggers: friendly schedules and project file
 * changes. GitHub/Jira/webhook triggers remain disabled in the editor until the
 * app has real integrations listening for them; this service deliberately does not
 * pretend to handle remote events it cannot receive.
 *
 * Scheduled workflows are due when their most recent scheduled moment is newer
 * than their last recorded run. Workflows that have never run are baselined
 * against the moment the scheduler booted, so launching the app does not
 * immediately fire every schedule whose time already passed earlier today.
 */
export class WorkflowSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Guards the ref poll, which spawns git and can outlast a fast tick interval. */
  private refPolling = false;
  private startedAt = new Date();
  /** Guards against re-firing the same schedule slot when a run is slow to record. */
  private readonly lastFiredFor = new Map<string, number>();
  /** Root folder -> fs watcher. Multiple workflows can share a project root. */
  private readonly fileWatchers = new Map<string, FSWatcher>();
  /** Workflow id -> last accepted file-change run time. */
  private readonly lastFileChangeFor = new Map<string, number>();
  /** `<root>@<branch>` -> last observed commit SHA. Seeded, never fired on, at boot. */
  private readonly lastRefSha = new Map<string, string>();
  /** Workflow id -> last accepted ref-change run time, for the self-commit cooldown. */
  private readonly lastRefRunFor = new Map<string, number>();
  /** Workflow id -> last accepted webhook run time, for delivery retries. */
  private readonly lastWebhookFor = new Map<string, number>();
  /** Guards the issue poll, which shells out to `gh` over the network. */
  private issuePolling = false;
  /** Project root -> issue numbers already seen. Seeded, never fired on, at boot. */
  private readonly seenIssues = new Map<string, Set<number>>();
  /** Workflow id -> last accepted issue-triggered run time. */
  private readonly lastIssueRunFor = new Map<string, number>();

  constructor(
    private readonly workflows: WorkflowService,
    private readonly webContentsProvider: () => EventBroadcaster | null,
    /** Injection seam for tests: runs one git command in `cwd`. */
    private readonly runGit: (cwd: string, args: string[]) => Promise<{ ok: boolean; output: string }> = git,
    /** Injection seam for tests: runs one `gh` command in `cwd`. */
    private readonly runGh: (cwd: string, args: string[]) => Promise<{ ok: boolean; output: string }> = gh,
  ) {}

  /** Open issues for `root`, optionally narrowed to a label. Null means "cannot tell". */
  private listIssues(root: string, label?: string): Promise<IssueSummary[] | null> {
    if (!label) return listOpenIssues(root, this.runGh);
    return listOpenIssues(root, (cwd, args) => this.runGh(cwd, [...args, "--label", label]));
  }

  start(options: SchedulerOptions = {}): void {
    if (this.timer) return;
    this.startedAt = new Date();
    this.refreshFileWatchers();
    // Seed ref SHAs before the first tick: without this, every ref-change workflow
    // fires once on launch simply because the app had never seen its HEAD before.
    void this.seedRefBaselines();
    // Same reason: without a baseline every issue already open would look new.
    void this.seedIssueBaselines();
    const intervalMs = Math.max(15_000, options.intervalMs ?? 60_000);
    this.timer = setInterval(() => {
      void this.runDueWorkflows();
      void this.runRefChangeWorkflows();
      void this.runIssueWorkflows();
      this.refreshFileWatchers();
      void options.onSync?.();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const watcher of this.fileWatchers.values()) watcher.close();
    this.fileWatchers.clear();
  }

  /** Runs every workflow whose schedule came due, sequentially. */
  async runDueWorkflows(now = new Date()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];

    try {
      for (const workflow of this.workflows.list()) {
        const dueAt = this.dueMoment(workflow, now);
        if (!dueAt) continue;

        this.lastFiredFor.set(workflow.id, dueAt.getTime());
        this.emitTriggered(workflow, dueAt);

        try {
          await this.workflows.run({ workflowId: workflow.id, triggeredBy: "schedule" });
          fired.push(workflow.id);
        } catch (error) {
          // One broken workflow must not stop the rest of the tick.
          this.emitFailure(workflow, error, "Scheduled run");
        }
      }
    } finally {
      this.ticking = false;
    }

    return fired;
  }

  /** Runs every active file-change workflow whose project/detail matches `changedPath`. */
  async runFileChangeWorkflows(changedPath: string, now = new Date()): Promise<string[]> {
    const fired: string[] = [];
    const absoluteChanged = path.resolve(changedPath);

    for (const workflow of this.workflows.list()) {
      if (!this.matchesFileChange(workflow, absoluteChanged)) continue;

      const last = this.lastFileChangeFor.get(workflow.id) ?? 0;
      if (now.getTime() - last < FILE_CHANGE_DEBOUNCE_MS) continue;
      this.lastFileChangeFor.set(workflow.id, now.getTime());
      this.emitFileChangeTriggered(workflow, absoluteChanged);

      try {
        await this.workflows.run({ workflowId: workflow.id, triggeredBy: "file-change" });
        fired.push(workflow.id);
      } catch (error) {
        this.emitFailure(workflow, error, "File-change run");
      }
    }

    return fired;
  }

  /**
   * Runs every active `git-push` workflow whose tracked ref moved since last poll.
   *
   * Named `git-push` for backward compatibility with saved workflows, but what is
   * actually detected is *any* ref change — commit, merge, rebase, amend, or pull.
   * When a `remote` is configured in `trigger.detail` the remote-tracking ref is
   * watched instead, which is the closest local approximation of "was pushed".
   */
  async runRefChangeWorkflows(now = new Date()): Promise<string[]> {
    if (this.refPolling) return [];
    this.refPolling = true;
    const fired: string[] = [];

    try {
      for (const { workflow, root, ref, key, config } of this.refTargets()) {
        const sha = await this.resolveRef(root, ref);
        if (!sha) continue;

        const previous = this.lastRefSha.get(key);
        // Always record first: a poll that observes a new SHA and then fails to run
        // must not re-fire the same commit on the next tick.
        this.lastRefSha.set(key, sha);

        // Unknown ref means this is the baseline observation, not a change. Firing
        // here would run every workflow once whenever the app restarts.
        if (previous === undefined || previous === sha) continue;

        if (config.branch && !config.remote) {
          const current = (await this.runGit(root, ["branch", "--show-current"])).output.trim();
          // A branch filter means "only when this branch moves"; a checkout to
          // another branch changes HEAD but is not a change to the watched branch.
          if (current && current !== config.branch) continue;
        }

        const lastRun = this.lastRefRunFor.get(workflow.id);
        // `undefined`, not `0`, means "never ran". A sentinel of 0 makes the cooldown
        // compare against the epoch, which blocks the very first run whenever `now`
        // is small — real with an injected clock, and a latent trap besides.
        if (lastRun !== undefined && now.getTime() - lastRun < REF_CHANGE_COOLDOWN_MS) continue;
        this.lastRefRunFor.set(workflow.id, now.getTime());
        this.emit(workflow, `🔀 ${ref} moved to ${sha.slice(0, 8)}`);

        try {
          await this.workflows.run({ workflowId: workflow.id, triggeredBy: "git-push" });
          fired.push(workflow.id);
        } catch (error) {
          this.emitFailure(workflow, error, "Ref-change run");
        }
      }
    } finally {
      this.refPolling = false;
    }

    return fired;
  }

  /**
   * Records the current SHA of every watched ref without firing anything.
   *
   * This is what makes "changed since the app was last looking" the trigger, rather
   * than "the app has not seen this SHA before".
   */
  async seedRefBaselines(): Promise<void> {
    for (const { root, ref, key } of this.refTargets()) {
      if (this.lastRefSha.has(key)) continue;
      const sha = await this.resolveRef(root, ref);
      if (sha) this.lastRefSha.set(key, sha);
    }
  }

  /**
   * Every ref a `git-push` workflow is watching, with the ref and cache key already
   * resolved. Shared by the poll and the seeder so the two can never disagree about
   * which ref a workflow means.
   */
  private *refTargets(): Generator<{
    workflow: WorkflowDefinition;
    root: string;
    ref: string;
    key: string;
    config: RefTrigger;
  }> {
    for (const workflow of this.eligible("git-push", true)) {
      const root = path.resolve(workflow.projectPath);
      const config = parseRefTrigger(workflow.trigger.detail);
      const branch = config.branch ?? "HEAD";
      const ref = config.remote ? `refs/remotes/${config.remote}/${branch}` : branch;
      yield { workflow, root, ref, key: `${root}@${ref}`, config };
    }
  }

  /** The SHA a ref points at, or null when the repo or ref does not resolve. */
  private async resolveRef(root: string, ref: string): Promise<string | null> {
    const result = await this.runGit(root, ["rev-parse", ref]);
    if (!result.ok) return null;
    const sha = result.output.trim().split(/\s+/)[0] ?? "";
    // `rev-parse` echoes the input back when it cannot resolve it, so a value that
    // is not a hex object id means "no such ref" rather than a real SHA.
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  }

  /**
   * Runs every active webhook workflow whose `detail` matches the delivered hook.
   *
   * Matching is on the trailing path segment (`/hooks/<name>`). An empty `detail`
   * matches nothing rather than everything: a workflow that fires on any inbound
   * delivery is almost never what someone meant, and defaulting to "all" would make
   * one hook name accidentally trigger unrelated automation.
   */
  async runWebhookWorkflows(hook: string, payload: unknown, now = new Date()): Promise<string[]> {
    const fired: string[] = [];
    const normalized = hook.trim().toLowerCase();
    if (!normalized) return fired;

    for (const workflow of this.eligible("webhook")) {
      const configured = workflow.trigger.detail?.trim().toLowerCase();
      if (!configured || configured !== normalized) continue;

      // Same debounce rule as file-change: a provider that retries a delivery, or a
      // double-click on "redeliver", should not stack runs of the same workflow.
      const last = this.lastWebhookFor.get(workflow.id) ?? 0;
      if (now.getTime() - last < WEBHOOK_DEBOUNCE_MS) continue;
      this.lastWebhookFor.set(workflow.id, now.getTime());
      this.emit(workflow, `🔔 Webhook /hooks/${hook} received${describePayload(payload)}`);

      try {
        await this.workflows.run({ workflowId: workflow.id, triggeredBy: "webhook" });
        fired.push(workflow.id);
      } catch (error) {
        this.emitFailure(workflow, error, "Webhook run");
      }
    }

    return fired;
  }

  /** True when at least one active workflow is waiting on an inbound delivery. */
  hasActiveWebhookWorkflows(): boolean {
    return this.eligible("webhook").some((workflow) => Boolean(workflow.trigger.detail?.trim()));
  }

  /**
   * Runs every active `issue-created` workflow for issues opened since last poll.
   *
   * Same discipline as the ref trigger: issues seen on the first poll are recorded
   * as the baseline and never fired on, so launching the app does not run a
   * workflow once for every issue already open in the repo.
   */
  async runIssueWorkflows(now = new Date()): Promise<string[]> {
    if (this.issuePolling) return [];
    this.issuePolling = true;
    const fired: string[] = [];

    try {
      // One `gh` call per repo, not per workflow: several workflows commonly watch
      // the same project and each poll is a network round-trip.
      const byRoot = new Map<string, WorkflowDefinition[]>();
      for (const workflow of this.eligible("issue-created", true)) {
        const root = path.resolve(workflow.projectPath);
        byRoot.set(root, [...(byRoot.get(root) ?? []), workflow]);
      }

      for (const [root, workflows] of byRoot) {
        const issues = await this.listIssues(root);
        // null means "cannot tell" (no gh, logged out, not a GitHub repo). Recording
        // a baseline from that would make every issue look new once gh starts working.
        if (issues === null) continue;

        const seen = this.seenIssues.get(root);
        if (!seen) {
          this.seenIssues.set(root, new Set(issues.map((issue) => issue.number)));
          continue;
        }

        const fresh = issues.filter((issue) => !seen.has(issue.number));
        for (const issue of issues) seen.add(issue.number);
        if (fresh.length === 0) continue;

        for (const workflow of workflows) {
          const { label } = parseIssueTrigger(workflow.trigger.detail);
          // A label filter needs a second call per issue, so it is only paid for
          // when the user actually asked for one.
          const matching = label ? await this.filterByLabel(root, fresh, label) : fresh;
          if (matching.length === 0) continue;

          const lastRun = this.lastIssueRunFor.get(workflow.id);
          if (lastRun !== undefined && now.getTime() - lastRun < ISSUE_COOLDOWN_MS) continue;
          this.lastIssueRunFor.set(workflow.id, now.getTime());

          const headline = matching[0];
          const extra = matching.length > 1 ? ` (+${matching.length - 1} more)` : "";
          this.emit(workflow, `🐛 Issue #${headline.number} opened: ${headline.title}${extra}`);

          try {
            await this.workflows.run({ workflowId: workflow.id, triggeredBy: "issue-created" });
            fired.push(workflow.id);
          } catch (error) {
            this.emitFailure(workflow, error, "Issue run");
          }
        }
      }
    } finally {
      this.issuePolling = false;
    }

    return fired;
  }

  /** Records currently-open issues without firing, so only later ones count as new. */
  async seedIssueBaselines(): Promise<void> {
    for (const workflow of this.eligible("issue-created", true)) {
      const root = path.resolve(workflow.projectPath);
      if (this.seenIssues.has(root)) continue;
      const issues = await this.listIssues(root);
      if (issues) this.seenIssues.set(root, new Set(issues.map((issue) => issue.number)));
    }
  }

  /** Issues carrying `label`, filtered one call at a time. */
  private async filterByLabel(root: string, issues: IssueSummary[], label: string): Promise<IssueSummary[]> {
    const labelled = await this.listIssues(root, label);
    if (labelled === null) return [];
    const allowed = new Set(labelled.map((issue) => issue.number));
    return issues.filter((issue) => allowed.has(issue.number));
  }

  /**
   * Active workflows of one trigger type that have at least one enabled step.
   *
   * Every runner needs this same triple, and `requireProject` covers the runners
   * that cannot do anything without a folder to work in. Keeping it in one place
   * stops the five call sites drifting apart on what "eligible" means.
   */
  private eligible(type: WorkflowTriggerType, requireProject: true): WithProject[];
  private eligible(type: WorkflowTriggerType, requireProject?: false): WorkflowDefinition[];
  private eligible(type: WorkflowTriggerType, requireProject = false): WorkflowDefinition[] {
    return this.workflows
      .list()
      .filter(
        (workflow) =>
          workflow.status === "active" &&
          workflow.trigger.type === type &&
          workflow.steps.some((step) => step.enabled) &&
          (!requireProject || Boolean(workflow.projectPath)),
      );
  }

  /** The scheduled moment this workflow owes a run for, or null when it is current. */
  private dueMoment(workflow: WorkflowDefinition, now: Date): Date | null {
    if (workflow.status !== "active") return null;
    if (workflow.trigger.type !== "schedule") return null;
    if (!workflow.steps.some((step) => step.enabled)) return null;

    const schedule = parseSchedule(workflow.trigger.schedule);
    if (!schedule) return null;

    const dueAt = previousOccurrence(schedule, now);
    if (!dueAt) return null;

    const alreadyFired = this.lastFiredFor.get(workflow.id);
    if (alreadyFired !== undefined && dueAt.getTime() <= alreadyFired) return null;

    const lastRunAt = workflow.stats.lastRunAt ? Date.parse(workflow.stats.lastRunAt) : NaN;
    const baseline = Number.isFinite(lastRunAt) ? lastRunAt : this.startedAt.getTime();
    return dueAt.getTime() > baseline ? dueAt : null;
  }

  private matchesFileChange(workflow: WorkflowDefinition, changedPath: string): boolean {
    if (workflow.status !== "active") return false;
    if (workflow.trigger.type !== "file-change") return false;
    if (!workflow.steps.some((step) => step.enabled)) return false;
    if (!workflow.projectPath) return false;

    const root = path.resolve(workflow.projectPath);
    const relative = path.relative(root, changedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;

    const detail = workflow.trigger.detail?.trim();
    if (!detail) return true;

    return detail
      .split(",")
      .map((part) => normalizeFilter(part))
      .filter(Boolean)
      .some((filter) => fileChangeFilterMatches(filter, relative));
  }

  private refreshFileWatchers(): void {
    const desired = new Set(this.eligible("file-change", true).map((workflow) => path.resolve(workflow.projectPath)));

    for (const [root, watcher] of this.fileWatchers.entries()) {
      if (desired.has(root)) continue;
      watcher.close();
      this.fileWatchers.delete(root);
    }

    for (const root of desired) {
      if (this.fileWatchers.has(root)) continue;
      this.watchProjectRoot(root);
    }
  }

  private watchProjectRoot(root: string): void {
    if (!fs.existsSync(root)) return;

    const onChange = (_event: string, filename: string | Buffer | null) => {
      const changedPath = filename ? path.resolve(root, filename.toString()) : root;
      void this.runFileChangeWorkflows(changedPath);
    };

    try {
      this.fileWatchers.set(root, fs.watch(root, { recursive: process.platform !== "linux" }, onChange));
    } catch {
      try {
        this.fileWatchers.set(root, fs.watch(root, onChange));
      } catch (error) {
        this.emitDetached(`⚠ File-change watcher could not start for ${root}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private emitTriggered(workflow: WorkflowDefinition, dueAt: Date): void {
    this.emit(workflow, `⏰ Schedule "${workflow.trigger.schedule}" came due at ${dueAt.toLocaleString()}`);
  }

  private emitFileChangeTriggered(workflow: WorkflowDefinition, changedPath: string): void {
    const root = workflow.projectPath ? path.resolve(workflow.projectPath) : "";
    const relative = root ? path.relative(root, changedPath) || "." : changedPath;
    this.emit(workflow, `📁 File change matched ${relative}`);
  }

  private emitFailure(workflow: WorkflowDefinition, error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emit(workflow, `⚠ ${prefix} could not start: ${message}`);
  }

  /** These log lines precede the run itself, so there is no run id to attach yet. */
  private emit(workflow: WorkflowDefinition, message: string): void {
    this.webContentsProvider()?.send("workflow:event", {
      type: "workflow:log",
      workflowId: workflow.id,
      workflowRunId: "",
      message,
      timestamp: new Date().toISOString(),
    } satisfies WorkflowEvent);
  }

  private emitDetached(message: string): void {
    this.webContentsProvider()?.send("workflow:event", {
      type: "workflow:log",
      workflowId: "",
      workflowRunId: "",
      message,
      timestamp: new Date().toISOString(),
    } satisfies WorkflowEvent);
  }
}

/** A `git-push` trigger's parsed `detail`; both fields absent means "watch HEAD". */
export type RefTrigger = { branch?: string; remote?: string };

/**
 * Reads a `git-push` trigger's `detail` field.
 *
 * `detail` is free text for backward compatibility, so this accepts what users
 * plausibly typed rather than demanding a schema: a bare branch (`main`), a
 * remote-qualified ref (`origin/main`), or `key=value` pairs
 * (`branch=main, remote=origin`). Anything unparseable degrades to watching HEAD,
 * which is the behaviour of an unconfigured trigger.
 */
export function parseRefTrigger(detail?: string | null): RefTrigger {
  const text = detail?.trim();
  if (!text) return {};

  if (text.includes("=")) {
    const config: RefTrigger = {};
    for (const part of text.split(/[,\n]/)) {
      const [rawKey, ...rest] = part.split("=");
      const key = rawKey?.trim().toLowerCase();
      const value = rest.join("=").trim();
      if (!key || !value) continue;
      if (key === "branch" || key === "ref") config.branch = value;
      else if (key === "remote") config.remote = value;
    }
    return config;
  }

  // `origin/main` is the shape people write for "the pushed branch", so treat a
  // single slash as remote/branch rather than as a branch literally named that.
  const slash = text.indexOf("/");
  if (slash > 0 && !text.includes(" ")) {
    return { remote: text.slice(0, slash), branch: text.slice(slash + 1) };
  }

  return { branch: text };
}

/**
 * A short, safe description of a delivery for the run log.
 *
 * Only the shape is reported, never the contents: a webhook body routinely carries
 * tokens and customer data, and the run log is rendered in the UI and persisted.
 */
function describePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return " (empty body)";
  if (typeof payload === "string") return ` (${payload.length} bytes of text)`;
  if (Array.isArray(payload)) return ` (array of ${payload.length})`;
  if (typeof payload === "object") {
    const keys = Object.keys(payload as Record<string, unknown>);
    return keys.length ? ` (JSON keys: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? "…" : ""})` : " (empty JSON)";
  }
  return "";
}

function normalizeFilter(filter: string): string {
  return filter.trim().replace(/^\.\//, "").replaceAll("\\", "/");
}

function fileChangeFilterMatches(filter: string, relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (filter.includes("*")) return globLikeMatch(filter, normalized);
  return normalized === filter || normalized.startsWith(`${filter}/`) || normalized.includes(filter);
}

function globLikeMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}
