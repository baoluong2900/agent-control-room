# Kế hoạch nâng cấp source — Agentic Workspace

Tài liệu này ghi lại trạng thái thực tế của source sau khi chuyển từ `apps/desktop` +
`packages/contracts` về `src/`, các bug đã được xác nhận bằng cách đọc code, và thứ tự
xử lý. Mọi kết luận ở đây đều đã được kiểm chứng bằng lệnh chạy thật, không phải suy đoán.

## 1. Trạng thái hiện tại

Cấu trúc sau migration:

```text
src/main/        # Electron main process (database, workflows, agents, git, knowledge)
src/preload/     # contextBridge -> window.agentic
src/renderer/    # React 19 UI (AgenticOS shell)
src/contracts/   # type dùng chung cho cả 3 tầng, alias @contracts
scripts/         # harness verify bằng Electron thật
tests/           # node:test chạy qua TS loader
```

Kết quả kiểm chứng (đã chạy thật, không phải giả định):

| Lệnh | Kết quả |
| --- | --- |
| `npm run typecheck` | Pass, không lỗi |
| `npm test` | Pass 76/76 |
| `npm run package` | Pass, build được app macOS arm64 |
| `grep apps/desktop\|packages/contracts` | Không còn tham chiếu nào |

Kết luận quan trọng: **migration đã sạch**. Cảm giác "bug nhiều quá" không đến từ
build hay test, mà đến từ các lỗi logic runtime chỉ xuất hiện khi dùng app thật —
đúng những chỗ mà typecheck và test hiện tại không chạm tới.

## 2. Bug đã xác nhận

### B1 — Dừng agent bằng tay bị ghi đè thành "failed" (nghiêm trọng)

`src/main/processes/agent-process-manager.ts`

`stop()` xoá run khỏi `this.running` rồi ghi status `stopped`. Sau đó process con
thật sự chết vì SIGTERM, handler `exit` chạy với `code === null`, tính ra
`status = "failed"` và ghi đè lên `stopped`. Handler `exit` không có cách nào biết
run vừa bị người dùng dừng, vì entry trong `this.running` đã bị xoá trước đó.

Hệ quả: user bấm Stop, history hiện "failed"; task liên kết bị `finishTaskRun`
gọi lần hai với `failed` nên nhảy sang `blocked` thay vì giữ trạng thái đã dừng.

Cách sửa: đánh dấu run là chủ động dừng trước khi `kill`, và cho handler `exit`
tôn trọng dấu đó thay vì suy ra status từ exit code.

### B2 — Gửi event vào webContents đã bị destroy (nghiêm trọng, macOS)

`src/main/main.ts`

`mainWindow` không bao giờ được set lại `null` khi cửa sổ đóng. Trên macOS,
`window-all-closed` không quit app, nên sau khi đóng cửa sổ biến này vẫn trỏ tới
một `BrowserWindow` đã destroy. `TaskAutomationService` (30s) và
`WorkflowSchedulerService` (60s) vẫn tick và vẫn gọi `webContentsProvider()?.send(...)`,
làm Electron ném `Object has been destroyed` từ trong timer.

Cách sửa: null hoá `mainWindow` khi cửa sổ `closed`, và chỉ trả webContents khi
window còn sống.

### B3 — Ghi database sau khi đã close lúc quit (trung bình)

`src/main/main.ts` + `agent-process-manager.ts`

`before-quit` gọi `processManager.stopAll()` rồi `database.close()` ngay. `stopAll`
chỉ gửi SIGTERM; handler `exit` của các process con chạy **sau đó**, và lúc này
`this.db.prepare(...)` thao tác trên database đã đóng nên ném exception trong lúc
app đang thoát.

Cách sửa: đánh dấu manager là đang shutdown để handler `exit` không ghi DB nữa.

## 3. Kế hoạch thực hiện

**Phase 1 — Sửa lỗi vòng đời (đã xong)**
Đã xử lý B1, B2, B3 trong commit `ebd7254`. Cả ba đều được chứng minh là bug thật
bằng cách tạm revert bản sửa và xem test mới fail đúng như mô tả:

```text
B1 -> actual 'failed' / expected 'stopped'
B3 -> Error: database is not open (ERR_INVALID_STATE)
```

**Phase 2 — Chốt bằng test hồi quy (đã xong)**
`tests/agent-process-lifecycle.test.ts` phủ ba tình huống trên và đã được thêm vào
`npm test`. Bộ test tăng từ 76 lên 79 và pass toàn bộ.

**Phase 3 — Thu hẹp khoảng trống kiểm chứng (đề xuất tiếp theo)**
Bộ test mạnh ở tầng database, workflow và schedule, nhưng trước Phase 2 thì
`agent-process-manager` và vòng đời window gần như không được phủ — đó chính là nơi
cả ba bug nằm. Việc còn thiếu, xếp theo mức độ đáng làm:

* Phủ test cho `WorkflowService.spawnStep`: nhánh timeout `SIGTERM` chỉ log rồi để
  handler `exit` quyết định status, chưa có test nào chạy vào nhánh này.
* Phủ test cho vòng đời window: hiện `activeWebContents()` đúng theo review code
  nhưng chưa có test tự động nào giữ nó khỏi hồi quy.

## 4. Cách kiểm chứng

Tất cả các lệnh dưới đây đã được chạy thật sau khi sửa và đều pass:

```bash
npm run typecheck        # clean
npm test                 # 79/79 pass
npm run package          # build macOS arm64 thành công
npm run verify:agents    # ALL CHECKS PASSED
npm run verify:agents:proc  # ALL CHECKS PASSED (gồm "stopped status recorded")
```
