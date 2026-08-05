# 11 — Task planner: từ word-count heuristic sang plan có ngữ cảnh

**Trạng thái: Done · Mức cũ: P2 · Effort: M**

Implemented 2026-08-06, cả 3 phase. Heuristic vẫn là mặc định; AI là chế độ
opt-in per request. Chi tiết ở cuối file.

## Trạng thái hiện tại

Planner thuần heuristic, không có LLM nào tham gia.

Độ khó là điểm cộng từ số từ + keyword + số câu (`src/main/tasks/task-planner.ts:159-170`):

```ts
const score = Math.ceil(words / 24) + keywordHits + Math.max(0, sentenceCount - 2);
if (score <= 2) return "small";
if (score <= 4) return "medium";
if (score <= 7) return "large";
return "epic";
```

`keywordHits` đếm khớp substring với danh sách 14 từ cố định tại `:23-38` (`"automation"`, `"database"`, `"electron"`, `"ipc"`, `"sqlite"`, `"workflow"`, …). Vì là `lower.includes(keyword)`, chúng vừa đặc thù cho domain repo này vừa khớp tham lam — chữ "database" trong một task không liên quan gì tới DB vẫn cộng điểm.

Steps là pipeline cố định cắt theo độ khó (`:176-228`): mảng `base` gồm Investigate→`kiro`, Plan→`claude`, Execute→`preferredCliId ?? "codex"`, Verify→`shell`. Rồi `small` trả `base.slice(1)` (3 step, bỏ Investigate), `medium` trả cả 4, `large` thêm Review→`claude` (5), `epic` chèn Analyze→`gemini` và thêm Review (6).

**Việc gán CLI cho từng step là hardcode** — planner chỉ định `kiro`/`claude`/`gemini`/`shell` bất kể **CLI đó có được cài trên máy hay không**. Đây là vấn đề thực tế lớn nhất: một plan sinh ra có thể chứa step không thể chạy được, và người dùng chỉ biết khi nó fail.

Estimate: `estimateMinutes` (`:268-277`) là `base[difficulty] + Math.min(120, Math.max(0, words - 20))` trên bảng cố định `{small:25, medium:60, large:140, epic:260}`. Deadline chia đều giữa now và due time của task cha (`dueForStep`, `:256-266`).

`TaskAutomationService.planTask()` chỉ lưu draft từ `buildTaskPlan(input)`, **không gọi agent/LLM nào**.

Nói cho công bằng: heuristic này *hoạt động* và nó rẻ, tất định, chạy offline. Vấn đề không phải nó tồn tại — mà là UI/mô tả gợi ý một planner hiểu codebase, còn nó thực chất đếm từ.

## Mục tiêu

Hai hướng, làm được cả hai và nên làm theo thứ tự này:

1. **Heuristic trung thực và hữu dụng hơn**: chỉ gán CLI đã cài, và nói rõ đây là plan theo khuôn mẫu.
2. **Thêm chế độ AI plan tuỳ chọn**: dùng agent CLI thật + knowledge snapshot để sinh subtask theo ngữ cảnh project.

Điểm quan trọng: **giữ heuristic làm mặc định**. Nó tức thì, không tốn quota, không cần credential. AI plan là nâng cấp có chủ đích, không phải thay thế.

## Các phase

### Phase 1 — chỉ gán CLI thật sự dùng được (nhỏ, giá trị cao)

`plannerStepsFor` (`task-planner.ts:176-228`) cần biết CLI nào đang khả dụng. Nguồn có sẵn: `pingAgentCli` / `agent:ping-all` (`register-ipc.ts:76`), hoặc `collectDiagnostics` (`src/main/ipc/diagnostics.ts:6`) đã ping toàn bộ 13 CLI.

Truyền danh sách CLI đã cài vào `buildTaskPlan()`, rồi thay từng vị trí hardcode bằng lựa chọn có fallback: ưu tiên CLI dự định (`kiro` cho Investigate), nếu không có thì lấy CLI khả dụng đầu tiên phù hợp vai trò, cuối cùng fallback `shell`.

