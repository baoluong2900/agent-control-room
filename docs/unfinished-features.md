# Các chức năng còn chưa hoàn thiện — Agentic Workspace

Tài liệu này ghi lại các khoảng trống chức năng đã được xác nhận bằng cách đọc source hiện tại. Mục tiêu không phải là chê toàn bộ app: nhiều phần đã có implementation thật như IPC bridge, lưu SQLite, agent process lifecycle, workflow run/approval, task scheduler, encrypted provider secret vault. Những mục dưới đây là các chỗ UI/contract/README đang hứa rộng hơn phần runtime hiện có.

Ngày ghi nhận: 2026-08-04.

Cập nhật 2026-08-05: xem `docs/audit-2026-08-05.md` cho bản rà soát mới nhất. Bản đó
ghi lại một bug thật đã tìm ra và sửa (run bị "vô hình" trong lúc spawn, khiến
`stop()` không có tác dụng và concurrency limit bị vượt), cùng phần verify lại từng
gap dưới đây bằng grep source ngày 2026-08-05.

Cập nhật bổ sung cùng ngày: các kế hoạch triển khai chi tiết đã được tách thành từng file trong `docs/feature/`, bắt đầu từ `docs/feature/README.md`. Một số gap trong bản ghi ban đầu đã được thu hẹp sau commit `0a434f1` (`feat: add schema migrations, provider verification, and step chaining`): app database đã có `schema_migrations`, provider verification backend đã có, và workflow step chaining / profile binding backend đã có. Các mục dưới đây giữ vai trò báo cáo gap; kế hoạch code cụ thể nằm trong `docs/feature/*.md`.

## Tóm tắt ưu tiên

| Mức | Khu vực | Vấn đề chính | Hướng xử lý ngắn |
| --- | --- | --- | --- |
| P0 residual | Workflows | Unsupported remote triggers are gated/warned; `file-change` has a local runner, but true remote `git-push`, `issue-created`, and `webhook` automation still need architecture. | Keep remote triggers disabled/warned until adding ref polling/API polling/local webhook service. |
| P0 residual | Provider connections | Local verification is wired and Connect no longer self-claims `connected`; OAuth/device remains open-external/manual, not token exchange. | Keep copy honest or implement callback/device-code auth as a separate feature. |
| P1 | Knowledge | CodeGraph is still full rescan + regex heuristic; truncation reporting now exists for caps/skips/drops. | Use current report to guide incremental scanner and parser work. |
| P1 residual | Git | Patch viewer, log, stage/unstage, and commit now exist; branch/push/pull/stash/blame/conflict tooling remains future work. | Keep expanding operations by reversibility: stash/log details next, push only with explicit outbound confirmation. |
| P2 | Tasks | “Plan” là heuristic trong code, không dùng AI/LLM dù UI mô tả khá thông minh. | Đổi copy thành heuristic scheduler hoặc thêm planner agent thật. |
| P2 residual | Agents | Restart + concurrency queue landed; pause/resume and SIGTERM escalation/tree-kill remain hardening gaps. | Add kill escalation tests/implementation; keep pause only for CLIs with explicit support. |
| P2 | AI gateway docs | `docs/aiagnet.md` mô tả 9Router/CLIProxyAPI sidecar, nhưng runtime/package hiện chưa có router process hoặc `/v1` endpoint. | Gắn nhãn tài liệu này là proposal, hoặc implement gateway sidecar thật. |

## Đã sửa (2026-08-04): workflow step ↔ agent connection

Ba khoảng trống dưới đây đã được implement, ghi lại ở đây vì chúng là nguyên nhân chính của cảm giác “agent không có connection, không nối được với nhau”:

