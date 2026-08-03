# Module AI Agent Custom cho app của bạn

**Làm được.** Hướng đúng là biến app thành một **command center cho các nhân viên AI**, UI nhìn như game chiến thuật nhưng vẫn là công cụ làm việc thật. 9Router hoặc CLIProxyAPI chỉ nên là lớp **AI Gateway** nằm bên dưới; phần 3D UI, Projects, Tasks, Agents, mission board và agent builder là sản phẩm riêng của bạn.

## Ý tưởng sản phẩm

Thay vì chỉ có một danh sách bot, app nên coi mỗi agent như một **nhân viên AI**:

* Có tên, vai trò, runtime, model và màu nhận diện.
* Có trạng thái: idle, running, blocked, completed, failed.
* Có chỉ số: success rate, completed tasks, total time, latency, quota.
* Có loadout: model, CLI, command override, prompt mode, permission, workspace.
* Có cấp độ hoặc rank nếu muốn game hóa: trainee, specialist, senior, elite.
* Có nhiệm vụ đang nhận và lịch sử nhiệm vụ đã hoàn thành.

UI kiểu game ở đây không phải là làm app thành đồ chơi. Nó là cách hiển thị trực quan để user nhìn vào là biết **đội AI của mình đang có ai, ai đang rảnh, ai đang làm việc, ai bị lỗi, agent nào phù hợp cho nhiệm vụ tiếp theo**.

## Các loại AI agent nên xây

```text
Planner Agent
  - Chia yêu cầu lớn thành plan, subtasks, độ khó và thứ tự làm.

Coder Agent
  - Sửa code, tạo file, implement feature theo task.

Reviewer Agent
  - Review diff, tìm bug, kiểm tra regression và thiếu test.

Tester Agent
  - Chạy test, build, lint, e2e và gom lỗi thành report.

Research Agent
  - Đọc tài liệu, tìm API, so sánh provider, chuẩn bị context.

Ops Agent
  - Chạy script, deploy, kiểm tra môi trường, quản lý release.

Builder Agent
  - Tạo agent profile mới, prompt template mới và workflow mới.

Security/Gatekeeper Agent
  - Kiểm tra permission, secret, command nguy hiểm và network access.

Local Agent
  - Dùng model local hoặc shell runtime cho việc offline/nhẹ.

Custom Agent
  - Agent do user tự định nghĩa role, prompt, model, tool và quyền.
```

## UI như chơi game nên có gì

Màn hình `Agents` hiện tại của app đã có nền rất hợp với hướng này: **3D View / Fleet View**, List View, Grid View, agent card, quick start, terminal, live sessions, activity feed, performance panel và resource panel. Có thể phát triển tiếp thành kiểu game như sau:

```text
Command Center
  ├── Fleet Map / 3D View
  │     Mỗi node là một nhân viên AI, màu theo CLI/model, hiệu ứng theo trạng thái.
  │
  ├── Agent Cards
  │     Avatar, role, rank, status, model, success rate, tasks completed.
  │
  ├── Mission Board
  │     Task queue, difficulty, deadline, assigned agent, progress, reward/priority.
  │
  ├── Agent Builder
  │     Chọn class, runtime, model, permission, prompt, workspace, tags.
  │
  ├── Terminal Console
  │     Mở console riêng cho từng agent để theo dõi hoặc nhập lệnh.
  │
  └── Activity Feed
        Log realtime: agent nhận task, chạy command, lỗi, hoàn thành, cần user duyệt.
```

Game hóa nên nằm ở lớp hiển thị:

* `Level` tăng theo completed tasks và success rate.
* `XP` tính từ task difficulty, thời gian chạy và kết quả verification.
* `Badges` cho chuyên môn: backend, frontend, test, review, ops, research.
* `Loadout` là bộ runtime/model/tools/permission của agent.
* `Mission` là task thật trong project, không phải nhiệm vụ giả.

## Agent có thể tạo agent khác không?

**Có, nhưng nên có kiểm soát.** Builder Agent hoặc Orchestrator Agent có thể đề xuất agent mới, nhưng app của bạn phải là bên quyết định cuối cùng.

Luồng an toàn:

```text
User yêu cầu tạo đội AI cho một loại project
   ↓
Builder Agent sinh agent templates
   ↓
Orchestrator kiểm tra role, model, prompt, permission
   ↓
App hiển thị preview cho user duyệt
   ↓
User bấm Create
   ↓
App lưu AgentProfile và workflow
```

Không nên để agent tự cấp quyền cho chính nó. Agent có thể tạo **đề xuất cấu hình**, còn quyền thật như edit files, run commands, network, git push, secret access phải do user hoặc policy của app duyệt.

Điểm quan trọng là phải tách thành **hai loại đăng nhập khác nhau**:

1. **Đăng nhập app của bạn**: Google, GitHub, email…
2. **Kết nối tài khoản AI**: Codex, Claude, GitHub Copilot, Kiro hoặc API key.

## Luồng người dùng đề xuất

```text
User mở app
   ↓
Login bằng Google/GitHub
   ↓
Dashboard
   ↓
Chọn project workspace
   ↓
Mở Command Center / Agents
   ↓
Tạo hoặc chọn đội nhân viên AI
   ↓
Connect AI Provider
   ├── Connect Codex
   ├── Connect Claude
   ├── Connect GitHub Copilot
   ├── Connect Kiro
   └── Add API Key
   ↓
Browser OAuth mở ra
   ↓
User xác nhận trên trang nhà cung cấp
   ↓
App nhận token
   ↓
User tạo Mission / Task
   ↓
Orchestrator gán agent phù hợp
   ↓
Agent bắt đầu làm việc
```

Người dùng **không nhập mật khẩu OpenAI hoặc Claude vào app của bạn**. App chỉ mở trang OAuth chính thức hoặc device login.

---

# Kiến trúc phù hợp nhất

```text
┌────────────────────────────────────────┐
│ Your Desktop App                       │
│ Electron + React + React Three Fiber   │
│                                        │
│ Projects / Agents / Tasks / Workflows  │
└───────────────────┬────────────────────┘
                    │
                    │ localhost API
                    ▼
┌────────────────────────────────────────┐
│ Local AI Gateway                      │
│ 9Router hoặc CLIProxyAPI Sidecar      │
│                                        │
│ OAuth management                       │
│ Format translation                     │
│ Model routing                          │
│ Token refresh                          │
│ Quota tracking                         │
│ Fallback                               │
└──────────┬─────────┬──────────┬────────┘
           │         │          │
           ▼         ▼          ▼
        Codex      Claude      Kiro
        OAuth      OAuth       OAuth
```

9Router đã cung cấp endpoint tương thích OpenAI tại `/v1`, hỗ trợ chuyển đổi format giữa OpenAI, Claude, Gemini, Kiro, Antigravity và những provider khác. Nó cũng có multi-account, tự refresh OAuth token và fallback khi một tài khoản hết quota.

Ví dụ app của bạn gọi local router:

```ts
const response = await fetch(
  "http://127.0.0.1:20128/v1/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localRouterKey}`,
    },
    body: JSON.stringify({
      model: "cx/gpt-5.4",
      messages: [
        {
          role: "user",
          content: "Phân tích repository và sửa lỗi authentication",
        },
      ],
      stream: true,
    }),
  },
);
```

9Router công bố endpoint OpenAI-compatible, API key cho endpoint và streaming qua SSE; dự án dùng giấy phép MIT nên về mặt giấy phép mã nguồn, bạn có thể fork và tùy biến với điều kiện tuân thủ nội dung license.

---

# Cách triển khai mình khuyên dùng

## Phase 1: Router chạy local

Khi user cài app:

```text
YourApp.exe
9router-sidecar.exe
agent-worker.exe
```

Hoặc trên macOS:

```text
YourApp.app/
  Contents/
    MacOS/YourApp
    Resources/bin/9router
    Resources/bin/agent-worker
```

App tự khởi chạy router:

```ts
import { spawn } from "node:child_process";

