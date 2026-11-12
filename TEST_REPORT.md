# Báo cáo kiểm thử

Ngày: 12/11/2026 · Node.js 22.23 · Chromium (Playwright 1.63) · Linux

```bash
npm test            # unit + API
npm run test:e2e    # build rồi chạy test giao diện
```

## Kết quả

| Bộ test | Số test | Kết quả |
|---|---|---|
| Unit – lõi PDF (`tests/unit`) | 38 | ✅ đạt hết |
| API máy chủ (`tests/server`) | 129 | ✅ đạt hết |
| Giao diện end-to-end (`tests/e2e`) | 119 | ✅ đạt hết |

### Unit – lõi PDF
Dựng tệp, sửa content stream (xóa chữ theo glyph, thay ảnh), mã hóa/mở mật khẩu, chuyển PDF sang Word (bảng, vị trí dòng, ảnh, chữ xoay; tệp DOCX được kiểm tra cấu trúc OOXML).

### API máy chủ
| Tệp | Nội dung |
|---|---|
| `usage` (14) | 5 trang miễn phí dùng trước, rồi đến trang đã mua; thiếu trang → 402 và không trừ gì; `opId` không bị trừ hai lần; cấp lại trang miễn phí theo chu kỳ; giới hạn theo IP/ngày (múi giờ Việt Nam) |
| `orders` (13) | Đơn chuyển khoản trả mã VietQR hợp lệ (CRC, số tài khoản, số tiền, nội dung = mã đơn); gọi lại trả cùng đơn; hết hạn; hủy; gói/phương thức sai; đơn của người khác → 404 |
| `sepay` (21) | Xác thực API Key và HMAC (chống phát lại 5 phút); tìm mã đơn trong nội dung lẫn ký tự lạ; gửi lặp chỉ cộng một lần; chuyển thiếu, chuyển ra, sai tài khoản, mã lạ, chuyển thừa |
| `paypal` (18) | Tạo đơn, chuyển hướng `payer-action`, thu tiền khi quay về (một lần, kể cả tải lại trang), số tiền/đơn không khớp không cộng, gia hạn token, hủy |
| `account-admin` (12) | Mã khôi phục chuyển tài khoản, giới hạn thử sai; trang quản trị: token, thống kê, xác nhận đơn, cộng/trừ trang, tra cứu |
| `security` (16) | Chặn POST khác nguồn, sai Content-Type, thân quá lớn, cookie giả; cờ cookie; địa chỉ IP qua proxy (`TRUST_PROXY`, Cloudflare, IPv6 /64) |
| `static` (18) | Thay biến cấu hình vào trang (không lộ bí mật, không thoát khỏi `<script>`), brotli/gzip, ETag/304, chặn `..`, chuyển hướng thư mục, 404, robots, sitemap, ads.txt, CSP |
| `config` (13), `db` (4) | Kiểm tra cấu hình sai, ngân hàng/BIN, dữ liệu giữ nguyên sau khi khởi động lại, dọn tài khoản cũ |