1. **Workflow step giờ nhận credential thật.** Trước đây `spawnStep()` chỉ merge `{ ...process.env, FORCE_COLOR }`, nên profile/provider connection user cấu hình trong Agent Builder không hề tới workflow. Nay cả hai đường spawn đều đi qua `resolveProviderEnv()` tại `src/main/agents/provider-resolver.ts`. `WorkflowStepDefinition` có thêm `profileId` và `providerConnectionId` (`src/contracts/workflow.ts`), chọn được trong editor.
2. **Step truyền output cho nhau.** `executeSteps()` tích luỹ `WorkflowStepOutcome[]` và interpolate qua `applyStepContext()` tại `src/main/workflows/step-context.ts`, hỗ trợ `{{previous.output}}` và `{{steps.<id|name>.output}}`. Step không có placeholder vẫn được append context của step trước, nên workflow cũ tự động chain. Context sống sót qua approval gate vì được park cùng `PendingApproval`.
3. **Provider connection có `baseUrl`.** Đủ để đấu proxy/router: `buildProviderRuntimeEnv()` set `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` (+ biến thể `_API_BASE`/`_API_URL`) khi connection có endpoint. Field này chỉ hiện cho provider mà CLI thật sự đọc env đó, xem `supportsBaseUrl()` tại `src/renderer/settings/provider-catalog.ts`.

Lưu ý về mục R1 bên dưới: `baseUrl` cho phép **trỏ tới** một router đang chạy, nhưng app vẫn chưa tự spawn/quản lý sidecar 9Router/CLIProxyAPI. Phần đó vẫn là proposal.

Test: `tests/workflow-agent-binding.test.ts`. Migration cho DB cũ: version 4 và 5 trong `src/main/database/migrations.ts`.

## 1. Workflows: unsupported remote triggers are gated; local triggers run

### W1 — Remote triggers still need runners, but UI no longer promises them silently

Status update 2026-08-04:

- `manual` and `schedule` remain supported.
- `file-change` now has a local runner with debounce/ignore/self-loop protection.
- Unsupported remote triggers (`git-push`, `issue-created`, `webhook`) are gated/warned instead of appearing as fully working automation.

Hệ quả còn lại: app vẫn chưa có service nhận sự kiện từ bên ngoài. `git-push` needs local ref polling or hook integration; `issue-created` needs provider polling/webhook + credentials; `webhook` needs an HTTP listener/tunnel/security model.

Việc nên làm tiếp:

1. Keep remote triggers disabled/warned until a runner exists.
2. Add `git-push`/ref-change via local polling if product wants a local-only path.
3. Treat webhook/issue-created as architecture work, not small UI fixes.
4. **Mới phát hiện 2026-08-05:** seed data vẫn quảng cáo trigger chưa chạy được —
   `src/main/workflows/workflow-seeds.ts:108` seed `trigger: { type: "git-push" }` và
   `:180` seed `type: "issue-created"`. UI đã gate/warn nhưng seed thì chưa, nên
   workspace mới vẫn có workflow trông như automation thật. Đổi hai seed này sang
   `manual`/`schedule`.

### W2 — Field `trigger.detail` được lưu nhưng chưa điều khiển runtime

Evidence:

- Contract mô tả `trigger.detail` là context như branch/repo/Jira project tại `src/contracts/workflow.ts:64`.
- Editor lưu `triggerDetail` tại `src/renderer/workflows/WorkflowEditorDrawer.tsx:187`.
- Scheduler chỉ đọc `workflow.trigger.schedule` để parse thời gian tại `src/main/workflows/workflow-scheduler.ts:81`; không đọc `trigger.detail`.
- Workflow run lấy `triggeredBy` từ option hoặc `workflow.trigger.type`, nhưng không dùng `trigger.detail` để lọc branch, repo, issue project, webhook payload tại `src/main/workflows/workflow-service.ts:195` đến `src/main/workflows/workflow-service.ts:199`.

Hệ quả: field Detail hiện chủ yếu là metadata hiển thị/lưu trữ, chưa phải điều kiện trigger thật.

Việc nên làm: định nghĩa schema riêng cho từng trigger thay vì một string tự do, ví dụ `{ branchPattern, pathGlobs }` cho file/git, `{ provider, projectKey }` cho issue, `{ secret, route }` cho webhook.