const router = spawn(routerBinaryPath, [], {
  env: {
    ...process.env,
    PORT: "20128",
    HOSTNAME: "127.0.0.1",
    DATA_DIR: userDataPath,
    REQUIRE_API_KEY: "true",
    API_KEY_SECRET: generatedSecret,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
```

Sau đó app chỉ giao tiếp qua:

```text
http://127.0.0.1:20128
```

### Ưu điểm

* Token OAuth nằm trên máy user.
* Source code dự án không cần upload lên server bạn.
* Ít chi phí máy chủ.
* Dễ chạy macOS, Windows, Linux.
* User dùng quota tài khoản của chính họ.
* Khi app đóng, router có thể đóng theo.
* Dễ kết hợp với Git, terminal và filesystem local.

9Router đã hỗ trợ chạy localhost, Docker hoặc VPS; cấu hình mặc định dùng SQLite để lưu provider, key, setting và usage history.

---

# Không nên chạy toàn bộ OAuth trên cloud ngay

Mô hình này kỹ thuật vẫn làm được:

```text
User App
   ↓
Your Cloud Gateway
   ↓
Codex/Claude OAuth token
   ↓
Provider
```

Nhưng bạn sẽ phải lưu token Claude, Codex của hàng nghìn người dùng trên server. Khi đó rủi ro tăng mạnh:

* Server bị hack sẽ lộ toàn bộ refresh token.
* Phải mã hóa theo từng tenant.
* Phải xây token rotation và revoke.
* Phải tuân thủ chính sách từng provider.
* Người dùng có thể dùng chung hoặc bán lại quota.
* Provider có thể thay đổi OAuth flow bất cứ lúc nào.
* Một user bị khóa không được ảnh hưởng user khác.

Đặc biệt, OAuth của Claude Code được thiết kế cho người mua các gói Claude và cho việc sử dụng thông thường trong Claude Code cùng các ứng dụng Anthropic. Vì vậy việc lấy OAuth subscription rồi cung cấp lại qua một dịch vụ proxy SaaS của bên thứ ba có rủi ro chính sách và không nên xem là integration chính thức.

OpenAI chính thức hỗ trợ đăng nhập ChatGPT cho Codex CLI, IDE extension và desktop client; tài liệu hiện tại không đồng nghĩa với việc token subscription có thể được gom vào một dịch vụ hosted multi-user rồi bán lại như API.

Vì vậy:

```text
Local OAuth subscription connector → được dùng cho MVP

Cloud official API key gateway       → phù hợp production

Cloud subscription-token proxy       → rủi ro cao, tránh ban đầu
```

---

# UX đăng nhập nên thiết kế thế nào

## Bước 1 — Login vào app

```text
Continue with GitHub
Continue with Google
Continue with Email
```

Đây là account của hệ thống bạn, dùng để lưu:

* Projects
* Tasks
* Workflows
* Agent configurations
* Subscription của app
* Sync settings

## Bước 2 — Connect AI accounts

Trang `Settings → AI Providers`:

```text
OpenAI Codex
Connected as: user@example.com
Plan: Plus
Status: Available
[Reconnect] [Disconnect]

Claude Code
Not connected
[Connect Claude]

Kiro
Connected
Quota: 37 / 50
[Reconnect] [Disconnect]

Custom API
[Add API Key]
```

## Bước 3 — Chọn agent và model

```text
Agent: Backend Developer
Harness: Codex
Provider: OpenAI Codex
Model: GPT
Workspace: Project Alpha
Permission: Ask before commands
```

Hoặc:

```text
Agent: Code Reviewer
Harness: Claude Agent
Provider: Claude Max
Workspace: Project Alpha
Permission: Read-only
```

---

# Phân biệt Router và Agent

Đây là phần rất quan trọng:

```text
9Router / CLIProxyAPI
= Model Router

Codex CLI / Claude Code / AGY
= Agent Runtime

App của bạn
= Agent Orchestrator + UI
```

Router chỉ giải quyết:

* Authentication
* Model endpoint
* Format conversion
* Fallback
* Quota
* Routing

Router **không tự thay thế toàn bộ agent runtime**.

Agent runtime mới chịu trách nhiệm:

* Đọc project.
* Sửa file.
* Chạy terminal.
* Chạy test.
* Quản lý context.
* Dùng MCP.
* Xin quyền user.
* Tạo commit hoặc pull request.

Kiến trúc hoàn chỉnh:

```text
User
 ↓
Your App UI
 ↓
Agent Orchestrator
 ↓
Codex / Claude / AGY Agent Adapter
 ↓
9Router / CLIProxyAPI
 ↓
Selected Model Provider
```

---

# Data model cơ bản

```ts
interface AppUser {
  id: string;
  email: string;
  displayName: string;
}

interface ProviderConnection {
  id: string;
  userId: string;

  provider:
    | "openai-codex"
    | "claude-code"
    | "github-copilot"
    | "kiro"
    | "custom-api";

  storageMode: "local";
  accountLabel?: string;
  status: "connected" | "expired" | "disconnected";
  createdAt: string;
}

interface AgentProfile {
  id: string;
  name: string;
  role: string;
  cliId:
    | "codex"
    | "claude"
    | "kiro"
    | "gemini"
    | "agy"
    | "grok"
    | "amazonq"
    | "aider"
    | "opencode"
    | "cursor"
    | "copilot"
    | "qwen"
    | "ollama"
    | "shell"
    | "custom";
  model: string;
  providerConnectionId?: string;

  accent: string;
  cwd?: string;
  systemPrompt?: string;
  extraArgs?: string;
  commandOverride?: string;
  promptMode?: "arg" | "flag" | "stdin";
  interactive: boolean;
  autoApprove: boolean;
  enabled: boolean;
  tags: string[];

  stats: {
    runs: number;
    completed: number;
    failed: number;
    successRate: number;
    totalMs: number;
    lastStatus?: string;
  };
}

interface AgentProgress {
  agentProfileId: string;
  level: number;
  xp: number;
  rank: "trainee" | "specialist" | "senior" | "elite";
  badges: string[];
  unlockedLoadouts: string[];
}

interface AgentMission {
  id: string;
  projectPath: string;
  title: string;
  prompt: string;
  difficulty: "small" | "medium" | "large" | "epic";
  assignedAgentIds: string[];
  status: "queued" | "running" | "waiting-approval" | "done" | "failed";
  dueAt?: string;
  rewardXp: number;
}

interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  defaultCliId: AgentProfile["cliId"];
  defaultModel: string;
  defaultPrompt: string;

  permissions: {
    readFiles: boolean;
    editFiles: boolean;
    runCommands: boolean;
    accessNetwork: boolean;
    gitPush: boolean;
  };
}
```

Không lưu access token thẳng trong database thông thường:

```ts
interface ProviderConnection {
  tokenReference: string; // keychain reference
}
```

Token thật lưu ở:

* macOS: Keychain
* Windows: Credential Manager hoặc DPAPI
* Linux: Secret Service/libsecret

---

# Có nên fork 9Router không?

**Có hai lựa chọn.**

### Dùng 9Router nguyên bản làm sidecar

Phù hợp MVP:

```text
Your App
  → gọi REST API của 9Router
  → không sửa quá nhiều source
```

Ưu điểm là ra sản phẩm nhanh.

### Fork và lấy phần routing core

Phù hợp về sau:

```text
Your Agent Gateway
  ├── OpenAI translator
  ├── Anthropic translator
  ├── OAuth connectors
  ├── quota tracking
  └── fallback engine
```

9Router hiện là dự án MIT và đã có endpoint, OAuth providers, API keys, SQLite, JWT cùng SSE.

Tuy nhiên, không nên phụ thuộc sâu vào toàn bộ dashboard của nó. App của bạn nên sở hữu:

* User system.
* Projects.
* Agents.
* Tasks.
* Workflow engine.
* Permissions.
* Desktop lifecycle.
* Analytics.
* Billing.

Còn 9Router chỉ nên là **Provider Gateway Layer**.

# Hướng tốt nhất cho sản phẩm của bạn

```text
Phase 1
Desktop local-first
+ user login vào app
+ connect provider bằng OAuth
+ 9Router sidecar
+ Codex/Claude CLI adapter
+ task queue
+ project workspace

Phase 2
Workflow nhiều agent
+ Planner
+ Coder
+ Tester
+ Reviewer
+ Git worktree isolation

Phase 3
Cloud sync
+ chỉ sync project metadata
+ không sync OAuth token mặc định

Phase 4
Team/Enterprise
+ official API keys
+ Bedrock / Vertex / OpenAI API
+ centralized gateway
```

Tóm lại: **bạn hoàn toàn có thể làm giống 9Router/CLIProxyAPI theo kiểu user login**, nhưng thiết kế tốt nhất là **user login vào app, sau đó tự liên kết tài khoản AI của họ; OAuth token và agent runtime chạy local**. App của bạn sẽ trở thành lớp quản lý công việc và orchestration, còn 9Router chỉ là lớp routing nằm bên dưới.

---

# Tích hợp Claude CLI, Agy và Codex vào app

Phần này ghi lại **trạng thái tích hợp thật** của ba agent runtime chính, kiểm chứng trực tiếp trên máy dev (macOS, `darwin 25.5.0`) chứ không phải flag suy đoán.

## Nơi tích hợp trong source

```text
src/contracts/agent.ts
  AgentCliId, AgentCliDescriptor, AgentPromptMode, AgentRunInput

src/main/agents/catalog.ts
  Khai báo descriptor cho từng CLI: binary candidates, baseArgs,
  interactiveArgs, modelFlag, promptFlag, promptMode, models

src/main/agents/commands.ts
  resolveExecutable()  → tìm binary trên PATH
  buildInvocation()    → dựng argv thật cho lần chạy
  withTty()            → bọc `script` cho CLI cần TTY

src/main/agents/probe.ts
  pingAgentCli()       → `<cli> --version`, báo installed + latency
  probeAgentModels()   → gọi modelListArgs, fallback về catalog

src/main/processes/agent-process-manager.ts
  spawn process, stream stdout/stderr qua IPC `agent:event`

src/renderer/agents/agent-modules.ts
  Map CLI → module/persona (planner, coder, reviewer, ops, builder…)
```

IPC surface đã sẵn sàng: `agent:catalog`, `agent:ping`, `agent:ping-all`, `agent:models`, `agent:start`, `agent:stop`, `agent:send`, `agent:sessions`.

## Ba runtime: flag đã kiểm chứng

### Claude Code (`cliId: "claude"`)

Phiên bản trên máy: `2.1.220 (Claude Code)`.

```text
Binary        claude
One-shot      claude -p "<prompt>"
Interactive   claude
Model flag    --model  (sonnet | opus | haiku | tên đầy đủ)
Prompt mode   arg
Flag hữu ích  --permission-mode, --output-format, --fallback-model,
              --input-format (chỉ có tác dụng cùng --print)
```

Catalog hiện tại khớp: `baseArgs: ["-p"]`, `modelFlag: "--model"`, `promptMode: "arg"`.

**Lưu ý quan trọng — không có binary tên `claude-cli`.** Binary thật là `claude`. Trên máy này `claude` còn là một shim zsh:

```sh
#!/bin/zsh
exec "${HOME}/.local/bin/claude-kiro" "$@"
```

Nghĩa là `type -a claude` trả về **shell function + 3 path khác nhau**, và cái thắng phụ thuộc PATH order. Đây là lý do phải cho user override command per-profile (`commandOverride`) thay vì hard-code — descriptor đã hỗ trợ sẵn.

### Agy (`cliId: "agy"`)

Phiên bản: `1.1.8`. CLI Go, flag một dấu gạch kép, có subcommand.

```text
Binary        agy
One-shot      agy -p "<prompt>"          (-p = --print)
Interactive   agy
Model flag    --model
Prompt mode   flag
Model list    agy models                 ← CLI tự liệt kê được
Flag hữu ích  --effort (low|medium|high)
              --mode (accept-edits|plan)
              --output-format (text|json|stream-json)
              --dangerously-skip-permissions
              --sandbox
              --add-dir (repeatable)
```

Model thật `agy models` trả về (khác hoàn toàn danh sách tĩnh `sonnet`/`opus` trong catalog):

```text
gemini-3.6-flash-high / -medium / -low
gemini-3.5-flash-high / -medium / -low
gemini-3.1-pro-high / -low
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

Vì vậy descriptor của agy **cần `modelListArgs: ["models"]`** để `probeAgentModels()` lấy list thật thay vì fallback catalog.

### Codex CLI (`cliId: "codex"`)

Phiên bản: `codex-cli 0.146.0`.

```text
Binary        codex
One-shot      codex exec "<prompt>"
Interactive   codex
Model flag    -m / --model
Prompt mode   arg  (hoặc stdin nếu prompt là `-`)
Flag hữu ích  -s, --sandbox <read-only|workspace-write|danger-full-access>
              -C, --cd <DIR>
              --add-dir <DIR>
              --skip-git-repo-check
              --json  (JSONL events → parse được thành activity feed)
              -o, --output-last-message <FILE>
              -c key=value  (override config.toml)
```

Catalog khớp: `baseArgs: ["exec"]`, `modelFlag: "-m"`, `promptMode: "arg"`.

`--sandbox` của Codex là **lớp permission mạnh nhất trong ba CLI** — nên map thẳng vào permission model của app:

```text
App permission            → codex --sandbox
──────────────────────────────────────────────
Read-only                 → read-only
Ask before commands       → workspace-write
Auto-approve (trusted)    → danger-full-access
```

## Vấn đề gốc: PATH của Electron khi mở từ Finder

Đây là nguyên nhân thực tế khiến ba agent "chưa vô" được dù đã cài đủ.

Khi chạy `npm start` từ terminal, process thừa hưởng PATH của zsh nên tìm thấy hết:

```text
claude   → /Users/…/.local/bin/claude
agy      → /Users/…/.local/bin/agy
codex    → /opt/homebrew/bin/codex
kiro-cli → /Users/…/.local/bin/kiro-cli
```

Nhưng khi user mở `.app` bằng Finder/Dock, macOS **không chạy shell startup file**. Electron chỉ nhận PATH tối thiểu:

```text
/usr/bin:/bin:/usr/sbin:/sbin
```

Cả `~/.local/bin` và `/opt/homebrew/bin` đều biến mất. Kết quả:

```text
resolveExecutable()  → null
pingAgentCli()       → installed: false
                       "Not found on PATH (tried claude)"
buildInvocation()    → throw "Claude Code was not found on PATH."
```

Người dùng thấy app báo chưa cài CLI trong khi terminal chạy bình thường. Cách xử lý:

1. Bổ sung PATH trong main process trước khi probe — thêm `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/.bun/bin`.
2. Hoặc đọc PATH thật bằng login shell một lần lúc khởi động (`$SHELL -ilc 'echo $PATH'`) rồi cache.
3. Luôn để `commandOverride` như đường thoát cuối: user dán absolute path.

Cách (1) rẻ và tất định, nên làm mặc định; (2) chính xác hơn nhưng tốn ~100–300ms và phụ thuộc dotfile của user.

## Cách chạy thật của một mission

```text
Renderer: user chọn AgentProfile (cliId + model + cwd + permission)
   ↓ IPC agent:start
AgentProcessManager.start(input)
   ↓
buildInvocation(input)
   ├── shell?      → shellInvocation()
   └── ngược lại   → resolveExecutable() + baseArgs + modelFlag + prompt
   ↓
spawn(executable, args, { cwd, env: { FORCE_COLOR: "1", TERM } })
   ↓
stdout/stderr → statusHints regex → AgentStatus
   (planning / reading / coding / testing / reviewing / waiting-approval)
   ↓
IPC agent:event → Activity Feed + Terminal + 3D map state
   ↓
exit code 0 → completed, khác 0 → failed
```

`statusHints` chỉ là suy luận theo regex trên output, không phải structured event. Muốn chính xác hơn thì dùng output có cấu trúc:

```text
codex exec --json          → JSONL events
agy -p --output-format json | stream-json
claude -p --output-format stream-json
```

Cả ba đều hỗ trợ, nên đây là đường nâng cấp rõ ràng cho activity feed sau này.

## Model sentinel

`buildInvocation()` bỏ qua `modelFlag` khi model thuộc tập sentinel:

```ts
const sentinelModels = new Set(["none", "default", "cli default"]);
```

Nghĩa là chọn `default` trong UI = để CLI dùng cấu hình riêng của nó. Giữ nguyên hành vi này khi thêm CLI mới, vì mỗi vendor đổi tên model rất thường xuyên.

## Việc còn thiếu

```text
[ ] Augment PATH trong main process trước khi probe CLI
[ ] agy: thêm modelListArgs: ["models"]
[ ] agy: cập nhật model tĩnh theo list thật (gemini-3.x, claude-*-4-6)
[ ] codex: map app permission → --sandbox
[ ] claude: --permission-mode thay cho autoApprove thuần UI
[ ] Parse structured output (--json / stream-json) thay cho statusHints regex
[ ] Ghi rõ trong UI: binary là `claude`, không phải `claude-cli`
```