Nếu **không có** CLI agent nào được cài, plan nên nói thẳng điều đó thay vì sinh ra 4 step không chạy được.

Cache kết quả ping — `collectDiagnostics` gọi `listAgentCatalog()` lại bên trong vòng lặp (`diagnostics.ts:14`) nên clone toàn bộ catalog 14 lần mỗi lần chạy (`catalog.ts:621-630`). Đừng làm planner gánh thêm chi phí đó mỗi lần plan.

### Phase 2 — đổi copy cho đúng

Nhãn UI cho kết quả plan hiện tại nên nói rõ nó là gì: plan theo khuôn mẫu (template plan) dựa trên độ dài và từ khoá, không phải phân tích codebase. Người dùng đọc đúng kỳ vọng thì heuristic là công cụ tốt; đọc sai kỳ vọng thì nó trông như AI kém.

Chỗ sửa nằm trong `TasksModule.tsx` quanh phần gọi `tasks.plan` (`:478`).

### Phase 3 — chế độ AI plan tuỳ chọn

Thêm `mode?: "heuristic" | "ai"` vào `TaskPlanInput` (`src/contracts/task.ts`), mặc định `heuristic` để không đổi hành vi hiện có.

Với `mode: "ai"`, `planTask()` (`task-automation-service.ts:41-57`) làm thêm:

1. Lấy knowledge snapshot của project (`knowledge.get(projectPath)` — đã có, `register-ipc.ts:125`). Nếu chưa có snapshot thì hoặc scan trước, hoặc plan không có ngữ cảnh và nói rõ.
2. Build prompt gồm: yêu cầu của người dùng, danh sách file/symbol liên quan từ snapshot, danh sách CLI khả dụng, và **schema đầu ra mong muốn**.
3. Spawn một agent CLI qua `AgentProcessManager` để sinh plan.
4. Parse output thành `TaskPlanResult`, validate, rồi lưu như draft.

Ba điểm dễ vỡ, cần xử lý tường minh:

- **Output không đúng schema.** LLM sẽ trả JSON lệch hoặc kèm text. Validate chặt và **fallback về heuristic** khi parse fail — đừng để người dùng nhận plan rỗng. Ghi lại lý do fallback.
- **Chi phí và độ trễ.** Plan bằng AI mất vài chục giây và tốn quota. UI phải hiện tiến trình và cho cancel, không phải đóng băng như `knowledge:scan` hiện tại (xem `knowledge-index.md` phase 2 cho cùng vấn đề).
- **Step vẫn phải dùng CLI đã cài.** Ràng buộc từ phase 1 áp cả cho plan do AI sinh: nếu AI đề xuất một CLI không có, map lại hoặc bỏ step đó.

Chế độ này phụ thuộc `provider-connection-truth.md` (cần credential thật sự dùng được) và hưởng lợi từ `knowledge-index.md` (snapshot chính xác hơn thì plan tốt hơn). Không bắt buộc phải chờ, nhưng plan AI trên snapshot có `@contracts` bị dán nhãn external sẽ cho ngữ cảnh sai lệch.

## Test

Mở rộng `tests/task-automation.test.ts` (đã có trong `test:workflows`):

| Case | Khẳng định |
| --- | --- |
| Không có CLI nào cài | Plan không chứa step trỏ CLI không tồn tại |
| Thiếu CLI dự định | Fallback sang CLI khả dụng, không phải bỏ trống |
| Heuristic vẫn tất định | Cùng input cho cùng plan (không hồi quy) |
| AI mode, output hợp lệ | Parse thành subtask đúng |
| AI mode, output rác | Fallback về heuristic, có ghi lý do |
| AI mode, không có snapshot | Không crash |

Test cho AI mode nên mock agent output thay vì gọi CLI thật — suite phải chạy được offline.

## Acceptance

