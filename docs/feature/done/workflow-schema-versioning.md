# 13 — Workflow schema versioning: đưa workflow repository vào `schema_migrations`

**Mức: Done · Effort: S**

> **Đã triển khai.** `workflow-repository.migrate()` giờ chỉ còn baseline
> `create table if not exists`; toàn bộ cột additive nằm trong `appMigrations`
> version 7 (`workflow-repository-legacy-columns`), `profile_id`/`provider_connection_id`
> chỉ khai báo một lần ở version 4. `seed()` chạy sau `runMigrations`, và
> `WorkflowRepository.bootstrap()` giữ đúng thứ tự đó cho test. Test legacy DB
> không có `schema_migrations` nằm ở `tests/database-migrations.test.ts`.

## Trạng thái hiện tại

App database đã có migration runner versioned thật:

- `schema_migrations` table tạo tại `src/main/database/migrations.ts:78-85`.
- `runMigrations()` transactional tại `:109-140`.
- `appMigrations` hiện đã có version 1–5 (`:34-76`), bao gồm `workflow-step-agent-binding` (`:60-68`) và `provider-connection-base-url` (`:70-75`).
- `DesktopDatabase.migrate()` gọi `runMigrations(this.db, appMigrations)` tại `desktop-database.ts:1113`.

Nhưng `workflow-repository.ts` vẫn sống gần như hoàn toàn ngoài hệ version:

- Import duy nhất liên quan schema là `ensureColumns` (`src/main/database/workflow-repository.ts:15`).
- `migrate()` (`:86`) tự `create table if not exists` rồi chạy hai block `ensureColumns` lớn.
- Block `workflows` có 14 cột additive (`:144-159`).
- Block `workflow_steps` có 11 cột additive (`:161-173`).
- Sau đó `this.seed()` (`:175`).

Điểm đáng chú ý: migration version 4 trong `appMigrations` **cũng** thêm `profile_id`/`provider_connection_id` cho `workflow_steps` (`migrations.ts:60-68`), trong khi `workflow-repository.ts` vẫn có cùng cột tại `:166-167`. Nhờ `ensureColumns` idempotent nên không lỗi, nhưng source of truth bị chia đôi: ai đọc migrations tưởng cột được quản lý ở đó, ai đọc repository tưởng nó được quản lý ở repository.

Hệ quả hiện tại không vỡ ngay vì toàn bộ thay đổi vẫn là additive columns. Nhưng khi cần đổi khó hơn — rename column, split table, backfill dữ liệu, rollback-safe migration — mô hình `ensureColumns` rải rác không đủ.

## Mục tiêu

1. Mọi schema change mới cho workflow đi qua `appMigrations`.
2. `workflow-repository.migrate()` chỉ còn baseline create table + seed, không còn là nơi thêm cột mới.
3. Source of truth về version rõ ràng: nhìn `migrations.ts` biết DB release nào thêm gì.

## Thiết kế

Không cố xoá sạch legacy trong một bước — đây là repo đang phát triển, có DB người dùng đã tồn tại. Cách an toàn:

- Giữ `create table if not exists` trong `workflow-repository.migrate()` làm baseline. Fresh DB cần table trước khi `runMigrations` chạy (hiện `DesktopDatabase.migrate()` gọi repository migrate trước `runMigrations`).
- Chuyển **các `ensureColumns` mới** sang `appMigrations`. Với cột cũ, có thể giữ một thời gian nhưng đánh dấu legacy.
- Sau khi đã có migration tương ứng cho từng cột cũ, repository có thể chỉ giữ minimum DDL baseline.

Quan trọng: `appMigrations` chạy **sau** repository migrate (`desktop-database.ts:1112-1113` comment nói rõ). Vì vậy migration workflow có thể assume table tồn tại.

## Các phase

### Phase 1 — lập inventory cột workflow

Tạo bảng trong comment hoặc doc ngay trong `workflow-repository.ts` liệt kê mỗi cột trong `workflows`/`workflow_steps`: baseline hay migration version nào thêm. Mục tiêu là không còn câu hỏi "cột này từ đâu ra".

Đây là việc nhỏ nhưng giúp phase 2 không sai.

### Phase 2 — chuyển cột đã có migration ra khỏi repository ensureColumns

`profile_id` và `provider_connection_id` đã có migration version 4 (`migrations.ts:60-68`). Xoá chúng khỏi block `ensureColumns` tại `workflow-repository.ts:166-167` **sau khi** test chứng minh fresh DB và legacy DB đều mở được.

Đây là bước thử an toàn: chỉ hai cột, đã có migration. Nếu phát hiện ordering issue, sửa ordering trước khi chuyển 23 cột còn lại.

### Phase 3 — tạo migration cho các cột workflow còn lại

Append version mới, ví dụ `workflow-repository-legacy-columns`, chứa toàn bộ cột hiện đang ở `ensureColumns` nhưng chưa có migration version. Nó vẫn dùng `ensureColumns` idempotent trong migration body để chịu được DB đã có cột do đường cũ.

Sau khi migration này tồn tại, `workflow-repository.migrate()` có thể bỏ block ensureColumns lớn hoặc giữ trong một release với comment "legacy compatibility only". Đề xuất bỏ để source of truth sạch, nhưng chỉ sau test.

### Phase 4 — harden migration test bằng snapshot cũ

`tests/database-migrations.test.ts` đã tồn tại. Thêm fixture tạo DB kiểu cũ **không có schema_migrations** nhưng có table workflow thiếu nhiều cột, rồi mở bằng `DesktopDatabase.open()` và assert:

- `schema_migrations` có version mới.
- Cột workflow đầy đủ.
- Seed không duplicate.
- Data cũ còn nguyên.

Đây là test quan trọng nhất — additive migration dễ xanh trên fresh DB mà fail trên DB thật đã qua nhiều phiên bản.

## Test

| File | Case |
| --- | --- |
| `tests/database-migrations.test.ts` | Legacy DB không có `schema_migrations` được nâng lên đầy đủ |
| `tests/workflow-repository.test.ts` | Fresh DB vẫn tạo đủ schema và seed |
| `tests/workflow-agent-binding.test.ts` | `profile_id` vẫn tồn tại sau khi xoá khỏi repository ensureColumns |
| `tests/database-migrations.test.ts` | Migration idempotent: mở DB lần hai không chạy lại và không lỗi |

## Acceptance

- [ ] Không còn cột workflow mới nào được thêm trực tiếp trong `workflow-repository.ensureColumns` mà không có migration version.
- [ ] `profile_id` / `provider_connection_id` chỉ có source of truth trong `migrations.ts`, không bị khai báo đôi.
- [ ] Legacy DB thiếu cột workflow mở được và data cũ còn nguyên.
- [ ] `npm test` xanh.

## Ghi chú

Đừng cố xoá cột legacy khỏi SQLite. SQLite hỗ trợ `drop column` nhưng không đáng rủi ro ở đây. Mục tiêu là dọn **source quản lý schema**, không phải dọn file DB người dùng.