### W3 — Workflow metrics delta đã được implement

Status update 2026-08-04: repository/service now computes metric deltas from historical windows when enough prior-period data exists, and the renderer shows signed up/down movement only when values are meaningful. This is no longer an unfinished feature; see `docs/feature/done/workflow-metrics-delta.md` for the completed plan.

## 2. Provider connections: “OAuth/device links” chưa có auth flow thật

### S1 — OAuth/device hiện chỉ mở trang ngoài

Evidence:

- Contract có `ProviderConnectionAuthMode = "oauth" | "device" | "api-key"` tại `src/contracts/settings.ts:33`.
- Settings service map provider sang URL tại `src/main/settings/settings-service.ts:12` đến `src/main/settings/settings-service.ts:18`.
- `openProviderAuth()` chỉ gọi `openExternal(url)` và trả `{ opened: true, url }` tại `src/main/settings/settings-service.ts:72` đến `src/main/settings/settings-service.ts:87`.
- Không có callback listener, device-code exchange, token refresh, hay provider SDK trong IPC handlers; save connection vẫn nhận dữ liệu user nhập qua `ProviderConnectionInput`.

Hệ quả: UI có thể gọi đây là OAuth/device link, nhưng app chưa tự hoàn tất đăng nhập hay thu token. User vẫn phải nhập/lưu connection metadata hoặc API key thủ công.

Việc nên làm:

1. Nếu muốn giữ scope nhỏ: đổi wording thành “Open provider login/docs” và chỉ coi connection là local metadata/manual secret.
2. Nếu muốn đúng nghĩa OAuth/device: thêm callback URL/deep link hoặc device-code polling, token exchange, refresh/expiry handling, và trạng thái expired tự động.

### S2 — Provider verification local đã có và Connect không còn tự nhận connected

Status update 2026-08-04:

- Provider verification backend remains local-only by design: it checks vault credential presence and CLI availability; it does not call provider APIs for quota/auth-live checks.
- New/saved connections default to `unverified` unless verification succeeds.
- Renderer Connect/Reconnect no longer hardcodes `status: "connected"`; UI can show `unverified`, `connected`, or `disconnected` with verification detail.

Residual: OAuth/device remains an open-external/manual credential flow. If product wants real OAuth/device auth, add callback/deep-link or device-code exchange as a separate feature.

### S3 — Secrets đã encrypted, nhưng vẫn là local file vault

Evidence tốt đã có:

- `ProviderSecretVault` lưu vào `provider-secrets.json` dưới Electron `userData` tại `src/main/settings/provider-secret-vault.ts:22` đến `src/main/settings/provider-secret-vault.ts:30`.
- Trước khi lưu, service yêu cầu `safeStorage.isEncryptionAvailable()` tại `src/main/settings/provider-secret-vault.ts:35` đến `src/main/settings/provider-secret-vault.ts:37`.
- Secret được encrypt rồi base64 vào JSON tại `src/main/settings/provider-secret-vault.ts:40` đến `src/main/settings/provider-secret-vault.ts:45`.
- SQLite chỉ lưu `tokenReference` qua `saveProviderConnection()` tại `src/main/settings/settings-service.ts:54` đến `src/main/settings/settings-service.ts:63`.

Khoảng trống còn lại: chưa có OS keychain item riêng, rotation, audit trail, hoặc validate quyền file. Đây không phải bug P0 vì secret không bị lưu plaintext raw, nhưng cần ghi rõ trong security docs.

## 3. Knowledge / CodeGraph: scanner còn heuristic, chưa phải index thông minh đầy đủ

### K1 — Scan là full rescan, không incremental

Evidence:

- `KnowledgeService.scan()` luôn gọi `collectFiles(projectPath, maxFiles, maxFileBytes)` rồi đọc/analyze từng file tại `src/main/knowledge/knowledge-service.ts:103` đến `src/main/knowledge/knowledge-service.ts:144`.
- Snapshot được lưu đè qua `this.database.saveKnowledgeSnapshot(snapshot)` tại `src/main/knowledge/knowledge-service.ts:143`.
- Không có watch mode, file hash diff, incremental update, hoặc per-file table trong service.

