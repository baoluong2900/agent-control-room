# Việc cần làm tiếp — Agentic Workspace (rà soát 2026-08-10)

Tài liệu này là **backlog thật còn lại**, viết sau khi đọc source hiện tại và chạy
verify thật, không copy lại từ `docs/unfinished-features.md`. Mọi kết luận dưới đây
đều có `file:line` hoặc output lệnh kèm theo.

## 0. Trạng thái verify tại thời điểm rà soát

| Lệnh | Kết quả thật |
| --- | --- |
| `npx tsc --noEmit` | pass, 0 lỗi |
| `npm run test:workflows` | `# tests 510 · # pass 510 · # fail 0` |
| `npm run build` | `BUILD_EXIT=0`, packaged `arm64/darwin` |
| `git branch --show-current` | `main` |

Lưu ý quan trọng: 5 test đỏ của `chat-transcript`/`chat-session-state` từng thấy ở
lần chạy trước **đã xanh** khi chạy lại toàn suite — chúng đỏ do worktree đang bị sửa
giữa lúc chạy, không phải regression.

Working tree hiện **không sạch**: 14 file modified + 11 file untracked, toàn bộ thuộc
feature gateway-chat / AgentRoom (`src/contracts/gateway-chat.ts`,
`src/main/gateway/gateway-chat-client.ts`, `gateway-chat-service.ts`,
`src/renderer/agents/AgentRoom.tsx`, `src/renderer/gateway/GatewayChatPanel.tsx`,
4 test file mới). mtime của chúng là 01:37–01:46 cùng ngày → **có session khác đang
sửa song song**. Đừng commit hộ; xác nhận chủ sở hữu trước.

---

## 1. P0 — Đóng gói phần việc đang treo trong worktree

**Vấn đề:** 1510 dòng code mới (client OpenAI-compatible `/v1/chat/completions`,
service, contract, 2 surface UI, 4 test file) đang là untracked/modified. Chúng đã
pass typecheck + toàn suite + build, nhưng chưa nằm trong lịch sử git. Một `git clean`
hay một session khác `git checkout` là mất trắng.

**Việc cần làm:**

1. Xác nhận session nào đang chủ trì (mtime mới nhất `AgentRoom.tsx` 01:46).
2. Nếu không còn ai sửa: `git add` đúng 25 path đó, chạy lại `npm test`, commit.
3. Không `git add .` — `package.json` đang bị đánh dấu modified nhưng `git diff` rỗng
   (chỉ thay đổi mtime), thêm vào commit chỉ tạo diff rỗng gây nhiễu.

**Acceptance:** `git status --short` sạch, `npm test` xanh sau commit.

---

## 2. ✅ ĐÃ XONG (2026-08-10) — Git workspace: outbound + blame

**Đã land:** `fetchGitRemote`, `pullGitRemote` (`--ff-only`), `readGitPushPlan`,
`pushGitBranch`, `readGitTracking`, `readGitRemotes`, `readGitBlame` trong
`git-service.ts`; 6 channel `git:*` mới (tất cả đi qua `approvedGitCwd`); tab
**Remote** + **Blame** trong `GitDiffPanel.tsx`. Test: `tests/git-remote-ops.test.ts`
(19 test, chạy với bare repo local làm remote nên không cần network).

Quyết định khác kế hoạch, có lý do:

- `git()` nhận thêm `timeoutMs`; network op dùng 60s. Budget 5s cũ giết một
  `push` đang truyền pack và báo là timeout, để lại user không biết object đã
  lên hay chưa.
- `git()` set `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=`. Không có thì fetch
  thiếu credential treo vĩnh viễn ở prompt username không có terminal nào để
  hiện, và chỉ kết thúc khi timeout — báo sai thành "timeout" thay vì
  "chưa auth".
- `readGitPushPlan` tách khỏi `pushGitBranch` để modal confirm và lệnh push
  dùng **cùng một** kết quả. `pushGitBranch` nhận `expectedBranch` và từ chối
  nếu HEAD đã đổi sau khi modal render.
