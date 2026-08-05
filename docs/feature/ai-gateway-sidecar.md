# 15 — AI gateway / sidecar: tài liệu mô tả router nhưng runtime chưa có server

**Trạng thái: Acceptance ngắn hạn Done · Mức: P3 · Effort: XL · Loại: quyết định sản phẩm trước khi code**

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

## Vì sao phase 1, 3, 4, 5 vẫn chưa làm

Không phải nợ kỹ thuật bị bỏ quên — chúng cần quyết định sản phẩm:

- **Phase 1/3 (sidecar + `/v1`)**: sẽ là process **đầu tiên trong app mở port**.
  Kéo theo firewall prompt, chọn port, local API key, CORS, và quyết định bundle
  binary hay yêu cầu user tự cài.
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

- [ ] App start/stop sidecar theo lifecycle, không để process mồ côi.
- [ ] Gateway chỉ bind `127.0.0.1`, có local API key, không leak secret vào logs.
- [ ] `/v1/chat/completions` stream hoạt động cho ít nhất một provider.
- [ ] Cancel request từ workflow/agent dừng stream thật.
- [ ] Diagnostics biết sidecar healthy/unhealthy và action sửa.
- [ ] Fallback policy rõ ràng và không gửi dữ liệu sang provider khác ngoài ý người dùng.