Hệ quả: project lớn sẽ scan lại toàn bộ trong mỗi lần user bấm scan/export nếu snapshot không có, và không có trạng thái “chỉ update file changed”.

Việc nên làm: lưu per-file hash/mtime, chỉ re-read file changed, và expose progress event cho UI.

### K2 — Symbol/import/export extraction dùng regex, chưa dùng AST/LSP

Evidence:

- Import extraction dùng regex trong `extractImports()` tại `src/main/knowledge/knowledge-service.ts:482` đến `src/main/knowledge/knowledge-service.ts:490`.
- Export extraction dùng regex trong `extractExports()` tại `src/main/knowledge/knowledge-service.ts:493` đến `src/main/knowledge/knowledge-service.ts:504`.
- Symbol extraction dùng regex trong `extractSymbols()` tại `src/main/knowledge/knowledge-service.ts:506` đến `src/main/knowledge/knowledge-service.ts:513`.
- Import resolution chỉ thử các path extension/index phổ biến tại `src/main/knowledge/knowledge-service.ts:531` đến `src/main/knowledge/knowledge-service.ts:550`; chưa hiểu alias TypeScript/Vite như `@contracts` nếu không nằm đúng relative path.

Hệ quả: CodeGraph hữu ích để overview, nhưng chưa đủ tin cậy cho refactor/navigation chính xác, nhất là alias, re-export phức tạp, dynamic import nâng cao, hoặc ngôn ngữ ngoài regex hiện có.

Việc nên làm: thêm parser theo language ưu tiên: TypeScript compiler API cho TS/TSX/JS/JSX, Python `ast`, Go parser/LSP, sau đó fallback regex.

### K3 — Truncation report đã có; cap không còn im lặng

Status update 2026-08-04:

- `KnowledgeSnapshot.truncation` stores `hitFileLimit`, `filesSeen`, `filesIndexed`, skip counts by reason, graph node/edge drops, and largest skipped files.
- `truncation_json` is persisted and old NULL snapshots read safely.
- Knowledge UI surfaces the report and offers an increase-caps rescan action when the file limit is hit.
- Markdown/XML exports include truncation details.

Hệ quả còn lại: với repo lớn, CodeGraph vẫn là bounded slice by design, but the user can now see exactly what was excluded. The remaining Knowledge work is K1/K2: incremental indexing and AST/LSP-grade parsing/resolution.

## 4. Git: Git workspace MVP đã có, còn thiếu thao tác nâng cao

### G1 — Patch/log/stage/commit đã có

Status update 2026-08-04:

- `AgenticDesktopApi.git` now includes `diff`, `fileDiff`, `log`, `stage`, `unstage`, and `commit`.
- Preload and IPC expose the same operations.
- Main service returns refreshed `GitDiffSummary` after write operations so UI refreshes from Git state.
- Stage/unstage/commit are intentionally scoped to local repository state; no outbound `push` was added.

Residual: branch checkout/create, push/pull/fetch, stash, blame, conflict resolution, structured binary/truncated diff metadata, and better missing-git error classification remain future Git workspace work.

Việc nên làm tiếp: add reversible/local operations before outbound ones; treat `push` as a separate plan with explicit confirmation and protected-branch/credential handling.

### G2 — Git panel đã xem được patch từng file

Status update 2026-08-04: `GitDiffPanel` now has Files/Patch/Stat/Log views. File rows are clickable and load `git:fileDiff(cwd, path, staged?)`; the panel also supports staging/unstaging a selected row and committing staged changes. Current patch view renders raw patch text rather than parsed hunk rows with colored gutters, so syntax-highlighted/structured diff rendering remains a UX enhancement rather than a missing runtime capability.

