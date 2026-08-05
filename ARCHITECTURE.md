# Architecture — Agentic Workspace

Local-first Electron desktop app that turns the AI coding CLIs already installed on your
machine (`claude`, `codex`, `gemini`, `kiro-cli`, `aider`, `ollama`, …) into a single managed
workspace: agent profiles, workflows, scheduled tasks, a code-knowledge index, and Git
inspection — all persisted locally in SQLite. No hosted backend, no telemetry, no account.

This document describes what the code actually does today. Where the runtime is narrower than
the UI copy suggests, it says so — the full gap list is
[docs/unfinished-features.md](docs/unfinished-features.md).

---

## 1. Process model

Electron's three contexts are kept strictly separated, and the renderer has no Node access.

```text
┌─────────────────────────────────────────────────────────────────┐
│ Renderer (React 19 + Zustand + R3F)          sandbox: true      │
│   no require(), no fs, no child_process                         │
└───────────────────────────┬─────────────────────────────────────┘
                            │ window.agentic.*   (typed, allow-listed)
┌───────────────────────────▼─────────────────────────────────────┐
│ Preload (src/preload/preload.ts)                                │
│   contextBridge.exposeInMainWorld — ipcRenderer.invoke only     │
└───────────────────────────┬─────────────────────────────────────┘
                            │ ipcMain.handle
┌───────────────────────────▼─────────────────────────────────────┐
│ Main process (src/main/**)                                      │
│   services · schedulers · node:sqlite · child_process · git     │
└─────────────────────────────────────────────────────────────────┘
```

`src/main/windows/main-window.ts` sets `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. The preload exposes a hand-written API object — there is no generic
"invoke any channel" escape hatch, so the renderer's privileges are exactly the methods
listed in `AgenticDesktopApi` (`src/contracts/ipc.ts`).

**Shared contracts.** `src/contracts/` is imported by all three contexts, so the IPC surface
is one type-checked definition rather than three drifting copies. `npm run typecheck` covers
`src/`, `scripts/`, and `tests/` together, which is what makes a channel rename a compile
error instead of a runtime `undefined`.

---

## 2. Module map

| Layer | Path | Responsibility |
| --- | --- | --- |
| Bootstrap | `src/main/main.ts` | PATH repair, DB open, service wiring, scheduler start/stop, quit path |
| IPC | `src/main/ipc/register-ipc.ts` | Every renderer-callable operation in one file |
| Agent runtime | `src/main/processes/agent-process-manager.ts`, `process-tree.ts` | Spawn/stream/stop CLI agents, concurrency queue, kill escalation |
| CLI knowledge | `src/main/agents/` | Catalog of 13 CLIs, argv builder, PATH resolution, version probe, provider env |
| Workflows | `src/main/workflows/` | Multi-step execution, approval gates, step chaining, schedule parsing |
| Tasks | `src/main/tasks/` | Heuristic planner, due-task scheduler, retry policy |
| Knowledge | `src/main/knowledge/` | Incremental repo scan, TS AST parsing, tsconfig aliases, ranked search |
| Persistence | `src/main/database/` | `node:sqlite` schema, versioned migrations, log retention |
| Settings | `src/main/settings/` | App identity, provider connections, `safeStorage` secret vault |
| Git | `src/main/git/git-service.ts` | diff / file-diff / log / stage / unstage / commit |
| UI | `src/renderer/<feature>/` | One folder per feature: `<Feature>Module.tsx` + `<feature>.css` |

Renderer state is two Zustand stores: `workspace-store.ts` (selected project, diagnostics,
git/task state) and `agents-store.ts` (catalog, profiles, live sessions, terminal events).

---

## 3. Agent execution

Every agent run goes through `AgentProcessManager.start()`, which is the only place a child
process is created for an agent.

```text
AgentRunInput ─▶ buildInvocation()      resolve CLI on PATH, build argv, apply options
              ─▶ resolveProviderEnv()   inject provider creds from the encrypted vault
              ─▶ spawn(exe, args[])     never a shell string
              ─▶ stdout/stderr ─▶ AgentEvent ─▶ webContents.send ─▶ xterm
              ─▶ exit ─▶ SQLite run record + per-agent stats