- Không có `--force`, và có test `assert.doesNotMatch(panel, /--force/)`.
- Conflict resolution vẫn **không** làm, đúng như kế hoạch: `readGitDiff` đã
  phân loại `kind: "conflicted"` là đủ để cảnh báo.

### Kế hoạch gốc (giữ lại để tham chiếu)

**Trạng thái thật:** `src/main/git/git-service.ts` (573 dòng) có
`readGitDiff`, `readGitFileDiff`, `readGitLog`, `stageGitFile`, `unstageGitFile`,
`commitGitChanges`, `readGitBranches`, `checkoutGitBranch`, `readGitStashes`,
`readGitStashDetail`, `createGitStash`, `applyGitStash`, `dropGitStash`.
Grep `push|pull|fetch` trong file này chỉ trả về `args.push(...)` của JS —
**không có lệnh git outbound nào**. Grep `blame` trong toàn `src/main` = 0 hit.

### 2.1 `fetch` trước (an toàn nhất, làm đầu)

`git fetch --prune` không đổi worktree, không đổi ref local. Đây là thao tác outbound
duy nhất không thể làm mất việc của user.

- Thêm `fetchRemote(cwd, remote)` vào `git-service.ts`, trả `GitOperationResult` +
  `GitDiffSummary` refresh như các hàm write hiện có.
- IPC `git:fetch` phải đi qua đúng approved-project allowlist như mọi channel `git:*`
  (xem `tests/project-path-security.test.ts` — đây là invariant, không phải tuỳ chọn).
- UI: nút Fetch trong tab Branches, hiện `ahead/behind` sau khi fetch.

### 2.2 `pull` — chỉ fast-forward

`git pull --ff-only`. Từ chối khi tree dirty, giống `applyGitStash` đang làm
(`hasUncommittedChanges`). Không bao giờ auto-merge/rebase: conflict resolution UI
chưa có, tạo conflict rồi bỏ user ở giữa là tệ hơn không pull.

### 2.3 `push` — cần confirm tường minh

Đây là thao tác duy nhất trong Git workspace **gửi dữ liệu ra ngoài máy**. Yêu cầu:

- Modal confirm hiện rõ: remote, branch, số commit sẽ đẩy, và upstream có tồn tại chưa.
- Chặn mặc định `main`/`master` (cho phép bằng một toggle riêng trong modal, không
  phải setting ẩn).
- `--set-upstream` khi branch chưa có upstream, không âm thầm tạo remote branch khác tên.
- Không bao giờ `--force`. Nếu cần, đó là plan riêng.

### 2.4 `blame` + conflict view

`blame` là read-only, dễ: `git blame --line-porcelain <file>` → map line → commit/author.
Conflict resolution thì **không** nên làm trong pass này: nó cần 3-way view, và
`readGitDiff` hiện đã phân loại `kind: "conflicted"` (`git-service.ts:471`) là đủ để
UI cảnh báo thay vì giả vờ giải quyết được.

**Test:** mở rộng `tests/git-service.test.ts` với repo tạm có remote local
(`git init --bare` làm remote) — verify được push/pull thật mà không cần network.

---

## 3. ✅ ĐÃ XONG (2026-08-10) — nhưng tiền đề của mục này SAI

**Đo lại trên source:** `agentProcessManager.start()` chỉ *enqueue* rồi return
ngay (`agent-process-manager.ts:144-238`), nên vòng `for (const task of dueTasks)`
**không** bị một task chạy 10 phút chặn. Và `AgentProcessManager` đã có
`MAX_CONCURRENT_RUNS = 3` + queue thật (`:290`, `activeCount()` ở `:311`). Không
cần thêm worker pool nào; thêm vào là tạo giới hạn thứ hai lệch với giới hạn
đang có, đúng cái mà chính mục này cảnh báo.

