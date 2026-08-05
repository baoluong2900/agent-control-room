# 03 — Workflow step ↔ agent profile binding (editor picker)

**Trạng thái: Done · Mức cũ: P0 · Effort: S · Loại: data-loss bug đã sửa**

Implemented 2026-08-04: workflow step profile/provider binding is now preserved by the editor, profile selection is available in the workflow editor, runtime uses the selected profile/provider env, and step output can feed later steps through `{{previous.output}}` / `{{steps.<id|name>.output}}`. Regression coverage lives in `tests/workflow-agent-binding.test.ts`.

## Trạng thái hiện tại

Đã sửa. Backend binding, persistence, migration, editor picker, and save round-trip are now aligned:

- `WorkflowStepDefinition` carries `profileId` / `providerConnectionId` through contract, repository save/read, and workflow execution.
- Editor includes the binding fields instead of dropping them during `handleSave()`.
- Runtime resolves the selected profile, CLI/model/options/prompt, and provider credential env before spawning step processes.
- Step chaining is implemented through step context interpolation, so bound steps can consume previous output.

Remaining hardening is incremental UX only: keep warning clearly if a saved workflow references a missing/disabled profile, and ensure future step fields are always included in editor save payloads.

## Mục tiêu

1. Editor có picker chọn agent profile cho từng step, mặc định "Use step CLI" (tức `profileId = undefined`, giữ hành vi cũ).
2. Save round-trip giữ nguyên binding — mở ra, sửa tên workflow, save, binding vẫn còn.
3. Nếu step bound tới một profile đã bị xoá/disabled, UI nói rõ chứ không im lặng fallback.

## Thiết kế

**Không cần đổi contract.** `WorkflowStep` đã có `profileId?` và `providerConnectionId?`, `WorkflowSaveInput` đã chấp nhận chúng. Đây thuần là công việc renderer. Đó cũng là lý do effort nhỏ — không đụng IPC, không đụng schema.

Editor cần danh sách profile. Đã có sẵn IPC `agent:profiles` (`src/contracts/ipc.ts:75`, `agents.listProfiles()`), và `agents-store` đã load profiles cho trang Agents nên có thể tái dùng thay vì gọi IPC lần nữa — kiểm tra `src/renderer/stores/agents-store.ts` xem selector nào expose `profiles` trước khi thêm fetch mới.

Shape cho draft step trong drawer: thêm `profileId?: string` vào type draft step hiện có (quanh `WorkflowEditorDrawer.tsx:39` nơi `triggerDetail` được khai báo, step draft type ở gần đó).

## Các phase

### Phase 1 — chặn mất dữ liệu (làm ngay, độc lập)

Đây là phần quan trọng nhất và có thể ship riêng trong vài phút: cho `handleSave()` **truyền lại** `profileId` và `providerConnectionId` từ step gốc, kể cả khi UI chưa cho sửa chúng.

Tại `WorkflowEditorDrawer.tsx:194-207`, khi build step payload, copy hai field đó từ step ban đầu (drawer đã giữ workflow gốc để init draft tại `:82`/`:97` — dùng nguồn đó). Sau phase này, binding tồn tại được qua vòng save dù chưa có picker.

Test hồi quy trước khi sửa: viết test khẳng định save round-trip giữ `profileId`. Đã có `tests/workflow-agent-binding.test.ts` (untracked, đang được viết) — đọc nó trước, mở rộng thay vì tạo file trùng.

### Phase 2 — thêm picker vào editor

Trong khối render từng step (quanh `WorkflowEditorDrawer.tsx:344`–`:349` nơi có nút reorder/remove), thêm một `<select>`:

- Option đầu: `Use step CLI` → `value=""` → patch `profileId: undefined`.
- Sau đó mỗi profile enabled: label là tên profile + CLI của nó, để người dùng biết profile này chạy bằng gì.
- Profile đang `disabled` không xuất hiện trong option list.

Khi một profile được chọn, dropdown CLI của step nên thành read-only hoặc hiện rõ là bị override — vì `workflow-service.ts:610` lấy `cliId` **từ profile**, giá trị CLI của step bị bỏ qua. Nếu UI vẫn cho sửa CLI trong khi profile override nó, người dùng lại bị đánh lừa lần nữa (đúng loại bug mà plan này đang sửa).

### Phase 3 — surface binding đã hỏng

`resolveStepProfile()` (`workflow-service.ts:581`) im lặng bỏ qua profile đã xoá hoặc disabled, rồi step chạy bằng CLI mặc định. Người dùng không biết.

Hai chỗ cần nói ra:

1. **Editor**: nếu `step.profileId` không khớp profile nào đang tồn tại, render option "Missing profile (<id>)" ở trạng thái cảnh báo, thay vì reset im lặng về "Use step CLI" — reset im lặng sẽ *xoá* binding ở lần save tiếp theo, tái tạo đúng bug này.
2. **Run log**: khi `resolveStepProfile` fallback, append một dòng log vào step run nói rõ profile nào bị bỏ và vì sao (deleted / disabled). Dùng cùng đường ghi log mà step execution đang dùng.

`WorkflowDetailPanel.tsx` cũng nên hiện profile name cho step đã bound để trạng thái nhìn được mà không cần mở editor.

## Test

Mở rộng `tests/workflow-agent-binding.test.ts` (đã tồn tại untracked; đã có trong `test:workflows` theo diff `package.json` hiện tại — verify lại). Các case:

| Case | Khẳng định |
| --- | --- |
| Round-trip save | Save một workflow có step `profileId` set, đọc lại, `profileId` vẫn còn |
| Save không kèm profileId | Mô phỏng payload editor cũ → khẳng định binding **không** bị xoá sau phase 1 |
| Profile bị xoá | `resolveStepProfile` trả undefined và run vẫn tiếp tục bằng step CLI |
| Profile disabled | Cùng như trên, không crash |

Case thứ hai là test canary cho chính bug này — nếu ai đó sau này refactor `handleSave` và làm rơi field, test đỏ.

## Acceptance

- [x] Mở một workflow có step bound, sửa tên workflow, Save → binding được giữ nguyên.
- [x] Editor cho chọn profile cho step; chọn xong Save, chạy workflow → profile/provider runtime được dùng.
- [x] Step output chaining hoạt động qua `{{previous.output}}` và `{{steps.<id|name>.output}}`.
- [x] `npm run typecheck` và `tests/workflow-agent-binding.test.ts` xanh; test file có tên trong `test:workflows`.

## Ghi chú khi làm

`WorkflowRepository.save()` ghi lại toàn bộ step rows thay vì diff từng field. Đó là lý do bug này tồn tại và cũng là bẫy cho mọi field step thêm sau này: **bất kỳ field nào editor không gửi lên sẽ bị xoá**. Nếu có thời gian, cân nhắc thêm comment tại `workflow-repository.ts:321` nói rõ ràng buộc đó, để field tiếp theo không lặp lại lịch sử.
