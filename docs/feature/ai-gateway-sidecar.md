# 15 — AI gateway / sidecar: tài liệu mô tả router nhưng runtime chưa có server

**Trạng thái: Phase 0, 1, 2, 3 Done · Mức: P3 · Effort: XL · Còn lại: phase 4/5 cần quyết định sản phẩm**

Phase 0 đã xong (2026-08-06 verify): `docs/aiagnet.md` đã có banner
`Status: proposal / future architecture` ở đầu file, README không claim `/v1`
gateway, và index đã link plan này với P3/XL. Phase 1+ vẫn cố ý chưa làm — chúng
cần quyết định sản phẩm trước, không phải nợ kỹ thuật cần trả gấp.

Plan này khác các plan còn lại: không khuyến nghị lao vào implement ngay. Đây là khoảng cách giữa **tài liệu định hướng** và **runtime hiện tại**.

## Trạng thái hiện tại

`docs/aiagnet.md` mô tả một `Local AI Gateway` với `9Router hoặc CLIProxyAPI Sidecar`, OAuth management, model routing, token refresh, quota tracking, fallback, và endpoint local kiểu OpenAI-compatible `/v1/chat/completions` (xem doc đó quanh đoạn kiến trúc `Local AI Gateway`, đặc biệt phần endpoint `http://127.0.0.1:20128/v1/chat/completions`).

Runtime hiện tại **không có bất kỳ server local nào**:

- Grep `src/main` và `src/preload` cho `createServer`, `.listen(`, `express`, `fastify`, `127.0.0.1`, `0.0.0.0`, `/v1`, `fetch(`, `node:http`, `node:net`, `WebSocketServer`, `localhost:` → zero hit đáng kể; hit duy nhất là chữ "express" trong comment tiếng Anh tại `desktop-database.ts:1179`.
- `package.json` dependency không có HTTP framework hay sidecar package — chỉ Electron, React, three/r3f, framer-motion, lucide-react, zustand, xterm, forge/vite/typescript.
- `forge.config.ts` chỉ package main/preload/renderer, không khai báo extra binary/resource cho sidecar.
- Agent runtime đi qua `child_process.spawn` của local CLI: `AgentProcessManager.start()` (`src/main/processes/agent-process-manager.ts:126`) và workflow step execution cũng spawn CLI/shell qua `workflow-service.ts`.
- Provider verification mới (`src/main/settings/provider-verification.ts`) **không có network call**; nó chỉ kiểm tra secret tồn tại + CLI installed.
- Main↔renderer traffic là Electron IPC (`ipcMain.handle` trong `register-ipc.ts`) và push event qua `webContents.send`, không phải HTTP.

Nói ngắn: app hiện là **local CLI orchestrator**. Nó chưa phải OpenAI-compatible gateway, chưa có multi-account OAuth router, chưa có token refresh, chưa có quota tracking, chưa có fallback model routing.

## Mục tiêu ngắn hạn

Tránh hiểu nhầm. `docs/aiagnet.md` phải được đánh nhãn rõ là proposal / future architecture, hoặc bị chia thành hai phần:

1. **Current runtime**: local CLI orchestration qua Electron IPC + child_process + SQLite.
2. **Future gateway architecture**: sidecar OpenAI-compatible, nếu quyết định làm.

Đừng để người đọc nghĩ feature đã ship.

## Nếu quyết định implement gateway thật

Cần một kiến trúc rõ trước khi viết code, vì đây là thay đổi nền tảng chứ không phải thêm vài endpoint.

### Component đề xuất

1. **Sidecar manager trong main process**
   - Locate/download binary.
   - Spawn/stop theo app lifecycle.
   - Health check.
   - Port selection + port conflict handling.
   - Log sidecar vào SQLite hoặc file riêng có retention.

2. **Local auth cho gateway**
   - Không expose `/v1` mở toang trên localhost. Một local API key ngẫu nhiên lưu trong safeStorage hoặc file permission chặt.
   - Chỉ renderer/main biết key. Không log key.

