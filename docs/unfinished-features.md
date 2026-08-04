# Các chức năng còn chưa hoàn thiện — Agentic Workspace

Tài liệu này ghi lại các khoảng trống chức năng đã được xác nhận bằng cách đọc source hiện tại. Mục tiêu không phải là chê toàn bộ app: nhiều phần đã có implementation thật như IPC bridge, lưu SQLite, agent process lifecycle, workflow run/approval, task scheduler, encrypted provider secret vault. Những mục dưới đây là các chỗ UI/contract/README đang hứa rộng hơn phần runtime hiện có.

Ngày ghi nhận: 2026-08-04.

## Tóm tắt ưu tiên

| Mức | Khu vực | Vấn đề chính | Hướng xử lý ngắn |
| --- | --- | --- | --- |
| P0 | Workflows | Contract/editor cho phép trigger `git-push`, `file-change`, `issue-created`, `webhook`, nhưng scheduler chỉ chạy `schedule`. | Hoặc ẩn/disable các trigger chưa chạy được, hoặc thêm watcher/webhook runners thật. |
| P0 | Provider connections | OAuth/device link hiện chỉ mở trang ngoài; app không có callback/device-code flow để tự lưu token. | Đổi copy thành “manual/local link”, hoặc implement OAuth/device callback + token exchange. |
| P1 | Knowledge | CodeGraph là full rescan + regex heuristic, có cap im lặng, chưa có AST/LSP/incremental index. | Ghi rõ giới hạn trong UI, rồi thêm incremental scanner/parser thật. |
| P1 | Git | App chỉ đọc branch/status/diff stat; không có stage/commit/branch/push/pull/stash/log. | Mở rộng contract IPC và UI Git panel theo từng operation an toàn. |
| P1 | Analytics/metrics | Một số delta metric đã có type/UI nhưng service không tính nên luôn vắng. | Implement historical windows hoặc bỏ delta khỏi UI. |
| P2 | Tasks | “Plan” là heuristic trong code, không dùng AI/LLM dù UI mô tả khá thông minh. | Đổi copy thành heuristic scheduler hoặc thêm planner agent thật. |
| P2 | Agents | Agent run không có pause/resume/restart/concurrency limit; chat resume chỉ hỗ trợ Claude/Agy JSON. | Thêm lifecycle actions và capability flags theo provider. |
| P2 | AI gateway docs | `docs/aiagnet.md` mô tả 9Router/CLIProxyAPI sidecar, nhưng runtime/package hiện chưa có router process hoặc `/v1` endpoint. | Gắn nhãn tài liệu này là proposal, hoặc implement gateway sidecar thật. |

## 1. Workflows: trigger được khai báo nhiều hơn scheduler thực sự hỗ trợ

### W1 — Các trigger ngoài `schedule` chưa tự chạy

Evidence:

- `WorkflowTriggerType` khai báo sáu loại trigger: `manual`, `schedule`, `git-push`, `file-change`, `issue-created`, `webhook` tại `src/contracts/workflow.ts:20`.
- Editor cho user chọn tất cả các loại trigger thông qua `triggerTypes.map(...)` tại `src/renderer/workflows/WorkflowEditorDrawer.tsx:285` và lưu `trigger.type` tại `src/renderer/workflows/WorkflowEditorDrawer.tsx:185`.
- Scheduler chỉ xét workflow khi `workflow.trigger.type === "schedule"` tại `src/main/workflows/workflow-scheduler.ts:76` đến `src/main/workflows/workflow-scheduler.ts:82`.
- Không có service nào theo dõi git push, file change, issue-created, hoặc webhook trong IPC surface hiện tại; IPC chỉ có `workflow:run-due` cho schedule tại `src/main/ipc/register-ipc.ts:111`.

Hệ quả: user có thể tạo workflow `git-push`, `file-change`, `issue-created`, hoặc `webhook`, workflow vẫn được lưu và hiển thị như một trigger hợp lệ, nhưng sẽ không bao giờ tự fire nếu user không bấm Run thủ công.

Việc nên làm:

1. Ngắn hạn: trong editor, chỉ cho chọn `manual` và `schedule`; các loại còn lại hiển thị “coming later” hoặc disabled.
2. Trung hạn: thêm từng runner riêng:
   - `file-change`: filesystem watcher theo `projectPath` + debounce.
   - `git-push`: hook/polling git remote/ref hoặc user-configured post-push hook.
   - `webhook`: local listener/tunnel hoặc app-level webhook inbox.
   - `issue-created`: provider integration cụ thể, ví dụ GitHub/Jira polling/webhook.

