# Feature plans — Agentic Workspace

Mỗi file trong thư mục này là kế hoạch triển khai cho **một chức năng còn thiếu hoặc chưa chạy được**, đã được verify bằng cách đọc source thật (không copy lại từ doc cũ).

- `docs/unfinished-features.md` = báo cáo *phát hiện* gap (what is broken).
- `docs/feature/*.md` = kế hoạch *sửa* từng gap (how to fix it), mỗi file tự chứa đủ để một người/agent làm một mình.

Ngày verify: **2026-08-04**, tại commit `0a434f1` (`feat: add schema migrations, provider verification, and step chaining`).

Re-verify **2026-08-05**: mọi gap trong bảng dưới đã được grep lại trên source hiện
tại và vẫn đúng. Chi tiết bằng chứng trong `docs/audit-2026-08-05.md`, cùng một bug
runtime đã tìm ra và sửa trong lần rà soát đó (spawn-window trong
`AgentProcessManager` khiến `stop()` không có tác dụng và concurrency limit bị vượt).

Re-verify **2026-08-06**: plan 07 (agent lifecycle) đã hoàn thành và được chuyển sang
`done/`. Trong lúc verify, một bug quit path đã được tìm ra và sửa: output đến muộn từ
child đang bị kill ghi vào database đã close, gây `uncaughtException` lúc thoát app.
Chi tiết trong `done/agent-lifecycle.md`.

Pass **2026-08-06 (tiếp)**: plan 05 (knowledge index, 5 phase) và plan 11 (task
planner, 3 phase) đã hoàn thành và chuyển sang `done/`; acceptance ngắn hạn của plan
15 đã verify đạt. Backlog mở còn lại chỉ là residual của 01/02 (remote trigger
runners, OAuth/device thật) và phase 1+ của 15. `npm test` 256/256, `npm run build`
pass.

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

## Plan chưa hoàn thành

Thứ tự này tính theo **giá trị / rủi ro**, không phải theo độ khó. Các mục P0 là chỗ UI đang hứa nhiều hơn runtime — người dùng bị đánh lừa, nên sửa trước.

| # | Plan | Mức | Effort | Vấn đề một dòng |
| --- | --- | --- | --- | --- |
| 01 | [workflow-triggers.md](workflow-triggers.md) | **Residual/P0** | M | Local file-change chạy được; remote `git-push`/issue/webhook runners vẫn chưa có |
| 02 | [provider-connection-truth.md](provider-connection-truth.md) | **Residual/P0** | S | Local verification đã có; OAuth/device token flow thật vẫn chưa có |
| 15 | [ai-gateway-sidecar.md](ai-gateway-sidecar.md) | P3 | XL | Acceptance ngắn hạn (dán nhãn proposal) đã xong; sidecar/`/v1` thật cần quyết định sản phẩm trước |

## Completed archive

Các plan hoàn thành được chuyển sang [`done/`](done/README.md), để thư mục
`docs/feature/` chỉ còn backlog chưa xong hoặc còn residual.

| # | Plan | Trạng thái |
| --- | --- | --- |
| 03 | [Workflow step profile binding](done/workflow-step-profile-binding.md) | Done |
| 04 | [Git workspace MVP](done/git-workspace.md) | Done/MVP |
| 06 | [Knowledge truncation report](done/knowledge-truncation-report.md) | Done |
| 08 | [Terminal log retention](done/terminal-log-retention.md) | Done |
| 09 | [Workflow metrics delta](done/workflow-metrics-delta.md) | Done |
| 10 | [Task retry policy](done/task-retry-policy.md) | Done |
| 12 | [Structured chat capability](done/structured-chat-capability.md) | Done |
| 11 | [Task AI planner](done/task-ai-planner.md) | Done |
| 13 | [Workflow schema versioning](done/workflow-schema-versioning.md) | Done |
| 14 | [Diagnostics tiers](done/diagnostics-tiers.md) | Done/MVP |
| 05 | [Knowledge index](done/knowledge-index.md) | Done |
| 07 | [Agent lifecycle](done/agent-lifecycle.md) | Done |
| — | [Hermes Agent gateway provider](done/hermes-agent-provider.md) | Done |

Effort: S = dưới 1 ngày, M = 1–3 ngày, L = 1 tuần, XL = nhiều tuần / cần quyết định sản phẩm.

## Thứ tự làm đề xuất

**Sprint 1 — dừng chảy máu (UI đang nói dối).** Plan 03, 02, và phần gating của 01 đã xong: step binding không còn mất dữ liệu, provider không còn tự nhận connected trước verify, và trigger chưa hỗ trợ không còn được bán như automation thật. Residual của 01/02 là remote runners và OAuth/device token flow.

**Sprint 2 — làm cho panel dùng được hằng ngày.** Plan 04 (Git workspace MVP), 06 (truncation report), và 08 (log retention) đã xong. Git còn các operation nâng cao như stash/branch/push/conflict UX, nhưng patch/stage/commit path đã dùng được hằng ngày.

**Sprint 3 — độ tin cậy.** Plan 10 và 13 đã xong: scheduler không còn spam retry mỗi 30 giây và mọi schema change của workflow đi qua `schema_migrations`. Plan 07 đã xong hoàn toàn: restart, concurrency queue, và kill escalation (SIGTERM→SIGKILL + tree-kill).

**Sprint 4+ — nâng chất lượng lõi.** Plan 05 đã xong cả 5 phase (alias, progress/cancel,
incremental, AST, ranked search) và plan 11 đã xong cả 3 phase (CLI availability, copy
trung thực, AI mode có fallback). Plan 15 vẫn cần quyết định sản phẩm trước khi viết code;
acceptance ngắn hạn của nó (dán nhãn tài liệu) đã đạt.

## Ràng buộc chung cho mọi plan

Các điều dưới đây đúng cho toàn repo, các plan sẽ không nhắc lại:

1. **Test phải được đăng ký thủ công.** `test:workflows` trong `package.json:25` liệt kê từng file. File mới trong `tests/` **không tự chạy** — thêm tên vào đó hoặc nó vô hình.
2. **Đổi contract là đổi 4 chỗ.** Một API mới cần: `src/contracts/*.ts` (type) → `src/contracts/ipc.ts` (`AgenticDesktopApi`) → `src/preload/preload.ts` (bridge) → `src/main/ipc/register-ipc.ts` (handler). Bỏ sót preload thì renderer nhận `undefined` lúc runtime chứ không fail typecheck.
3. **Schema mới đi qua `schema_migrations`.** Thêm entry vào `appMigrations` (`src/main/database/migrations.ts:34`), append version, không bao giờ sửa version đã release. Runner đã transactional và idempotent (`migrations.ts:109`).
4. **CSS override layer mang layout.** Các block "Final dark override" không phải CSS chết. Recolour tại chỗ, đừng xoá.
5. **`npm test` = typecheck + suite.** Chạy nó trước khi coi một phase là xong.
