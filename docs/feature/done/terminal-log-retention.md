# 08 — Terminal log retention

**Trạng thái: Done · Mức cũ: P1 · Effort: S**

Implemented 2026-08-04: terminal log messages are byte-capped with a visible middle truncation marker, rows are pruned per run, old finished-run logs are swept on startup, and regression coverage lives in `tests/log-retention.test.ts` plus database lifecycle tests.

## Trạng thái hiện tại

Đã sửa. `appendTerminalLog` áp policy tập trung ở database layer: message dài bị cắt giữa với marker nhìn thấy được, mỗi run bị prune về số row tối đa, và startup sweep xoá log cũ của run đã kết thúc. UI/read path vẫn giữ cap hiển thị riêng, nhưng DB không còn lưu vô hạn phần output mà renderer không bao giờ đọc.

Phần chưa làm và được để ngoài scope plan này: UI Settings/Diagnostics chưa có màn hình dung lượng log + nút xoá thủ công. Đó là phần control-plane/observability nhỏ, không còn là bug phình DB chính.

## Mục tiêu

Log đủ để debug một run, không đủ để làm phình DB. Ba tầng bảo vệ, không tầng nào một mình đủ:

1. Giới hạn kích thước một message (chống một dòng khổng lồ).
2. Giới hạn số row mỗi run (chống agent lặp vô hạn).
3. Dọn log của run cũ theo tuổi/tổng dung lượng (chống tích tụ dài hạn).

## Thiết kế

Đặt policy ở một chỗ, cạnh `appendTerminalLog`, để mọi caller đều chịu cùng ràng buộc. `agent-process-manager.ts:253`/`:352` không nên phải tự biết về cap.

```ts
const maxMessageBytes = 16_000;    // một chunk dài hơn thì cắt giữa, giữ đầu và cuối
const maxLogsPerRun = 5_000;       // vượt thì xoá row cũ nhất của run đó
const retentionDays = 14;          // dọn log của run đã kết thúc quá hạn
```

Ba con số này nên đọc được từ settings về sau, nhưng đừng chờ có UI settings mới làm — hardcode có comment rõ vẫn tốt hơn không có gì.

**Cắt phải nhìn thấy được.** Khi một message bị cắt, chèn marker rõ ràng (ví dụ `… [đã cắt 240KB] …`) chứ đừng cắt im lặng. Người debug cần biết mình đang xem dữ liệu thiếu. Cùng nguyên tắc với `knowledge-truncation-report.md`.

Lưu ý về `workflow-service.ts:528`: workflow step output đã có `output.slice(-4000)`. Nghĩa là repo này đã có một chỗ hiểu vấn đề rồi — nhưng chỉ một chỗ, và với con số khác. Cân nhắc dùng chung helper để hai đường không lệch nhau.

## Các phase

### Phase 1 — cap per-message và per-run

Trong `appendTerminalLog` (`desktop-database.ts:500-507`): cắt message vượt `maxMessageBytes`, giữ phần đầu và phần cuối (phần cuối thường quan trọng hơn — stack trace, exit message), chèn marker ở giữa.

Cap per-run: sau khi insert, nếu số row của `runId` vượt `maxLogsPerRun`, xoá row cũ nhất. Đếm mỗi lần insert là tốn kém; rẻ hơn là chỉ kiểm tra định kỳ (mỗi N insert) hoặc dùng một counter trong bộ nhớ theo run. Index tại `:1059` nên đã hỗ trợ query theo `run_id` — verify nó bao gồm cột cần thiết trước khi thêm query mới.

### Phase 2 — dọn theo tuổi lúc mở app

Trong `DesktopDatabase.open()` (`:177-186`), sau khi migrate: xoá log của run đã kết thúc và cũ hơn `retentionDays`. Chỉ áp cho run đã kết thúc — đừng xoá log của run đang chạy dù nó bắt đầu từ lâu.

Cân nhắc `vacuum` sau lần dọn lớn, nhưng **không** mỗi lần mở app: vacuum trên DB lớn chậm và làm app khởi động lâu. Chỉ chạy khi vừa xoá nhiều, hoặc để một hành động thủ công trong Settings.

Cũng tại đây: dọn log của run mà agent profile/task liên quan đã bị xoá (hiện `deleteTask` tại `:682` để lại log mồ côi).

### Phase 3 — cho người dùng thấy và điều khiển

Hiện dung lượng log trong Settings hoặc Diagnostics, kèm nút xoá log cũ. Không cần phức tạp — một dòng "Terminal logs: 240 MB" cộng một nút là đủ để người dùng tự xử lý trước khi thành vấn đề.

[`diagnostics-tiers.md`](diagnostics-tiers.md) dùng "database health" làm chỗ tự nhiên cho thông tin này.

## Test

Thêm `tests/terminal-log-retention.test.ts` (nhớ đăng ký vào `test:workflows` ở `package.json:25`).

| Case | Khẳng định |
| --- | --- |
| Message dài | Bị cắt, có marker, giữ được cả đầu và cuối |
| Vượt cap per-run | Số row không vượt `maxLogsPerRun`; row còn lại là row mới nhất |
| Retention | Log của run đã kết thúc quá hạn bị xoá; log run đang chạy **không** bị xoá |
| Run mới | Không bị ảnh hưởng bởi lần dọn |
| Đọc lại | `listTerminalLogs` vẫn trả đúng thứ tự tăng dần sau khi có xoá |

## Acceptance

- [x] Chạy một agent in ra nhiều dòng → số row trong `terminal_logs` dừng ở cap, không tăng vô hạn.
- [x] Một dòng output rất lớn không làm phình DB và hiện marker đã cắt trong terminal.
- [x] Mở lại app sau khi có log cũ hơn hạn → chúng bị dọn, log run đang chạy còn nguyên.
- [x] Terminal UI vẫn hiện đúng output của run hiện tại (không hồi quy hiển thị).
- [x] Regression tests cho retention/pruning/truncation đã có trong suite workflow.
