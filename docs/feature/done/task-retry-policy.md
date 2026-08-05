# 10 — Task retry policy: hiện có task bị retry vô hạn mỗi 30 giây

**Mức: Done · Effort: M**

> **Đã triển khai.** `src/main/tasks/retry-policy.ts` chứa phân loại lỗi, backoff và
> phát hiện treo; `TaskRecord` có `attemptCount`/`maxAttempts`/`nextRetryAt`/`lastError`
> (migration version 6), `TaskStatus` có `failed`, `listDueTasks` tôn trọng backoff và
> attempt budget, `sweepStalledTasks` reap agent im lặng, và UI có badge attempt +
> nút "Retry Now" (`task:retry-now`). Test: `tests/task-retry-policy.test.ts`.

Xếp P2 nhưng chứa một bug thật đáng chú ý — đọc phần "retry vô hạn" trước khi quyết định thứ tự.

## Trạng thái hiện tại

`TaskRecord` (`src/contracts/task.ts:7-26`) **không có field retry nào**: không `attempts`, `maxAttempts`, `retryAt`, `backoffMs`, `lastError`. `runCount` (`:23`) là counter tăng đơn thuần (tăng tại `desktop-database.ts:658`), **không có ai đọc nó để quyết định có retry hay không**.

`TaskStatus` chỉ có `"open" | "investigating" | "blocked" | "done"` (`:3`) — **không có `"failed"`**. `finishTaskRun` (`desktop-database.ts:667-668`) gộp mọi agent status không phải `completed` thành `"blocked"`. Nên "agent lỗi" và "task bị chặn vì lý do khác" không phân biệt được.

`runDueTasks` (`src/main/tasks/task-automation-service.ts:59-125`):

- Chỉ có guard chống re-entrancy: `if (this.ticking) return {...}` (`:60-62`), reset trong `finally` (`:121`). Cái này chống **tick chồng nhau**, không chống nhiều agent process đồng thời.
- Vòng lặp `:70` là `for…of` với `await agentProcessManager.start(...)` (`:92`) — nhưng `start()` resolve ngay khi child spawn xong, **không đợi exit**. Nên một tick với 20 task due sẽ spawn 20 CLI process cùng lúc. Xem `agent-lifecycle.md` phase 2 cho phần giới hạn đồng thời.
- **Không có timeout per-task.** Agent treo → task ở `"investigating"` mãi mãi.
- Interval: `Math.max(10_000, options.intervalMs ?? 30_000)` (`:27-34`), gọi không tham số từ `main.ts:74`, nên 30 giây.

### Bug: retry vô hạn không backoff

Hành vi retry hiện tại là **tình cờ, không phải thiết kế**:

`listDueTasks` (`desktop-database.ts:570-584`) lọc `automation_enabled = 1 and status = 'open' and due_at <= ?`. `markTaskRunStarted` chuyển status thành `'investigating'` (`:654`), nên task đang chạy rời khỏi tập due — không double-fire. Khi `finishTaskRun` set `'blocked'`, nó cũng không bao giờ fire lại.

**Nhưng**: một task fail **trước khi** kịp ghi DB — nhánh `catch` tại `:109`, ví dụ CLI không có trên PATH — vẫn giữ `'open'` với `due_at` trong quá khứ. Nên nó được **retry mỗi tick 30 giây, mãi mãi, không backoff**. Mỗi lần lại spawn thử, lại fail, lại ghi log.

Nhánh thiếu project (`:71-85`) chủ động set `'blocked'` để tránh đúng chuyện này — nghĩa là tác giả đã nhận ra vấn đề cho một trường hợp mà bỏ sót trường hợp còn lại.

## Mục tiêu

1. Lỗi tạm thời được retry có backoff, không phải mỗi 30 giây.
2. Lỗi vĩnh viễn dừng lại sau số lần cố định, có lý do lưu lại.
3. Phân biệt được "fail" với "blocked".
4. Agent treo không giữ task ở `investigating` mãi.

## Thiết kế

Thêm vào `TaskRecord` (`src/contracts/task.ts:7-26`):

```ts
attemptCount: number;
maxAttempts: number;      // mặc định 3
nextRetryAt?: string;     // ISO; listDueTasks phải tôn trọng field này
lastError?: string;
```

Thêm `"failed"` vào `TaskStatus` (`:3`). `finishTaskRun` (`desktop-database.ts:667-668`) phân biệt: agent fail → `failed`, thiếu điều kiện tiên quyết (không có project, không có CLI) → `blocked`. Hai cái cần hành động khác nhau từ người dùng, nên không được gộp.

