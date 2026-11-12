# PDF Edit Online

Trang web chỉnh sửa PDF trực tuyến, xây dựng từ ứng dụng [pdf-edit](https://github.com/lupin2498/pdf-edit) cho Windows: cùng bộ máy chỉnh sửa, chạy ngay trên trình duyệt. Trang kiếm tiền bằng **quảng cáo** và **bán gói trang**: mỗi người dùng có **5 trang miễn phí**, sau đó mua gói trang để tiếp tục tải xuống, in và chuyển đổi.

Tệp PDF được xử lý hoàn toàn trên máy người dùng (không tải lên máy chủ). Máy chủ chỉ phục vụ trang web, đếm số trang đã dùng và xử lý thanh toán.

## Tính năng

**Trình chỉnh sửa** (`/app/`, giống bản Windows)
- Sửa trực tiếp văn bản (giữ phông, cỡ chữ, màu, tiếng Việt) và hình ảnh có sẵn; thêm chữ, ảnh, liên kết, che trắng, cắt trang.
- Chú thích: tô sáng, gạch chân/ngang, ghi chú, bút vẽ, hình khối, con dấu, chữ ký (vẽ, gõ bằng phông viết tay, ảnh).
- Trang: sắp xếp kéo thả, xoay, xóa, chèn, nhân bản, trích xuất, tách tệp (tải về dạng ZIP).
- Gộp nhiều PDF và ảnh; tạo PDF trống hoặc từ ảnh.
- Mật khẩu AES-256, giới hạn quyền, biên tập (redaction) xóa thật nội dung.
- Biểu mẫu, chuyển sang Word (giữ bố cục), ảnh, văn bản, HTML; nén; in.
- Giao diện tiếng Việt/tiếng Anh, sáng/tối; dùng được trên điện thoại (chạm, kéo, thu phóng hai ngón).

**Trang công khai** (song ngữ, chuẩn SEO)
- Trang chủ, 11 trang công cụ (chỉnh sửa, gộp, tách, nén, PDF sang Word, PDF sang ảnh, ảnh sang PDF, ký, sắp xếp trang, chú thích, bảo mật), bảng giá, chính sách bảo mật, điều khoản, trang 404.
- Thả tệp ngay trên trang công cụ → trình chỉnh sửa mở sẵn tệp và chạy đúng công cụ.
- Sitemap, robots.txt, ads.txt, thẻ Open Graph, JSON-LD, hreflang vi/en; cài được như ứng dụng (PWA, mở tệp PDF từ máy).

**Kiếm tiền**
- Trang miễn phí theo tài khoản ẩn danh (cookie) và giới hạn theo IP mỗi ngày.
- Gói trang mua một lần, không hết hạn; mã khôi phục để dùng trên thiết bị khác.
- Thanh toán **chuyển khoản VietQR** (xác nhận tự động qua SePay hoặc thủ công) và **PayPal**.
- Quảng cáo **Google AdSense** hoặc mạng khác ở 5 vị trí; quảng cáo nội bộ giới thiệu gói trang; tự ẩn quảng cáo khi người dùng còn trang đã mua.
- Trang quản trị `/admin/`: doanh thu, đơn hàng, giao dịch cần xem, tra cứu tài khoản, cộng/trừ trang.

## Cách tính trang

| Thao tác | Tính phí |
|---|---|
| Xem, chỉnh sửa, chú thích | Miễn phí, không giới hạn |
| Tải xuống tệp đã chỉnh sửa | Số trang của tệp |
| In, chuyển sang Word/ảnh/văn bản/HTML, nén, trích xuất, tách | Số trang được xuất |
| Tải lại cùng tài liệu, tải tệp chưa thay đổi | Không tính |

Trang miễn phí được dùng trước, sau đó đến trang đã mua. Thiếu trang thì hộp thoại mua gói hiện ra, gợi ý gói đủ cho tài liệu đang xuất; mua xong, tệp được tải xuống tiếp.

## Chạy thử

Yêu cầu Node.js 22.13 trở lên (dùng `node:sqlite` có sẵn, máy chủ không cần thư viện ngoài).

```bash
npm install
npm run build                     # đóng gói trình chỉnh sửa và tạo các trang vào dist/
PAYMENTS_TEST_MODE=1 npm start    # http://localhost:3000 (có phương thức "thanh toán thử nghiệm")
```

`npm run dev` build bản chưa nén (dễ gỡ lỗi) rồi chạy máy chủ. Khi máy chủ chạy ngoài môi trường `production`, các trang được nạp lại sau mỗi lần build.

## Cấu hình

Sao chép `.env.example` thành `.env` và sửa. Các nhóm chính:

| Biến | Ý nghĩa |
|---|---|
| `SITE_URL`, `SITE_NAME`, `CONTACT_EMAIL` | Địa chỉ trang (bắt buộc khi chạy thật), tên thương hiệu, email hỗ trợ |
| `FREE_PAGES`, `FREE_RESET_DAYS`, `FREE_IP_DAILY_PAGES` | Số trang miễn phí, chu kỳ cấp lại, giới hạn theo IP mỗi ngày |
| `PACKS` | Danh sách gói (JSON: số trang, giá VND, giá USD, gói nổi bật) |
| `BANK_CODE`/`BANK_BIN`, `BANK_ACCOUNT`, `BANK_ACCOUNT_NAME`, `ORDER_PREFIX` | Tài khoản nhận chuyển khoản VietQR |
| `SEPAY_API_KEY` hoặc `SEPAY_WEBHOOK_SECRET` | Xác nhận chuyển khoản tự động qua SePay |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` | Thanh toán PayPal (live/sandbox) |
| `ADSENSE_CLIENT`, `ADSENSE_SLOT_*`, `ADS_HTML_*`, `ADS_HOUSE`, `ADS_HIDE_FOR_PAID` | Quảng cáo |
| `ADMIN_TOKEN` | Mật khẩu trang quản trị (≥ 12 ký tự) |
| `TRUST_PROXY` | `0`, số reverse proxy phía trước (`1`, `2`...) hoặc `cloudflare` |
| `DATA_DIR` | Thư mục cơ sở dữ liệu SQLite |

Giá trên trang bảng giá, số trang miễn phí trong nội dung và tên thương hiệu đều lấy từ cấu hình khi máy chủ khởi động, không cần build lại.

### Thanh toán chuyển khoản (VietQR + SePay)

1. Đặt `BANK_CODE`, `BANK_ACCOUNT`, `BANK_ACCOUNT_NAME`. Người mua quét mã QR (số tiền và nội dung là mã đơn, ví dụ `PEAB12CD34`, được điền sẵn) bằng bất kỳ ứng dụng ngân hàng nào.
2. Xác nhận tự động: đăng ký [SePay](https://sepay.vn), liên kết tài khoản ngân hàng, tạo webhook tới `https://<tên miền>/api/pay/sepay/webhook`, chọn xác thực **API Key** và đặt cùng khóa vào `SEPAY_API_KEY`. Máy chủ tìm mã đơn trong nội dung chuyển khoản, kiểm tra số tiền và cộng trang (gửi lặp lại không bị cộng hai lần; chuyển thiếu hoặc không khớp đơn được đưa vào mục "Giao dịch cần xem").
3. Không dùng SePay: mở `/admin/`, mục **Đơn hàng → Chờ thanh toán**, bấm **Xác nhận đã nhận tiền** khi thấy tiền về.

### PayPal

Tạo ứng dụng REST trên developer.paypal.com, đặt `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (thử trước với `PAYPAL_ENV=sandbox`). Người mua được chuyển sang PayPal ở thẻ mới; khi quay về, máy chủ thu tiền (capture), kiểm tra số tiền/đơn rồi cộng trang, thẻ trình chỉnh sửa tự cập nhật. Giao dịch PayPal ở trạng thái chờ (PENDING) không được cộng tự động — xác nhận trong `/admin/` khi PayPal báo hoàn tất.

### Quảng cáo

- **AdSense**: đặt `ADSENSE_CLIENT=ca-pub-…` và mã đơn vị quảng cáo cho từng vị trí: `ADSENSE_SLOT_LANDING_TOP`, `…_LANDING_MID`, `…_LANDING_BOTTOM` (trang công khai), `ADSENSE_SLOT_APP_HOME` (màn hình chính trình chỉnh sửa), `ADSENSE_SLOT_APP_SIDE` (bảng thuộc tính khi không chọn gì). `ads.txt` được tạo tự động. Quảng cáo chỉ được tải khi vị trí cuộn vào màn hình. Nếu bật **Quảng cáo tự động** (Auto ads) trong AdSense, hãy loại trừ đường dẫn `/app/` để quảng cáo không chèn vào giao diện chỉnh sửa.
- **Mạng khác**: `ADS_HTML_<VỊ_TRÍ>` chứa mã HTML của đơn vị quảng cáo, `ADS_CUSTOM_HEAD` cho mã đặt trong `<head>`, `ADS_TXT` cho dòng ads.txt bổ sung.
- **Quảng cáo nội bộ** (`ADS_HOUSE=1`): khi chưa có quảng cáo mạng, một số vị trí giới thiệu gói trang.
- Khi có mã quảng cáo/analytics bên thứ ba, chính sách bảo mật nội dung (CSP) được nới để các mã đó chạy; nếu không, trang dùng CSP chặt (chỉ mã của chính trang).

## Triển khai

**Docker**

```bash
docker build -t pdf-edit-online .
docker run -d --name pdf-edit -p 3000:3000 -v pdfedit-data:/data --env-file .env pdf-edit-online
```

**Máy chủ Linux (systemd)**: `npm ci && npm run build`, rồi chạy `node server/index.mjs` với `NODE_ENV=production` dưới systemd hoặc pm2.

**Reverse proxy & HTTPS**: đặt nginx/Caddy phía trước (bắt buộc HTTPS cho thanh toán), chuyển tiếp tới cổng `PORT` và đặt `TRUST_PROXY=1` (Cloudflare: `TRUST_PROXY=cloudflare`) để giới hạn theo IP hoạt động đúng. Các tệp tĩnh có hash được cache 1 năm và nén sẵn brotli/gzip.

**Sao lưu**: toàn bộ dữ liệu (tài khoản, số trang, đơn hàng) nằm trong `DATA_DIR/pdfedit.sqlite` (kèm tệp `-wal`). Sao lưu thư mục này định kỳ.

## Kiểm thử

```bash
npm test             # unit test lõi PDF + test API máy chủ
npm run test:e2e     # build rồi chạy test giao diện trên Chromium (Playwright)
npm run test:all
```

Một số kiểm tra cần `pdftotext` (gói `poppler-utils`). Test giao diện dùng Chromium của Playwright (`npx playwright-core install chromium`). Workflow `.github/workflows/ci.yml` chạy toàn bộ test và build image Docker cho mỗi lần push.

## Kiến trúc

- `src/core` – lõi PDF (phân tích/sửa content stream, dựng trang, chú thích, mã hóa, chuyển Word) dùng chung với bản Windows.
- `src/renderer` – trình chỉnh sửa (pdf.js hiển thị, pdf-lib ghi tệp).
- `src/web` – lớp web: cầu nối `window.api` (chọn tệp, tải xuống, ZIP, IndexedDB), đếm trang và hộp thoại mua (`billing.js`, `paywall.js`), quảng cáo (`ads.js`), giao diện web/di động (`web.css`).
- `src/site` – nội dung và bộ sinh trang công khai (`content.mjs`, `build-site.mjs`), script/style trang, trang thanh toán và quản trị.
- `server` – máy chủ Node không phụ thuộc thư viện ngoài: phục vụ tệp tĩnh, API tài khoản/đếm trang/đơn hàng, VietQR, webhook SePay, PayPal, quản trị, SQLite.
- `scripts/build.mjs` – đóng gói bằng esbuild, sao chép pdf.js, tạo trang, nén sẵn.
- `tests` – unit test lõi, test API máy chủ, test giao diện end-to-end.

## Lưu ý

- Việc chỉnh sửa diễn ra trong trình duyệt nên giới hạn trang được kiểm soát ở phía người dùng và máy chủ; người rành kỹ thuật vẫn có thể can thiệp mã trên trình duyệt của họ. Đây là đánh đổi để tệp không phải tải lên máy chủ.
- Chính sách bảo mật và điều khoản trong `src/site/content.mjs` là bản mẫu — hãy rà soát cho phù hợp trước khi chạy thật (AdSense yêu cầu trang có chính sách bảo mật nêu việc dùng cookie quảng cáo).

## Giấy phép

MIT. Thành phần bên thứ ba: pdf.js (Apache-2.0), pdf-lib/@cantoo (MIT), fontkit (MIT), fflate (MIT), qrcode-generator (MIT), phông Liberation, Be Vietnam Pro và Dancing Script (SIL OFL 1.1).