3. **Provider account model**
   - Token/refresh token per provider.
   - Expiry/refresh trước khi hết hạn.
   - Quota/rate-limit cache.
   - Mapping model → provider/account.

4. **Adapter giữa workflow/agent và gateway**
   - Hiện workflow step spawn CLI. Gateway path sẽ stream HTTP response. Cần abstraction chung: "model invocation" có thể là CLI process hoặc gateway request.
   - Log streaming phải thống nhất với `terminal_logs` và retention (`done/terminal-log-retention.md`).

5. **Failure and fallback policy**
   - Khi provider A rate-limited, fallback sang provider B theo rule nào?
   - Có cho workflow đổi model giữa chừng không?
   - Có cần user approval khi fallback sang provider khác (dữ liệu rời máy tới vendor khác)? Đây là quyết định bảo mật/sản phẩm.

### Bảo mật bắt buộc

- Không listen trên `0.0.0.0` mặc định. Chỉ `127.0.0.1`.
- Local API key bắt buộc, kể cả localhost.
- CORS chặt nếu có HTTP server để tránh browser web page trên máy gọi gateway.
- Secret không được ghi plaintext vào SQLite; dùng `ProviderSecretVault` hiện có (`provider-secret-vault.ts`) hoặc OS keychain nếu nâng cấp.
- Log không được chứa raw API key/refresh token.

### Phụ thuộc các plan khác

Gateway nên chờ ít nhất:

- `provider-connection-truth.md`: connection status phải đáng tin, không tự nhận `connected`.
- `done/diagnostics-tiers.md`: cần health check cho gateway/sidecar.
- `done/terminal-log-retention.md`: sidecar logs có thể ồn.
- `done/structured-chat-capability.md`: tránh tiếp tục hardcode capability theo CLI khi thêm transport HTTP.

## Các phase nếu làm

### Phase 0 — sửa tài liệu ngay

Đổi đầu `docs/aiagnet.md` thành:

> This is a future architecture proposal. The current runtime is a local Electron CLI orchestrator and does not yet start a 9Router/CLIProxyAPI sidecar or expose `/v1` endpoints.

Link tới `docs/feature/ai-gateway-sidecar.md` để người đọc biết plan triển khai nằm đâu.

### Phase 1 — sidecar manager skeleton, chưa route model

Thêm service spawn/stop một process dummy hoặc binary local cấu hình được, health check, port conflict, log. Không connect provider, không `/v1` thật. Mục tiêu chỉ là lifecycle vững.

### Phase 2 — `/health` + local API key

Sidecar expose `/health` trên `127.0.0.1`, yêu cầu local API key cho mọi endpoint trừ health nếu muốn. Diagnostics đọc health và báo sidecar status.

### Phase 3 — OpenAI-compatible `/v1/chat/completions` streaming

Implement minimal adapter cho một provider trước. Không fallback. Không multi-account. Chỉ chứng minh streaming, cancellation, logging, error mapping.

### Phase 4 — provider accounts + refresh + quota

Mới làm OAuth/device flow thật ở đây, không nhét vào `openProviderAuth` hiện tại. `ProviderConnectionAuthResult` phải đổi contract để có token/expiry hoặc callback completion state.

### Phase 5 — routing/fallback policy

Thêm rule engine: model preference, provider priority, budget/quota, fallback. Đây là sản phẩm riêng — cần UI/UX rõ trước khi code.

## Test

| Phase | Test |
| --- | --- |
| 0 | Doc/header check không cần automated test |
| 1 | Sidecar manager spawn/stop, port conflict, crash recovery |
| 2 | `/health` chỉ bind localhost; key auth hoạt động |
| 3 | Streaming response, cancel giữa stream, error mapping, log retention |
| 4 | Token refresh mock, expired token, revoked credential |
| 5 | Fallback không gửi dữ liệu sang provider khác nếu policy cấm |