## 5. Tasks: planner/scheduler có thật nhưng còn heuristic và tuyến tính

### T1 — Task planner là heuristic hardcoded, chưa phải AI planning

Evidence:

- `buildTaskPlan()` gọi `estimateDifficulty()`, `estimateMinutes()`, `plannerStepsFor()` trong code local tại `src/main/tasks/task-planner.ts:58` đến `src/main/tasks/task-planner.ts:120`.
- Độ khó dựa trên word count, keyword hits và sentence count tại `src/main/tasks/task-planner.ts:159` đến `src/main/tasks/task-planner.ts:170`.
- Steps được hardcode thành Investigate/Plan/Execute/Verify/Review theo difficulty tại `src/main/tasks/task-planner.ts:176` đến `src/main/tasks/task-planner.ts:228`.
- `TaskAutomationService.planTask()` chỉ lưu draft từ `buildTaskPlan(input)`, không gọi agent/LLM tại `src/main/tasks/task-automation-service.ts:41` đến `src/main/tasks/task-automation-service.ts:57`.

Hệ quả: “split a large request into scheduled subtasks” hoạt động, nhưng không hiểu codebase/context như planner AI thật.

Việc nên làm: đổi copy UI/docs thành “heuristic plan”, hoặc thêm bước optional gọi agent planner để sinh subtasks từ knowledge snapshot/project context.

### T2 — Scheduler chạy due tasks tuần tự, chưa có retry/backoff/concurrency control

Evidence:

- `runDueTasks()` lấy `this.db.listDueTasks()` rồi for-loop tuần tự từng task tại `src/main/tasks/task-automation-service.ts:59` đến `src/main/tasks/task-automation-service.ts:124`.
- Không có field retry/maxAttempts/backoff trong `TaskRecord` tại `src/contracts/task.ts:7` đến `src/contracts/task.ts:26`.
- Khi thiếu `projectPath`, task bị set `blocked` ngay tại `src/main/tasks/task-automation-service.ts:71` đến `src/main/tasks/task-automation-service.ts:84`.

Hệ quả: automation tốt cho local queue nhỏ, nhưng chưa đủ cho hàng đợi dài/nhiều agent/temporary failure.

Việc nên làm: thêm `attemptCount`, `lastError`, `nextRetryAt`, `maxAttempts`, và concurrency limit theo CLI/provider.

### T3 — Preset tasks là template fallback, không phải backlog thật cho đến khi user tương tác

Evidence:

- `taskSeeds` là mảng hardcoded trong renderer tại `src/renderer/tasks/TasksModule.tsx:72` đến `src/renderer/tasks/TasksModule.tsx:216`.
- UI dùng `displayedTasks = tasks.length > 0 ? tasks : templateTasks` tại `src/renderer/tasks/TasksModule.tsx:336` đến `src/renderer/tasks/TasksModule.tsx:338`.
- Template chỉ được lưu thành task khi investigate/status gọi `ensureSavedTask()` tại `src/renderer/tasks/TasksModule.tsx:402` đến `src/renderer/tasks/TasksModule.tsx:456`.

Hệ quả: khi project chưa có task, UI trông như có backlog nhưng thực chất là preset cards.

Việc nên làm: giữ preset nhưng label rõ “Templates”, hoặc tạo onboarding action “Import templates into this project”.

## 6. Agents: runtime chạy thật, nhưng lifecycle/capability chưa đầy đủ

### A1 — Restart/concurrency queue đã có; kill escalation và pause capability còn lại

Status update 2026-08-04:

- Restart is now available through the agent lifecycle path and creates a new run from saved input while preserving the previous run/logs.
- Concurrency limit + queue are real runtime behavior; `queued` no longer means “about to spawn immediately”.
- `stopAll`/shutdown path handles queued work without spawning more processes.

Status update 2026-08-05 — spawn-window bug fixed:

`drainQueue()` shifted a run off `queued` and then awaited `spawnQueued()`, which
awaits `buildInvocation()` before registering the child in `running`. During that
window the run was in neither collection, so it counted against neither the
concurrency limit (a fourth child could spawn past `MAX_CONCURRENT_RUNS = 3`) nor
`sessions()` (the UI dropped the row), and `stop()` found it nowhere and silently
did nothing — leaving an orphaned child once the spawn completed.

Fix: a `spawning` map holds in-flight spawns, `activeCount()` = `running.size +
spawning.size` gates concurrency, `sessions()` reports them as `planning` /
`(starting)`, and `stop()` records the cancellation in `cancelledSpawns` so
`spawnQueued()` SIGTERMs the fresh child instead of publishing it as live.
Verified: `tests/agent-process-lifecycle.test.ts` went from 6 pass / 1 fail to 7
pass / 0 fail across three consecutive runs; full `npm test` is 175/175.

Residual: `stop()` still needs hardening for stubborn child processes — SIGKILL /
tree-kill escalation after a SIGTERM timeout is still absent (grep for `SIGKILL`
and `tree-kill` in `src/main/processes/agent-process-manager.ts` returns nothing).
Pause/resume should stay out of scope unless a CLI exposes an application-level
checkpoint/resume capability.

### A2 — Structured chat resume chỉ áp dụng Claude/Agy

Evidence:

- `usesStructuredChat()` chỉ trả true khi `uiMode === "chat"` và CLI là `claude` hoặc `agy` tại `src/main/agents/commands.ts:202` đến `src/main/agents/commands.ts:204`.
- Structured chat args chỉ định nghĩa cho Claude/Agy tại `src/main/agents/commands.ts:206` đến `src/main/agents/commands.ts:222`.
- `conversationId` chỉ extract từ JSON field `session_id` hoặc `conversation_id` tại `src/main/processes/agent-process-manager.ts:375` đến `src/main/processes/agent-process-manager.ts:383`.

Hệ quả: Chat UI có thể dùng chung nhiều agent profile, nhưng resume conversation/provider-native structured chat chưa general cho Codex/Gemini/Kiro/Grok/etc.

Việc nên làm: thêm capability flags trong catalog: `supportsStructuredChat`, `resumeArgs`, `conversationIdExtractor`, hoặc ẩn resume/chat-specific affordances cho provider chưa hỗ trợ.

### A3 — Terminal log retention đã có

Status update 2026-08-04: terminal log storage now has per-message truncation with a visible marker, per-run row pruning, and startup cleanup for old finished-run logs. Long-running noisy agents no longer grow SQLite without bound. Remaining nice-to-have: expose database/log size and manual cleanup controls in Settings/Diagnostics.

## 7. AI gateway / router: tài liệu kiến trúc đã mô tả nhiều hơn runtime hiện tại

### R1 — 9Router/CLIProxyAPI sidecar mới là proposal, chưa được đóng gói hoặc chạy trong app

Evidence:

- `docs/aiagnet.md` mô tả kiến trúc `Local AI Gateway` với `9Router hoặc CLIProxyAPI Sidecar`, OAuth management, model routing, token refresh, quota tracking và fallback tại `docs/aiagnet.md:151` đến `docs/aiagnet.md:180`.
- Tài liệu đó cũng đưa ví dụ app gọi endpoint local `http://127.0.0.1:20128/v1/chat/completions` tại `docs/aiagnet.md:182` đến `docs/aiagnet.md:207`.
- Trong source runtime hiện tại, agent runs vẫn đi qua `AgentProcessManager.start()` và `spawnStep()` để spawn CLI/shell process trực tiếp; IPC agents chỉ có `agent:start`, `agent:stop`, `agent:send`, `agent:models`, `agent:ping` tại `src/main/ipc/register-ipc.ts:69` đến `src/main/ipc/register-ipc.ts:85`.
- `package.json` không có dependency/script nào cho 9Router, CLIProxyAPI, local gateway, HTTP server, hoặc OpenAI-compatible `/v1` route tại `package.json:13` đến `package.json:63`.
- `forge.config.ts` chỉ đóng gói main/preload/renderer qua Vite và không khai báo extra binary/resource cho sidecar tại `forge.config.ts:8` đến `forge.config.ts:57`.

