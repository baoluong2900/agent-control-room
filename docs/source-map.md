# Source map — Agentic Workspace

Tài liệu này là bản đồ review source. Mục tiêu: nhìn vào đây là biết module nào làm chức năng gì, nên đọc file nào trước, và file nào chỉ là support/test/generated.

## Runtime chính

```text
src/
├── contracts/   Kiểu dữ liệu + IPC contract dùng chung giữa main/preload/renderer
├── main/        Electron main process: database, process, workflows, schedulers, IPC
├── preload/     Cầu nối an toàn contextBridge -> window.agentic
└── renderer/    React UI + Zustand stores + CSS theo từng feature
```

Các file ngoài `src/`:

```text
docs/      Ghi chú thiết kế, kế hoạch nâng cấp, source map này
scripts/   Harness chạy app/Electron thật để verify luồng lớn
tests/     Unit/integration tests bằng node:test + SQLite thật/in-memory
public/    Asset tĩnh copy vào renderer build
image/     Asset/reference thiết kế đang được track
```

Các thư mục build/local như `.verify/`, `.vite/`, `dist/`, `out/`, `src/renderer/dist/`, `src/renderer/.vite/`, `.wrangler/`, `.vinext/`, `.pytest_cache/` là artifact sinh ra khi chạy build/test/dev và đã nằm trong `.gitignore`. Không review chúng như source.

## Review theo feature

| Feature/module | Renderer entry | Main/backend entry | Contract/test nên đọc |
| --- | --- | --- | --- |
| App shell + navigation | `src/renderer/App.tsx`, `src/renderer/workspace-navigation.ts`, `src/renderer/components/Sidebar.tsx`, `src/renderer/components/TopBar.tsx` | `src/main/main.ts`, `src/main/windows/main-window.ts` | `src/contracts/ipc.ts` |
| Agents page/profile/run | `src/renderer/agents/AgentsPage.tsx`, `AgentBuilderModal.tsx`, `AgentTerminal.tsx`, `src/renderer/stores/agents-store.ts` | `src/main/agents/catalog.ts`, `commands.ts`, `path-env.ts`, `provider-runtime-env.ts`, `src/main/processes/agent-process-manager.ts`, `src/main/database/desktop-database.ts` | `src/contracts/agent.ts`, `agent-options.ts`, `tests/agent-process-lifecycle.test.ts`, `tests/agent-path-env.test.ts`, `tests/provider-runtime-env.test.ts` |
| Workflows | `src/renderer/workflows/WorkflowsModule.tsx`, `WorkflowDetailPanel.tsx`, `WorkflowEditorDrawer.tsx`, `workflow-ui.ts` | `src/main/workflows/workflow-service.ts`, `workflow-scheduler.ts`, `workflow-schedule.ts`, `workflow-seeds.ts`, `src/main/database/workflow-repository.ts` | `src/contracts/workflow.ts`, `tests/workflow-*.test.ts` |
| Tasks + automation | `src/renderer/tasks/TasksModule.tsx` | `src/main/tasks/task-planner.ts`, `task-automation-service.ts`, `src/main/database/desktop-database.ts` | `src/contracts/task.ts`, `tests/task-automation.test.ts`, `tests/shell-navigation.test.ts` |
| Knowledge | `src/renderer/knowledge/KnowledgeModule.tsx` | `src/main/knowledge/knowledge-service.ts`, `src/main/database/desktop-database.ts` | `src/contracts/knowledge.ts`, `tests/knowledge-service.test.ts` |
| Settings/providers | `src/renderer/settings/SettingsModule.tsx`, `provider-catalog.ts`, `provider-compat.ts` | `src/main/settings/settings-service.ts`, `provider-secret-vault.ts`, `src/main/database/desktop-database.ts` | `src/contracts/settings.ts`, `tests/settings-service.test.ts` |
| Projects/git diagnostics | `src/renderer/projects/ProjectsModule.tsx`, `src/renderer/components/GitDiffPanel.tsx`, `DiagnosticsPanel.tsx` | `src/main/projects/project-service.ts`, `src/main/git/git-service.ts`, `src/main/ipc/diagnostics.ts` | `src/contracts/project.ts`, `src/contracts/system.ts`, `tests/git-service.test.ts` |
| 3D workspace map | `src/renderer/map/*`, `src/renderer/agents/AgentRobotArena.tsx`, `AgentFace.tsx` | none, UI-only except data from stores | `src/renderer/map/scene-config.ts`, `src/renderer/map/agent-nav.ts` |
| Analytics/integrations placeholders | `src/renderer/analytics/AnalyticsModule.tsx`, `src/renderer/integrations/IntegrationsModule.tsx` | currently UI/data-light | CSS beside each module |