Phần server nên có test riêng, không chạy Electron UI trừ khi cần. Nếu sidecar là binary ngoài repo, cần mock/fake sidecar trong tests để CI offline.

## Acceptance ngắn hạn

- [x] `docs/aiagnet.md` nói rõ đây là future proposal, không phải runtime hiện tại.
- [x] README/source docs không claim app đã có `/v1` gateway.
      (grep `\/v1|9Router|gateway|sidecar` trong README: 0 hit.)
- [x] `docs/feature/README.md` link plan này với effort XL và P3.

## Phase 2 đã implement (2026-08-06)

Phase 2 ("Diagnostics đọc health và báo sidecar status") làm được **ngay** mà không
cần phần sidecar mà plan này defer. Endpoint probe đã tồn tại sẵn cho provider
verification; Diagnostics chỉ đơn giản là chưa gọi nó, nên một proxy đã chết vẫn
hiện thành row `connected` màu xanh.

`collectGatewayChecks` (`src/main/ipc/diagnostics.ts`) probe `baseUrl` của mỗi
connection `hermes-agent`, và **là check live duy nhất** trong Diagnostics. Mọi
provider check khác đọc stored verification state, thứ không thể trả lời "proxy có
đang chạy không" — gateway là process user tự start/stop ngoài app, nên một row
verify từ một giờ trước không nói gì về hiện tại.

Ba outcome thay vì hai, vì cần lời khuyên khác nhau:

| Kết quả | Status | Lý do |
| --- | --- | --- |
| Không reachable | `fail` | Nêu `hermes proxy start`, vì fix không nằm trong Settings |
| Answer nhưng 4xx | `warn` | Process đang chạy, nên bảo "start proxy" là sai; vấn đề là credential upstream |
| Answer | `ok` | Không cần call to action |

Connection không phải gateway, hoặc không có `baseUrl`, bị skip **không tốn network
call** — đó cũng là thứ giữ cho `tests/diagnostics.test.ts` chạy offline. Probe
injectable nên test mới không bao giờ chạm mạng.

Test: `tests/diagnostics-gateway.test.ts` (6 case), gồm một case pin rằng stored
`connected` không được che một endpoint đã chết.

## Phase 1 đã implement (2026-08-06, pass 3)

