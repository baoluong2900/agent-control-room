# 14 — Diagnostics tiers: từ `--version` thành health check có hành động

**Mức: Done/MVP · Effort: M**

> **Đã triển khai.** `SystemDiagnostics` có actionable `checks` với trạng thái
> `ok/warn/fail/unknown` và action tới Settings/Integrations/project picker.
> Collector chỉ clone catalog một lần; phân biệt binary có mặt với version command
> lỗi; đọc provider status/last verification mà không mutate DB; thực hiện
> create/delete probe để chứng minh project writable; kiểm tra Git repo; và trả
> SQLite schema version, file footprint cùng số terminal-log rows. CLI chưa khai
> báo quota-safe smoke test được hiển thị `unknown`, không bị coi là fail. Projects
> UI render toàn bộ checks và refresh lại khi đổi project. Test:
> `tests/diagnostics.test.ts`.

## Trạng thái hiện tại

`collectDiagnostics()` (`src/main/ipc/diagnostics.ts:6-34`) kiểm tra presence/version cho 13 agent CLI + `git` + `docker`.

Luồng hiện tại:

1. Lấy `listAgentCatalog()` rồi bỏ `custom` và `shell` (`:7-9`).
2. Với từng CLI, gọi `pingAgentCli` (`:16`) trong `Promise.all` (`:11`). Từ catalog 15 entry, nó kiểm tra 13: kiro, agy, grok, claude, codex, gemini, amazonq, aider, opencode, cursor, copilot, qwen, ollama.
3. Thêm `git` (`:26`) và `docker` (`:27`) qua `checkTool`.
4. Trả `{platform, checkedAt, tools}` (`:29-33`).

`checkTool` (`:36-56`) chỉ resolve binary (`resolveBinary`, `:58-75`) và chạy `--version` (`readCommandOutput`, `:77-104`) với timeout 2.5s (`:84-87`). Nó giữ dòng đầu tiên của stdout/stderr (`:101`).

Hạn chế:

- Không kiểm tra auth provider, quota, key expired, hay command thật sự chạy được.
- Không kiểm tra project folder writable.
- Không kiểm tra SQLite health / DB size / log bloat.
- Không phân biệt "installed" với "usable".
- `collectDiagnostics` gọi `listAgentCatalog()` **lặp lại bên trong map** tại `:14`, nghĩa là deep-clone catalog nhiều lần (`catalog.ts:621-630`) chỉ để lookup descriptor.

`IntegrationsModule` dùng diagnostics như dashboard: load connections (`:31-42`), refresh diagnostics (`:46-60`), metric cards (`:66-72`), và mọi nút quản lý đều navigate về Settings (`:86`, `:89`, `:92`, `:121`, `:162`, `:247`). Nó không connect/verify trực tiếp.

`AnalyticsModule` thì khác: nó **có dữ liệu thật**, không phải mock. `src/renderer/analytics/AnalyticsModule.tsx:53-58` gọi `workflows.list()`, `workflows.metrics()`, `workflows.activity(8)`, `tasks.list()`, rồi reduce dữ liệu thành trend/rank.

## Mục tiêu

Diagnostics nên trả lời câu hỏi người dùng thực sự có: "Tại sao agent/task/workflow của tôi không chạy?". Presence/version là tầng đầu tiên, không phải kết luận cuối.

## Thiết kế: health tiers

Thay vì một `ToolHealth` flat, chia theo tier:

1. **Installed** — binary có trên PATH và đọc được version. Đây là hiện tại.
2. **Authenticated** — CLI/provider có credential dùng được. Phụ thuộc `provider-connection-truth.md` để connection status đáng tin.
3. **Runnable smoke test** — command tối thiểu chạy được không interactive. Ví dụ `claude --version` chưa đủ; cần một prompt no-op hoặc dry-run nếu CLI hỗ trợ.
4. **Project permissions** — folder đang chọn tồn tại, writable, là git repo nếu feature cần git.
5. **Database health** — DB mở được, schema version, size, terminal log size (liên quan `terminal-log-retention.md`).
6. **Network/proxy** — optional, chỉ khi provider cần network.

Contract mới có thể giữ backward compatibility bằng cách thêm field `checks` vào tool hiện tại:

```ts
interface DiagnosticCheck {
  key: string;
  status: "ok" | "warn" | "fail" | "unknown";
  detail?: string;
  action?: { label: string; target: "settings" | "docs" | "install"; value?: string };
}
```

UI không cần hiểu logic — chỉ render check list và action.

## Các phase

### Phase 1 — dọn implementation hiện tại

Trước khi thêm tier, sửa inefficiency: tạo `const catalog = listAgentCatalog()` một lần, build map id→descriptor, không gọi lại trong vòng lặp (`diagnostics.ts:14`). Không đổi contract, test dễ.

Đồng thời phân biệt thiếu binary với command lỗi — `readCommandOutput` đã có error handler, nhưng result hiện chỉ là `installed: false/detail`. Dùng detail rõ ràng hơn.

### Phase 2 — project + DB health

Thêm check không cần credential:

- Project path tồn tại, đọc được, ghi được (create/delete file tạm trong thư mục `.agentic-healthcheck` hoặc dùng `fs.access` với W_OK — create file thật chính xác hơn nhưng phải dọn sạch).
- Git repo status dùng `readGitDiff` (`git-service.ts:9`) nhưng phân biệt lỗi thiếu git theo plan [`git-workspace.md`](git-workspace.md).
- DB size, schema version (`DesktopDatabase.schemaVersion()` đã có theo migration runner), số row `terminal_logs`, dung lượng ước lượng.

Các check này deterministic và test offline được.

### Phase 3 — provider/auth health

Dùng `settings.verifyProviderConnection` logic nhưng **không tự động rotate status** nếu người dùng chỉ mở Diagnostics. Diagnostics nên có mode read-only: đọc credential presence + CLI presence + last verification, không sửa DB. Nếu muốn sửa status, nút "Verify" ở Settings mới là hành động ghi.

Hiển thị connection `unverified` như warn, `disconnected`/`expired` như fail, `connected` như ok. Nếu `lastVerifiedAt` quá cũ, warn.

### Phase 4 — runnable smoke test theo capability

Không mọi CLI có cách smoke test an toàn. Cần thêm capability vào catalog, ví dụ:

```ts
smokeTest?: { args: string[]; input?: string; timeoutMs?: number };
```

Không hardcode từng CLI trong diagnostics. Đây cùng triết lý với [`structured-chat-capability.md`](structured-chat-capability.md).

Smoke test phải không tiêu quota đáng kể. Nếu CLI không có dry-run/no-op, status là `unknown`, không phải fail.

## Test

| File | Case |
| --- | --- |
| `tests/diagnostics.test.ts` (mới) | Catalog chỉ được đọc một lần; missing binary có detail đúng |
| `tests/settings-service.test.ts` | Diagnostics đọc provider status mà không mutate DB |
| `tests/desktop-database.test.ts` | DB health trả schema version + log size |
| `tests/git-service.test.ts` | Project git check phân biệt non-repo và thiếu git sau plan 04 |

Nhớ thêm test mới vào `package.json:25`.

## Acceptance

- [ ] Diagnostics panel không chỉ hiện "installed", mà cho biết thiếu auth / project không writable / DB log quá lớn.
- [ ] Mở Diagnostics không tự đổi status provider trong DB.
- [ ] CLI không có smoke test được đánh `unknown`, không bị coi là fail.
- [ ] Action trong diagnostic đưa người dùng tới đúng nơi sửa (Settings, install docs, project picker).
- [ ] `npm test` xanh.
