# 04 — Git: từ stat viewer thành workspace dùng được

**Trạng thái: Done/MVP · Mức cũ: P1 · Effort: M**

Implemented 2026-08-04: Git workspace now has `git:fileDiff`, `git:log`, `git:stage`, `git:unstage`, and `git:commit` across contract/preload/IPC/main service. The Projects Git panel can inspect per-file patches, show recent commits, stage/unstage individual files, and commit staged changes. Verified with `npm run test:workflows -- tests/git-service.test.ts` (140 passing total suite) and `npm run typecheck`.

## Trạng thái hiện tại

Đã nâng từ stat viewer thành Git workspace MVP:

- `src/main/git/git-service.ts` vẫn giữ `readGitDiff(cwd)` nhưng có thêm `readGitFileDiff`, `readGitLog`, `stageGitFile`, `unstageGitFile`, và `commitGitChanges`.
- Contract/preload/IPC expose đủ `git:fileDiff`, `git:log`, `git:stage`, `git:unstage`, `git:commit`.
- `GitDiffPanel` có tab Files/Patch/Stat/Log; click file mở patch, staged/unstaged dùng key theo `path + staged`, và form commit chỉ bật khi có staged changes + message.
- Write ops trả lại `GitDiffSummary` mới để renderer refresh từ trạng thái thật.
- Path input cho file operations được normalize/reject parent traversal trước khi gọi git.

MVP này chủ động chưa làm `push`, `stash`, checkout/branch, parser structured hunks, binary/truncated diff metadata, hoặc git-binary-missing classification. Các mục đó vẫn là follow-up hardening/feature work, không còn là blocker để dùng Git panel hằng ngày cho patch/stage/commit.

## Mục tiêu

1. Xem được diff thật từng file, không chỉ tổng kết.
2. Trạng thái lỗi trung thực (thiếu git ≠ không phải repo).
3. Sau khi read path vững, thêm write op có confirm rõ ràng.

## Thiết kế

Mở rộng contract `git` (`src/contracts/ipc.ts:108-110`) theo từng bước, read trước write:

```ts
git: {
  diff: (cwd: string) => Promise<GitDiffSummary>;
  fileDiff: (cwd: string, path: string, staged?: boolean) => Promise<GitFileDiff>;
  log: (cwd: string, limit?: number) => Promise<GitLogEntry[]>;
  // phase 3+
  stage: (cwd: string, paths: string[]) => Promise<GitDiffSummary>;
  unstage: (cwd: string, paths: string[]) => Promise<GitDiffSummary>;
  commit: (cwd: string, message: string) => Promise<GitCommitResult>;
}
```

`GitFileDiff` nên mang hunk đã parse, không phải text thô, để renderer không phải parse:

```ts
type GitDiffLine = { kind: "context" | "add" | "remove"; oldLine?: number; newLine?: number; text: string };
type GitHunk = { header: string; lines: GitDiffLine[] };
type GitFileDiff = { path: string; staged: boolean; binary: boolean; hunks: GitHunk[]; truncated: boolean };
```

Parse ở main process là đúng chỗ: nó gần `git` nhất, test được bằng `node:test` không cần DOM, và giữ renderer thuần trình bày.

## Các phase

### Phase 1 — patch viewer (giá trị cao nhất, không rủi ro)

Thêm `git:fileDiff`. Command: `git diff -- <path>` cho unstaged, `git diff --cached -- <path>` cho staged. Dùng lại helper `git()` có sẵn.

Parser cần xử lý: hunk header `@@ -a,b +c,d @@` (lấy được số dòng để hiện gutter), `diff --git` header, binary file (`Binary files ... differ` — không có hunk, set `binary: true`), file mới/bị xoá (`/dev/null` một bên), và no-newline marker `\ No newline at end of file`.

Giới hạn kích thước: một diff khổng lồ (file generated, lockfile) sẽ đóng băng renderer. Cắt ở ngưỡng hợp lý và set `truncated: true` để UI nói rõ "diff bị cắt", chứ **đừng cắt im lặng** — đó chính là lỗi mà `knowledge-truncation-report.md` đang phải đi sửa ở chỗ khác.

Trong `GitDiffPanel`, làm `<li>` tại `:106` click được để chọn file, thêm pane hiện hunk. Vì `files` có thể chứa hai entry cùng path (staged + unstaged), React key phải là `path + staged`, không phải `path`.

### Phase 2 — trạng thái lỗi trung thực + `git:log`

Tách nhánh `:11-23` thành ba trạng thái phân biệt: không phải repo, git chưa cài, và lỗi khác. Cách phát hiện: nếu `child.on("error")` bắn ENOENT thì đó là thiếu binary. Helper hiện gộp mọi thứ vào `{ok: false, output}` (`:132`), nên cần trả thêm một field phân loại.

Cũng tại đây, sửa hai chỗ nhỏ đã biết: `unquote` decode escape kiểu C của git để tên file non-ASCII hiện đúng, và phân biệt timeout với lỗi thật (hiện `kill()` tại `:124` resolve qua handler `exit` với stdout dở, trông như thành công một phần).

`git:log` với `--pretty=format:` cho ra danh sách commit gần đây. Đây là read-only, rẻ, và làm panel hữu ích hơn nhiều cho việc điều hướng.

### Phase 3 — write operation, có confirm

Chỉ làm sau khi phase 1–2 đã ổn định. Thứ tự theo mức độ khó hoàn tác:

1. `stage` / `unstage` — dễ hoàn tác, an toàn nhất.
2. `commit` — hoàn tác được (`reset --soft`), nhưng cần validate message không rỗng.
3. `stash` — cần hiện danh sách stash để người dùng không "mất" thay đổi.

**Không đưa `push` vào phase này.** Push là hành động ra bên ngoài, không hoàn tác được dễ, và cần xử lý credential/2FA/protected branch. Nó đáng một plan riêng.

Mọi write op phải: chạy trên project đang chọn (không phải cwd của app), trả `GitDiffSummary` mới để UI refresh từ sự thật thay vì đoán, và không bao giờ chạy khi `isRepository` false.

## Test

`tests/git-service.test.ts` đã có 9 test cho read path (non-repo, clean, staged/unstaged, deletion, rename, path có space, detached HEAD). Thêm:

| Case | Khẳng định |
| --- | --- |
| Parse hunk cơ bản | Số dòng old/new đúng, kind add/remove/context đúng |
| File mới | `/dev/null` một bên không làm parser sai |
| Binary file | `binary: true`, không có hunk giả |
| Diff quá lớn | `truncated: true` |
| Thiếu git binary | Phân biệt được với non-repo (mock exec trả ENOENT) |
| Path non-ASCII | Tên file tiếng Việt hiện đúng sau unquote |
| Stage rồi diff | Sau `stage`, file chuyển từ unstaged sang staged trong summary |

## Acceptance

- [x] Click một file trong Git panel → hiện patch/hunk text của file đó.
- [ ] File binary hiện thông báo structured riêng, không phải hunk rác.
- [ ] Lockfile lớn hiện "diff bị cắt" chứ không đóng băng UI.
- [ ] Máy chưa cài git → app nói thiếu git, không nói "không phải repo".
- [ ] File tên tiếng Việt quoted kiểu C hiện đúng tên.
- [x] Stage/unstage cập nhật panel ngay và đúng.
- [x] Commit staged changes tạo commit mới và refresh panel/log.
- [x] `npm run test:workflows -- tests/git-service.test.ts` xanh.
- [x] `npm run typecheck` xanh.
