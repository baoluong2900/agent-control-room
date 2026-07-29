**Đấu được.** App của bạn có thể dùng **9Router hoặc CLIProxyAPI làm lớp AI Gateway**, còn giao diện 3D, Projects, Tasks và Agents là sản phẩm riêng của bạn.

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

9Router đã cung cấp endpoint tương thích OpenAI tại `/v1`, hỗ trợ chuyển đổi format giữa OpenAI, Claude, Gemini, Kiro, Antigravity và những provider khác. Nó cũng có multi-account, tự refresh OAuth token và fallback khi một tài khoản hết quota. ([GitHub][1])

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

9Router công bố endpoint OpenAI-compatible, API key cho endpoint và streaming qua SSE; dự án dùng giấy phép MIT nên về mặt giấy phép mã nguồn, bạn có thể fork và tùy biến với điều kiện tuân thủ nội dung license. ([GitHub][1])

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

9Router đã hỗ trợ chạy localhost, Docker hoặc VPS; cấu hình mặc định dùng SQLite để lưu provider, key, setting và usage history. ([GitHub][1])

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

Đặc biệt, tài liệu Anthropic nói OAuth của Claude Code được thiết kế cho người mua các gói Claude và cho việc sử dụng thông thường trong Claude Code cùng các ứng dụng Anthropic. Vì vậy việc lấy OAuth subscription rồi cung cấp lại qua một dịch vụ proxy SaaS của bên thứ ba có rủi ro chính sách và không nên xem là integration chính thức. ([Claude Platform Docs][2])

OpenAI chính thức hỗ trợ đăng nhập ChatGPT cho Codex CLI, IDE extension và desktop client; tài liệu hiện tại không đồng nghĩa với việc token subscription có thể được gom vào một dịch vụ hosted multi-user rồi bán lại như API. ([OpenAI Developers][3])

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
  userId: string;

  name: string;
  runtime: "codex" | "claude" | "agy" | "custom";
  providerConnectionId: string;
  model: string;

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

9Router hiện là dự án MIT và đã có endpoint, OAuth providers, API keys, SQLite, JWT cùng SSE. ([GitHub][1])

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

