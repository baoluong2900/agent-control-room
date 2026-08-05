# 07 — Agent lifecycle: restart, concurrency limit, kill escalation

**Trạng thái: Done · Mức cũ: P1 · Effort: M**

Implemented 2026-08-04: restart and a real concurrency queue are wired through the process manager/API/UI, so `queued` now represents actual waiting work and failed runs can be restarted with their saved input.

Completed 2026-08-06: kill escalation landed. `src/main/processes/process-tree.ts` snapshots the process tree, escalates SIGTERM→SIGKILL after an injectable grace period (`taskkill /F /T` on win32), and reaps descendants deepest-first; `stop()` no longer drops its bookkeeping before the child is confirmed dead. Covered by `tests/process-kill-escalation.test.ts` (registered in `test:workflows`).

## Trạng thái hiện tại

Done. `AgentProcessManager` đã có queue/concurrency limit thật và restart path; IPC/renderer có hành động restart, và task/workflow callers không còn phải spawn vô hạn khi nhiều run đến cùng lúc. Status `queued` giờ là trạng thái runtime thật thay vì chỉ là nhãn trước khi spawn.

Kill escalation đã xong (2026-08-06): `stop()` giữ handle cho tới khi child thật sự exit, escalate SIGTERM→SIGKILL sau grace period, và kill cả cây process con nên `sh -lc` không còn để lại orphan. Grace period injectable qua constructor để test co xuống vài trăm ms.

### Cập nhật 2026-08-05 — spawn-window bug đã sửa

Trong lúc rà soát app, một lỗi thật của queue path đã được tìm ra và sửa (chi tiết
đầy đủ trong `docs/audit-2026-08-05.md`):

`drainQueue()` shift run khỏi `queued` rồi `await spawnQueued()`, mà hàm này phải
`await buildInvocation()` trước khi đưa child vào `running`. Trong cửa sổ đó run
không nằm ở collection nào, nên:

- không chiếm slot concurrency → child thứ 4 vẫn spawn được dù limit là 3;
- không xuất hiện trong `sessions()` → UI mất row;
- `stop()` không tìm thấy nó ở đâu → return im lặng, và child spawn ra sau đó thành
  orphan.

Đã sửa bằng: map `spawning` giữ spawn đang bay, `activeCount()` =
`running.size + spawning.size` làm concurrency gate, `sessions()` báo cáo chúng là
`planning` / `(starting)`, và `stop()` ghi cancellation vào `cancelledSpawns` để
`spawnQueued()` SIGTERM child ngay khi có handle thay vì publish nó như live.

Test `tests/agent-process-lifecycle.test.ts` chuyển từ 6 pass / 1 fail sang 7 pass /
0 fail (chạy 3 lần liên tiếp); full `npm test` = 175/175.

Việc này **không** thay thế Phase 1 dưới đây. Phase 1 (kill escalation) sau đó đã
được làm xong trong pass 2026-08-06 — xem ghi chú Completed ở đầu file.


### Cập nhật 2026-08-06 — late output ghi vào DB đã close

Khi verify phase 1, suite lộ ra một bug thật của quit path (`npm test` 192 pass /
1 fail, luôn cùng một file):

`app.on("before-quit")` (`src/main/main.ts:123-128`) gọi `processManager.stopAll()`
rồi `database.close()` — cả hai đồng bộ. Nhưng child process sống thêm tới hết
grace period, và agent CLI thường in output lúc bị kill. Output muộn đó đi vào
`handleOutput()` → `appendTerminalLog()` trên handle đã đóng và throw
`database is not open` từ trong stream callback, tức **uncaughtException trên
đường thoát app**, một lần cho mỗi agent còn chạy.

`handleOutput` là DB writer async duy nhất trong manager **không** có guard
`shuttingDown` — mọi handler khác (`error`, `exit`, `onEscalate`) đều đã có. Fix
là thêm guard đó; bỏ vài byte cuối của một CLI đang chết trong lúc quit là trade
đúng, vì run đã được ghi `stopped` và không còn reader nào để hiển thị.

Regression test: `tests/process-kill-escalation.test.ts` — "the quit path survives
output that arrives after the database closes". Đã verify test này load-bearing
bằng cách bỏ guard ra và thấy nó đỏ với đúng lỗi `database is not open`.

`npm test`: 193/193.


## Mục tiêu

1. `stop()` thực sự dừng process, kể cả process cứng đầu.
2. Có giới hạn số agent chạy đồng thời, và hàng đợi thật khi vượt.
3. Restart một run mà không phải nhớ lại tham số đã dùng.
4. Status `queued` nói đúng sự thật.

Cố ý **không** làm: pause/resume. Xem ghi chú cuối file.

## Các phase

### Phase 1 — kill escalation (an toàn nhất, làm trước)

Trong `stop()` (`:257-265`): sau khi gửi SIGTERM, đặt timer (khoảng 5 giây). Nếu process chưa exit khi timer nổ, gửi `SIGKILL`. Xoá entry khỏi map **chỉ khi** đã xác nhận exit, không phải ngay sau khi gửi signal như hiện tại tại `:265`.