**Gap thật là điểm 2 của mục này** và nó đã được sửa: task chờ trong queue hiện
`investigating` như đang chạy. `TaskStatus` có thêm `queued`;
`markTaskRunStarted` set `queued`, `markTaskRunSpawned(id, runId)` promote sang
`investigating` khi child thật sự spawn (scoped theo `last_run_id` + chỉ từ
`queued`, nên callback của run cũ hay task đã settle không kéo task trở lại).
UI có tone `cyan`, filter, và tile Queued riêng. Test:
`tests/task-retry-policy.test.ts` (2 test mới) + `tests/agent-spawn-failure.test.ts`
(pin cả promotion khi slot mở ra).

### Ghi chú gốc (tiền đề sai, giữ lại để đối chiếu)

**Trạng thái thật:** `src/main/tasks/task-automation-service.ts:186` là
`for (const task of dueTasks)` — tuần tự, `await` từng task. Grep
`MAX_CONCURRENT|activeRuns|inFlight` trong file này = **0 hit**.

Retry đã có thật (`src/contracts/task.ts:31-37`: `attemptCount`, `maxAttempts`,
`nextRetryAt`, `lastError`) nên phần đó **không** còn là gap.

**Hệ quả:** một task chạy 10 phút chặn toàn bộ queue. Ngược lại, nếu sau này chuyển
sang `Promise.all` một cách hồn nhiên thì 20 task due cùng lúc sẽ spawn 20 CLI —
`AgentProcessManager` có `MAX_CONCURRENT_RUNS = 3` nhưng scheduler không biết về nó.

**Việc cần làm:**

1. Thêm worker pool có giới hạn trong `runDueTasks()`, mặc định **bằng đúng** giới hạn
   của `AgentProcessManager` — hai con số lệch nhau là cách tạo queue vô hình.
2. Task pending trong pool phải hiện là `queued` trong UI, không phải `running`.
   Bài học từ bug spawn-window (`docs/audit-2026-08-05.md`): trạng thái trung gian
   không được biến run thành vô hình.
3. Một task fail không được huỷ tick — mẫu `try/catch` per-item của
   `runFileChangeWorkflows` (`workflow-scheduler.ts:172`) là đúng, tái dùng.

**Test:** mở rộng `tests/task-automation.test.ts`: N task due với limit K → không quá
K task ở trạng thái running tại bất kỳ thời điểm; task thứ K+1 là `queued`.

---

## 4. P2 — `trigger.detail` là string tự do, mỗi trigger tự parse một kiểu

**Trạng thái thật:** contract chỉ có `detail?: string` với comment
"Extra context such as branch name, repo, or Jira project"
(`src/contracts/workflow.ts:74`). Runtime thì đã parse nó **4 cách khác nhau**:

- `parseRefTrigger(workflow.trigger.detail)` — `workflow-scheduler.ts:264,550`
- `parseIssueTrigger(workflow.trigger.detail)` — `issue-poller.ts:118`
- webhook: chỉ cần `detail` non-empty làm token — `workflow-scheduler.ts:318`
- file-change: split `,` rồi glob match — `workflow-scheduler.ts:457-464`,
  `fileChangeFilterMatches` / `globLikeMatch` (`:598`, `:604`)

**Hệ quả:** user không có cách nào biết ô Detail cần nhập gì; đổi trigger type làm
detail cũ trở thành vô nghĩa nhưng vẫn được lưu và vẫn được parse. Webhook đặc biệt
nguy: `detail` **là secret token**, nằm cùng field với "branch name" trong copy.

**Việc cần làm:**

1. Đổi `WorkflowTrigger` thành discriminated union theo `type`:
   - `schedule`: `{ schedule: string }`
   - `file-change`: `{ pathGlobs: string[] }`
   - `git-push`: `{ ref: string; remote?: string }`
   - `issue-created`: `{ label?: string }`
   - `webhook`: `{ token: string }` — field riêng, render dạng password, không log
   - `manual`: `{}`
2. Migration đọc `trigger_detail` cũ, chạy đúng parser hiện có để backfill sang cột
   mới. Giữ `trigger_detail` lại một version để rollback được.
3. Editor render control theo type thay vì một `<input>` chung
   (`WorkflowEditorDrawer.tsx:187`).

**Rủi ro:** đây là thay đổi contract chạm cả 3 tầng + DB. Làm sau mục 2 và 3.

---

