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
| Done | Workflows | All six triggers now run locally: schedule, file-change, ref polling, a loopback webhook listener, and issue polling via the user's `gh`. Nothing is gated. | Wants architecture. | Keep remote triggers disabled/warned until adding ref polling/API polling/local webhook service. |
| Residual | Provider connections | Fixed properly 2026-08-06: two renderer call sites still hardcoded `connected` despite this being marked done. Both now verify instead. Real OAuth stays a separate plan. | Keep copy honest or implement callback/device-code auth as a separate feature. |
| Done | Knowledge | Incremental scan, AST parsing, tsconfig alias resolution, progress/cancel, and ranked search all landed 2026-08-06. | Nothing open; see `docs/feature/done/knowledge-index.md`. |
| P1 residual | Git | Patch viewer, log, stage/unstage, and commit now exist; branch/push/pull/stash/blame/conflict tooling remains future work. | Keep expanding operations by reversibility: stash/log details next, push only with explicit outbound confirmation. |
| Done | Tasks | Planner now assigns only installed CLIs, labels itself a template plan, and has an opt-in AI mode with stated fallback. | Nothing open; see `docs/feature/done/task-ai-planner.md`. |
| P2 residual | Agents | Restart, concurrency queue, and SIGTERM→SIGKILL/tree-kill escalation all landed; only pause/resume remains out of scope. | Keep pause only for CLIs with an explicit application-level checkpoint capability. |
| Residual | AI gateway | App now spawns and owns a sidecar (lifecycle, ports, logs, `/health`, local key) and Diagnostics reports it. Still no `/v1` routing — that needs a product decision. | Gắn nhãn tài liệu này là proposal, hoặc implement gateway sidecar thật. |

## Đã sửa (2026-08-04): workflow step ↔ agent connection

Ba khoảng trống dưới đây đã được implement, ghi lại ở đây vì chúng là nguyên nhân chính của cảm giác “agent không có connection, không nối được với nhau”:

1. **Workflow step giờ nhận credential thật.** Trước đây `spawnStep()` chỉ merge `{ ...process.env, FORCE_COLOR }`, nên profile/provider connection user cấu hình trong Agent Builder không hề tới workflow. Nay cả hai đường spawn đều đi qua `resolveProviderEnv()` tại `src/main/agents/provider-resolver.ts`. `WorkflowStepDefinition` có thêm `profileId` và `providerConnectionId` (`src/contracts/workflow.ts`), chọn được trong editor.
2. **Step truyền output cho nhau.** `executeSteps()` tích luỹ `WorkflowStepOutcome[]` và interpolate qua `applyStepContext()` tại `src/main/workflows/step-context.ts`, hỗ trợ `{{previous.output}}` và `{{steps.<id|name>.output}}`. Step không có placeholder vẫn được append context của step trước, nên workflow cũ tự động chain. Context sống sót qua approval gate vì được park cùng `PendingApproval`.
3. **Provider connection có `baseUrl`.** Đủ để đấu proxy/router: `buildProviderRuntimeEnv()` set `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` (+ biến thể `_API_BASE`/`_API_URL`) khi connection có endpoint. Field này chỉ hiện cho provider mà CLI thật sự đọc env đó, xem `supportsBaseUrl()` tại `src/renderer/settings/provider-catalog.ts`.

Lưu ý về mục R1 bên dưới: `baseUrl` cho phép **trỏ tới** một router đang chạy, nhưng app vẫn chưa tự spawn/quản lý sidecar 9Router/CLIProxyAPI. Phần đó vẫn là proposal.

Test: `tests/workflow-agent-binding.test.ts`. Migration cho DB cũ: version 4 và 5 trong `src/main/database/migrations.ts`.

## 1. Workflows: unsupported remote triggers are gated; local triggers run

### W1 — Đã sửa hoàn toàn (2026-08-06): cả 6 trigger đều có runner

`WorkflowSchedulerService` poll local ref bằng `git rev-parse` (tái dùng `git()` từ
`git-service`). Phát hiện là **ref đã đổi** — commit/merge/rebase/pull — nên label
đổi thành *On Ref Change*; gọi "On Push" là hứa thứ cần webhook. `detail` =
`origin/main` thì watch remote-tracking ref, tín hiệu local gần nhất với "đã push".

Baseline được seed lúc `start()` nên mở app không fire hàng loạt; cooldown 90s chặn
workflow tự commit rồi tự trigger; SHA ghi trước khi run nên run fail không retry mãi
cùng commit. Test `tests/workflow-ref-trigger.test.ts` (11 case), cộng verify trên
repo git thật.

**Pass bổ sung cùng ngày** đã đóng nốt hai cái còn lại:

- `webhook`: loopback HTTP listener (`127.0.0.1`), bắt buộc token so sánh
  timing-safe, chỉ mở port khi có webhook workflow active và đóng lại khi không còn.
  Verify thật: LAN IP của máy (192.168.1.31/.32) đều bị refuse, chỉ loopback trả 202,
  và không có firewall prompt.