### Giao diện end-to-end (trình duyệt thật, máy chủ thật)
| Tệp | Nội dung |
|---|---|
| `01`–`06`, `08`, `09` (68) | Bộ test của bản Windows chạy trên web: mở tệp/mật khẩu, sửa chữ tiếng Việt, chú thích chuẩn PDF, sắp xếp/trích xuất/tách trang (ZIP), gộp tệp + ảnh, hình mờ, tìm và biên tập, mật khẩu AES, biểu mẫu, ảnh, chữ ký, liên kết, chuyển Word/văn bản/ảnh, in, làm phẳng, quyền hạn chế, Word giữ bố cục |
| `07-leave-guard` (3) | Rời trang khi còn thay đổi chưa tải → hỏi; "Tải xuống với tên khác" |
| `10-billing` (13) | Số trang trên thanh tiêu đề; hộp thoại mua khi thiếu trang (gợi ý gói đủ dùng); "Để sau" không tải, không trừ; trừ 3 trang miễn phí đúng một lần, tải lại không trừ; chỉ trừ trang mới; mua bằng phương thức thử rồi tải tiếp; ẩn quảng cáo khi còn trang mua; bấm hai lần/hai thao tác cùng lúc chỉ trừ một lần; webhook SePay hoàn tất đơn khi hộp thoại đang mở; mã khôi phục trên trình duyệt mới; tách tệp không trả được thì không tải ZIP |
| `11-site` (20) | Trang chủ, giá theo `PACKS`, không còn biến `%%`; thả tệp ở trang gộp/sửa/tách → trình chỉnh sửa chạy đúng công cụ (kể cả khi không có IndexedDB); giao diện tối và ngôn ngữ chuyển sang trình chỉnh sửa; nút mua ở bảng giá; không tràn ngang trên iPhone; menu di động; 404, sitemap, robots; quảng cáo nội bộ/AdSense/mạng khác, ads.txt; trang quản trị; trang kết quả thanh toán; PayPal |
| `12-mobile` (7) | iPhone 13: bảng bên đóng sẵn, không tràn ngang, nút Tải xuống luôn hiện, thu phóng hai ngón, cuộn tự nhiên, hộp thoại mua vừa màn hình |
| `13-editor-web` (8) | Hộp chọn tệp thật, thả tệp vào cửa sổ, xuất nhiều ảnh thành một ZIP, tệp gần đây sau khi tải lại trang, tải xuống khi mất mạng (đồng bộ sau), không có phương thức thanh toán, đổi ngôn ngữ |

Mọi bộ test giao diện đều kiểm tra không có lỗi JavaScript nào trong console.

## Lỗi tìm thấy và đã sửa

- Bấm Tải xuống hai lần, hoặc tải xuống trong lúc đang chuyển đổi, bị trừ trang hai lần; bấm lặp khi đang tải tạo hai bản tải.
- Hộp thoại mua nháy lên rồi tắt khi số dư đã đủ; công cụ (tách, nén…) mở từ trang giới thiệu làm chậm phần còn lại của lúc khởi động.
- Trình duyệt không lưu được tệp chuyển từ trang giới thiệu thì trình chỉnh sửa mở trống, không báo.
- Sau một lần xem trang tiếng Anh, trang tiếng Việt mở trình chỉnh sửa bằng tiếng Anh.
- Phím thu phóng không hoạt động khi đang gõ trong ô biểu mẫu (trình duyệt tự phóng to cả trang).
- Máy chủ: giới hạn theo IP bị qua mặt bằng `X-Forwarded-For` tự đặt hoặc đổi địa chỉ IPv6 trong cùng /64; PayPal được cộng khi `custom_id` không phải đơn của mình; số tài khoản > 19 ký tự làm hỏng mã QR; `SITE_URL` sai làm mọi POST lỗi 500; thân yêu cầu chunked quá lớn bị ngắt kết nối thay vì 413; ETag dùng chung cho mọi kiểu nén; chuyển hướng thư mục tên có dấu bị lỗi.
- Giao diện: nút Tải xuống bị mờ đè lên thanh thẻ trên điện thoại; quảng cáo nội bộ lặp 3 lần một trang; quảng cáo cố định 300×250 tràn bảng thuộc tính; mã gradient logo trùng nhau trong trang; tiêu đề trang chủ xuống dòng lẻ chữ.
- Giới hạn trang miễn phí theo IP mặc định quá chặt với mạng di động dùng chung IP (nay mặc định 20 × `FREE_PAGES`).

## Kiểm tra bằng mắt

Đã chụp và xem: trang chủ (sáng, tối, iPhone), trang công cụ, bảng giá, menu di động, trình chỉnh sửa (màn hình chính, tài liệu, tối, điện thoại), hộp thoại mua trang, mã QR chuyển khoản, tài khoản/mã khôi phục, trang quản trị, trang kết quả thanh toán, 404, ảnh chia sẻ mạng xã hội.

## Chưa kiểm tra được trong môi trường này

- Thanh toán thật với SePay/PayPal (đã giả lập đúng định dạng yêu cầu/trả lời) và quảng cáo AdSense thật (mạng quảng cáo bị chặn trong test).
- Build image Docker (không có Docker daemon); thay vào đó đã chạy máy chủ với đúng bố cục tệp của image (không có `node_modules`). CI build và chạy thử image trên GitHub Actions.
- Safari/iOS và Firefox thật: test chạy trên Chromium (giả lập iPhone 13).
