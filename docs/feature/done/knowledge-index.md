# 05 — Knowledge index: incremental scan + parser thật

**Trạng thái: Done · Mức cũ: P1 · Effort: L**

Implemented 2026-08-06, cả 5 phase. Chi tiết ở cuối file; các mục acceptance đã
được tick và verify bằng số đo thật trên chính repo này.

Plan lớn nhất trong nhóm P1. Nên làm **sau** `knowledge-truncation-report.md`, vì báo cáo truncation sẽ cho biết index đang bỏ sót bao nhiêu — số đó quyết định phần nào của plan này đáng làm trước.

## Trạng thái hiện tại

### Full rescan mỗi lần

`scan()` (`src/main/knowledge/knowledge-service.ts:103-145`) làm: resolve path → `fs.stat` guard (`:106-108`) → clamp cap (`:110-111`) → `collectFiles` walk (`:112`) → **`await fs.readFile` tuần tự từng file** trong vòng `for` (`:116-124`) → `analyzeFile` (`:123`) → build snapshot (`:135-138`) → `saveKnowledgeSnapshot` (`:143`).

`scan()` **không bao giờ đọc snapshot cũ** — không gọi `this.get()`. Nên mỗi lần scan là đọc lại và parse lại toàn bộ. Không có hash: grep `createHash|sha` trong file không ra gì. `stat.mtime` được lấy tại `:197` nhưng chỉ để hiển thị làm `updatedAt` (`:232`, render "Updated" tại `KnowledgeModule.tsx:461-462`), **không bao giờ được so sánh** với giá trị trước.

Đọc file tuần tự, không concurrency — chi phí scan tuyến tính theo số file.

### Regex, không AST

Ba hàm extraction, tất cả regex trên text thô:

`extractImports` (`:482-491`) chạy sáu pattern:
```js
/\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g   // :484
/\brequire\(["']([^"']+)["']\)/g                                    // :485
/\bimport\(["']([^"']+)["']\)/g                                     // :486
/^\s*@import\s+["']([^"']+)["']/gm                                  // :487 CSS
/^\s*from\s+([\w.]+)\s+import\s+/gm                                 // :488 Python
/^\s*import\s+([\w.]+)\s*$/gm                                       // :489
```

`extractExports` (`:493-504`) và `extractSymbols` (`:506-513`) tương tự. Vì chạy trên text thô, **match trong comment và string literal không phân biệt được với code thật**. Và `export * from "./x"` không pattern nào bắt được.

### Alias `@contracts` bị coi là external — sai ngay trên repo này

`resolveImportPath` (`:531-551`) bỏ ngay mọi thứ không bắt đầu bằng `.`:

```js
if (!imported.startsWith(".")) return null;   // :532
```

Nhưng `tsconfig.json:21-24` định nghĩa `@contracts` → `./src/contracts/index.ts`, và repo này dùng nó khắp nơi: `git-service.ts:2`, `register-ipc.ts:17`, `preload.ts:21`, `KnowledgeModule.tsx:23`. Mỗi import đó trở thành **node external giả** qua `externalNodeId` (`:318`, `:692-699`) với confidence 0.58 (`:342`).

Nói cách khác: scan chính project này thì tầng contracts — trung tâm kiến trúc của app — bị dán nhãn là package third-party. Đây là lỗi dễ thấy nhất và cũng dễ sửa nhất.

Thêm nữa: một import local hợp lệ mà file đích bị cap `maxFiles` loại bỏ cũng degrade thành "external", vì resolution chỉ probe trong tập path đã có trong snapshot (`:535-550`).

### Không có search thật

Không có channel `knowledge:search`, không có service method, **không có scoring nào**. Cái đang có là filter substring client-side: `filteredFiles` (`KnowledgeModule.tsx:80-100`) nối bảy field thành một string (`:88-94`) rồi `.includes(normalized)` (`:98`). Không rank, không thứ tự theo độ liên quan, và chỉ trong phạm vi snapshot đã load.

### Không có progress

`scanProject` (`:107-134`) set cờ boolean `scanning` (`:117`), await một IPC invoke duy nhất (`:121-125`), clear trong `finally` (`:132`). Phản hồi duy nhất là spinner + đổi label (`:179-180`). Không có channel `knowledge:progress` — `ipc.ts:116-120` chỉ có ba subscription: agent, workflow, task. Repo lớn → UI đứng im không biết bao lâu, không cancel được.

## Mục tiêu

Theo thứ tự giá trị/chi phí:

