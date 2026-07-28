**Build được**, và có thể chạy chung một codebase trên **macOS, Windows và Linux**.

## Stack mình chọn cho app này

Với UI 3D nặng như ảnh, mình khuyên dùng **Electron**, không dùng Tauri cho Phase 1.

```text
Electron Desktop
├── React + TypeScript
├── React Three Fiber + Three.js
├── Tailwind CSS + shadcn/ui
├── Zustand + XState
├── xterm.js
├── SQLite
└── Electron Main Process
    ├── Claude CLI
    ├── Kiro CLI
    ├── Codex CLI
    ├── Git
    ├── Docker
    └── Local filesystem
```

Electron đóng gói Chromium và Node.js trong ứng dụng, hỗ trợ Windows, macOS và Linux bằng cùng một codebase. Vì Chromium được đóng gói chung, WebGL và giao diện 3D sẽ đồng nhất hơn giữa các hệ điều hành. ([Electron][1])

## Vì sao chưa chọn Tauri?

Tauri cũng hỗ trợ Windows, macOS và Linux, đồng thời nhẹ hơn Electron. Tuy nhiên, Tauri sử dụng webview khác nhau:

* Windows: Edge WebView2
* macOS: WKWebView
* Linux: WebKitGTK

Điều này có thể tạo khác biệt khi render shader, WebGL, font và hiệu ứng 3D. Với app ưu tiên 3D giống ảnh, Electron sẽ dễ kiểm soát hơn. ([Tauri][2])

Sau này có thể thử chuyển sang Tauri khi scene 3D đã ổn định và cần giảm dung lượng.

## Kiến trúc desktop app

```text
┌───────────────────────────────────────────┐
│ Electron Renderer                         │
│                                           │
│ React Dashboard                           │
│ ├── 3D Agent Map                          │
│ ├── Project Sidebar                       │
│ ├── Agent Cards                           │
│ ├── Workflow Editor                       │
│ ├── Terminal UI                           │
│ └── Git Diff Viewer                       │
└────────────────┬──────────────────────────┘
                 │ Secure IPC
┌────────────────▼──────────────────────────┐
│ Electron Main Process                     │
│                                           │
│ ├── Agent Manager                         │
│ ├── CLI Process Manager                   │
│ ├── Project/File Manager                  │
│ ├── Git Worktree Manager                  │
│ ├── Docker Manager                        │
│ ├── Permission Manager                    │
│ └── SQLite Database                       │
└────────────────┬──────────────────────────┘
                 │
      ┌──────────┼───────────┐
      ▼          ▼           ▼
 Claude CLI   Kiro CLI   Codex CLI
```

Không cần chạy ASP.NET API hoặc mở một localhost server trong bản MVP. Electron Main Process có thể quản lý file, process và terminal trực tiếp.

## Phân chia code

```text
agentic-workspace/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/
│       │   │   ├── main.ts
│       │   │   ├── windows/
│       │   │   ├── ipc/
│       │   │   ├── agents/
│       │   │   ├── processes/
│       │   │   ├── projects/
│       │   │   ├── git/
│       │   │   └── database/
│       │   │
│       │   ├── preload/
│       │   │   └── preload.ts
│       │   │
│       │   └── renderer/
│       │       ├── app/
│       │       ├── components/
│       │       ├── map/
│       │       ├── agents/
│       │       ├── terminal/
│       │       ├── workflows/
│       │       └── stores/
│       │
│       └── forge.config.ts
│
├── packages/
│   ├── contracts/
│   ├── agent-core/
│   └── ui/
│
├── assets/
│   ├── models/
│   ├── textures/
│   └── icons/
│
└── scripts/
    ├── build-windows.ts
    ├── build-macos.ts
    └── build-linux.ts
```

## Frontend 3D

```text
React 19
React Three Fiber 9
Three.js
Drei
React Spring Three
Zustand
Framer Motion
```

React Three Fiber là React renderer cho Three.js và phiên bản 9 được thiết kế để ghép với React 19. ([Poimandres Documentation][3])

Scene map:

```tsx
<Canvas
  orthographic
  camera={{
    position: [12, 14, 12],
    zoom: 55
  }}
>
  <WorkspaceFloor />
  <PlanningZone />
  <CodingZone />
  <TestingZone />
  <DeploymentZone />
  <MonitoringZone />

  <AgentLayer />
  <WorkflowPathLayer />
  <TaskEffectLayer />
</Canvas>
```

UI bên ngoài Canvas:

```tsx
<div className="desktop-layout">
  <Sidebar />
  <AgentMap />
  <SystemOverview />
  <TerminalPanel />
  <WorkflowActivity />
</div>
```

Không nên đưa sidebar, task card và biểu đồ vào WebGL. Chỉ đưa map, room, agent và đường di chuyển vào Canvas.

## Chạy AI CLI trên cả ba OS

Tạo một adapter chung:

```ts
export interface AgentAdapter {
  id: string;
  displayName: string;

  detect(): Promise<boolean>;

  start(input: AgentRunInput): Promise<AgentProcess>;

  send(sessionId: string, message: string): Promise<void>;

  stop(sessionId: string): Promise<void>;
}
```

Implement:

```text
ClaudeAdapter
KiroAdapter
CodexAdapter
GeminiAdapter
ShellAdapter
```

Command resolver:

```ts
const commands = {
  claude: {
    win32: ["claude.exe", "claude.cmd", "claude"],
    darwin: ["claude"],
    linux: ["claude"],
  },
  codex: {
    win32: ["codex.exe", "codex.cmd", "codex"],
    darwin: ["codex"],
    linux: ["codex"],
  },
};
```

Ứng dụng tự kiểm tra:

```text
Claude CLI installed     ✓
Kiro CLI installed       ✓
Codex CLI not found      Install required
Docker running           ✓
Git available            ✓
```