- `issue-created`: poll qua chính `gh` CLI của user, nên **không cần credential mới
  và không mở port**. `listOpenIssues` trả `null` chứ không phải `[]` khi không xác
  định được (thiếu gh / chưa login / không phải GitHub repo), vì coi nhầm thành "repo
  rỗng" sẽ khiến nó fire cho mọi issue đang mở ngay khi gh hoạt động trở lại.

`unsupportedTriggerCopy` giờ rỗng, và có test assert rằng không trigger nào bị gate.

Evidence (lịch sử):

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

### S2 — Đã sửa thật (2026-08-06); trước đó bị đánh dấu xong nhầm

Mục này từng ghi là xong, nhưng `connectProvider` và `reconnectProvider` trong
`SettingsModule.tsx` **vẫn truyền `status: "connected"`**. Vì
`saveProviderConnection` resolve `input.status ?? existing ?? "unverified"`, giá trị
renderer truyền thắng default — card xanh ngay khi lưu credential, đúng hành vi plan
02 được viết ra để sửa.

Nguyên nhân sống sót: backend test có pin default `unverified`, nhưng không test nào
pin việc renderer override nó. Giờ cả hai handler không truyền status và verify ngay
sau khi save, nên luồng vẫn một click nhưng trạng thái là thật.

`tests/provider-connection-honesty.test.ts` assert trên source text — bug là một
*claim*, không phải phép tính, nên test hành vi sẽ phải dựng cả module để bắt một
string literal.

Evidence (lịch sử):

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

### K1 — Đã sửa (2026-08-06): scan giờ là incremental

Bảng `knowledge_files(project_path, path, hash, mtime, bytes, insight_json)` giữ
per-file index (migration 8 + baseline DDL). Rescan bỏ qua theo hai tầng: size+mtime
giống thì không đọc file; mtime đổi mà content hash giống thì đọc nhưng không parse
lại. Index được ghi lại trong một transaction nên file đã xoá cũng bị evict.

Đo trên repo này: cold 140ms → warm **21ms (6.83x)**, `reused=166/166`. `force: true`
là đường thoát khi analyzer đổi. Graph vẫn rebuild toàn bộ mỗi lần vì edge là quan hệ
giữa các file. Progress/cancel có qua `knowledge:progress` / `knowledge:cancel`.
Test: `tests/knowledge-incremental.test.ts`, `tests/knowledge-progress.test.ts`.

Evidence (lịch sử, trạng thái trước khi sửa):

- `KnowledgeService.scan()` luôn gọi `collectFiles(projectPath, maxFiles, maxFileBytes)` rồi đọc/analyze từng file tại `src/main/knowledge/knowledge-service.ts:103` đến `src/main/knowledge/knowledge-service.ts:144`.
- Snapshot được lưu đè qua `this.database.saveKnowledgeSnapshot(snapshot)` tại `src/main/knowledge/knowledge-service.ts:143`.
- Không có watch mode, file hash diff, incremental update, hoặc per-file table trong service.

Hệ quả: project lớn sẽ scan lại toàn bộ trong mỗi lần user bấm scan/export nếu snapshot không có, và không có trạng thái “chỉ update file changed”.

Việc nên làm: lưu per-file hash/mtime, chỉ re-read file changed, và expose progress event cho UI.

### K2 — Đã sửa (2026-08-06): TS/JS dùng AST, regex chỉ còn là fallback

`src/main/knowledge/ast-parser.ts` dùng `ts.createSourceFile` cho
`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`. Import trong comment/string/template không
còn tạo edge, `export * from` được bắt (trước đây không regex nào cover), và mọi dạng
import thật đều nhận ra: default, namespace, named, type-only, side-effect,
`require()`, dynamic `import()` ở mọi độ sâu, `import x = require()`.
`import(variable)` bị bỏ qua chứ không đoán.

Đo được: `src/contracts/index.ts` từ 0 lên 9 import. Regex **vẫn giữ** cho Python/Go/
CSS — TS compiler không parse được chúng và một parser sai còn tệ hơn regex thô; có
test pin điều đó. Alias `@contracts` cũng đã resolve thành local node thay vì external
package (`tsconfig-aliases.ts`, chịu được JSONC vì tsconfig của repo có `//` comment).
Chi phí: cold scan 140→327ms, nhưng incremental giữ warm rescan ở 20ms.
Test: `tests/knowledge-ast.test.ts`, `tests/knowledge-alias.test.ts`.

Evidence (lịch sử, trạng thái trước khi sửa):

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

### T1 — Đã sửa (2026-08-06): CLI thật + copy trung thực + AI mode tuỳ chọn

Heuristic vẫn là mặc định (tức thì, tất định, offline, không tốn quota), nhưng ba
vấn đề thật đã được sửa:

1. **Không còn gán CLI chưa cài.** Mỗi role có danh sách ưu tiên, lấy candidate đầu
   tiên có cài, cuối cùng fallback `shell`. Availability được probe và cache 5 phút.
2. **Copy nói đúng bản chất.** Summary báo `source: "template"`, và UI nói thẳng nó
   không phân tích codebase. Reassignment được hiện ra (`Analyze: gemini -> claude`).
3. **AI mode opt-in** (`mode: "ai"`) hỏi một agent CLI đã cài, dùng knowledge snapshot
   làm context. Mọi failure — không CLI, timeout, exit != 0, prose thay JSON, JSON sai
   shape, step trỏ CLI không tồn tại — đều fallback về template plan kèm
   `fallbackReason` hiện ra cho user.

Live verify: AI plan mất 41.6s, `source=ai`, và đề xuất đúng hướng (cache schema →
migration → incremental logic → tests). Test: `tests/task-planner-availability.test.ts`,
`tests/task-ai-planner.test.ts` (chạy offline, không gọi CLI thật).

Evidence (lịch sử, trạng thái trước khi sửa):

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

### A1 — Restart/concurrency queue/kill escalation đã có; chỉ còn pause capability

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

Status update 2026-08-06 — kill escalation landed:

`src/main/processes/process-tree.ts` snapshots the pid/ppid table *before*
signalling (once the root dies its children are re-parented and the link that
identifies them is gone), sends SIGTERM, and escalates to SIGKILL after an
injectable grace period — `taskkill /F /T /PID` on win32, which is the only way
to take a tree there. Descendants are reaped deepest-first, because killing a
parent before its children is what creates the orphans the function exists to
prevent. `stop()` no longer deletes its bookkeeping right after signalling: it
keeps the child handle until exit is confirmed, so "stopped" is a fact about the
OS rather than a claim. A `terminating` set keeps the run out of the concurrency
count and the session list while the kill is in flight, so a queued run does not
wait out the grace period of a child that is already logically stopped.

A second bug surfaced while verifying this. `before-quit`
(`src/main/main.ts:123-128`) calls `stopAll()` then `database.close()`, both
synchronous — but the signalled children outlive them by up to the full grace
period and an agent CLI prints on its way out. That late stdout reached
`handleOutput()` → `appendTerminalLog()` on a closed handle and threw
`database is not open` from inside a stream callback: an uncaughtException on the
way to exit, once per live agent. `handleOutput` was the only async DB writer in
the manager without a `shuttingDown` guard; every other handler already had one.

Verified: `npm test` 193/193 (was 192 pass / 1 fail). The new regression test in
`tests/process-kill-escalation.test.ts` was confirmed load-bearing by removing the
guard and watching it fail with the exact `database is not open` error.

Residual: pause/resume stays out of scope unless a CLI exposes an
application-level checkpoint/resume capability — SIGSTOP mid-stream leaves a dead
provider connection behind, which is a worse state than stopping outright.

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

### R1 — Đã làm phần hạ tầng (2026-08-06); còn lại là quyết định sản phẩm

**Cập nhật pass 3:** app **giờ đã** spawn và quản lý sidecar
(`src/main/gateway/sidecar-manager.ts`): lifecycle không để process mồ côi (dùng lại
`terminateProcessTree`), port conflict báo rõ chứ không âm thầm đổi port, log cap 500
dòng, local API key strip khỏi log. Verify với router thật `hermes proxy start`:
`/health` trả HTTP 200, stop 72ms, port được giải phóng, không process sót.

Vẫn **chưa** expose `/v1` routing của riêng app — và đó mới là phần cần quyết định
sản phẩm (adapt provider nào trước, cancellation map vào workflow step thế nào).
App không bundle binary: command là config trong bảng `settings`, chưa cấu hình thì
là no-op im lặng.

Đã làm được phần không cần quyết định: `collectGatewayChecks` live-probe `baseUrl`
của connection `hermes-agent` và là check **live duy nhất** trong Diagnostics — các
provider check khác đọc stored state, thứ không trả lời được "proxy có đang chạy".
Ba outcome: không reachable → `fail` kèm `hermes proxy start`; 4xx → `warn` chỉ vào
credential upstream; answer → `ok`. Test `tests/diagnostics-gateway.test.ts`.

Evidence (lịch sử):

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

Cập nhật 2026-08-06: D3 **vẫn đúng** — TopBar chưa đổi, nó vẫn chỉ filter
`workspaceNavigation`. Nhưng building block đã có: `knowledge:search`
(`src/main/knowledge/knowledge-search.ts`) là ranked search thật trên snapshot, có
scoring theo filename/symbol/export/import/purpose và báo cả lý do match. Nếu làm D3
thì nối vào channel đó thay vì viết filter thứ hai.

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
