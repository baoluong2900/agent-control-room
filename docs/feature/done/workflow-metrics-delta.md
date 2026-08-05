# 09 — Workflow metrics delta

**Trạng thái: Done · Mức cũ: P2 · Effort: S**

Implemented 2026-08-04: `WorkflowRepository.countRunsInPeriod()` now queries 30-day windows, `WorkflowService.metrics()` emits run/workflow/success deltas when a previous period exists, and the renderer shows up/down arrows with absolute values. Verified with workflow metrics tests and `npm run typecheck`.

## Trạng thái hiện tại

Đã sửa. Service không còn để các field delta là code chết: repository có query theo cửa sổ thời gian, `WorkflowService.metrics()` so sánh hai window 30 ngày liền nhau khi đủ dữ liệu, và renderer hiển thị delta tăng/giảm với giá trị tuyệt đối thay vì hardcode mũi tên tăng.

Các cột `baseline_*` cũ trong DB vẫn là legacy vô hại. Chúng không phải nguồn sự thật cho metric delta; source of truth hiện là `workflow_runs.started_at` trong các query windowed.

## Quyết định trước khi code

Có hai đường, và đường nào cũng đúng — nhưng phải chọn một, đừng để nguyên trạng:

**Đường A — bỏ delta.** Xoá bốn field khỏi contract, xoá nhánh render tại `WorkflowsModule.tsx:560`, xoá bốn cột `baseline_*` vết tích. Mất khoảng một giờ. Hợp lý nếu "so với tháng trước" không thực sự là thông tin người dùng cần — với một app local mới dùng vài ngày, so sánh tháng gần như luôn vô nghĩa.

**Đường B — tính thật.** Thêm query theo cửa sổ và tính delta. Mất khoảng một ngày. Hợp lý nếu Analytics là hướng phát triển (`AnalyticsModule` đã là module dữ liệu thật, xem ghi chú dưới).

**Đề xuất: đường B, nhưng đổi nhãn.** "So với tháng trước" là sai đơn vị cho một app dùng theo ngày. Cửa sổ 7 ngày so với 7 ngày trước đó có ý nghĩa hơn nhiều, và cùng chi phí thực hiện.

Lý do nghiêng về B thay vì A: `AnalyticsModule.tsx:53-58` **đã** dùng dữ liệu thật (`workflows.list()`, `workflows.metrics()`, `workflows.activity(8)`, `tasks.list()`), và tự tính trend 14 ngày bằng `buildTrend` (`:458-476`), average duration (`:494-507`), rank theo CLI (`:509`) và project (`:536`). Nghĩa là logic tính theo cửa sổ thời gian **đã tồn tại trong renderer**. Đường B chủ yếu là chuyển ý tưởng đó xuống main process và dùng lại, không phải phát minh mới.

## Thiết kế (đường B)

Thêm query theo cửa sổ vào `WorkflowRepository`:

```ts
runStatsBetween(fromIso: string, toIso: string): { runs: number; succeeded: number };
```

Dùng `where started_at >= ? and started_at < ?` với index phù hợp trên `started_at` (kiểm tra index hiện có trước khi thêm).

Trong `metrics()` (`workflow-service.ts:104`), tính hai cửa sổ liền nhau (7 ngày gần nhất, và 7 ngày trước đó) rồi ra phần trăm thay đổi.

Ba điểm dễ sai với phép chia phần trăm, cần xử lý tường minh:

1. **Cửa sổ trước bằng 0.** `(5 - 0) / 0` là vô cực. Trả `undefined` (UI đã ẩn đúng) thay vì `Infinity` hoặc `100`.
2. **Cả hai bằng 0.** Không có thay đổi, không phải tăng 0% — cũng nên `undefined` để không hiện "▲ 0%" gây nhiễu.
3. **Không đủ dữ liệu lịch sử.** App mới cài chưa có 14 ngày dữ liệu. Nếu run cũ nhất mới 3 ngày, một delta "7 ngày so với 7 ngày trước" là dối. Kiểm tra tuổi dữ liệu và trả `undefined` cho tới khi đủ.

Điểm 3 là lý do chính khiến field này nên trả `undefined` một cách chủ động chứ không phải "cứ tính ra số nào đó".

`totalWorkflows` và `activeWorkflows` là số đếm hiện tại, không phải sự kiện theo thời gian — delta cho chúng cần lịch sử số lượng workflow theo thời điểm, mà DB không lưu. Hoặc bỏ hai delta đó, hoặc thêm bảng snapshot đếm theo ngày. **Đề xuất bỏ**: `totalDeltaPercent` và `activeDeltaPercent` xoá khỏi contract, chỉ giữ `runsDeltaPercent` và `successDeltaPercent` là hai thứ thực sự có dữ liệu chuỗi thời gian.

## Các phase

1. **Dọn vết tích**: xoá bốn cột `baseline_*` khỏi `ensureColumns` (`workflow-repository.ts:154-157`) và type (`:30-33`). Cột đã tồn tại trong DB người dùng thì để nguyên (xoá cột trong SQLite tốn kém, và chúng vô hại); chỉ ngừng khai báo chúng như thể có ý nghĩa. Thêm comment nói rõ chúng là legacy.
2. **Thu hẹp contract**: bỏ `totalDeltaPercent`, `activeDeltaPercent`. Cập nhật `WorkflowsModule.tsx:521`/`:528` tương ứng.
3. **Thêm query + tính toán**: `runStatsBetween`, rồi gán hai delta còn lại trong `metrics()`.
4. **Đổi nhãn UI**: `WorkflowsModule.tsx:560` từ "from last month" thành "so với 7 ngày trước".

## Test

Mở rộng `tests/workflow-repository.test.ts` (đã có trong `test:workflows`):

| Case | Khẳng định |
| --- | --- |
| Có dữ liệu hai cửa sổ | Delta tính đúng dấu và giá trị |
| Cửa sổ trước rỗng | `undefined`, không phải `Infinity` |
| Cả hai rỗng | `undefined`, không phải 0 |
| Dữ liệu chưa đủ 14 ngày | `undefined` |
| Run đúng biên cửa sổ | Không bị đếm hai lần (kiểm tra `>=` và `<`) |

## Acceptance

- [x] Workspace có run trong hai cửa sổ 30 ngày → thẻ metrics hiện delta đúng dấu.
- [x] Workspace mới cài hoặc thiếu dữ liệu trước đó → không hiện delta nào, không hiện `0%` gây nhiễu.
- [x] Contract không còn field delta nào mà service không tính.
- [x] Workflow repository/service tests và `npm run typecheck` xanh.
