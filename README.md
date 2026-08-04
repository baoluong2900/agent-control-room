# Agentic Workspace

Local-first Electron desktop app for coordinating AI CLI agents across project folders.

This repo now follows the Phase 1 direction in [image/phase_1.md](image/phase_1.md): Electron + React + TypeScript, secure preload IPC, local CLI/process control, 3D agent map, realtime terminal output, local SQLite history, and Git diff inspection.

## Requirements

- Node.js `>=22.13.0`
- Git on PATH
- Optional agent CLIs on PATH:
  - `claude`
  - `kiro`
  - `codex`
  - `gemini`
- Optional Docker on PATH for diagnostics

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

## Desktop app shape

```text
src/
├── main/       Electron main process, IPC, CLI process manager, SQLite, Git
├── preload/    contextBridge API exposed as window.agentic
├── renderer/   React UI, 3D workspace map, terminal, controls
└── contracts/  Shared IPC and domain types

forge.config.ts Electron Forge packaging config
```

For review/navigation, start with [docs/source-map.md](docs/source-map.md). It maps each feature to its renderer entry, backend service, shared contract, and tests, and marks generated folders that should not be reviewed as source.

## Phase 1 implemented

- Select a project folder through the native desktop dialog.
- Auto-detect Claude, Kiro, Codex, Gemini, Git, and Docker from PATH.
- Create/run an agent with a selected CLI and model label.
- Send task prompts to CLI processes through the Electron main process.
- Stream stdout/stderr/events to an embedded xterm terminal.
- Start, stop, and cancel an active agent run.
- Display agent state on a React Three Fiber 3D workspace map.
- Persist project/task run history in local SQLite under Electron userData.
- Inspect current Git branch, status, and diff stat for the selected folder.
- Persist task records in local SQLite and run investigations from saved tasks
  or starter templates.
- Split a large request into scheduled subtasks with difficulty/ETA scoring,
  assigned AI CLIs, and automatic due-time execution.
- Manage a separate local app identity plus AI provider connection records in
  `Settings`, with provider links stored locally and agent profiles able to
  point at a saved connection.

## AI Agents (Agents page)

The `Agents` nav item is a full local agent manager. Everything on it is driven by
real data from your machine — no mock agents.

- **CLI catalog with live ping.** 13 terminal agents are known out of the box:
  Kiro CLI (`kiro-cli`), Claude Code, Codex, Gemini, Agy, Grok Build, Amazon Q,
  Aider, OpenCode, Cursor Agent, GitHub Copilot CLI, Qwen Code, Ollama, plus raw
  Shell and a Custom CLI escape hatch. Each is resolved on PATH, version-checked,
  and timed (`Ping all CLIs`).
- **Model picker per CLI.** Models come from the catalog, or from the CLI itself
  when it can list them (`ollama list`, `grok models`, `aider --list-models`). Any
  model id can be typed by hand. The footer previews the exact command that will
  run.
- **Agent profiles.** Name, role, CLI, model, working folder, system prompt,
  extra args, command override, interactive mode, force-TTY, auto-approve. Saved
  in local SQLite with per-agent run stats (success rate, tasks, total time).
- **Interactive terminal per agent.** xterm panel streaming stdout/stderr in
  real time, with stdin so you can answer prompts, send `Ctrl+C`, stop the run,
  or keep chatting with a live session.
- **Live monitoring.** Platform overview counters, activity feed from process
  events, 7-day performance chart, and resource rings are derived from saved
  profiles, live sessions, CLI pings, and real run history.

Command shapes the app builds (verified against the installed CLIs):

```text
kiro-cli chat --no-interactive --model claude-sonnet-4-5 "<task>"
claude -p --model sonnet "<task>"
codex exec -m gpt-5-codex "<task>"
agy -p "<task>"
grok --model grok-4.5 "<task>"
```

Interactive mode drops the one-shot flags and sends the prompt on stdin, keeping
the process alive for follow-up input.

### Verifying the agent runtime

```bash
npm run verify:agents        # catalog, arg parsing, ping, profiles, SQLite stats
npm run verify:agents:proc   # spawn, stream, stdin, stop, error handling
npm run verify:agents:ui     # Electron UI: create agent → run → terminal output
```