### W2 — Field `trigger.detail` được lưu nhưng chưa điều khiển runtime

Evidence:

- Contract mô tả `trigger.detail` là context như branch/repo/Jira project tại `src/contracts/workflow.ts:64`.
- Editor lưu `triggerDetail` tại `src/renderer/workflows/WorkflowEditorDrawer.tsx:187`.
- Scheduler chỉ đọc `workflow.trigger.schedule` để parse thời gian tại `src/main/workflows/workflow-scheduler.ts:81`; không đọc `trigger.detail`.
- Workflow run lấy `triggeredBy` từ option hoặc `workflow.trigger.type`, nhưng không dùng `trigger.detail` để lọc branch, repo, issue project, webhook payload tại `src/main/workflows/workflow-service.ts:195` đến `src/main/workflows/workflow-service.ts:199`.

Hệ quả: field Detail hiện chủ yếu là metadata hiển thị/lưu trữ, chưa phải điều kiện trigger thật.

Việc nên làm: định nghĩa schema riêng cho từng trigger thay vì một string tự do, ví dụ `{ branchPattern, pathGlobs }` cho file/git, `{ provider, projectKey }` cho issue, `{ secret, route }` cho webhook.

### W3 — Workflow metrics có delta fields nhưng service chưa tính

Evidence:

- `WorkflowMetrics` có `totalDeltaPercent`, `activeDeltaPercent`, `runsDeltaPercent`, `successDeltaPercent` tại `src/contracts/workflow.ts:143` đến `src/contracts/workflow.ts:146`.
- UI render delta nếu field tồn tại tại `src/renderer/workflows/WorkflowsModule.tsx:517` đến `src/renderer/workflows/WorkflowsModule.tsx:560`.
- `WorkflowService.metrics()` chỉ trả `totalWorkflows`, `activeWorkflows`, `automatedRuns`, `successRate` tại `src/main/workflows/workflow-service.ts:95` đến `src/main/workflows/workflow-service.ts:112`.

Hệ quả: delta “from last month” đã có UI path nhưng backend không bao giờ gửi dữ liệu.

Việc nên làm: tính delta theo run history trong repository, hoặc bỏ delta UI/type để tránh tạo kỳ vọng sai.

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

### S2 — Provider connections chưa kiểm tra quota/auth thật

Evidence:

- `ProviderConnection` có `status`, `quotaLabel`, `lastConnectedAt` tại `src/contracts/settings.ts:35` đến `src/contracts/settings.ts:48`.
- `saveProviderConnection()` mặc định status thành `connected` nếu input không truyền status tại `src/main/settings/settings-service.ts:58` đến `src/main/settings/settings-service.ts:63`.
- Không có call kiểm tra provider API hoặc CLI auth trong `SettingsService`; service chỉ lưu DB và secret vault.

Hệ quả: connection có thể hiện “connected” dù key/token chưa được validate.

Việc nên làm: thêm “Verify connection” theo provider, hoặc đổi status mặc định thành `disconnected`/`unverified` cho đến khi check thành công.

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

### K3 — Scanner có cap và truncation nhưng UI/docs chưa nhấn mạnh đủ

Evidence:

- Default scan giới hạn `defaultMaxFiles = 800` và `defaultMaxFileBytes = 180_000` tại `src/main/knowledge/knowledge-service.ts:29` đến `src/main/knowledge/knowledge-service.ts:30`.
- Input bị clamp tối đa `maxFiles` 5,000 và `maxFileBytes` 1,000,000 tại `src/main/knowledge/knowledge-service.ts:110` đến `src/main/knowledge/knowledge-service.ts:111`.
- Graph node/edge bị cap `1_200` nodes và `2_400` edges tại `src/main/knowledge/knowledge-service.ts:347` đến `src/main/knowledge/knowledge-service.ts:351`.

Hệ quả: với repo lớn, “indexed files” và graph chỉ là slice, không phải toàn bộ repo.

Việc nên làm: hiển thị cap/skipped rõ trong UI, cho cấu hình scan sâu, và lưu report “excluded by size/count/ignored dir”.

## 4. Git: panel mới là diff/status viewer, chưa phải Git workspace đầy đủ

### G1 — Contract chỉ có `git.diff(cwd)`

Evidence:

- `AgenticDesktopApi.git` chỉ định nghĩa `diff(cwd)` tại `src/contracts/ipc.ts:106` đến `src/contracts/ipc.ts:108`.
- Preload chỉ expose `git.diff` tại `src/preload/preload.ts:84` đến `src/preload/preload.ts:86`.
- IPC handler chỉ có `git:diff` tại `src/main/ipc/register-ipc.ts:120`.
- `readGitDiff()` chạy `rev-parse`, `branch --show-current`, `status --porcelain`, `diff --stat`, `diff --cached --stat` tại `src/main/git/git-service.ts:9` đến `src/main/git/git-service.ts:48`.

Hệ quả: app chưa có stage/unstage, commit, branch checkout/create, push/pull/fetch, stash, log, blame, conflict resolution, hoặc full patch viewer.

Việc nên làm: mở rộng Git API theo hướng read-only trước (`log`, `show`, full `diff`), sau đó mới thêm action có confirm rõ (`stage`, `commit`, `stash`, `push`).

### G2 — Git Diff Viewer không hiển thị patch từng file

Evidence:

- UI chỉ có hai tab `Files` và `Stat` tại `src/renderer/components/GitDiffPanel.tsx:38` đến `src/renderer/components/GitDiffPanel.tsx:57`.
- File list chỉ render path/status code tại `src/renderer/components/GitDiffPanel.tsx:95` đến `src/renderer/components/GitDiffPanel.tsx:114`.
- `diffStat` là text stat, không phải patch content tại `src/main/git/git-service.ts:25` đến `src/main/git/git-service.ts:30`.

Hệ quả: tên “Git Diff Viewer” đúng ở mức summary, nhưng chưa xem được diff hunk thật trong app.

Việc nên làm: thêm endpoint `git:fileDiff(cwd, path, staged?)` và panel hunk viewer có syntax highlight tối thiểu.

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

### A1 — Chưa có pause/resume/restart/concurrency limit

Evidence:

- Agent IPC chỉ có `start`, `stop`, `send`, `sessions`, `history`, `logs`, profile CRUD tại `src/contracts/ipc.ts:63` đến `src/contracts/ipc.ts:77`.
- `AgentProcessManager` có `start()`, `send()`, `stop()`, `stopAll()`, `sessions()` tại `src/main/processes/agent-process-manager.ts:57`, `src/main/processes/agent-process-manager.ts:247`, `src/main/processes/agent-process-manager.ts:257`, `src/main/processes/agent-process-manager.ts:286`, `src/main/processes/agent-process-manager.ts:293`.
- Không có pause/resume/restart API hoặc max concurrent runs trong manager.

Hệ quả: start/stop/stdin/logs đều thật, nhưng process lifecycle vẫn là MVP.

Việc nên làm: thêm `restart(runId/profileId)`, `pause` chỉ khi CLI/process hỗ trợ, queue/concurrency limit theo CLI, và UI trạng thái “queued because limit”.

### A2 — Structured chat resume chỉ áp dụng Claude/Agy

Evidence:

- `usesStructuredChat()` chỉ trả true khi `uiMode === "chat"` và CLI là `claude` hoặc `agy` tại `src/main/agents/commands.ts:202` đến `src/main/agents/commands.ts:204`.
- Structured chat args chỉ định nghĩa cho Claude/Agy tại `src/main/agents/commands.ts:206` đến `src/main/agents/commands.ts:222`.
- `conversationId` chỉ extract từ JSON field `session_id` hoặc `conversation_id` tại `src/main/processes/agent-process-manager.ts:375` đến `src/main/processes/agent-process-manager.ts:383`.

Hệ quả: Chat UI có thể dùng chung nhiều agent profile, nhưng resume conversation/provider-native structured chat chưa general cho Codex/Gemini/Kiro/Grok/etc.

Việc nên làm: thêm capability flags trong catalog: `supportsStructuredChat`, `resumeArgs`, `conversationIdExtractor`, hoặc ẩn resume/chat-specific affordances cho provider chưa hỗ trợ.

### A3 — Terminal output được lưu nhưng chưa có retention/size policy

Evidence:

- Mọi stdout/stderr được append vào `terminal_logs` qua `handleOutput()` tại `src/main/processes/agent-process-manager.ts:324` đến `src/main/processes/agent-process-manager.ts:358`.
- Lifecycle messages cũng append vào terminal log tại `src/main/processes/agent-process-manager.ts:360` đến `src/main/processes/agent-process-manager.ts:371`.
- Contract `logs(runId)` trả toàn bộ log array tại `src/contracts/ipc.ts:76`.
- Không thấy retention/max bytes/truncate policy ở `AgentProcessManager`; workflow step output có slice `output.slice(-4000)` tại `src/main/workflows/workflow-service.ts:528`, nhưng terminal logs không có cap tương tự ở manager.