## 5. ✅ ĐÃ XONG (2026-08-10) — smoke tier có thể `ok` thật

**Đã land:** `AgentSmokeTest { args, expect?, proves }` trên
`AgentCliDescriptor`, `runSmokeCheck()` trong `diagnostics.ts` với seam
`dependencies.runSmoke`.

Khai cho 4 CLI, **verify live trên máy này, 4/4 `ok`**:

| CLI | Probe | Live |
| --- | --- | --- |
| kiro | `chat --list-sessions -f json` | ok, 2.4s |
| claude | `mcp list` | ok, 0.3s |
| codex | `mcp list` | ok, 1.3s |
| opencode | `models` | ok, 0.9s |

Hai thứ khác kế hoạch, đều vì đo thật:

- **`expect` là bắt buộc về mặt thiết kế, không phải trang trí.** `grok models`
  exit 0 trong khi in `You are not authenticated.` rồi vẫn liệt kê model. Exit
  code một mình chứng minh không gì cả, nên grok để `unknown`.
- **`agy models` in `Fetching available models...`** — có network call, không
  chắc quota-safe, nên cũng để `unknown`. Thà `unknown` thật còn hơn `ok` giả.
- Timeout riêng 8s: `kiro-cli --list-sessions` mất ~2.4-3.8s, budget 2.5s của
  version check sẽ báo một CLI hoàn toàn khoẻ là timeout.
- Không bao giờ `fail`, chỉ `warn`: CLI lỗi lệnh local vẫn có thể chạy prompt
  thật tốt.
- Copy khi không có probe đã sửa: nói "không có lệnh nào kiểm tra được mà không
  tốn quota" chứ không phải "chưa khai báo" (có test
  `assert.doesNotMatch(..., /does not declare/)`).

Gemini vẫn để nguyên: `command -v gemini` = không có trên máy này.

### Ghi chú gốc

**Trạng thái thật:** `src/main/ipc/diagnostics.ts:70-73` phát ra check
`tool:<id>:smoke` với `status: "unknown"` và detail *"This CLI does not declare a
quota-safe smoke test"*. Grep `smokeTest|smokeArgs` trong toàn `src/` = **0 hit** —
`AgentCliDescriptor` (`src/contracts/agent.ts:179-218`) không có field nào để khai báo.
Nghĩa là tier này **không thể** chuyển sang `ok` cho bất kỳ CLI nào.

Phần còn lại của Diagnostics thì thật: `collectDatabaseChecks` (`:235`),
`project:writable` (`:194`), và `collectGatewayChecks` là live probe.

**Việc cần làm:** thêm `smokeTest?: { args: string[]; expect: RegExp | string }` vào
descriptor và khai báo cho các CLI có đường chạy **không tốn quota**. Verify thật trên
máy này: `kiro-cli chat --list-sessions -f json` trả JSON hợp lệ và **không gọi model**
— đó là smoke test đúng nghĩa. `--list-models` cũng vậy. CLI nào không có đường như
thế thì giữ `unknown`, và detail phải nói "CLI này không có lệnh nào kiểm tra được mà
không tốn quota", chứ không phải "chưa khai báo".

---

## 6. P2 — Structured chat: Kiro có đủ điều kiện, Gemini thì chưa

**Trạng thái thật:** `structuredChat` đã khai cho agy, grok, claude, codex, opencode
(`src/main/agents/catalog.ts:88, 227, 321, 394, 555`). Entry `kiro` (`:13-27`) và
`gemini` (`:475`) **không có** block đó, nên `uiMode: "chat"` bị ẩn cho hai CLI này.

### Kiro — đã verify thật trên máy này, làm được ngay

```
kiro-cli chat --no-interactive "Remember the codeword BANANA77. Reply OK."
kiro-cli chat --list-sessions -f json
  → [{"cwd":"/private/tmp/kirochk","sessions":[{"sessionId":"803be273-…", …}]}]
kiro-cli chat --no-interactive --resume-id 803be273-… "What was the codeword?"
  → BANANA77
```

Resume **hoạt động thật**, nhớ đúng codeword qua 2 lượt.