1. Alias resolution đúng (rẻ, sửa lỗi thấy được ngay trên chính repo này).
2. Progress + cancel (không đổi thuật toán, cải thiện cảm nhận rõ rệt).
3. Incremental scan theo hash/mtime.
4. AST parser cho TS/TSX thay regex.
5. Search có scoring ở main process.

## Các phase

### Phase 1 — alias resolution (rẻ, sửa lỗi rõ ràng)

Đọc `compilerOptions.paths` + `baseUrl` từ `tsconfig.json` của project đang scan, build một resolver alias, và thử nó **trước** khi kết luận một import là external. `resolveImportPath` (`:531`) nhận thêm bước: nếu specifier khớp một alias pattern, map sang path thật rồi probe như relative.

Cẩn thận: tsconfig của project người dùng có thể có `extends`, `paths` với nhiều target, hoặc không có tsconfig. Mọi trường hợp phải fallback êm về hành vi hiện tại, không throw — scan hỏng vì tsconfig lạ thì tệ hơn là alias sai.

Cũng phân biệt "external thật" với "local nhưng ngoài index": hiện cả hai đều thành external node. Loại thứ hai nên có kind riêng hoặc cờ, để `knowledge-truncation-report.md` báo được là graph thiếu vì cap chứ không phải vì dependency.

### Phase 2 — progress + cancel

Thêm push channel `knowledge:progress` (theo mẫu `workflow:event` tại `workflow-service.ts:679`), emit sau mỗi N file với `{ processed, total, currentPath }`. Thêm `events.subscribeKnowledge` vào `ipc.ts:116-120` và preload.

Cancel: `scan()` cần nhận signal. Đơn giản nhất là một token/id scan mà renderer có thể gọi `knowledge:cancel`, service check giữa các file trong vòng lặp `:116-124`. Không cần abort giữa một `readFile`.

Vòng lặp tuần tự tại `:116-124` cũng có thể được đọc song song theo batch nhỏ (ví dụ 8 file một lúc) — cải thiện đáng kể trên SSD mà không đổi kiến trúc. Đừng song song không giới hạn: sẽ chạm giới hạn file descriptor.

### Phase 3 — incremental scan

Thêm bảng per-file thay vì chỉ blob snapshot: `knowledge_files(project_path, path, hash, mtime, bytes, insight_json)`. Qua migration mới trong `appMigrations` (`migrations.ts:34`).

Luồng scan mới: walk lấy danh sách path + mtime + size → so với bảng → chỉ `readFile` + `analyzeFile` những file có mtime/size khác → hash nội dung để chắc chắn (mtime đổi mà nội dung giống thì bỏ qua parse) → xoá row của file không còn tồn tại → rebuild graph từ tập insight đầy đủ.

Lưu ý: graph phải build lại **toàn bộ** dù chỉ một file đổi, vì edge phụ thuộc lẫn nhau. Đó vẫn nhanh hơn nhiều so với đọc lại mọi file.

Giữ `saveKnowledgeSnapshot` như một view tổng hợp để không phá `getKnowledgeSnapshot` và export hiện có.

### Phase 4 — AST parser cho TS/TSX

`typescript` đã là devDependency (`package.json:61`), nên TypeScript compiler API dùng được ngay, không thêm dependency runtime.

Dùng `ts.createSourceFile` + walk AST cho `.ts/.tsx/.js/.jsx`: import/export/symbol lấy từ node thật, nên comment và string literal không còn tạo match giả, và `export * from` bắt được.

Giữ regex làm fallback cho ngôn ngữ khác (Python, CSS, Go...). Đừng xoá nó — một parser sai với ngôn ngữ lạ thì tệ hơn regex thô.

Chi phí: AST chậm hơn regex đáng kể. Đây là lý do phase 3 (incremental) nên làm **trước** phase 4 — khi chỉ parse file đã đổi, chi phí AST trở nên chấp nhận được.

### Phase 5 — search có scoring

Chuyển search về main process: channel `knowledge:search(projectPath, query, limit)`. Scoring tối thiểu nên tính: khớp tên file/symbol cao điểm hơn khớp trong purpose text, khớp đầu chuỗi cao hơn khớp giữa, và file có nhiều edge (trung tâm hơn trong graph) được cộng điểm nhẹ.

Không cần embedding hay index đảo ngược cho quy mô này. Một pass có scoring trên tập insight đã load là đủ, và nó thay thế filter substring hiện tại (`KnowledgeModule.tsx:80-100`) bằng thứ có thứ tự nghĩa.

## Test

