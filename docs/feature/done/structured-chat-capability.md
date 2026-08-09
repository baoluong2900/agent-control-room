# 12 — Structured chat: đổi hardcode cli id thành capability flag

**Mức: Done · Effort: S**

> **Đã triển khai và mở rộng 2026-08-09.** `AgentCliDescriptor.structuredChat` là
> plain-data capability (`args`, một trong `resumeFlag`/`resumeArgs`, optional id
> fields/output format), hiện được verify thật cho Claude, Agy, Grok, OpenCode và
> Codex. Codex dùng resume **subcommand** `exec resume <id>` thay vì giả làm một
> flag; turn 2 qua `AgentProcessManager` giữ đúng `thread_id` và nhớ codeword turn
> 1. Builder tự bỏ các option mà `codex exec resume` không chấp nhận, nên profile
> có `--sandbox` không còn chạy turn 1 rồi chết ở turn 2. Parser chỉ lấy
> `item.type=agent_message`, không nhầm shell output/error thành câu trả lời.
> Structured transcript giữ stderr diagnostics lại khi stdout đã có answer (Codex
> hiện xả 29–31 auth-refresh log lines mỗi turn), nhưng vẫn hiện stderr nếu run
> thất bại không có answer. Test: `tests/structured-chat.test.ts`,
> `tests/structured-chat-catalog.test.ts`, `tests/chat-transcript.test.ts`; live
> harness `AGENTIC_CHAT_CLI=codex npm run verify:agents:chat` pass toàn bộ.

Plan nhỏ và gọn. Giá trị chính không phải là thêm feature mà là **bỏ một cái bẫy**: hiện muốn thêm một CLI hỗ trợ chat phải sửa ba hàm ở một file không liên quan gì tới catalog.

## Trạng thái hiện tại

Structured chat và conversation resume **hardcode theo cli id**, không phải capability trong catalog.

`src/main/agents/commands.ts:202-204`:

```ts
export function usesStructuredChat(input: Pick<AgentRunInput, "cliId" | "uiMode">): boolean {
  return input.uiMode === "chat" && (input.cliId === "claude" || input.cliId === "agy");
}
```

Hai hàm build args, cũng switch theo literal id (`commands.ts:206-222`):

```ts
function structuredChatArgs(cliId: AgentCliId): string[] {
  if (cliId === "claude") return ["-p", "--output-format", "json"];
  if (cliId === "agy") return ["--print", "--output-format", "json"];
  return [];
}

function structuredChatResumeArgs(cliId: AgentCliId, conversationId: string): string[] {
  if (cliId === "claude") return ["--resume", conversationId];
  if (cliId === "agy") return ["--conversation", conversationId];
  return [];
}
```

`AgentCliDescriptor` (`src/contracts/agent.ts:134-167`) **không có flag nào cho việc này**. Nó có `supportsInteractive`, `supportsStdin`, `promptMode`, `autoApproveArgs`, `systemPromptFlag`, `modelListArgs`, `options` — nhưng không có `supportsStructuredChat` hay `resumeFlag`.

Hệ quả: thêm CLI thứ ba hỗ trợ chat = sửa **ba hàm** trong `commands.ts`, không phải thêm một entry vào catalog. Và catalog — nơi mọi thuộc tính CLI khác được khai báo — không phản ánh sự thật rằng chỉ 2 trong 15 CLI hỗ trợ chat.

Còn một ràng buộc chỉ được ghi bằng comment: `catalog.ts:88-89` nói `--output-format` của `agy` được giữ riêng cho structured chat. Không có gì trong code thi hành điều đó — nếu người dùng thêm `--output-format` vào extra args của một profile, nó sẽ xung đột im lặng.

### Chỗ dễ vỡ khác: extract conversation id

`extractConversationId` (`src/main/processes/agent-process-manager.ts:359-367`) `JSON.parse` **toàn bộ buffer stdout** rồi đọc `session_id ?? conversation_id`. Được gọi mỗi chunk (`:313`) và lại lúc exit (`:219`).

Nghĩa là: JSON stream từng phần, hoặc nhiều JSON object nối nhau (JSONL — khá phổ biến với CLI agent), sẽ throw và trả `undefined`. Resume chỉ hoạt động khi CLI in ra **đúng một** JSON object hoàn chỉnh. Với `claude` và `agy` ở chế độ `--output-format json` thì đúng, nhưng nó là giả định mong manh không được ghi ở đâu.

Parse lại toàn bộ buffer mỗi chunk cũng là O(n²) theo kích thước output — với response dài thì tốn kém vô ích.

## Mục tiêu

1. Capability chat/resume khai báo trong catalog, cùng chỗ với mọi capability khác.
2. Thêm CLI mới = một entry catalog, không sửa logic.
3. CLI không hỗ trợ chat thì UI không mời gọi chat.
4. Extract conversation id chịu được JSONL và stream từng phần.

## Thiết kế