Schema đi qua migration mới trong `appMigrations` (`src/main/database/migrations.ts:34`) — append version, đừng sửa version đã release.

Backoff: nhân đôi từ một phút, có trần (1m, 2m, 4m... tối đa 30m). Cộng jitter nhỏ nếu nhiều task fail cùng lúc, để chúng không đồng loạt retry cùng thời điểm.

`listDueTasks` (`desktop-database.ts:570`) đổi điều kiện thành: `due_at <= now` **và** (`next_retry_at` null hoặc `<= now`) **và** `attempt_count < max_attempts`.

## Các phase

### Phase 1 — chặn retry vô hạn (nhỏ, làm ngay)

Trước cả khi thêm schema: trong nhánh `catch` tại `task-automation-service.ts:109`, đừng để task ở `'open'` im lặng. Set `'blocked'` (giống nhánh thiếu project tại `:71-85`) và ghi lý do vào đâu đó người dùng đọc được.

Việc này làm ngừng chảy máu ngay bằng vài dòng, đổi lại là mất khả năng tự retry — chấp nhận được tạm thời, vì hiện tại "tự retry" nghĩa là spam mỗi 30 giây và cũng không bao giờ thành công (CLI thiếu thì lần thứ 100 vẫn thiếu).

### Phase 2 — attempt/backoff thật

Thêm bốn field + `"failed"` status qua migration. Cập nhật `finishTaskRun` và `listDueTasks` theo thiết kế trên.

Trong nhánh `catch`, thay vì `blocked` cứng: tăng `attemptCount`, ghi `lastError`, tính `nextRetryAt`. Nếu đã đạt `maxAttempts` thì set `failed`.

Phân loại lỗi để quyết định có đáng retry: CLI không tồn tại trên PATH thì retry vô nghĩa (fail luôn, `attemptCount = maxAttempts`); lỗi spawn tạm thời hoặc provider rate limit thì đáng retry. Không cần phân loại hoàn hảo — chỉ cần tách "chắc chắn vô vọng" khỏi "có thể do tạm thời".

### Phase 3 — timeout cho task đang chạy

Task ở `'investigating'` quá lâu (ví dụ hơn 2 giờ, cho cấu hình) nên được coi là treo: stop agent run tương ứng, đánh dấu `failed` với lý do timeout, và cho phép retry theo policy phase 2.

Cần cẩn thận không kill task đang chạy hợp lệ mà chỉ lâu — một task refactor lớn có thể chạy hàng giờ. Vì vậy ngưỡng nên rộng và cho cấu hình, và nên dựa vào việc **agent có còn tiến triển** (có output mới) hay không, chứ không chỉ dựa vào thời gian trôi. Nếu `terminal_logs` có row mới trong 15 phút gần đây thì task vẫn sống, dù đã chạy 3 giờ.

### Phase 4 — UI

Hiện `attemptCount/maxAttempts` và `lastError` trên task card trong `TasksModule.tsx`. Task `failed` cần nút "Retry now" để reset `nextRetryAt` và `attemptCount`.

Task `blocked` và `failed` phải trông khác nhau — hiện `statusMeta` xử lý chung; thêm entry cho `failed` với tone khác.

## Test

Mở rộng `tests/task-automation.test.ts` (đã có trong `test:workflows`):

| Case | Khẳng định |
| --- | --- |
| Fail trước khi ghi DB | Không còn ở `open` với `due_at` quá khứ (bug hiện tại) |
| Backoff | `nextRetryAt` tăng theo lần thử; task không due trước thời điểm đó |
| Hết attempt | Status `failed`, không xuất hiện trong `listDueTasks` nữa |
| CLI thiếu | Fail ngay, không tiêu tốn 3 lần thử |
| Retry thủ công | Reset counter và chạy lại được |
| Task treo | Bị timeout khi không có output mới; **không** bị timeout khi vẫn có output |

Case cuối là chỗ dễ làm sai nhất — test cả hai chiều.

## Acceptance

- [ ] Tạo task với CLI không tồn tại → fail một lần với lý do rõ, **không** spam mỗi 30 giây (xem log để xác nhận).
- [ ] Task fail do lỗi tạm thời → retry sau 1 phút, rồi 2, rồi 4, rồi dừng ở `failed`.
- [ ] Task `failed` hiện lý do và nút retry; bấm retry thì chạy lại.
- [ ] Task chạy lâu nhưng vẫn có output → không bị kill.
- [ ] `npm test` xanh.