## Terminal tích hợp

Dùng:

```text
xterm.js
node-pty
```

Mỗi agent có terminal riêng:

```text
Agent Planner Terminal
Agent Coder Terminal
Agent Reviewer Terminal
Agent Tester Terminal
```

Luồng dữ liệu:

```text
CLI stdout
   ↓
Main Process
   ↓ IPC event
Renderer
   ↓
xterm.js + Agent Animation
```

Khi CLI xuất:

```text
Reading src/auth/login.ts
```

Map sẽ hiển thị:

```text
Coder → Coding Zone
Status: Reading Files
```

Khi CLI chạy:

```text
npm test
```

Agent có thể di chuyển sang Testing Zone.

## Trạng thái agent

```ts
export type AgentStatus =
  | "idle"
  | "queued"
  | "planning"
  | "moving"
  | "reading"
  | "coding"
  | "testing"
  | "reviewing"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "stopped";
```

Mỗi trạng thái ánh xạ sang animation:

```ts
const animationMap = {
  idle: "Idle",
  planning: "Thinking",
  moving: "Walking",
  reading: "Reading",
  coding: "Typing",
  testing: "Testing",
  reviewing: "Reviewing",
  completed: "Celebrate",
  failed: "Error",
};
```

## Database local

Phase đầu dùng SQLite:

```text
projects
agents
tasks
agent_runs
agent_events
terminal_logs
workflows
workflow_steps
approvals
settings
```

Không cần PostgreSQL cho một desktop app local.

Sau này khi muốn sync nhiều máy:

```text
Local SQLite
     ↓
Cloud Sync API
     ↓
PostgreSQL
```

## Project isolation

Mỗi agent nên làm việc trên một Git worktree:

```text
project/
├── main/
└── .agent-worktrees/
    ├── coder-task-001/
    ├── reviewer-task-001/
    └── tester-task-001/
```

Như vậy nhiều agent có thể chỉnh cùng một project mà ít đụng nhau.

```bash
git worktree add \
  .agent-worktrees/coder-task-001 \
  -b agent/coder-task-001
```

## Security bắt buộc

Renderer 3D không được quyền trực tiếp:

```text
Đọc toàn bộ filesystem
Chạy shell command
Đọc environment variables
Truy cập API keys
Điều khiển Docker
```

Chỉ expose một số API qua preload:

```ts
contextBridge.exposeInMainWorld("agentic", {
  projects: {
    selectFolder: () => ipcRenderer.invoke("project:select-folder"),
  },

  agents: {
    start: request => ipcRenderer.invoke("agent:start", request),
    stop: id => ipcRenderer.invoke("agent:stop", id),
  },

  events: {
    subscribe: callback => {
      ipcRenderer.on("agent:event", (_, event) => callback(event));
    },
  },
});
```

Electron khuyến nghị bật context isolation và dùng preload/context bridge để không làm lộ API đặc quyền cho renderer. ([Electron][4])

Browser window:

```ts
new BrowserWindow({
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
```

## File cài đặt cho từng OS

Electron Forge có thể tạo các định dạng phân phối riêng cho từng hệ điều hành. ([Electron Forge][5])

```text
Windows
├── AgenticWorkspaceSetup.exe
└── AgenticWorkspace.msi

macOS
├── AgenticWorkspace.dmg
└── AgenticWorkspace.app

Linux
├── AgenticWorkspace.AppImage
├── agentic-workspace.deb
└── agentic-workspace.rpm
```

Electron Forge hỗ trợ tạo Squirrel installer cho Windows và package `.deb` cho Linux. ([Electron Forge][6])

Các architecture nên build:

```text
Windows x64
Windows ARM64

macOS Intel x64
macOS Apple Silicon ARM64

Linux x64
Linux ARM64
```

Electron cung cấp binary theo các platform và architecture như `win32`, `darwin`, `linux` và `arm64`. ([Electron][7])

## CI/CD build ba hệ điều hành

```yaml
strategy:
  matrix:
    include:
      - os: windows-latest
        command: pnpm make:windows

      - os: macos-latest
        command: pnpm make:macos

      - os: ubuntu-latest
        command: pnpm make:linux
```

Release kết quả:

```text
GitHub Release
├── Windows installer
├── macOS DMG
└── Linux AppImage/DEB
```

## Phase 1 nên có gì?

Bản đầu nên tập trung vào chức năng thật:

1. Chọn project folder.
2. Tự phát hiện Claude, Kiro và Codex CLI.
3. Tạo agent.
4. Chọn model/CLI cho agent.
5. Giao task bằng prompt.
6. Xem terminal realtime.
7. Start, stop và cancel agent.
8. Hiển thị agent trên bản đồ 3D.
9. Lưu lịch sử task.
10. Xem file thay đổi bằng Git diff.

Chưa cần ở Phase 1:

```text
AI tự chia 20 agent
Multiplayer
Cloud sync
Temporal
Kubernetes
Marketplace
Model 3D quá chi tiết
```

## Stack chốt

```text
Desktop:
Electron + Electron Forge

UI:
React + TypeScript
Vite
Tailwind CSS
shadcn/ui

3D:
Three.js
React Three Fiber
Drei

State:
Zustand
XState

Terminal:
xterm.js
node-pty

Local runtime:
Electron Main Process
Node child_process
Git worktree
Docker optional

Storage:
SQLite

Security:
Preload API
Context Isolation
Command allowlist
Workspace permission
```

**Lựa chọn tốt nhất cho app của bạn hiện tại là Electron + React Three Fiber.** Nó dễ build cross-platform, render 3D đồng nhất hơn và thuận tiện khi cần gọi Claude/Kiro/Codex CLI trực tiếp trên máy người dùng.