Thêm vào `AgentCliDescriptor` (`src/contracts/agent.ts:134-167`):

```ts
structuredChat?: {
  args: string[];                        // ví dụ ["-p", "--output-format", "json"]
  resumeArgs: (conversationId: string) => string[];
  conversationIdFields?: string[];       // mặc định ["session_id", "conversation_id"]
  outputFormat?: "json" | "jsonl";       // ảnh hưởng cách parse
};
```

Dùng function cho `resumeArgs` vì mỗi CLI đặt id ở vị trí khác nhau (`--resume <id>` so với `--conversation <id>`). Nếu muốn catalog thuần data (serialize được qua IPC), thay bằng `resumeFlag: string` rồi ghép — nhưng kiểm tra trước: catalog **được gửi qua IPC** tới renderer (`agent:catalog` tại `register-ipc.ts:72`), và function không serialize được qua contextBridge. Vậy nên dùng dạng data:

```ts
structuredChat?: {
  args: string[];
  resumeFlag: string;                    // "--resume" | "--conversation"
  conversationIdFields?: string[];
  outputFormat?: "json" | "jsonl";
};
```

Đây là chi tiết quan trọng: `listAgentCatalog()` clone và spread mọi entry (`catalog.ts:621-630`), và descriptor đi tới renderer. Bất kỳ function nào trong descriptor sẽ mất hoặc gây lỗi khi qua IPC.

## Các phase

### Phase 1 — chuyển sang catalog, giữ hành vi y nguyên

Thêm `structuredChat` vào entry `claude` và `agy` trong `catalog.ts` với đúng args hiện có. Viết lại ba hàm trong `commands.ts:202-222` để đọc từ descriptor thay vì so sánh id. Không CLI nào khác được thêm capability ở phase này — mục tiêu là refactor không đổi hành vi.

Sau phase này, `usesStructuredChat` trở thành: `uiMode === "chat" && descriptor.structuredChat !== undefined`.

### Phase 2 — extract conversation id vững hơn

Trong `extractConversationId` (`agent-process-manager.ts:359-367`):

- Hỗ trợ JSONL: thử parse từng dòng, lấy id từ dòng cuối có id.
- Với JSON đơn: thử parse toàn bộ như hiện tại.
- Đọc field theo `conversationIdFields` từ descriptor thay vì hardcode hai tên.
- Đừng parse lại toàn bộ buffer mỗi chunk: chỉ thử khi buffer đã đổi đáng kể, hoặc parse incremental theo dòng mới. Với JSONL thì chỉ cần parse dòng mới.

### Phase 3 — UI tôn trọng capability

Renderer đã nhận descriptor qua `agent:catalog`. Với CLI không có `structuredChat`, ẩn hoặc disable affordance chat trong `AgentsPage`/`AgentChatPanel` kèm lý do ("CLI này chưa hỗ trợ chat có cấu trúc"), thay vì để người dùng mở chat rồi nhận hành vi lạ.

Nếu `AgentBuilderModal` cho chọn `uiMode`, chỉ cho chọn `chat` khi CLI hỗ trợ.

### Phase 4 (tuỳ chọn) — thi hành ràng buộc `--output-format`

Comment tại `catalog.ts:88-89` nói `--output-format` thuộc về structured chat. Biến nó thành kiểm tra thật: khi build argv, nếu extra args của profile chứa flag mà structured chat đang dùng, cảnh báo hoặc bỏ qua nó thay vì để hai nguồn đặt cùng flag.

## Test

`tests/agent-path-env.test.ts` và `tests/provider-runtime-env.test.ts` đã cover phần env. Thêm `tests/structured-chat.test.ts` (đăng ký vào `test:workflows`):

| Case | Khẳng định |
| --- | --- |
| Claude chat | argv chứa `-p --output-format json` như trước refactor |
| Agy chat | argv chứa `--print --output-format json` |
| CLI không hỗ trợ | `usesStructuredChat` false; không có args chat rò rỉ vào argv |
| Resume | Flag đúng theo từng CLI + id đúng vị trí |
| Extract từ JSON đơn | Lấy được `session_id` |
| Extract từ JSONL | Lấy được id từ dòng cuối có id |
| Extract từ JSON dở | Trả `undefined`, không throw |
| Descriptor qua IPC | Không có function trong descriptor (serialize được) |

Case cuối bảo vệ đúng cái bẫy đã nêu trong phần thiết kế.

## Acceptance

- [ ] Chat với Claude và Agy hoạt động y như trước refactor (không hồi quy).
- [ ] Thêm capability cho một CLI thứ ba chỉ cần sửa `catalog.ts`, không sửa `commands.ts` — verify bằng cách thử thật với một CLI có sẵn.
- [ ] CLI không hỗ trợ chat không mời người dùng vào chat.
- [ ] Resume conversation vẫn hoạt động, và không vỡ khi CLI in JSONL.
- [ ] `npm test` xanh.