- [x] Máy chỉ cài một CLI → plan sinh ra chỉ dùng CLI đó, không đề cập CLI khác.
      (Verify với `availableCliIds: ["codex","shell"]`: cả 5 agent step dồn về codex.)
- [x] Máy không cài CLI nào → plan nói rõ thay vì sinh step chết.
      (`noAgentsAvailable: true`, mọi step fallback `shell`.)
- [x] Nhãn UI không gọi plan heuristic là phân tích thông minh.
      (`source: "template"`, hint nói thẳng "It does not analyse your codebase".)
- [x] AI mode sinh được subtask theo ngữ cảnh project, và fallback êm khi output không parse được.
      (Live verify: 41.6s, `source=ai`, plan đề xuất cache schema + migration + incremental logic.)
- [x] `npm test` xanh (256/256) và chạy được không cần mạng — test AI mode dùng string
      cố định chứ không gọi CLI thật.

## Đã implement (2026-08-06)

**Phase 1 — chỉ gán CLI đã cài.** `rolePreferences` cho mỗi role một danh sách ưu
tiên; lấy candidate đầu tiên có cài, cuối cùng fallback `shell`.
`TaskAutomationService` probe availability và **cache 5 phút** — ping 13 CLI là 13
process, làm mỗi lần plan thì chậm cho một kết quả chỉ đổi khi user cài thêm.

Ba phân biệt mà implementation phụ thuộc vào:

- **"Chưa được cho biết" khác "không có gì".** `availableCliIds` không truyền →
  giữ nguyên hành vi cũ (tests/harness không bị ảnh hưởng). Mảng rỗng → đã probe
  và thật sự không có. Probe lỗi → trả `undefined`, không phải mảng rỗng, để một
  probe hỏng không dồn cả plan về `shell`.
- **`preferredCliId` chưa cài thì bị bỏ**, vì một preference máy không đáp ứng
  được là một step chết chứ không phải preference.
- **`shell`/`custom` không tính là agent**, nên `noAgentsAvailable` nói "không có
  agent CLI" chứ không phải "không có gì".

**Phase 2 — copy trung thực.** Summary báo `source`, `noAgentsAvailable`, và danh
sách `reassignedSteps` dạng `Analyze: gemini -> claude`. Reassignment được **hiện
ra** chứ không âm thầm áp dụng.

**Phase 3 — AI mode.** `src/main/tasks/ai-planner.ts`. Phần khó không phải prompt
mà là *từ chối tin* output. Mọi failure đều kết thúc bằng template plan +
`fallbackReason`, không bao giờ là plan rỗng:

| Failure | Xử lý |
| --- | --- |
| Không có project folder / không có agent CLI | Fallback, nêu lý do. `shell` bị loại **ở tầng type**, không chỉ filter |
| Timeout 90s, spawn fail, exit != 0 | Fallback. stdout dùng được thì thắng exit code, vì nhiều CLI ghi answer ra stdout và diagnostics ra stderr rồi vẫn exit != 0 |
| Prose thay vì JSON, fence, JSON kèm text | Brace-matching từ `{` đầu tiên, **bỏ qua brace trong string literal** — cách "tìm `}` cuối" hoặc regex sẽ cắt mất plan khi directive có chứa `}` |
| Step trỏ CLI chưa cài | Giữ step, bỏ **chỉ** phần gợi ý CLI, để role resolver của phase 1 gán cái có thật |
| `difficulty` ngoài range | Bỏ qua, dùng lại estimate heuristic |
| Model lan man | Cap 8 step |

Hai ràng buộc có chủ ý: snapshot chỉ được **đọc**, không build — plan không được
âm thầm kích hoạt full scan (project chưa index thì plan không có context, và
prompt nói rõ điều đó để model không tự bịa file path); và timeout **kill child
trước khi reject**, để một lần plan timeout không để lại CLI chạy trên project
của user.

Test: `tests/task-planner-availability.test.ts` (10) và
`tests/task-ai-planner.test.ts` (13). Đã xác nhận load-bearing bằng cách tắt
availability check và thấy 5/10 test đỏ.