```

**No shell interpolation.** `spawn()` is always called as `spawn(executable, args[])` with
`windowsHide`, never with `shell: true` and never with a concatenated command string. A task
prompt containing `; rm -rf ~` is passed as one argv element, so it cannot break out into the
shell. This holds for all four spawn sites: agent runs, workflow steps, CLI pings, and
diagnostics.

**Concurrency is real.** `MAX_CONCURRENT_RUNS = 3`; excess runs sit in a `queued` list and
`drainQueue()` releases them as slots free. The interesting part is the *spawn window*: an
earlier version shifted a run off the queue and then awaited `buildInvocation()`, during
which the run existed in neither `queued` nor `running` — so it counted against no limit,
vanished from the session list, and `stop()` silently did nothing while an orphan child was
still on its way up. That is now closed by a `spawning` map, with
`activeCount() = running.size + spawning.size` gating admission and `cancelledSpawns`
recording a stop that arrives mid-spawn.

**Stopping is a fact, not a claim.** `process-tree.ts` snapshots the pid/ppid table *before*
signalling — once the root dies its children are re-parented and the link identifying them is
gone — sends `SIGTERM`, then escalates to `SIGKILL` after a grace period (`taskkill /F /T` on
Windows). Descendants are reaped deepest-first, since killing a parent before its children is
exactly what creates the orphans the function exists to prevent. Bookkeeping is retained
until exit is confirmed, and a `terminating` set keeps a dying run out of both the
concurrency count and the session list.

**Shutdown ordering.** `before-quit` stops schedulers, signals children, and closes the DB —
but signalled CLIs keep printing for up to the full grace period, and that late stdout used
to reach an already-closed database handle and throw `database is not open` from inside a
stream callback. Every async DB writer in the manager now checks a `shuttingDown` guard.

---

## 4. Data and storage

Everything lives under Electron's `userData` directory:

```text
userData/
├── agentic-workspace.sqlite   projects, tasks, agent profiles/runs, terminal logs,
│                              workflows/runs/steps, settings, knowledge snapshots
└── provider-secrets.json      safeStorage-encrypted values, keyed by reference
```

**Migrations.** `src/main/database/migrations.ts` owns a `schema_migrations` table and applies
each version inside a transaction with rollback. `tests/database-migrations.test.ts` opens
legacy snapshots to pin the upgrade path. Workflow tables still carry some legacy
additive-column bootstrapping in `workflow-repository.ts`; consolidating it is tracked as DB1.

**Secrets.** `ProviderSecretVault` refuses to write unless
`safeStorage.isEncryptionAvailable()`, stores ciphertext as base64, and hands back an opaque
`provider-secret:<uuid>` reference. SQLite stores only that reference — never the secret. The
`SecretStorage` dependency is injected rather than imported, which is what lets the vault be
unit-tested outside a running Electron process.

**Log growth is bounded.** Terminal output is truncated per message with a visible marker,
pruned per run, and old finished-run logs are cleaned at startup — a chatty long-running
agent cannot grow the database without limit.

---

## 5. Knowledge index

`KnowledgeService.scan()` walks the selected project under explicit caps
(`maxFiles` 20–5,000, `maxFileBytes` 20KB–1MB) with an ignore list for `node_modules`, build
output, and VCS directories.

- **Incremental** — per-file hash/mtime means an unchanged file is not re-read.
- **AST-based for TypeScript** — imports/exports/symbols come from the TypeScript compiler
  API, with `tsconfig` path aliases (`@contracts`) resolved properly; regex remains the
  fallback for other languages.
- **Cancellable with progress** — scans emit `knowledge:progress` and can be cancelled by id.
- **Honest about truncation** — the snapshot records files seen vs indexed, skip reasons,
  dropped graph nodes/edges, and the largest skipped files. A bounded slice is labelled as a
  bounded slice, and the UI offers a raise-the-caps rescan.
- **Ranked search in the main process**, so scoring is not re-implemented in the renderer.

---

## 6. Workflows and tasks

**Workflows** are ordered steps, each an agent task with its own CLI, model, prompt, timeout,
approval gate, and continue-on-error flag. `executeSteps()` accumulates outcomes and
interpolates `{{previous.output}}` / `{{steps.<id|name>.output}}` into later prompts; steps
without a placeholder still receive the prior step's context, so existing workflows chain
automatically. Approval gates park run state in `pendingApprovals` and survive the wait with
their context intact. A missing CLI is recorded as a failed step with the concrete PATH error
rather than a generic failure.

Triggers are gated by what actually runs: `manual` and `schedule` execute, `file-change` has
a local runner with debounce and self-loop protection, and `git-push` / `issue-created` /
`webhook` are disabled with an explanation because no listener exists yet. Seed workflows are
templates — run counts and success rates come only from recorded runs.

**Tasks** paste a requirement, pick a due time and lead CLI, and get a parent task plus
staggered subtasks with difficulty, ETA, and agent assignment. The main process polls due
tasks, starts the assigned agent, links the run back to the task, and settles it from the
process result, with `attemptCount` / `lastError` / `nextRetryAt` driving retry.

> **The planner is heuristic, not an LLM.** `buildTaskPlan()` scores difficulty from word
> count, keyword hits, and sentence count, then emits a fixed Investigate → Plan → Execute →
> Verify → Review shape. It does not read your codebase. Steps are assigned only to CLIs
> actually installed. "AI planning from project context" is a planned feature (T1).

---

## 7. Verification

```bash
npm run typecheck        # tsc --noEmit over src/, scripts/, tests/
npm test                 # typecheck + the node:test suite
npm run test:workflows   # the suite alone
```

**Current status: 243/243 passing, typecheck clean, `npm audit` 0 vulnerabilities.**

29 suites run against the real repository classes on in-memory `node:sqlite` — not mocks.
TypeScript executes directly through a small loader in `tests/support/` built on the
already-installed `typescript` package, so the suite adds no test-runner dependency.

Coverage worth calling out, because these are the paths that broke before:
`agent-process-lifecycle`, `agent-spawn-failure`, `process-kill-escalation`,
`database-migrations` (legacy snapshots), `log-retention`, `workflow-approval`,
`task-retry-policy`, `knowledge-incremental`, `knowledge-ast`.

Test files are enumerated in `package.json` → `test:workflows`. **A new test file must be
added there or it will never run.**

Beyond unit tests, `scripts/*-harness.ts` boot a real Electron instance to drive whole flows
(create agent → run → terminal output; task navigation; provider settings) and capture
screenshots:

```bash
npm run verify:agents        # catalog, argv parsing, ping, profiles, SQLite stats
npm run verify:agents:proc   # spawn, stream, stdin, stop, error handling
npm run verify:agents:ui     # Electron UI end-to-end
```

Add `AGENTIC_REAL_CLI=claude|kiro|agy|codex` to drive a real CLI end to end.

CI (`.github/workflows/desktop-build.yml`) typechecks and packages on
windows/macos/ubuntu with `fail-fast: false`, so one platform's packaging break does not mask
the others.

---

## 8. Threat model

The app runs local CLIs against local folders, so the honest framing is: **it is as trusted as
the CLIs you install and the folders you point it at.**

| Concern | Position |
| --- | --- |
| Renderer → Node escape | Blocked: sandbox + contextIsolation, no `nodeIntegration`, allow-listed preload API |
| Shell injection via prompts | Blocked: `spawn(exe, args[])` everywhere, never `shell: true` |
| Secrets at rest | `safeStorage`-encrypted vault file; SQLite holds references only |
| Git write operations | Deliberately local-only — stage/unstage/commit exist, `push` does not |
| Path traversal in Git file ops | Relative paths only; absolute and `../` are rejected |
| Outbound network | None from the app itself; only what the CLIs you run choose to do |
| Arbitrary command execution | **By design** — a Custom CLI / Shell agent runs what you configure. Treat a workflow definition as executable code and review imported JSON before running it. |

Residual gaps, stated plainly: no OS keychain item per secret, no rotation or audit trail, no
file-permission validation on the vault, and provider "verification" checks credential
presence plus CLI availability locally rather than calling provider APIs. OAuth/device modes
open an external login page — the app does not complete a token exchange (S1).

---

## 9. Known limitations

| Area | Reality today |
| --- | --- |
| Task planner | Heuristic scoring, not LLM planning |
| Remote triggers | `git-push` / `issue-created` / `webhook` gated, no listener |
| Provider OAuth | Opens external URL; no callback or device-code exchange |
| AI gateway (`docs/aiagnet.md`) | **Proposal only** — no sidecar, no `/v1` endpoint. `baseUrl` can point at a router you run yourself |
| Agent pause/resume | Out of scope; `SIGSTOP` mid-stream leaves a dead provider connection |
| Structured chat resume | Claude and Agy only |
| Diagnostics | CLI presence/version; not auth, quota, or DB health |
| Git | No branch/push/pull/stash/blame/conflict tooling |
| TopBar search | Navigation launcher, not code/task search |

Files that deserve a refactor before they grow further: `src/renderer/agents/agents.css`
(3,151 lines), `src/main/database/desktop-database.ts` (1,606),
`src/main/knowledge/knowledge-service.ts` (1,128), `src/renderer/agents/AgentsPage.tsx` (1,122).

---

## 10. Reading order

1. `src/contracts/index.ts` — the domain types
2. `src/preload/preload.ts` + `src/main/ipc/register-ipc.ts` — the full privilege boundary
3. `src/main/main.ts` — how services are wired and torn down
4. One feature row from [docs/source-map.md](docs/source-map.md)
5. The matching suite in `tests/`