| File | Case |
| --- | --- |
| `tests/knowledge-service.test.ts` (có sẵn) | Không hồi quy graph cap và XML escaping |
| `tests/knowledge-alias.test.ts` (mới) | `@contracts` resolve thành local node, không phải external; không có tsconfig thì fallback êm; `extends` không crash |
| `tests/knowledge-incremental.test.ts` (mới) | Scan lần hai không đọc lại file không đổi; file bị xoá thì mất khỏi index; mtime đổi mà nội dung giống thì không parse lại |
| `tests/knowledge-ast.test.ts` (mới) | Import trong comment/string **không** tạo edge; `export * from` bắt được; file TS lỗi syntax không làm hỏng scan |
| `tests/knowledge-search.test.ts` (mới) | Khớp tên file xếp trên khớp mô tả |

Thêm tất cả vào `test:workflows` (`package.json:25`).

## Acceptance

- [x] Scan chính repo này → `src/contracts` là local node, không phải external package.
      (59/59 edge `@contracts` trỏ `file:src/contracts/index.ts`; 0 alias node còn external.)
- [x] Scan repo lớn → thấy progress tăng, và cancel được giữa scan.
      (Channel `knowledge:progress` + `knowledge:cancel`, có phase `collecting/analyzing/graphing/done/cancelled`.)
- [x] Scan lần hai ngay sau lần đầu → nhanh hơn rõ rệt, và số liệu cho thấy hầu hết file được bỏ qua.
      (140ms → 21ms, **6.83x**, `reused=166/166` báo về UI.)
- [x] Import viết trong comment không xuất hiện thành edge trong graph.
      (AST parser; `src/contracts/index.ts` từ 0 lên 9 import nhờ bắt được `export * from`.)
- [x] Search "workflow" → file tên `workflow-*.ts` xếp trên file chỉ nhắc chữ đó trong mô tả.
      (`workflow.ts` 223 điểm vs file chỉ nhắc trong purpose ~12; hit nói rõ lý do match.)
- [x] `npm test` xanh (256/256).

## Đã implement (2026-08-06)

| Phase | Kết quả | Test |
| --- | --- | --- |
| 1 — alias resolution | `src/main/knowledge/tsconfig-aliases.ts`. Đọc `paths`/`baseUrl`, theo `extends`, và **parse được JSONC** — điều kiện bắt buộc vì `JSON.parse` throw trên chính tsconfig của repo này (có `//` comment). Thêm node kind `unindexed` để phân biệt "local ngoài index" với "external package". | `tests/knowledge-alias.test.ts` |
| 2 — progress + cancel | Push channel `knowledge:progress`, invoke `knowledge:cancel`, scan id giữ trong `useRef`. Cancel trả snapshot cũ chứ không throw. Đọc file theo batch 8 (bounded để không chạm fd limit). | `tests/knowledge-progress.test.ts` |
| 3 — incremental | Bảng `knowledge_files` (migration 8 + baseline DDL). Hai tầng bỏ qua: size+mtime giống → không đọc; mtime đổi mà hash giống → đọc nhưng không parse lại. Ghi lại toàn bộ index trong một transaction để xoá file đã biến mất. | `tests/knowledge-incremental.test.ts` |
| 4 — AST parser | `src/main/knowledge/ast-parser.ts` dùng `ts.createSourceFile` cho TS/JS; regex vẫn giữ cho Python/Go/CSS. Cold scan 140→327ms (AST đắt hơn thật), nhưng phase 3 giữ warm rescan ở 20ms — đúng lý do plan yêu cầu làm phase 3 trước. | `tests/knowledge-ast.test.ts` |
| 5 — search có scoring | `src/main/knowledge/knowledge-search.ts`, channel `knowledge:search`. Weight filename 100 → purpose 12, exact ×2.2, prefix ×1.6, multi-word là AND. Centrality bonus **cap ở 12 điểm** để connectivity không bao giờ vượt được relevance. | `tests/knowledge-search.test.ts` |

Ghi chú kỹ thuật đáng giữ:

- `typescript` là devDependency nhưng vite **inline** nó vào main bundle: main.js
  174KB → 3.67MB. `npm run build` vẫn package thành công (đã verify), nhưng đây là
  chi phí thật cần biết trước khi thêm thứ tương tự.
- Mọi API mới đều đi đủ 4 chỗ (contract → `AgenticDesktopApi` → preload → ipcMain).
  Bỏ preload thì renderer nhận `undefined` lúc runtime mà typecheck vẫn xanh.
- Mỗi test suite đã được xác nhận *load-bearing* bằng cách tắt code tương ứng và
  thấy nó đỏ, rồi restore.