## Backend call graph

```text
renderer React
  -> window.agentic (declared in src/renderer/global.d.ts)
  -> preload contextBridge (src/preload/preload.ts)
  -> ipcMain handlers (src/main/ipc/register-ipc.ts)
  -> services/repositories (src/main/**)
  -> SQLite / child_process / git / local filesystem
```

Important backend hubs:

- `src/main/main.ts`: app bootstrap, window lifecycle, service wiring, scheduler start/stop.
- `src/main/ipc/register-ipc.ts`: one place to see every renderer-callable operation.
- `src/preload/preload.ts`: one place to see the safe public API exposed to UI.
- `src/main/database/desktop-database.ts`: app database schema and repositories for projects/tasks/agents/settings/knowledge.
- `src/main/database/workflow-repository.ts`: workflow-specific persistence.
- `src/main/processes/agent-process-manager.ts`: starts/stops CLI agents and streams events.

## Frontend organization

Pattern hiện tại của renderer:

```text
src/renderer/<feature>/<FeatureModule>.tsx
src/renderer/<feature>/<feature>.css
```

Global/layout CSS lives in:

- `src/renderer/globals.css`: canonical design tokens and base app surface.
- `src/renderer/styles.css`: renderer import hub and shell-level styles.
- Feature CSS files: local module surfaces. Existing final override layers carry layout; recolor in place instead of deleting blindly.

State:

- `src/renderer/stores/workspace-store.ts`: selected project, diagnostics, git/task state shared across shell modules.
- `src/renderer/stores/agents-store.ts`: agent catalog, profiles, live sessions, terminal events, stats.

## Test and verify map

| Command | Scope |
| --- | --- |
| `npm run typecheck` | Whole TypeScript project including `src/`, `scripts/`, and `tests/` per current tsconfig |
| `npm run test:workflows` | Enumerated node:test suite in `package.json`; add new test files there or they will not run |
| `npm test` | Typecheck + node:test suite |
| `npm run verify:agents` | Backend/catalog/profile harness |
| `npm run verify:agents:proc` | Real process lifecycle harness |
| `npm run verify:agents:ui` | Electron UI agent flow harness |
| `npm run verify:tasks:ui` | Electron UI task navigation harness |

## Files that currently deserve refactor attention

These are still source, not generated clutter. Review them first when planning a cleanup split:

| File | Why it feels heavy | Safe next split direction |
| --- | --- | --- |
| `src/renderer/agents/agents.css` | Largest CSS file; mixes dashboard, builder, terminal, robot/arena styling | Split by page/panel: `agents-page.css`, `agent-builder.css`, `agent-terminal.css`, arena styles |
| `src/renderer/globals.css` | Design tokens + global shell + final overrides in one file | Keep tokens/base here; move shell-only rules to `styles.css` only after visual diff |
| `src/renderer/tasks/TasksModule.tsx` + `tasks.css` | Tasks page combines planning form, list, scheduler UI, chart styles | Extract presentational cards/table/form components before logic changes |
| `src/renderer/agents/AgentsPage.tsx` + `AgentRobotArena.tsx` | Large UI components with multiple panels | Extract small pure panels first; keep store calls in container |
| `src/main/database/desktop-database.ts` | One database class handles many app domains | Split repository classes only after preserving schema migration helpers/tests |
| `src/main/workflows/workflow-service.ts` | Workflow execution, status updates, and logs are together | Extract step execution helper after workflow tests cover timeout/cancel paths |
| `src/main/knowledge/knowledge-service.ts` | Indexing/search/scoring responsibilities are together | Extract parsing/scoring helpers with current tests as guardrails |

## Suggested review order

1. `src/contracts/index.ts` to understand exported domain types.
2. `src/preload/preload.ts` and `src/main/ipc/register-ipc.ts` to understand API boundaries.
3. One feature row from the table above.
4. Matching tests in `tests/`.
5. Matching CSS only after behavior is clear.

## Current cleanup baseline

After deleting ignored generated artifacts, the source tree should not contain build output under `src/renderer/.vite` or `src/renderer/dist`. If those folders reappear, they are local artifacts from Vite/Electron and can be removed again without affecting tracked source.