Hệ quả: `docs/aiagnet.md` đang hữu ích như tài liệu định hướng/sản phẩm tương lai, nhưng nếu đọc như trạng thái hiện tại thì sẽ hiểu nhầm rằng app đã có local router, multi-account OAuth, token refresh, quota tracking và model fallback tự động. Runtime thực tế hiện là local CLI orchestrator, chưa phải OpenAI-compatible gateway.

Việc nên làm:

1. Ngắn hạn: đổi đầu `docs/aiagnet.md` thành “proposal / future architecture”, và link ngược sang tài liệu này để phân biệt trạng thái hiện tại với hướng làm.
2. Trung hạn: nếu muốn giữ lời hứa gateway, thêm service quản lý sidecar: locate/download binary, spawn/stop theo app lifecycle, health check, local API key, log/port conflict handling.
3. Dài hạn: thêm provider account model thật cho router: OAuth/device flow, refresh token, quota/rate-limit tracking, fallback policy, và adapter giữa workflow/agent task với `/v1/chat/completions` streaming.

## 8. Diagnostics / Integrations / Analytics: chủ yếu là health dashboard, chưa phải control plane đầy đủ

### D1 — Diagnostics chỉ kiểm tra CLI presence/version

Evidence:

- `collectDiagnostics()` ping agent CLIs rồi check `git` và `docker` tại `src/main/ipc/diagnostics.ts:6` đến `src/main/ipc/diagnostics.ts:33`.
- `checkTool()` chỉ resolve binary và đọc version output tại `src/main/ipc/diagnostics.ts:36` đến `src/main/ipc/diagnostics.ts:56`.

Hệ quả: diagnostics không kiểm tra API auth, provider quota, writable project folder, SQLite health, network/proxy, or real end-to-end CLI task ability.

Việc nên làm: chia diagnostics thành tiers: installed, authenticated, runnable smoke test, project permissions, database health.

### D2 — Integrations page không tự connect provider; nó dẫn về Settings

Evidence:

- Integrations load connections bằng `window.agentic.settings.listProviderConnections()` tại `src/renderer/integrations/IntegrationsModule.tsx:31` đến `src/renderer/integrations/IntegrationsModule.tsx:42`.
- Nút `Manage` chỉ gọi `onNavigate("Settings")` tại `src/renderer/integrations/IntegrationsModule.tsx:160` đến `src/renderer/integrations/IntegrationsModule.tsx:165`.
- Provider cards render metadata từ `providerCatalog` + saved connection tại `src/renderer/integrations/IntegrationsModule.tsx:125` đến `src/renderer/integrations/IntegrationsModule.tsx:170`.

Hệ quả: Integrations là dashboard/route map, chưa phải nơi setup OAuth/provider trực tiếp.

Việc nên làm: hoặc giữ vai trò dashboard và đổi copy, hoặc thêm inline connect/verify/disconnect actions.

### D3 — TopBar search là navigation search, chưa phải workspace/code search

Evidence:

- Search results chỉ filter `workspaceNavigation` theo label/summary tại `src/renderer/components/TopBar.tsx:36` đến `src/renderer/components/TopBar.tsx:44`.
- Enter mở workspace area đầu tiên qua `openNav(searchResults[0].key)` tại `src/renderer/components/TopBar.tsx:90` đến `src/renderer/components/TopBar.tsx:93`.

Hệ quả: placeholder “Search workspace” có thể bị hiểu là search toàn project/code/tasks, nhưng hiện chỉ là navigation launcher.

Việc nên làm: đổi placeholder thành “Open workspace area”, hoặc tích hợp project/task/knowledge search.

## 9. Database/migration: app DB đã có `schema_migrations`, workflow repository còn legacy `ensureColumns`

