# 02 — Provider connection: đừng tự nhận "connected" khi chưa check

**Trạng thái: Done/P0 residual · Mức cũ: P0 · Effort: S · Loại: UI nói sai trạng thái**

Implemented 2026-08-04: new provider rows default to `unverified`, Connect/Reconnect no longer hardcode `connected`, verification is wired through IPC, renderer cards expose unverified/verified details, and Kiro verification no longer depends on the lossy provider→CLI inversion. Remaining residual: OAuth/device is still a manual/open-external flow, not a full callback/device-token exchange.

## Trạng thái hiện tại

Đã sửa phần trạng thái sai. Backend verification kiểm tra local readiness (credential trong vault + CLI provider trên PATH), IPC/preload/contract đã nối, DB default là `unverified`, và renderer không còn tự truyền `status: "connected"` khi Connect/Reconnect. Verify là đường đưa connection sang `connected`; khi thiếu CLI/credential, card hiển thị `disconnected` hoặc `unverified` kèm detail.

Residual còn lại là OAuth/device wording/flow: `openProviderAuth()` vẫn mở trang provider bằng browser để người dùng tự lấy credential, chưa có callback listener, device-code exchange, token refresh, hay provider SDK. Vì vậy tài liệu này được đánh dấu Done/P0 residual thay vì P0 mở.

## Mục tiêu

Trạng thái hiển thị phải phản ánh điều app thực sự biết:

1. Bấm Connect → `unverified`, không phải `connected`.
2. Verify là hành động rõ ràng, và là con đường duy nhất tới `connected`.
3. Copy trong UI không gọi `openExternal` là OAuth/device login.

Cố ý **không** nằm trong scope: OAuth thật. Xem phase 4 để biết vì sao nó là quyết định riêng.

## Các phase

### Phase 1 — bỏ hardcode `connected` (một dòng mỗi chỗ)

Tại `SettingsModule.tsx:177` và `:216`, bỏ `status: "connected"` khỏi payload. Để `desktop-database.ts:296` áp default `"unverified"`.

Kèm theo: sau khi save thành công, **tự gọi verify ngay** rồi cập nhật card bằng kết quả. Như vậy luồng người dùng vẫn một bước ("Connect" → thấy trạng thái thật), không bắt họ bấm hai nút. Nếu verify trả `cli-missing`, card hiện `disconnected` cùng lý do — đó là thông tin hữu ích, không phải lỗi.

Cẩn thận với `last_connected_at` tại `desktop-database.ts:332`: nó chỉ set khi status là `connected`. Sau phase này, nó sẽ được set lúc verify thành công thay vì lúc save — đúng nghĩa hơn với tên field.

### Phase 2 — hoàn tất UI verification (phần lớn đã có trong working tree)

Đã có: nút Verify, pill "Unverified", `verificationDetail` một dòng có tooltip, `.status-unverified` CSS. Còn thiếu:

- **`IntegrationsModule`**: đọc `connection.status` tại `src/renderer/integrations/IntegrationsModule.tsx:68-69` và `:138-139` nhưng không có case cho `unverified`, và không bao giờ hiện `lastVerifiedAt`. Thêm cả hai, cộng CSS `.integrations-status` tương ứng cho state mới.
- **`lastVerifiedAt`**: chưa render ở đâu cả (`grep` chỉ thấy trong contracts/main/tests). Hiện nó dạng tương đối ("verified 3 phút trước") trong provider card — một verification từ tuần trước không nên trông giống vừa mới check.

### Phase 3 — sửa map provider→CLI bị lossy

`provider-verification.ts:36-41` build map provider→CLI bằng cách **đảo** `providerByCli` (`src/main/agents/provider-runtime-env.ts:8-14`). Map gốc có hai CLI trỏ cùng một provider (`kiro: "kiro"` và `amazonq: "kiro"`), nên phép đảo mất dữ liệu — last-write-wins khiến provider `kiro` resolve thành binary **`amazonq`**.

Hệ quả: verify một connection Kiro sẽ đi probe `amazonq`. Nếu người dùng có Kiro nhưng không có Amazon Q, họ nhận `cli-missing` sai.

Sửa bằng cách khai báo map xuôi tường minh (provider → danh sách CLI chấp nhận được) thay vì đảo, và coi provider là verified nếu **bất kỳ** CLI trong danh sách tồn tại. `tests/settings-service.test.ts:278` hiện đang assert đúng hành vi lossy này — cập nhật test cùng lúc, và ghi trong test lý do map là xuôi chứ không đảo.

### Phase 4 — đổi copy cho OAuth (hoặc quyết định làm thật)

Ngắn hạn, trung thực: đổi wording UI từ OAuth/device login thành đúng những gì xảy ra — mở trang provider trong browser để người dùng tự lấy credential rồi dán vào. Sửa label quanh `SettingsModule.tsx:164-168` và `:201-205`, và cân nhắc đổi tên `openProviderAuth` thành `openProviderSite` để tên hàm không hứa hẹn quá.

Nếu muốn OAuth thật thì đó là một plan riêng, vì nó cần: custom protocol handler (`app.setAsDefaultProtocolClient`) hoặc loopback listener cho redirect, PKCE + `state`, token exchange, refresh trước khi hết hạn, và thêm field token vào `ProviderConnectionAuthResult`. Chú ý một loopback listener sẽ là **process đầu tiên trong app mở port** — hiện `src/main` không có gì listen (xem `ai-gateway-sidecar.md`), nên nó kéo theo cân nhắc về bảo mật và firewall prompt. Đừng nhét vào plan này.

## Test

Mở rộng `tests/settings-service.test.ts`:

| Case | Khẳng định |
| --- | --- |
| Save không truyền status | Kết quả là `unverified`, và `lastConnectedAt` vẫn null |
| Verify thành công | Status thành `connected`, `lastVerifiedAt` được set |
| Verify khi thiếu CLI | Status `disconnected` + detail nói rõ CLI nào thiếu |
| Rotate credential | Verification cũ bị invalidate (đã có ở `settings-service.ts:78`) |
| Map Kiro | Provider `kiro` probe CLI `kiro` — thay thế assertion lossy tại `:278` |

## Acceptance

- [x] Bấm Connect với API key hợp lệ và CLI đã cài → card chỉ hiện `connected` sau khi verify chạy, không phải trước.
- [x] Bấm Connect khi CLI chưa cài → card hiện `disconnected` kèm lý do, không phải `connected`.
- [x] Provider chưa từng verify hiện pill `Unverified` có style.
- [x] Integrations page hiện cùng trạng thái đó, không có state nào không được style.
- [x] Không còn chỗ renderer connect/reconnect tự hardcode `status: "connected"`.
- [x] `npm run typecheck` và settings tests xanh.