Hệ quả: long-running noisy agents có thể làm SQLite phình lớn.

Việc nên làm: thêm retention policy: max logs per run, max bytes per message/run, cleanup old logs, và UI warning khi truncation xảy ra.

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

## 9. Database/migration: có ensureColumns, nhưng chưa có versioned migrations đầy đủ

### DB1 — Schema nâng cấp là additive columns, chưa có migration version theo release

Evidence:

- `DesktopDatabase.open()` gọi `database.migrate()` khi mở DB tại `src/main/database/desktop-database.ts:177` đến `src/main/database/desktop-database.ts:186`.
- Workflow repository tạo bảng nếu chưa có và thêm cột bằng `ensureColumns()` tại `src/main/database/workflow-repository.ts:86` đến `src/main/database/workflow-repository.ts:171`.
- Desktop database cũng import `ensureColumns` tại `src/main/database/desktop-database.ts:28` và dùng mô hình tương tự cho schema chính.

Hệ quả: app xử lý tốt việc thêm cột, nhưng chưa có migration version table cho thay đổi phá vỡ như rename column, split table, backfill dữ liệu phức tạp, hoặc rollback.

Việc nên làm: thêm `schema_migrations` version table, migration functions idempotent, backup DB trước destructive migration, và test mở DB từ các snapshot cũ.

## Những phần đã kiểm tra và không nên gọi là “chưa làm”

- IPC bridge đầy đủ cho API hiện có: contract `AgenticDesktopApi`, preload, và `registerIpcHandlers()` đang khớp các channel chính (`system`, `projects`, `settings`, `agents`, `tasks`, `workflows`, `git`, `knowledge`).
- Agent options không còn là dead field: `AgentProfile.options` / `AgentRunInput.options` được build thành argv qua `buildOptionArgs()` tại `src/contracts/agent-options.ts:51` đến `src/contracts/agent-options.ts:96`, và `buildInvocation()` gọi nó tại `src/main/agents/commands.ts:146`.
- Agent stdin/send có implementation thật: `AgentProcessManager.send()` ghi vào `stdin` và append log tại `src/main/processes/agent-process-manager.ts:247` đến `src/main/processes/agent-process-manager.ts:255`.
- Workflow run/approval có implementation thật: approval gate được park/resume qua `pendingApprovals` tại `src/main/workflows/workflow-service.ts:352` đến `src/main/workflows/workflow-service.ts:363` và approve tiếp tục step còn lại tại `src/main/workflows/workflow-service.ts:241` đến `src/main/workflows/workflow-service.ts:273`.
- Schedule workflow có runner thật cho các string parse được: scheduler parse `Daily`, `Weekly`, `Monthly`, `Every N minutes/hours` trong `src/main/workflows/workflow-schedule.ts:37` đến `src/main/workflows/workflow-schedule.ts:68`.
- Provider secrets không bị lưu plaintext raw trong SQLite: secret được encrypt bằng Electron safeStorage và DB chỉ lưu reference.

## Đề xuất thứ tự làm tiếp

1. **Chốt scope hiển thị**: disable/label rõ các trigger workflow chưa chạy được và đổi copy OAuth/device nếu chưa implement callback.
2. **Nâng Git panel lên useful daily tool**: thêm full patch viewer trước, sau đó stage/commit.
3. **Làm Knowledge index đáng tin hơn**: hiển thị cap/skipped, thêm incremental scan, rồi TypeScript parser cho repo TS/TSX.
4. **Thêm verification cho provider connections**: validate API key/CLI auth, tự set expired/disconnected.
5. **Nâng task planner**: thêm option “AI plan from project context” dùng knowledge snapshot + agent CLI.
6. **Thêm lifecycle/retention cho agents**: restart, concurrency limit, terminal log retention.
7. **Làm rõ AI gateway/9Router**: gắn nhãn `docs/aiagnet.md` là proposal nếu chưa build sidecar, hoặc bắt đầu bằng sidecar health check + spawn lifecycle.
8. **Versioned DB migrations**: chuẩn bị trước khi schema bắt đầu thay đổi nhiều hơn additive columns.