Đây là sửa lỗi rõ ràng: hiện app có thể để lại process mồ côi và người dùng không có cách nào biết. Sau phase này, `stop()` nghĩa là đã dừng.

Ghi log lifecycle khi phải escalate — nếu một CLI thường xuyên cần SIGKILL, đó là thông tin đáng biết.

Cẩn thận trên win32: `kill(undefined)` không có tương đương SIGKILL trực tiếp. Cần `taskkill /F /T /PID` để hạ cả cây process con, vì nhiều CLI spawn process con riêng.

### Phase 2 — concurrency limit + queue thật

Thêm giới hạn số run đồng thời (mặc định gợi ý: theo số CPU core, hoặc một số nhỏ như 4 — agent CLI thường tốn nhiều RAM hơn CPU).

`start()` (`:57`) thay vì spawn ngay tại `:126`: nếu số run đang chạy đã đạt giới hạn, ghi run vào hàng đợi, giữ status `queued` (status này đã có sẵn ở `:79`/`:95` nên UI không cần đổi nhiều), rồi return. Khi một run kết thúc, lấy run kế tiếp từ hàng đợi và spawn.

Điểm cần quyết định: `start()` hiện resolve sau khi spawn. Nếu run bị queue, nó resolve khi nào? Đề xuất resolve ngay với `AgentProcess` có status `queued` — caller (task scheduler, workflow, UI) không nên bị block chờ. Nhưng phải kiểm tra `task-automation-service.ts:92` và workflow step execution xem chúng có giả định process đã chạy sau khi `start()` resolve hay không.

UI cần nói rõ lý do chờ: "queued — đang chờ slot (2 đang chạy)". Status `queued` hiện tại không phân biệt được "vừa tạo" với "đang chờ slot".

Giới hạn nên tính theo CLI hay tổng? Tổng đơn giản hơn và đủ cho vấn đề hiện tại (bảo vệ máy). Giới hạn theo CLI/provider hữu ích cho rate limit nhưng phức tạp hơn — để sau.

### Phase 3 — restart

Thêm `restart(runId)` vào manager và channel `agent:restart` (theo mẫu `agent:stop` tại `register-ipc.ts:80`).

Restart cần tham số gốc của run. Chúng có trong DB (run record lưu cwd, cliId, prompt, options). Đọc lại từ đó, stop run cũ nếu còn chạy, rồi start một run **mới** với cùng input — không tái dùng runId, vì log và history của lần chạy trước phải giữ nguyên để so sánh.

Với structured chat (`commands.ts:202`), restart có thể tiếp tục conversation cũ nếu có `conversationId`, hoặc bắt đầu mới. Cho người dùng chọn, mặc định là mới (an toàn hơn — conversation cũ có thể đã ở trạng thái lỗi).

## Test

`tests/agent-process-lifecycle.test.ts` đã tồn tại và đã có trong `test:workflows`. Mở rộng nó thay vì tạo file mới.

| Case | Khẳng định |
| --- | --- |
| Process phớt lờ SIGTERM | Bị SIGKILL sau timeout; map không còn entry; status đúng |
| Stop process bình thường | Không escalate (không SIGKILL không cần thiết) |
| Vượt giới hạn | Run thứ N+1 có status `queued`, không spawn |
| Run kết thúc | Run trong hàng đợi được spawn tự động |
| Queue rồi stop | Stop một run đang queued thì nó bị bỏ khỏi hàng đợi, không spawn sau đó |
| Restart | Tạo run mới, giữ log run cũ, dùng đúng tham số gốc |
| Shutdown khi có queue | `stopAll` dọn cả hàng đợi, không spawn thêm sau khi shutting down |

Case "queue rồi stop" và "shutdown khi có queue" là hai chỗ dễ sai nhất — hàng đợi phải tôn trọng cờ `shuttingDown` (`:49`) đã có.

## Acceptance

- [x] Chạy một CLI bắt SIGTERM và không thoát → app vẫn dừng được nó, không để lại process mồ côi (verify bằng `ps`).
- [x] Start nhiều agent hơn giới hạn → số process thật đúng bằng giới hạn, phần còn lại hiện `queued`.
- [x] Một agent kết thúc → agent đang chờ tự động bắt đầu.
- [x] Đóng app khi có agent đang queued → không spawn thêm sau shutdown.
- [x] Restart một run đã fail → run mới chạy, log run cũ vẫn xem được.
- [x] Lifecycle/concurrency tests and `npm run typecheck` xanh.

## Ghi chú: vì sao không làm pause/resume

SIGSTOP/SIGCONT dừng process ở tầng OS, nhưng phần lớn agent CLI giữ kết nối HTTP tới provider. Một process bị SIGSTOP giữa lúc đang stream response sẽ bị timeout phía server, và khi SIGCONT thì nó tiếp tục với một kết nối đã chết — trạng thái tệ hơn cả stop hẳn, và khó debug vì trông như đang chạy.

Pause chỉ có nghĩa nếu CLI hỗ trợ nó ở tầng ứng dụng (checkpoint conversation rồi thoát). Đó là capability theo từng CLI, nên nếu làm thì làm qua flag trong catalog — xem `done/structured-chat-capability.md` cho mẫu đúng của việc thêm capability flag thay vì hardcode theo cli id.