`src/main/gateway/sidecar-manager.ts`. Lý do hoãn cũ ("sẽ là process đầu tiên mở
port") **hết hiệu lực** khi webhook listener landed, nên phần còn lại của phase 1
chỉ là công việc bình thường.

Scope đúng như plan yêu cầu: **chỉ lifecycle**, không route model, không proxy `/v1`.
Xây route lên một lifecycle chưa chứng minh là cách chắc chắn để có một router mồ côi
giữ port.

**App không bundle và không tự download binary.** Đó là quyết định sản phẩm plan này
defer, nên command là **config trong bảng `settings`**
(`gateway.sidecar.command/args/port/cwd`). Chưa cấu hình = no-op im lặng, không phải
warning — app cố ý ship không kèm router, mà một badge vàng vĩnh viễn cho trạng thái
mặc định sẽ dạy user bỏ qua Diagnostics.

### Hai bug thật, tìm ra bằng test chứ không phải bằng đọc

1. **Sai tên command làm crash cả app.** `spawn` **không** throw khi thiếu binary —
   nó emit `error` ở tick sau. Handler của tôi lại attach *sau* một `await`, nên nó
   thành `uncaughtException`. Giờ listener được gắn trước khi có bất kỳ chỗ yield
   nào, và `start()` await kết quả spawn.
2. **`raceExit` trong `process-tree.ts` dùng `timer.unref()`**, nên trong một process
   có event loop rảnh thì grace period *co lại*, và child trap SIGTERM bị báo là
   `exited-on-term` mà **không hề escalate**. Trong Electron và trong test runner luôn
   có thứ giữ loop mở nên escalation vẫn đúng trong app thật — nhưng đây là cái bẫy
   đáng biết, và là lý do test mới dùng workload `sh`/`trap` mà suite kill-escalation
   đã chứng minh, thay vì `node -e` (child Node có một khoảng sau spawn mà handler
   chưa kịp cài; stop chen vào đúng khoảng đó thì giết luôn và test thành vô nghĩa).

### Chi tiết

| Yêu cầu của plan | Cách làm |
| --- | --- |
| Spawn/stop theo lifecycle, không mồ côi | Dùng lại `terminateProcessTree`, **không** `child.kill()` — router fork worker thì worker sẽ giữ port. Có test spawn worker thật rồi assert nó chết theo |
| Port selection + conflict | Port 0 để OS chọn; port cấu hình bị chiếm thì **báo lỗi**, không âm thầm đổi sang port khác (user chọn port đó vì có thứ đang trỏ vào) |
| Log có retention | Cap 500 dòng trong memory, không persist — `terminal_logs` retention đã lo phần run output |
| Local API key | Sinh ngẫu nhiên 32 byte, truyền vào child qua env, bắt buộc cho `/health`, và **strip khỏi log** |
| Không leak secret vào log | Fake sidecar trong test **cố ý in key ra**, và có test assert nó quay về dạng `***` |

## Phase 2 đã implement (2026-08-06, pass 3)

`probeSidecarHealth` + `collectSidecarChecks`. Diagnostics phân biệt **ba** trạng thái
cần ba cách sửa khác nhau:

- **crashed** → `fail`, kèm lý do đã ghi (`exited immediately (exit code 3)`)
- **đang chạy nhưng `/health` im lặng** → `warn`, và **không** khuyên "start it" (process
  đang sống; vấn đề là flags hoặc chưa boot xong)
- **healthy** → `ok`

Check xanh **bắt buộc** phải do `/health` trả lời, không bao giờ suy ra từ lifecycle
state — vì phase 1 promote process thành `running` ngay khi nó sống qua startup.

### Verify với router thật

Không chỉ với fake: `hermes proxy start --port 8646` (một OpenAI-compatible router
thật có trên máy) — spawn được, `/health` trả **HTTP 200**, capture đúng 5 dòng log
startup của nó, **không leak key**, stop mất 72ms, và sau đó `lsof` cho thấy không có
gì giữ port 8646, `pgrep` không còn `hermes proxy` nào.

## Phase 3 đã implement (2026-08-10)

`/v1/chat/completions` streaming, cancellation, error mapping. Lý do hoãn cũ —
"adapt provider nào trước" — **không còn là câu hỏi mở**: provider connection đã có
`baseUrl` + credential trong vault, `resolveConnectionBaseUrl` đã resolve endpoint, và
`custom-api`/`hermes-agent` **là** endpoint OpenAI-compatible. Không cần quyết định
sản phẩm nào để adapt cái đầu tiên; nó đã được cấu hình sẵn.

| File | Vai trò |
| --- | --- |
| `src/contracts/gateway-chat.ts` | Contract. `requestId` do **caller** cấp, không phải trả về |
| `src/main/gateway/gateway-chat-client.ts` | HTTP + SSE thuần, `fetch` injectable |
| `src/main/gateway/gateway-chat-service.ts` | Vault, chọn connection, registry cancel |
| `src/renderer/gateway/gateway-chat-ui.ts` | Copy + state machine, test không cần DOM |
| `src/renderer/gateway/GatewayChatPanel.tsx` | UI trong Integrations rail |
| `tests/gateway-chat-client.test.ts` (23) · `tests/gateway-chat-service.test.ts` (16) | |

### Cancellation là lý do contract có shape này

Một CLI run bị dừng bằng cách signal pid. Một HTTP stream **không có pid**, nên id
phải là handle — và nó do renderer mint **trước khi** request rời đi. Nếu id chỉ về
cùng completion thì mấy giây đầu (trước token đầu tiên) sẽ không thể cancel, đúng
khoảng thời gian user hay bấm Stop nhất.

Cancel trả về **partial text** như một completion `ok` với `cancelled: true`, không
phải error. Những token đó đã được sinh ra và đã bị bill; bỏ đi vừa là UI tệ hơn vừa
là bản ghi không trung thực.

### Một bug thật, chỉ tìm ra bằng gateway thật

Pool API (`:5100`) trả **HTTP 200 + `content-type: text/event-stream`** nhưng đặt lỗi
**bên trong** stream:

```
data: {"error":{"message":"No healthy upstream deployment was available.",...,"code":"upstream_error"}}
data: [DONE]
```

Client bản đầu parse cái này thành completion **thành công với text rỗng** — tức báo
một request chạy được mà chẳng sinh ra gì. Đây đúng loại "side effect thành công
nhưng bản ghi nói dối". Toàn bộ 34 unit test lúc đó đều xanh vì stub nào cũng đặt lỗi
ở status line.

Sửa: `parseErrorEnvelope` dùng chung cho **cả hai** parser (stream và non-stream, vì
cả hai gặp đúng cái bẫy này), và `classifyStreamErrorCode` map `code` sang kind — vì
không có HTTP status để dựa vào, một auth failure gửi kiểu này vẫn phải chỉ user tới
Settings chứ không phải nút Retry. 5 test mới, một trong đó dùng nguyên payload thật
của gateway.

### Verify với server thật

Không chỉ với fake. Streaming + cancel chống mock provider `:5199` mà Pool API front
(SSE thật, chunk thật, không viết ra để làm test pass):

| Hạng mục | Kết quả |
| --- | --- |
| Streaming | **10 delta callback** (thật sự incremental), TTFT 31ms, usage 19 token |
| Non-streamed | text đủ, `ttftMs: null` (không đo thì không bịa số 0) |
| Cancel giữa stream | `cancelled: true`, **93 ký tự partial giữ lại**, registry sạch |
| 401 thật (Pool API `:5100`) | `unauthorized` + statusCode 401 |
| In-stream error thật | `server-error` kèm nguyên văn của gateway |
| Port chết `:5399` | `unreachable` |
| Credential | **không xuất hiện** trong target list, completion, hay event nào |

### Ma trận phân biệt (chứng minh test có "răng")

Không sabotage source; drive code thật bằng input phải xử lý **khác nhau**:

- **Connection eligibility**: 9 case → hermes/custom-with-baseUrl/unverified/explicit-id
  routed; custom-không-baseUrl, claude-code, expired, disconnected, explicit-id-sai
  refused. Nếu guard là no-op thì cả 9 dòng giống nhau.
- **HTTP status**: 401/403 → `unauthorized`; 402 → nhắc credit; 400/429/500/503 →
  `server-error`. Ba nhóm khác nhau.
- **Cancel vs timeout vs transport**: `cancelled` / `unreachable (did not finish in
  time)` / `unreachable (fetch failed)` — ba kind riêng, vì user bấm Stop không phải
  là một failure.
- **SSE reassembly**: cùng một frame chia 1 chunk, 2 chunk, và **54 chunk từng byte**
  → cả ba ra `"ABCDEFGH"`. Parser giả định một frame/chunk sẽ mất token ở case 54.

### Phase 4/5 vẫn chưa làm, và vì sao đó là quyết định chứ không phải effort

Phase 3 **không** kéo được phase 4/5 theo. `sendChat` gửi credential mà connection đã
lưu; nó không refresh token, không rotate, không đăng nhập. Phase 4 (multi-account
OAuth) cần đúng những thứ `done/provider-connection-truth.md` cố ý loại khỏi scope.
Phase 5 (fallback routing) có một câu hỏi bảo mật thật: fallback sang provider khác
nghĩa là dữ liệu rời máy tới vendor khác — cần approval của user hay không? Đó là câu
chủ sản phẩm trả lời, không phải agent tự quyết.

Còn một residual **của phase 3** đúng là quyết định: workflow step hiện spawn CLI, và
cho step chọn gateway transport cần abstraction "model invocation" chung (mục 4 trong
Component đề xuất) — tức đổi shape của step definition, thứ ảnh hưởng tới schema và
UI builder. Transport đã có và đã verify; nối nó vào workflow step là một plan riêng.

## Vì sao phase 4, 5 vẫn chưa làm

Không phải nợ kỹ thuật bị bỏ quên — chúng cần quyết định sản phẩm.

**Cập nhật 2026-08-06 (pass 2): lý do "chưa ai mở port bao giờ" không còn đúng.**
Webhook listener (`src/main/workflows/webhook-listener.ts`) đã mở port thật, và nó
thiết lập sẵn khuôn mẫu mà phase 1/3 có thể dùng lại nguyên vẹn:

- bind `127.0.0.1` nên không có firewall prompt, không lộ ra LAN;
- token bắt buộc, so sánh timing-safe, lưu trong vault sẵn có;
- port `0` để OS tự chọn, `EADDRINUSE` báo lý do ra UI thay vì crash;
- chỉ mở khi thực sự có thứ cần tới nó, đóng lại khi không còn;
- đóng trước `database.close()` trên quit path.

Nói cách khác, **rào cản hạ tầng đã hết**; phần còn lại của phase 1/3 giờ thuần là
câu hỏi sản phẩm: có bundle binary của router hay bắt user tự cài, dùng port cố định
hay ngẫu nhiên, và ai chịu trách nhiệm vòng đời process đó khi app đóng. Đó là những
câu chỉ chủ sản phẩm trả lời được, không phải thứ agent nên tự quyết.

- **Phase 3 (`/v1` streaming)**: **đã làm** — xem section riêng bên dưới.
- **Phase 4 (multi-account OAuth)**: cần đúng những thứ `provider-connection-truth.md`
  đã cố ý loại khỏi scope.
- **Phase 5 (routing/fallback)**: là một sản phẩm riêng — cần UX rõ trước, và có câu
  hỏi bảo mật thật: fallback sang provider khác nghĩa là dữ liệu rời máy tới vendor
  khác, nên cần approval của user hay không?

Vị trí trung thực hiện tại: app **trỏ được** tới gateway do user chạy, và báo đúng
sự thật nó có answer hay không. Verify 2026-08-06: `defaultEndpointProbe` với
`http://127.0.0.1:8645/v1` trả `{reachable:false}` khi chưa `hermes proxy start` —
tức đường "trỏ tới router" đã chạy thật, chỉ chưa tự spawn.

Re-verify runtime 2026-08-06: grep `createServer` / `.listen(` / `express` /
`fastify` trong `src/main` và `src/preload` vẫn không có hit thật — app vẫn là
local CLI orchestrator, không mở port nào. Hit duy nhất liên quan là một comment
và địa chỉ bind mặc định của `hermes proxy start` trong `provider-runtime-env.ts`,
tức là *trỏ tới* một router bên ngoài, không phải tự chạy một cái.

## Acceptance dài hạn nếu implement

- [x] App start/stop sidecar theo lifecycle, không để process mồ côi.
      (Verify với router thật: stop 72ms, port 8646 free, không process sót.)
- [x] Gateway chỉ bind `127.0.0.1`, có local API key, không leak secret vào logs.
      (Key strip khỏi log, có test với sidecar cố ý in key ra.)
- [x] `/v1/chat/completions` stream hoạt động cho ít nhất một provider.
      (Verify với server thật: 10 delta callback, TTFT 31ms, usage 19 token.)
- [x] Cancel request từ workflow/agent dừng stream thật.
      (Cancel trên socket thật giữ lại 93 ký tự partial, registry sạch sau đó.)
- [x] Diagnostics biết sidecar healthy/unhealthy và action sửa.
      (Ba trạng thái: crashed / running-nhưng-không-answer / healthy.)
- [ ] Fallback policy rõ ràng và không gửi dữ liệu sang provider khác ngoài ý người dùng.