Nhưng đây **không** phải cùng shape với các CLI hiện có, và đó là phần cần thiết kế:

- Không có `--output-format json` cho một lượt chat. Output là text kèm footer
  `▸ Credits: 0.02 • Time: 2s` → parser phải strip footer, không phải `JSON.parse`.
- Session id **không** nằm trong output của lượt chat. Phải lấy qua
  `--list-sessions -f json` (scoped theo cwd), tức là một lệnh thứ hai sau lượt 1.
- Resume là **flag có giá trị** (`--resume-id <id>`) → dùng `resumeFlag`, không phải
  `resumeArgs`.

Nên contract cần thêm một biến thể: `outputFormat: "text"` + `conversationIdCommand`
(argv chạy sau lượt đầu để lấy id). Đừng nhét vào `conversationIdFields` — không có
JSON nào để đọc field từ đó.

Cẩn thận với `--trust-tools=`: truyền rỗng in ra warning
`--trust-tools arg for custom tool needs to be prepended with @{MCPSERVERNAME}/`
trên stderr dù run vẫn thành công. Transcript phải coi đó là noise, giống 29–31 dòng
auth-refresh của Codex.

### Gemini — không verify được

`command -v gemini` = không có trên máy này. **Không** khai `structuredChat` dựa trên
đọc doc: đó đúng là cách tạo ra một agent card trông chạy được rồi fail ở lượt 2.
Để nguyên cho tới khi có máy cài `gemini` để verify wire format + resume thật.

---

## 7. ✅ ĐÃ XONG (2026-08-10) — migration version 9

Đã xoá import chết ở `workflow-repository.ts`, chuyển 7 chỗ
`ensureColumn`/`ensureColumns` của `desktop-database.ts` thành migration
version 9 (`app-legacy-additive-columns`), và xoá luôn method private
`ensureColumn` giờ không còn ai gọi.

**Bẫy phát hiện khi làm, không có trong kế hoạch:** `idx_tasks_due` và
`idx_agent_runs_task` index đúng các cột mà v9 mới thêm, mà baseline block chạy
*trước* `runMigrations()`. Để nguyên thì DB cũ fail khi tạo index trên cột chưa
tồn tại. Hai index đã dời vào trong body v9, ngay sau `ensureColumns`.

**Test bites (sabotage + restore):** bỏ `tasks.automation_enabled` khỏi v9 →
`tests/database-migrations.test.ts` đỏ với
`Schema migration 9 (app-legacy-additive-columns) failed: no such column: automation_enabled`;
restore → 11/11 xanh.

### Ghi chú gốc

**Trạng thái thật:** mục DB1 trong `docs/unfinished-features.md:503` đã **lỗi thời**.
`WorkflowRepository` không còn `ensureColumns()` nào — grep chỉ còn **dòng import**
(`workflow-repository.ts:15`), tức là một **import chết**; `bootstrap()` đã đi qua
`runMigrations(db, workflowMigrations())` (`:112`) và comment ở `:117-125` đã nói rõ
"Nothing new belongs in this method; add a migration version".

Nợ thật còn lại nằm ở chỗ khác: `desktop-database.ts` vẫn có **6** lần
`this.ensureColumn(...)` (`:1557-1562`, cho `agent_runs` và `agent_profiles`) cộng một
`ensureColumns(this.db, "tasks", …)` (`:1563`) nằm **ngoài** `appMigrations` (hiện tới
version 8, `migrations.ts:139`).

**Việc cần làm:**

1. Xoá import chết ở `workflow-repository.ts:15`.
2. Chuyển 7 chỗ trên thành migration version 9, giữ idempotent
   (`create ... if not exists` / kiểm tra cột trước khi add).
3. Sửa mục DB1 trong `docs/unfinished-features.md` — nó đang mô tả sai trạng thái
   hiện tại và sẽ khiến người đọc đi sửa một thứ đã xong.

**Test:** `tests/database-migrations.test.ts` — mở DB từ snapshot version 8 rồi
migrate lên 9, assert cột tồn tại và dữ liệu không mất.

---