### DB1 — Versioned migrations đã có cho app DB, nhưng workflow schema chưa được gom hết vào đó

Evidence:

- `migrations.ts` đã tạo bảng `schema_migrations`, có `appMigrations`, và `runMigrations()` chạy transaction từng version.
- `DesktopDatabase.migrate()` đã gọi `runMigrations(this.db, appMigrations)` sau baseline schema.
- Workflow repository vẫn tự tạo bảng và thêm nhiều cột bằng `ensureColumns()` tại `src/main/database/workflow-repository.ts:86` đến `src/main/database/workflow-repository.ts:171`.

Hệ quả: gap “chưa có migration version table” đã được sửa cho app DB chính, nhưng source of truth cho workflow schema vẫn bị chia đôi giữa `workflow-repository.ts` và `migrations.ts`. Các thay đổi workflow phức tạp như rename/split/backfill vẫn cần gom về migration version.

Việc nên làm: gom các `ensureColumns` còn lại của workflow vào `appMigrations`, giữ migration idempotent, backup DB trước destructive migration, và test mở DB từ các snapshot cũ.

## Những phần đã kiểm tra và không nên gọi là “chưa làm”

- IPC bridge đầy đủ cho API hiện có: contract `AgenticDesktopApi`, preload, và `registerIpcHandlers()` đang khớp các channel chính (`system`, `projects`, `settings`, `agents`, `tasks`, `workflows`, `git`, `knowledge`).
- Agent options không còn là dead field: `AgentProfile.options` / `AgentRunInput.options` được build thành argv qua `buildOptionArgs()` tại `src/contracts/agent-options.ts:51` đến `src/contracts/agent-options.ts:96`, và `buildInvocation()` gọi nó tại `src/main/agents/commands.ts:146`.
- Agent stdin/send có implementation thật: `AgentProcessManager.send()` ghi vào `stdin` và append log tại `src/main/processes/agent-process-manager.ts:247` đến `src/main/processes/agent-process-manager.ts:255`.
- Workflow run/approval có implementation thật: approval gate được park/resume qua `pendingApprovals` tại `src/main/workflows/workflow-service.ts:352` đến `src/main/workflows/workflow-service.ts:363` và approve tiếp tục step còn lại tại `src/main/workflows/workflow-service.ts:241` đến `src/main/workflows/workflow-service.ts:273`.
- Schedule workflow có runner thật cho các string parse được: scheduler parse `Daily`, `Weekly`, `Monthly`, `Every N minutes/hours` trong `src/main/workflows/workflow-schedule.ts:37` đến `src/main/workflows/workflow-schedule.ts:68`.
- Provider secrets không bị lưu plaintext raw trong SQLite: secret được encrypt bằng Electron safeStorage và DB chỉ lưu reference.

## Đề xuất thứ tự làm tiếp

1. **Làm Knowledge index đáng tin hơn**: dùng truncation report hiện có để ưu tiên incremental scan, rồi thêm TypeScript parser cho repo TS/TSX.
2. **Hoàn thiện Git workspace beyond MVP**: thêm stash/branch/log details/conflict UX; chỉ thêm push sau khi có confirm rõ cho hành động outbound.
3. **Hoàn thiện trigger remote**: giữ `git-push`/`issue-created`/`webhook` gated cho tới khi có ref polling/API polling/local listener thật.
4. **Nâng task planner**: thêm option “AI plan from project context” dùng knowledge snapshot + agent CLI.
5. **Agent lifecycle hardening**: thêm SIGTERM→SIGKILL/tree-kill escalation; pause/resume chỉ làm khi CLI có capability rõ.
6. **Làm rõ AI gateway/9Router**: gắn nhãn `docs/aiagnet.md` là proposal nếu chưa build sidecar, hoặc bắt đầu bằng sidecar health check + spawn lifecycle.
7. **Versioned DB migrations**: gom dần workflow repository legacy `ensureColumns` vào `appMigrations` trước khi schema bắt đầu thay đổi phức tạp hơn additive columns.
