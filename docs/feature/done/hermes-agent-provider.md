# Hermes Agent gateway provider

**Trạng thái: Done · Effort: M · Loại: provider/endpoint mới + redesign UI**

Implemented 2026-08-05: thêm provider `hermes-agent` (local OpenAI-compatible proxy của Hermes Agent), cho phép mọi CLI nói giọng OpenAI chạy mà không cần API key vendor; đồng thời làm lại UI phần Settings → AI providers.

## Vấn đề

Trước thay đổi này, provider catalog chỉ có 4 vendor + `custom-api`. Ai muốn dùng proxy của Hermes Agent phải chọn "Custom API", tự gõ endpoint, và **bắt buộc** dán một API key — trong khi bản chất proxy không cần key (nó tự gắn OAuth credential của người dùng ở upstream). Ba hệ quả:

1. Không lưu được connection nếu không bịa ra một key giả.
2. `codex` không nằm trong danh sách CLI tương thích `custom-api`, nên dù có endpoint cũng không route được.
3. Verify chỉ kiểm tra "có key trong vault không" — với một endpoint local thì đó là thông tin vô dụng; cái cần biết là **proxy có đang chạy không**.

Về UI, các card provider dùng chung một biến `apiKeyDraft` và một `baseUrlDrafts` — gõ key vào card này có thể theo sang card khác khi save.

## Đã làm

### Provider mới

`hermes-agent` được thêm vào `ProviderConnectionProvider` (`src/contracts/settings.ts`). Nó là loại **gateway**: bản thân nó là endpoint, không phải một vendor có CLI riêng.

- `provider-runtime-env.ts` đặt `OPENAI_BASE_URL` / `OPENAI_API_BASE` trỏ vào proxy, mặc định `http://127.0.0.1:8645/v1` (đúng bind mặc định của `hermes proxy start`).
- Không có key trong vault vẫn chạy được: một bearer placeholder được cấp, vì SDK OpenAI bên trong các CLI từ chối khởi động với key rỗng, còn credential thật do proxy gắn ở upstream.
- `resolveConnectionBaseUrl()` là chỗ duy nhất quyết định endpoint, để runtime và verification không lệch nhau.

### Route CLI → provider

`compatibleProvidersForCli()` thay cho map một-chiều cũ, trả về **danh sách theo thứ tự ưu tiên**:

1. Provider vendor của chính CLI đó (Claude Code cho `claude`, ...) — luôn thắng nếu có.
2. `hermes-agent`, rồi `custom-api` — cho các CLI nói giọng OpenAI.

`codex` được bổ sung vào nhóm OpenAI-compatible (trước đây thiếu). `claude` **không** nằm trong nhóm này vì Claude Code không nói wire format của OpenAI — đưa vào sẽ hứa một tuyến route không chạy được.

### Verification cho gateway

Đây là ngoại lệ có chủ ý so với nguyên tắc "không bao giờ gọi API của provider để test credential" ghi trong `provider-connection-truth.md`. Lý do: endpoint là loopback do chính người dùng chạy, nên `GET /models` không tốn quota và không gửi gì ra khỏi máy. Với gateway thì **reachability chính là thông tin hữu ích**, vì connection chết hoàn toàn khi proxy không bật.

| Kết quả probe | Status | Ý nghĩa |
| --- | --- | --- |
| Không kết nối được | `disconnected` | Proxy chưa chạy — detail nói thẳng `hermes proxy start` |
| 401 / 403 | `expired` | Proxy chạy nhưng upstream chưa login → `hermes proxy status` |
| 5xx | `expired` | Proxy chạy nhưng đang hỏng |
| 2xx | `connected` | Dùng được |

`EndpointProbe` được inject qua constructor `SettingsService` nên test không bao giờ mở socket thật.

### UI

- Tách state theo từng card: `Record<provider, ProviderDraft>` thay vì `apiKeyDraft` dùng chung. Key gõ ở card nào ở lại card đó (có test E2E khẳng định điều này).
- Tách `ProviderCard` thành component riêng — `SettingsModule` trước đó render toàn bộ inline.
- Ô API key chỉ hiện với provider thật sự cần (`authMode === "api-key"`), không hiện với gateway/oauth.
- Ô Endpoint chiếm trọn hàng (URL đầy đủ bị cắt khi để nửa cột), có placeholder là địa chỉ proxy mặc định.
- Mỗi card có hàng tag (harness · runtime · auth mode) và một dòng hint nói rõ nút bấm sẽ làm gì.
- Card đã có connection dùng được được đánh dấu bằng viền + vạch accent phía trên, để tìm nhanh trong lưới 6 card.
- Status chip đổi từ chữ máy (`unverified`) sang chữ người (`Not checked`).
- Nút Verify được nâng thành primary trong hàng action, vì nó là đường duy nhất đưa connection sang `connected`.

## Test

- `tests/provider-runtime-env.test.ts` — thứ tự ưu tiên provider, endpoint mặc định, endpoint tường minh ghi đè mặc định, `claude` không được route qua gateway.
- `tests/settings-service.test.ts` — verify gateway thành công / proxy chết / proxy trả 401.
- `scripts/settings-providers-harness.ts` (`npm run verify:settings:ui`) — E2E Electron thật: render đủ 6 card, save không cần gõ endpoint, verify promote sang Connected qua IPC thật, key không rò giữa các card, và **đo hình học DOM** (không control nào tràn card, không control nào bị bóp dưới ngưỡng đọc được, lưới 2 cột đều, thu hẹp cửa sổ thì sụp về 1 cột không sinh scroll ngang).

## Ghi chú vận hành

Proxy phải được bật thủ công bằng `hermes proxy start` (mặc định `127.0.0.1:8645`). App **không** tự spawn nó — xem `ai-gateway-sidecar.md` về lý do `src/main` hiện không có gì listen port.
