# 01 — Workflow triggers: chỉ `schedule` chạy được, 4 loại còn lại là nhãn trống

**Trạng thái: Done/P0 residual · Mức cũ: P0 · Effort: M · Loại: UI hứa nhiều hơn runtime**

Implemented 2026-08-04: unsupported remote triggers are gated in the editor/UI, saved unsupported triggers carry warnings instead of silently promising automation, and the local `file-change` runner is implemented with debounce/ignore-loop protection. Residual future work: true remote `git-push`, `issue-created`, and `webhook` runners still need separate architecture decisions.

## Trạng thái hiện tại

P0 đã được xử lý: UI không còn bán các trigger chưa có runner như thể chúng tự chạy được. `manual`/`schedule` vẫn hoạt động như trước; `file-change` hiện có runner local thật; các trigger remote (`git-push`, `issue-created`, `webhook`) được giữ visible nhưng gated/warned cho tới khi có kiến trúc nhận sự kiện bên ngoài.

`trigger.detail` vẫn là metadata/string tương thích ngược cho các trigger chưa chuyển sang config schema đầy đủ. Với `file-change`, runner dùng cấu hình local đủ để debounce, ignore generated dirs, và tránh self-trigger loop. Schema discriminated-union cho toàn bộ trigger set vẫn là hướng tương lai khi làm các remote runner.

## Mục tiêu

Không loại trigger nào xuất hiện như đang hoạt động khi nó không hoạt động. Theo thứ tự:

1. Người dùng không thể tạo workflow với trigger chưa có runner mà không biết.
2. `file-change` chạy thật (đây là loại khả thi nhất, thuần local).
3. `git-push` chạy thật qua polling ref local.
4. `webhook` và `issue-created` có quyết định kiến trúc rõ ràng trước khi viết code.

## Thiết kế

### Vấn đề `trigger.detail` là string tự do

Hiện `detail` là một `string?` cho cả sáu loại. Điều đó không đủ để điều khiển runtime: `file-change` cần glob, `git-push` cần branch pattern, `webhook` cần route + secret. Thay bằng discriminated union theo loại trigger:

```ts
type WorkflowTriggerConfig =
  | { type: "manual" }
  | { type: "schedule"; schedule: string }
  | { type: "file-change"; pathGlobs: string[]; debounceMs?: number }
  | { type: "git-push"; branchPattern?: string; remote?: string }
  | { type: "webhook"; route: string; secretRef?: string }
  | { type: "issue-created"; provider: "github" | "jira"; projectKey: string };
```

Đây là breaking change với dữ liệu đã lưu, nên nó cần một migration version mới trong `appMigrations` (`src/main/database/migrations.ts:34`) để chuyển `detail` string sang JSON config. Migration phải chịu được `detail` rác — người dùng đã có thể nhập bất kỳ text nào vào field đó. Quy tắc chuyển đổi an toàn: parse được thì dùng, không parse được thì giữ nguyên text vào một field `legacyDetail` để không mất thông tin người dùng đã gõ, và đánh trigger là chưa cấu hình.

Giữ `detail` cũ song song một release nếu muốn giảm rủi ro, nhưng **đừng để cả hai là nguồn sự thật** — chọn một, field còn lại chỉ để đọc.

### Runner shape

`WorkflowSchedulerService` (start tại `src/main/main.ts:75`) là scheduler duy nhất hiện có, hoạt động theo polling tick. Các runner mới nên theo cùng hình dạng để lifecycle nhất quán: một class có `start()`/`stop()`, được wire trong `main.ts` cạnh scheduler hiện tại, emit event qua cùng đường `workflow:event` (`workflow-service.ts:679`).

Điểm chung cho mọi runner: chúng đều kết thúc bằng cách gọi `workflowService.run({ workflowId, triggeredBy })`. Đừng để runner tự spawn process — `run()` đã lo approval gate, timeout, cancel, step chaining.

## Các phase

### Phase 1 — ngừng bán thứ chưa có (làm ngay)

Chia `triggerTypes` thành hai nhóm trong `workflow-ui.ts`: loại đã có runner, và loại chưa. Trong `WorkflowEditorDrawer.tsx:287-297`, render nhóm thứ hai ở trạng thái `disabled` với hậu tố rõ ràng (ví dụ `On Push — chưa khả dụng`), thay vì bỏ hẳn khỏi list. Giữ chúng nhìn thấy được nhưng không chọn được là trung thực hơn cả hai lựa chọn còn lại: bỏ hẳn thì người dùng đang dùng chúng bị mất context, cho chọn thì tiếp tục lừa.

Với workflow **đã lưu** dùng trigger chưa hỗ trợ (bao gồm hai seed): hiện badge cảnh báo trong `WorkflowsModule` và `WorkflowDetailPanel` nói rõ "trigger này chưa tự chạy, dùng Run để chạy tay". Đồng thời cân nhắc đổi hai seed tại `workflow-seeds.ts:108` và `:180` sang `manual` — một app mới cài không nên trông như có automation đang chạy mà thực ra không.

Phase này không cần migration, không đổi contract, và loại bỏ toàn bộ phần "lừa" của bug.

### Phase 2 — `file-change` runner

Loại khả thi nhất: thuần local, không cần credential, không cần network.

Một `FileChangeRunnerService` theo dõi `projectPath` của workflow, dùng `fs.watch` với `{ recursive: true }`. Các điểm cần cẩn thận, đây là chỗ file watcher thường sai:

- **Debounce là bắt buộc.** Một lần save trong editor có thể phát nhiều event. Debounce theo workflow, mặc định khoảng 2 giây, cho cấu hình qua `debounceMs`.
- **Bỏ qua thư mục sinh ra.** `.git`, `node_modules`, `.vite`, `dist`, `out`, `.verify` — nếu không loại, một lần `npm install` sẽ fire hàng nghìn event. `knowledge-service.ts` đã có danh sách ignore dir cho scanner; tái dùng nguồn đó thay vì viết list thứ hai sẽ lệch dần.
- **`fs.watch` recursive không đồng đều giữa các OS.** Trên macOS/Windows nó hoạt động; trên Linux nó chỉ được hỗ trợ từ Node mới và có giới hạn inotify. Repo yêu cầu Node >= 22.13 (`package.json:8`) nên recursive có sẵn, nhưng vẫn cần xử lý trường hợp watcher fail — báo lỗi rõ trong workflow status thay vì im lặng không bao giờ fire.
- **Đừng để workflow tự trigger chính nó.** Nếu một step ghi file trong project đang watch, nó sẽ fire lại → loop vô hạn. Chặn bằng cách bỏ qua event trong lúc workflow đó đang chạy, cộng cooldown sau khi run xong.
- **Giới hạn số watcher.** Mỗi workflow active một watcher; nhiều project lớn có thể chạm giới hạn file descriptor của OS.

### Phase 3 — `git-push` runner

Không có cách nào để app biết về push từ bên ngoài mà không có server. Hai đường khả thi, chọn đường thứ nhất:

**Polling ref local (đề xuất).** Đọc `.git/refs/heads/<branch>` hoặc `git rev-parse HEAD` theo chu kỳ, so với SHA đã thấy lần trước. Fire khi SHA đổi và khớp `branchPattern`. Dùng lại exec helper đã có tại `src/main/git/git-service.ts:114-141` — nó đã có timeout 5 giây và không bao giờ reject. Chu kỳ 30–60 giây là đủ; đây là local file, không phải API call.

Lưu ý đặt tên: cái này thực chất là "ref đã thay đổi" (commit, merge, rebase, checkout đều đổi SHA), không hẳn là "push". Nếu đặt tên trigger là `git-push` thì người dùng sẽ mong nó fire lúc push lên remote. Cân nhắc đổi label thành `On Commit` / `On Ref Change` cho đúng, hoặc thêm so sánh với `refs/remotes/<remote>/<branch>` nếu thật sự muốn nghĩa "đã push".

**Git hook do app cài.** Chính xác hơn nhưng phải ghi vào `.git/hooks/post-push` của repo người dùng — sửa file trong repo của họ, dễ xung đột với hook có sẵn, và cần một kênh để hook nói chuyện lại với app (lại cần port hoặc file signal). Không nên làm trước.

### Phase 4 — `webhook` và `issue-created` cần quyết định trước

Cả hai đòi hỏi thứ app hiện **không có**: một cách nhận thông tin từ bên ngoài.

`webhook` cần một process listen port. Hiện `src/main` không listen gì cả — không có `createServer`, không có port nào mở. Thêm cái đó là một quyết định kiến trúc thật (firewall prompt, chọn port, auth cho endpoint local, có tunnel hay không nếu webhook đến từ internet). Xem `ai-gateway-sidecar.md` — nếu app cuối cùng có sidecar/HTTP layer thì webhook nên sống ở đó chứ không phải là server thứ hai.

`issue-created` cần credential provider và polling API GitHub/Jira. Nó phụ thuộc provider connection có credential dùng được — tức phụ thuộc `provider-connection-truth.md` xong trước, vì hiện một connection có thể hiện `connected` mà chưa từng được validate.

Đề xuất: **giữ cả hai disabled** cho tới khi có quyết định sản phẩm. Chúng ở lại phase 1 (disabled + nhãn rõ) là trạng thái đúng, không phải nợ kỹ thuật cần trả gấp.

## Test

| File | Case |
| --- | --- |
| `tests/workflow-schedule.test.ts` (có sẵn) | Không hồi quy: `schedule` vẫn parse và fire như trước |
| `tests/workflow-trigger-config.test.ts` (mới) | Migration `detail` string → JSON config, gồm cả input rác |
| `tests/workflow-file-watch.test.ts` (mới) | Debounce gộp nhiều event thành một run; ignore dir không fire; workflow đang chạy không tự trigger |
| `tests/workflow-git-trigger.test.ts` (mới) | SHA đổi thì fire; SHA giữ nguyên thì không; branch không khớp pattern thì không |

Nhớ thêm mọi file mới vào `test:workflows` trong `package.json:25` — test không có tên trong đó sẽ không chạy.

Test watcher cần thư mục tạm thật và có yếu tố thời gian. Cho phép inject clock/debounce ngắn qua option thay vì `sleep` cứng trong test, nếu không suite sẽ chậm và flaky.

## Acceptance

- [x] Editor không cho chọn trigger chưa có runner mà không có cảnh báo; nhãn/copy nói rõ trạng thái hỗ trợ.
- [x] Workflow đã lưu với trigger chưa hỗ trợ hiện cảnh báo, vẫn chạy được bằng Run tay.
- [x] Sửa một file trong project → workflow `file-change` fire đúng một lần sau debounce.
- [x] Generated/ignored dirs không fire watcher.
- [x] Workflow `file-change` mà step của nó ghi file → không loop.
- [ ] Remote/ref trigger thực sự (`git-push`/ref-change) vẫn là future work.
- [x] Trigger tests đã được đăng ký trong `test:workflows`, và `npm run typecheck` xanh.
