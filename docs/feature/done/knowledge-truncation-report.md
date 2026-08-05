# 06 — Knowledge: báo cáo phần bị cắt

**Trạng thái: Done · Mức cũ: P1 · Effort: S**

Implemented 2026-08-04: `KnowledgeTruncationReport` is now part of the contract, scans classify skipped files by reason, graph cap drops are counted, `truncation_json` round-trips through SQLite, the Knowledge UI renders a truncation panel with a cap-increase rescan action, and Markdown/XML exports include the report. Verified with `npm run typecheck` and `npm run test:workflows -- tests/knowledge-service.test.ts`.

Plan nhỏ, nên làm trước `knowledge-index.md`: nó cho thấy scan đang bỏ sót bao nhiêu, và đó là dữ liệu cần có để quyết định phần index lớn kia đáng làm tới đâu.

## Trạng thái hiện tại

Đã sửa. Migration version 3 (`knowledge-scan-truncation`) tạo cột `truncation_json`, và cột này hiện được dùng thật ở cả bốn lớp:

- **Contract**: `KnowledgeTruncationReport` mô tả cap/skip/drop reasons; `KnowledgeSnapshot` có `truncation?: KnowledgeTruncationReport`.
- **Service**: `scan()` tích luỹ `hitFileLimit`, `filesSeen`, `filesIndexed`, skip theo loại, largest skipped files, và graph node/edge drops. `collectFiles()` tiếp tục walk/count sau khi đạt cap thay vì return im lặng.
- **Persistence**: `saveKnowledgeSnapshot()` ghi `truncation_json`; `getKnowledgeSnapshot()` đọc nullable JSON và map snapshot cũ về `undefined` an toàn.
- **UI/export**: Knowledge module hiện report truncation, message sau scan nói rõ skipped count, có nút tăng cap/rescan khi hit file limit, Markdown/XML export kèm report.

Các cap vẫn tồn tại để bảo vệ app, nhưng không còn cắt dữ liệu im lặng.

## Mục tiêu

Sau scan, người dùng biết chính xác cái gì **không** nằm trong index và vì sao.

## Thiết kế

Thêm vào `src/contracts/knowledge.ts`:

```ts
export interface KnowledgeTruncationReport {
  hitFileLimit: boolean;
  filesSeen: number;          // số file gặp khi walk, trước khi cắt
  filesIndexed: number;
  skippedUnsupported: number;
  skippedTooLarge: number;
  skippedBinary: number;
  skippedUnreadable: number;
  graphNodesDropped: number;
  graphEdgesDropped: number;
  largestSkipped?: Array<{ path: string; bytes: number }>;  // vài file lớn nhất bị bỏ
}
```

`KnowledgeSnapshot` nhận thêm `truncation?: KnowledgeTruncationReport`.

Tách riêng từng lý do skip thay vì một số tổng là điểm chính của plan này: "bỏ 400 file" không hành động được, còn "bỏ 400 file vì chạm cap 800" thì người dùng biết cần tăng cap, và "bỏ 12 file vì quá lớn" thì họ biết đó là file generated không cần index.

## Các phase

### Phase 1 — thu số liệu trong service

`collectFiles` (`knowledge-service.ts:112`, return tại `:165`/`:170`) hiện dừng và quên. Cho nó tiếp tục **đếm** sau khi chạm cap thay vì return ngay — hoặc rẻ hơn, trả kèm số lượng candidate còn lại. Không cần đếm chính xác đến từng file nếu repo khổng lồ; đếm tới một ngưỡng rồi báo "800+ file chưa index" cũng đủ hành động.

Đổi các biến đếm skip rời rạc (`:183`, `:189`, `:119`) thành một accumulator có phân loại. `skippedFiles` giữ nguyên để không phá contract cũ, tính bằng tổng các loại.

Graph: tại `:347`/`:351`, ghi lại số node/edge bị cắt trước khi slice.

### Phase 2 — persist

Thêm `truncation_json` vào INSERT tại `desktop-database.ts:388` và bind list tại `:405-417`. Thêm vào SELECT của `getKnowledgeSnapshot` (`:421-459`) và vào `KnowledgeSnapshotRow` (`:116-130`).

Vì đây là cột nullable đã tồn tại, snapshot cũ đọc lên sẽ có `truncation: undefined` — UI phải chịu được trường hợp đó (snapshot scan trước khi có feature này).

### Phase 3 — hiện trong UI

Trong `KnowledgeModule.tsx`, thay message hiện tại `CodeGraph indexed N files.` (`:128`) bằng câu có nói tới phần bị bỏ khi có: ví dụ "Đã index 800 file, bỏ qua 412 (chạm giới hạn 800)."

Thêm một khối chi tiết mở được (không phải modal, người dùng không cần bấm để biết là mình đang xem dữ liệu thiếu) liệt kê từng lý do và vài file lớn nhất bị bỏ. Nếu `hitFileLimit` là true, kèm nút tăng cap và scan lại — hiện `maxFiles` hardcode trong renderer tại `:122-124`, nên cần cho nó thành state.

## Test

Mở rộng `tests/knowledge-service.test.ts` (hiện 2 test, chỉ cover graph cap integrity và XML control-char).

| Case | Khẳng định |
| --- | --- |
| Chạm cap file | `hitFileLimit: true`, `filesSeen > filesIndexed` |
| File quá lớn | Đếm vào `skippedTooLarge`, không phải loại khác |
| File binary | Đếm vào `skippedBinary` |
| Graph bị cắt | `graphNodesDropped`/`graphEdgesDropped` > 0 khi vượt cap |
| Snapshot cũ | Đọc row có `truncation_json` NULL không crash |
| Round-trip | Save rồi get, report giữ nguyên |

## Acceptance

- [x] Scan một repo lớn hơn cap → UI nói rõ số file bị bỏ và lý do.
- [x] Scan repo nhỏ → không có cảnh báo gây nhiễu (`truncation` omitted when no cap/skip/drop exists).
- [x] `truncation_json` có dữ liệu thật trong SQLite sau scan and round-trips via `KnowledgeService.get()`.
- [x] Mở snapshot đã scan từ trước khi có feature → không lỗi (`truncation_json` nullable maps to `undefined`).
- [x] `npm run typecheck` xanh.
- [x] `npm run test:workflows -- tests/knowledge-service.test.ts` xanh.