Add `AGENTIC_REAL_CLI=claude|kiro|agy|codex` to `verify:agents:proc` to drive a
real AI CLI end to end.

## Workflows (Workflows page)

The `Workflows` nav item is a full local workflow builder modeled on
[image/workflow.png](image/workflow.png). Each workflow is a sequence of steps,
and every step is an **AI agent task** you configure: what the agent does
(`investigate`, `analyze`, `review`, `execute`, `test`, `deploy`, `notify`,
`approval`, …), which CLI runs it, the model, the instruction/prompt, timeout,
approval gate, continue-on-error, and enabled flag. Steps can be added, removed,
and reordered.

The page reproduces the reference: four stat cards, a filter/sort toolbar, a
workflow table (Workflow · Trigger · Stages · Owner/Agents · Runs · Success Rate
· Status · Last Run), pagination, a live activity feed, and a detail panel with
Overview / Runs / Steps / Logs tabs. Workflows are persisted in local SQLite and
can be run, cancelled, duplicated, exported/imported as JSON, paused/activated,
and deleted. Runs execute each step's CLI/shell process, streaming output to the
Logs tab. A missing CLI is recorded as a failed step with the concrete PATH
error so workflow results stay tied to the local machine. Seed workflows are
templates only; run counts, success rates, recent activity, and last-run fields
come from recorded workflow runs.

## Tasks (Tasks page)

The `Tasks` nav item now uses the local SQLite `tasks` table instead of a fixed
renderer array. The starter cards are templates: choosing Investigate or marking
a status first saves a task record for the selected project path, then updates
that persisted record. The page's stat strip, filters, status pills, recent run
history, and 24-hour throughput chart are derived from stored task records and
agent run history.

Tasks also have a local scheduler. Paste a requirement, choose a due time and
lead CLI, and the app creates a parent task plus staggered subtasks with
difficulty, ETA, agent assignment, and automation metadata. The Electron main
process polls due tasks, starts the assigned local agent, links the agent run
back to the task, and marks the task done or blocked from the process result.

### Testing the workflow engine

```bash
npm test                     # typecheck + workflow unit tests
npm run test:workflows       # node:test suite only (SQLite repository + UI helpers)
```

The suite runs against the real `WorkflowRepository` on an in-memory
`node:sqlite` database and the renderer formatter/label helpers. TypeScript is
executed directly via a small loader in `tests/support/` that uses the
already-installed `typescript` package (no extra dependency).

## Security model

The renderer does not receive direct Node.js access. Electron is configured with:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Privileged operations are exposed only through the preload API:

```ts
window.agentic.projects.selectFolder()
window.agentic.system.diagnostics()
window.agentic.agents.catalog()
window.agentic.agents.ping(cliId)
window.agentic.agents.models(cliId)
window.agentic.agents.saveProfile(profile)
window.agentic.agents.start(input)
window.agentic.agents.send(runId, data)
window.agentic.agents.stop(runId)
window.agentic.settings.getIdentity()
window.agentic.settings.saveIdentity(input)
window.agentic.settings.listProviderConnections()
window.agentic.settings.saveProviderConnection(input)
window.agentic.settings.deleteProviderConnection(id)
window.agentic.settings.openProviderAuth(input)
window.agentic.git.diff(cwd)
window.agentic.tasks.plan(input)
window.agentic.tasks.runDue()
```

Provider secrets use a local encrypted vault file, while the SQLite database
stores connection metadata and token references only.

## Packaging

```bash
npm run make:windows
npm run make:macos
npm run make:linux
```

Electron Forge is configured with makers for Windows Squirrel, macOS ZIP, Linux DEB, and Linux RPM.

## Legacy web fallback

The previous Next/Vinext starter dashboard and Cloudflare/D1 examples have been
removed so the repo has a single supported runtime: the Electron desktop app.
There is no `app/` directory and no web fallback page;
`tests/rendered-html.test.mjs` asserts the starter files stay deleted and that
`next`, `vinext`, `drizzle-orm`, and `wrangler` stay out of `package.json`. The
shared visual baseline lives with the renderer at
`src/renderer/globals.css`, imported by `renderer/styles.css`.