## 8. Còn lại là quyết định sản phẩm, không phải nợ kỹ thuật

### 8.1 Gateway `/v1` — hướng đã tự đổi

Plan 15 phase 3/4/5 (`docs/feature/ai-gateway-sidecar.md`) viết theo hướng
"app **serve** một endpoint `/v1` OpenAI-compatible". Nhưng code đang landed trong
worktree đi hướng ngược lại: `gateway-chat-client.ts:120` **gọi**
`${baseUrl}/chat/completions` của một gateway bên ngoài (Pool API), có streaming,
cancel, và target list. Grep `createServer|\.listen(` trong `src/main` chỉ ra 2 chỗ:
webhook listener (`webhook-listener.ts:118`) và port-probe của sidecar
(`sidecar-manager.ts:128`) — **không có HTTP server nào phục vụ `/v1`**.

Đây là hướng tốt hơn (không phải viết lại router, không bundle binary), nhưng nghĩa là
plan 15 phase 3/4/5 nên được **viết lại thành "consume gateway"** chứ không phải
"serve gateway". Để nguyên thì nó là một backlog mô tả sai kiến trúc đang chọn.

### 8.2 OAuth thật (S1)

`openProviderSite()` (`settings-service.ts:147`) đã đặt tên trung thực và comment ở
`:142` nói rõ không có callback listener, không có device-code exchange. Đây là trạng
thái **đúng và honest**, không phải bug. Chỉ làm khi thực sự cần app tự thu token.

### 8.3 Secret vault (S3)

Secret đã encrypt bằng Electron `safeStorage`, DB chỉ giữ reference. Grep
`rotate|keychain|keytar` trong `provider-secret-vault.ts` = 0 hit → chưa có rotation,
chưa có OS keychain item riêng, chưa có audit trail. Không phải P0 vì không có
plaintext, nhưng nên ghi vào security docs thay vì để mặc định người đọc tự suy ra.

### 8.4 T3 (task templates) — đã xong, gỡ khỏi backlog

`docs/unfinished-features.md:296` nói preset trông như backlog thật. Source hiện tại
đã label rõ: `decorateTemplateTask` set `source: "template"`
(`TasksModule.tsx:1315-1321`) và UI hiện badge `"Preset"` / `"Agent Preset"`
(`:748`, `:752`, `:1439`). Mục này nên chuyển sang phần Done.

---

## Trạng thái (cập nhật 2026-08-10, sau pass thực thi)

| Mục | Trạng thái |
| --- | --- |
| 1 — commit gateway-chat đang treo | ✅ đã nằm trong lịch sử git (`2938d11`, `aec3db2`) |
| 2 — Git outbound + blame | ✅ xong, 19 test mới |
| 3 — task queue visibility | ✅ xong (tiền đề concurrency của mục này sai — xem mục 3) |
| 5 — Diagnostics smoke tier | ✅ xong, 4 CLI verify live |
| 7 — migration version 9 | ✅ xong, test có sabotage-proof |
| 4 — trigger schema union | ⏳ còn lại, xem bên dưới |
| 6 — Kiro structured chat | ⏳ còn lại |
| 8.1 — viết lại plan 15 | ⏳ còn lại (là việc doc, không phải code) |

Verify sau pass: `npx tsc --noEmit` pass; `npm test` **535/535** (baseline đo đầu pass:
510); `npm run build` exit 0, packaged `arm64/darwin`.

## Còn lại, theo thứ tự đề nghị

1. **Mục 6** — Kiro structured chat. Đã verify resume thật, nhưng cần thêm biến thể
   contract (`outputFormat: "text"` + `conversationIdCommand`) vì session id không nằm
   trong output lượt chat. Đây là thay đổi shape của descriptor, không phải một entry
   catalog thêm vào — nên nó là việc thật, không phải quyết định.
2. **Mục 4** — trigger schema union. Chạm contract + migration + editor UI. Rủi ro cao
   nhất trong phần còn lại, nên làm sau cùng trong nhóm code.
3. **Mục 8.1** — viết lại plan 15 theo hướng consume gateway. Việc doc.
