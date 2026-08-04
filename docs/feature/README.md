# Feature plans — Agentic Workspace

Mỗi file trong thư mục này là kế hoạch triển khai cho **một chức năng còn thiếu hoặc chưa chạy được**, đã được verify bằng cách đọc source thật (không copy lại từ doc cũ).

- `docs/unfinished-features.md` = báo cáo *phát hiện* gap (what is broken).
- `docs/feature/*.md` = kế hoạch *sửa* từng gap (how to fix it), mỗi file tự chứa đủ để một người/agent làm một mình.

Ngày verify: **2026-08-04**, tại commit `0a434f1` (`feat: add schema migrations, provider verification, and step chaining`).

## Cách đọc một file plan

Mỗi plan có cùng cấu trúc:

| Mục | Nội dung |
| --- | --- |
| Trạng thái hiện tại | Điều gì thực sự tồn tại trong source, kèm `file:line` |
| Mục tiêu | Định nghĩa "xong" theo hành vi người dùng thấy được |
| Thiết kế | Contract/IPC/service shape trước khi viết code |
| Các phase | Từng bước commit được độc lập, phase sau không phá phase trước |
| Test | File test cần thêm, và phải đăng ký vào `test:workflows` |
| Acceptance | Checklist verify được, không phải "cảm giác xong" |

## Bảng ưu tiên

Thứ tự này tính theo **giá trị / rủi ro**, không phải theo độ khó. Các mục P0 là chỗ UI đang hứa nhiều hơn runtime — người dùng bị đánh lừa, nên sửa trước.

| # | Plan | Mức | Effort | Vấn đề một dòng |
| --- | --- | --- | --- | --- |
| 01 | [workflow-triggers.md](workflow-triggers.md) | **P0** | M | 4/6 trigger được chọn trong UI nhưng không có runner nào chạy |
| 02 | [provider-connection-truth.md](provider-connection-truth.md) | **P0** | S | Verify backend đã xong, nhưng Connect vẫn tự ghi `connected` không cần check |
| 03 | [workflow-step-profile-binding.md](workflow-step-profile-binding.md) | **P0** | S | Backend bind agent profile vào step đã xong, editor không có picker → save là **mất dữ liệu** |
| 04 | [git-workspace.md](git-workspace.md) | P1 | M | Git panel chỉ xem được `--stat`, không xem được hunk; không có write op |
| 05 | [knowledge-index.md](knowledge-index.md) | P1 | L | Full rescan mỗi lần, regex thay vì AST, alias `@contracts` bị coi là external |
| 06 | [knowledge-truncation-report.md](knowledge-truncation-report.md) | P1 | S | Cột `truncation_json` đã migrate nhưng luôn NULL; cap cắt dữ liệu im lặng |
| 07 | [agent-lifecycle.md](agent-lifecycle.md) | P1 | M | Không có restart/concurrency limit; SIGTERM không escalate |
| 08 | [terminal-log-retention.md](terminal-log-retention.md) | P1 | S | `terminal_logs` không bao giờ bị xoá → SQLite phình vô hạn |
| 09 | [workflow-metrics-delta.md](workflow-metrics-delta.md) | P2 | S | 4 field delta có type + UI nhưng service không tính → UI chết vĩnh viễn |
| 10 | [task-retry-policy.md](task-retry-policy.md) | P2 | M | Không có attempt/backoff; task fail trước khi ghi DB bị retry mỗi 30s vô hạn |
| 11 | [task-ai-planner.md](task-ai-planner.md) | P2 | M | Planner là word-count heuristic, gán CLI hardcode không cần biết CLI có tồn tại |
| 12 | [structured-chat-capability.md](structured-chat-capability.md) | P2 | S | Resume chat hardcode `claude`/`agy` trong 3 hàm thay vì flag trong catalog |
| 13 | [workflow-schema-versioning.md](workflow-schema-versioning.md) | P2 | S | `workflow-repository` còn 25 `ensureColumns`, nằm ngoài `schema_migrations` |
| 14 | [diagnostics-tiers.md](diagnostics-tiers.md) | P2 | M | Diagnostics chỉ check `--version`, không check auth/quota/ghi được folder |
| 15 | [ai-gateway-sidecar.md](ai-gateway-sidecar.md) | P3 | XL | `docs/aiagnet.md` mô tả local router, runtime không có server nào listen port |

Effort: S = dưới 1 ngày, M = 1–3 ngày, L = 1 tuần, XL = nhiều tuần / cần quyết định sản phẩm.

## Thứ tự làm đề xuất

**Sprint 1 — dừng chảy máu (UI đang nói dối).** Plan 03 trước tiên vì nó là data-loss bug đang tồn tại, rồi 02 (một dòng đổi status + đã có sẵn nút Verify đang làm dở), rồi 01 phase 1 (disable trigger chưa chạy). Cả ba đều nhỏ và loại bỏ hiểu nhầm ngay.

**Sprint 2 — làm cho panel dùng được hằng ngày.** Plan 04 phase 1 (patch viewer), 06 (truncation report), 08 (log retention). Đây là các mục người dùng cảm nhận được ngay mà không cần đổi kiến trúc.

**Sprint 3 — độ tin cậy.** Plan 07, 10, 13. Sau sprint này scheduler và agent runtime chịu được hàng đợi dài và lỗi tạm thời.

**Sprint 4+ — nâng chất lượng lõi.** Plan 05 (AST index) là mục lớn nhất và nên làm sau khi 06 đã cho thấy scan bỏ sót bao nhiêu. Plan 15 cần quyết định sản phẩm trước khi viết code.

## Ràng buộc chung cho mọi plan

Các điều dưới đây đúng cho toàn repo, các plan sẽ không nhắc lại:

1. **Test phải được đăng ký thủ công.** `test:workflows` trong `package.json:25` liệt kê từng file. File mới trong `tests/` **không tự chạy** — thêm tên vào đó hoặc nó vô hình.
2. **Đổi contract là đổi 4 chỗ.** Một API mới cần: `src/contracts/*.ts` (type) → `src/contracts/ipc.ts` (`AgenticDesktopApi`) → `src/preload/preload.ts` (bridge) → `src/main/ipc/register-ipc.ts` (handler). Bỏ sót preload thì renderer nhận `undefined` lúc runtime chứ không fail typecheck.
3. **Schema mới đi qua `schema_migrations`.** Thêm entry vào `appMigrations` (`src/main/database/migrations.ts:34`), append version, không bao giờ sửa version đã release. Runner đã transactional và idempotent (`migrations.ts:109`).
4. **CSS override layer mang layout.** Các block "Final dark override" không phải CSS chết. Recolour tại chỗ, đừng xoá.
5. **`npm test` = typecheck + suite.** Chạy nó trước khi coi một phase là xong.
