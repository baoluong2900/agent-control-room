# 03 — Workflow step ↔ agent profile binding (editor picker)

**Mức: P0 · Effort: S · Loại: data-loss bug đang tồn tại**

Đây là plan nên làm **đầu tiên** trong toàn bộ danh sách. Không phải vì nó lớn, mà vì nó là chỗ duy nhất người dùng có thể mất dữ liệu bằng một hành động bình thường (mở workflow ra sửa tên rồi Save).

## Trạng thái hiện tại

Backend cho phép mỗi workflow step chạy bằng một agent profile cụ thể, và phần đó **đã hoàn chỉnh**:

- `resolveStepProfile()` tại `src/main/workflows/workflow-service.ts:581` tra `step.profileId`, bỏ qua profile đã xoá hoặc đang disabled.
- Profile cung cấp `cliId`, `model`, `systemPrompt`, `extraArgs`, `commandOverride`, `promptMode`, `autoApprove`, `options` tại `workflow-service.ts:610-625`.
- `resolveProviderEnv()` tại `workflow-service.ts:630` inject credential vào env của child process (`workflow-service.ts:659`).
- Persist qua hai cột `profile_id` / `provider_connection_id` tại `src/main/database/workflow-repository.ts:166-167`, bind khi ghi tại `:249-250`, hydrate khi đọc tại `:546-547`.
- Migration version 4 `workflow-step-agent-binding` tại `src/main/database/migrations.ts:60-68`.

Vấn đề nằm ở editor:

- `src/renderer/workflows/WorkflowEditorDrawer.tsx` **không có bất kỳ tham chiếu nào tới `profileId`** — `grep -c profileId` trả về 0.
- `handleSave()` tại `WorkflowEditorDrawer.tsx:194-207` build step payload **thiếu cả `profileId` và `providerConnectionId`**.
- `WorkflowRepository.save()` tại `workflow-repository.ts:321` **ghi lại toàn bộ step rows** (delete + insert, không phải update từng field).

Ba điều đó cộng lại thành bug: một workflow có step bound tới profile, người dùng mở editor sửa bất cứ thứ gì rồi Save → payload không mang `profileId` → repository ghi lại step rows với `profile_id = null` → **binding biến mất im lặng**. Không có warning, không có cách undo. Người dùng chỉ phát hiện khi lần chạy tiếp theo dùng CLI mặc định thay vì profile họ đã chọn.

Và vì editor chưa bao giờ set được `profileId`, cách duy nhất để có một step bound hiện tại là seed data hoặc sửa SQLite tay — nên feature backend này thực tế **không tiếp cận được từ UI**.

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

- [ ] Mở một workflow có step bound, sửa tên workflow, Save → query SQLite thấy `profile_id` không đổi.
- [ ] Editor cho chọn profile cho step; chọn xong Save, chạy workflow → log cho thấy CLI/model của profile được dùng, không phải step CLI.
- [ ] Xoá profile đang được một step dùng → editor hiện "Missing profile", run log nói rõ đã fallback.
- [ ] `npm test` xanh, `tests/workflow-agent-binding.test.ts` có tên trong `package.json` script `test:workflows`.

## Ghi chú khi làm

`WorkflowRepository.save()` ghi lại toàn bộ step rows thay vì diff từng field. Đó là lý do bug này tồn tại và cũng là bẫy cho mọi field step thêm sau này: **bất kỳ field nào editor không gửi lên sẽ bị xoá**. Nếu có thời gian, cân nhắc thêm comment tại `workflow-repository.ts:321` nói rõ ràng buộc đó, để field tiếp theo không lặp lại lịch sử.
