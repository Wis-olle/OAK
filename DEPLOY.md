# Hướng dẫn triển khai OAK (Render + Supabase)

Ứng dụng chạy trên **Render** (web service, gói free), dữ liệu nằm ngoài server:

- **Supabase Postgres** — tài khoản, booking, review... (thay cho file SQLite cũ, vốn bị xoá mỗi lần Render restart).
- **Supabase Storage** — ảnh upload (thay cho thư mục `server/uploads` trên ổ đĩa tạm).

Nhờ vậy dữ liệu **không mất** khi Render redeploy/restart/ngủ đông.

---

## 1. Tạo project Supabase (một lần)

1. Vào <https://supabase.com> → đăng ký/đăng nhập (miễn phí) → **New project**.
2. Đặt tên (vd. `oak`), chọn region gần Việt Nam (**Southeast Asia (Singapore)**), đặt **Database Password** — *lưu lại mật khẩu này*.
3. Chờ project khởi tạo xong (~1–2 phút).

### Lấy chuỗi kết nối database (DATABASE_URL)

1. Trong dashboard project → nút **Connect** (trên cùng).
2. Chọn tab **Session pooler** (⚠️ *không* dùng "Direct connection" — host trực tiếp chỉ có IPv6, Render không kết nối được).
3. Copy URI dạng:
   ```
   postgresql://postgres.xxxxxxxx:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
   ```
4. Thay `[YOUR-PASSWORD]` bằng mật khẩu database ở bước tạo project.

### Lấy khoá Storage

1. **Project Settings → API**:
   - **Project URL** → dùng cho `SUPABASE_URL` (dạng `https://xxxx.supabase.co`).
   - **service_role** key (mục *Project API keys*) → dùng cho `SUPABASE_SERVICE_ROLE_KEY`. ⚠️ Khoá này có toàn quyền — chỉ đặt trong env của server, không bao giờ đưa vào code/git/frontend.
2. Bucket ảnh: server tự tạo bucket public tên `uploads` ở lần upload đầu tiên. (Nếu muốn tạo tay: **Storage → New bucket** → tên `uploads`, bật **Public bucket**.)

---

## 2. Cấu hình Render

Trong Render dashboard → service `oak-demo` → **Environment**, thêm 5 biến ([render.yaml](render.yaml) đã khai báo sẵn dạng `sync: false`):

| Biến | Giá trị |
|------|---------|
| `DATABASE_URL` | URI Session pooler ở trên (đã điền mật khẩu) |
| `SUPABASE_URL` | Project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `RESEND_API_KEY` | API key của Resend — kênh gửi mail đặt lại mật khẩu (§7) |
| `RESET_MAIL_FROM` | Địa chỉ gửi, vd. `OAK Beauty <no-reply@oakbeauty.vn>` — phải thuộc domain đã xác minh ở Resend |

Một biến **tùy chọn**: `ADMIN_EMAILS` — danh sách email (ngăn cách bằng dấu phẩy) được phép ẩn/hiện bài blog qua `PATCH /api/posts/:id/status`. Không khai thì không tài khoản nào ẩn được bài (route trả 403), tức là lời hứa "gỡ nội dung vi phạm" ở Điều khoản chưa có công cụ thực thi — khai một địa chỉ trước khi mở blog cho người dùng thật.

Các biến còn lại đã có sẵn giá trị trong `render.yaml`, không cần khai trong dashboard — đáng chú ý là `TZ=Asia/Ho_Chi_Minh`: container Render chạy UTC, biến này đưa đồng hồ hệ thống của container về đúng quy ước sản xuất, cho mọi thứ đọc trực tiếp từ đồng hồ đó. ("Hôm nay" và "bây giờ" của phần đặt lịch do `server/src/lib/time.js` tự ép về múi giờ VN nên đúng kể cả khi thiếu biến này.)

Sau đó **Save & Deploy** (hoặc push commit mới). Lần boot đầu tiên server tự tạo bảng, nhưng **không** seed dữ liệu mẫu: mọi tài khoản demo dùng chung một mật khẩu in công khai trong `server/README.md`, nên `NODE_ENV=production` là đủ để server bỏ qua seed và ghi một dòng log nói vậy. Muốn có dữ liệu mẫu trên một database production thì tự khai `SEED_DEMO=1`.

Nếu database đã được seed từ trước khi có chốt này, chạy [`tools/sql/lock-demo-accounts.sql`](tools/sql/lock-demo-accounts.sql) một lần trong Supabase SQL editor. Script khoá cả mười tài khoản demo — mật khẩu ngẫu nhiên không ai biết, địa chỉ chuyển sang `.invalid` để "Quên mật khẩu?" cũng không còn là đường vào, xoá link đặt lại đang treo và xoá token mời nhân viên cố định. Chạy lại nhiều lần vô hại. Cuối file có hai câu **chỉ đọc** phải trả về 0 hàng thì mới coi là xong: chúng tìm người ngoài đã kịp nhận ghế nhân viên ở salon demo, và lời mời còn sót lại ở đó.

Lưu ý: script **chỉ đóng lối đăng nhập**. Sáu salon demo vẫn còn và vẫn hiện trên trang khách, nên khách thật vẫn đặt lịch vào một console không còn ai mở được. Muốn gỡ chúng xuống thì bỏ chú thích ở mục **TÙY CHỌN** cuối file — đó là quyết định của người vận hành, không phải mặc định.

Nhân tiện, kiểm tra `ADMIN_EMAILS` trong Render: nó **không được** là một địa chỉ demo (bộ smoke test dùng `hoangyen@oak.vn`), nếu không thì quyền ẩn/hiện bài blog nằm ở một tài khoản mà script trên vừa khoá.

---

## 3. Chạy local (dev)

Cần Postgres local — dùng Docker:

```powershell
docker run -d --name oak-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=oak postgres:17-alpine
docker exec oak-pg psql -U postgres -c "CREATE DATABASE oak_test;"
docker exec oak-pg psql -U postgres -d oak -c "CREATE EXTENSION IF NOT EXISTS citext;"
docker exec oak-pg psql -U postgres -d oak_test -c "CREATE EXTENSION IF NOT EXISTS citext;"
```

Rồi chạy như cũ trong thư mục `server/`:

```powershell
npm install
$env:TZ='Asia/Ho_Chi_Minh'   # giống production; máy đã ở giờ VN thì bỏ qua cũng được
npm start      # dev DB mặc định: postgres://postgres:postgres@localhost:5432/oak
npm test       # smoke test, dùng DB riêng oak_test (tự xoá sạch mỗi lần chạy)
```

Không đặt `SUPABASE_URL` khi chạy local → ảnh upload rơi về thư mục `server/uploads` như cũ.

---

## 4. Build lại CSS (Tailwind)

`ui/assets/css/oak-tailwind.css` được build sẵn (không còn Tailwind Play CDN chạy trong trình duyệt) và **đã commit** vào repo — deploy không cần bước build nào.

Toàn bộ tooling build nằm ở `tools/tailwind/` (ngoài thư mục `ui/` — vì mọi thứ trong `ui/` đều được server phục vụ công khai).

Chỉ cần chạy lại khi **thêm/đổi class Tailwind trong `ui/*.html` hoặc trong ba script được quét: `ui/assets/js/oak-api.js`, `oak-header.js`, `oak-i18n.js`** (header trang khách nằm trọn trong `oak-header.js` nên class của nó đến từ file đó, không phải từ HTML), hoặc khi sửa token trong `ui/assets/js/oak-tailwind-config.js`:

```powershell
cd tools/tailwind
npm install        # chỉ lần đầu
npm run build:css
```

Nhớ commit lại file `ui/assets/css/oak-tailwind.css` sau khi build. Tokens vẫn lấy từ `ui/assets/js/oak-tailwind-config.js` (file này không còn được trang nào load, chỉ dùng lúc build).

Muốn kiểm tra file CSS đã commit có còn khớp với HTML hiện tại không (không ghi đè gì cả) — chạy trong `tools/tailwind`, sau khi đã `npm install`:

```powershell
npm run check:css   # thoát khác 0 nếu CSS đã cũ
```

---

## 5. Thêm icon mới

Font icon `ui/assets/fonts/font-material-subset.woff2` chỉ chứa đúng những icon đang dùng (Material Symbols đầy đủ nặng 1.1MB). Khi cần một icon mới:

1. Thêm tên icon vào `tools/icons/icon-names.txt` (mỗi dòng một tên, đúng tên ligature của Material Symbols, vd. `shopping_cart`).
2. Lấy file font gốc — từ git history (bản đầy đủ đã xoá ở commit `0c221aa`) hoặc tải lại từ Google Fonts:

   ```powershell
   cmd /c "git show 0c221aa~1:ui/assets/fonts/font-0bb58271a2.woff2 > material-symbols.woff2"
   ```

   (Phải qua `cmd /c`: dấu `>` của PowerShell ghi file dạng text nên làm hỏng file nhị phân.)

3. Chạy script subset (cần `pip install fonttools brotli`):

   ```powershell
   python tools/icons/subset_icons.py material-symbols.woff2
   ```

Script ghi đè `ui/assets/fonts/font-material-subset.woff2` — commit lại file này. Nếu một tên icon không có trong font gốc, script báo lỗi và dừng.

---

## 6. Lưu ý vận hành

- **Supabase free tier**: project bị *tạm dừng* nếu không có truy vấn nào trong 7 ngày liên tục; vào dashboard bấm **Restore** là chạy lại, dữ liệu không mất. Khi web có người dùng thật thường xuyên thì không bị.
- **Render free tier**: service ngủ sau ~15 phút không truy cập, request kế tiếp chờ ~30–60s để thức dậy. Dữ liệu giờ đã an toàn ở Supabase; chỉ còn trải nghiệm chậm lúc thức dậy. Khi go-live chính thức: nâng **Starter** (~7 USD/tháng) để bỏ cold start, rồi gắn tên miền riêng (**Settings → Custom Domains**, SSL tự động). Trong lúc còn ở gói free, ping giữ thức ở §8 gần như xoá hẳn cold start.
- **Backup**: Supabase tự backup hằng ngày (giữ 7 ngày ở gói free).

---

## 7. Email đặt lại mật khẩu (Resend)

Đây là **kênh gửi ra ngoài duy nhất** của OAK: link đặt lại mật khẩu, không có gì khác. Không dùng khoá này để gửi tin khuyến mãi — reset là thư người dùng tự yêu cầu, marketing thì không, và trộn hai loại trên cùng một domain là cách nhanh nhất để mất uy tín gửi thư.

Không có `RESEND_API_KEY`, server vẫn tạo token nhưng **không gửi đi đâu** — khách bấm "Quên mật khẩu?" ở production sẽ không bao giờ nhận được link. Vì vậy hãy làm bước này trước khi mở cho người dùng thật.

1. Đăng ký <https://resend.com> (gói free 3.000 mail/tháng, 100 mail/ngày — thừa cho giai đoạn này).
2. **Domains → Add Domain** → nhập `oakbeauty.vn` → Resend hiện các bản ghi DNS (một TXT cho DKIM, một MX + TXT cho return-path). Thêm đúng các bản ghi đó ở nhà cung cấp DNS của domain, rồi bấm **Verify** — thường vài phút, có thể tới vài giờ.
3. **API Keys → Create API Key**, quyền *Sending access*, chép chuỗi `re_…` (chỉ hiện một lần).
4. Trong Render → **Environment**: `RESEND_API_KEY` = chuỗi vừa chép, `RESET_MAIL_FROM` = một địa chỉ **thuộc domain vừa xác minh**, vd. `OAK Beauty <no-reply@oakbeauty.vn>`. Save & Deploy.
5. Thử: mở `dang-nhap-nguoi-dung.html` → "Quên mật khẩu?" với một email có tài khoản thật → hộp thư (kể cả Spam) phải nhận được link `https://…/dat-lai-mat-khau.html?token=…` và link đó đặt được mật khẩu mới.

Nếu không thấy thư, xem log của service trên Render: `sendResetMail:` là dòng duy nhất báo lỗi ở đây (thường là `403` domain chưa xác minh, hoặc `From` không thuộc domain đã xác minh). Trang web **không** báo lỗi cho khách trong trường hợp này — thông điệp luôn giống nhau dù email có tồn tại hay không, để không ai dò được địa chỉ nào đã đăng ký.

Địa chỉ trong link lấy từ `RENDER_EXTERNAL_URL` (Render tự đặt) hoặc `PUBLIC_BASE_URL` nếu chạy ở nơi khác, không lấy từ header `Host` của request — nên không ai giả được một link trỏ sang máy chủ khác. Nếu chạy với `NODE_ENV=production` mà không khai biến nào trong hai biến này, service **không gửi mail** và ghi `forgot-password: no RENDER_EXTERNAL_URL or PUBLIC_BASE_URL configured` vào log (khách vẫn nhận cùng một thông điệp trung tính).

Chạy local không đặt `RESEND_API_KEY` → không gửi mail, và `/api/auth/forgot-password` trả thẳng `demo_reset_url` trong response như trước (chỉ khi `NODE_ENV` khác `production`).

---

## 8. Giữ service thức (ping `/api/health`)

Render free ngủ sau ~15 phút không có request; người vào tiếp theo chờ 30–60s. Một cron ping bên ngoài giữ service thức gần như cả ngày, tốn 0 dòng code (750 giờ/tháng của gói free đủ cho **một** service chạy liên tục — đừng bật ping cho nhiều service cùng lúc).

Dùng **UptimeRobot** (<https://uptimerobot.com>, free):

1. **Add New Monitor** → Monitor Type **HTTP(s)**.
2. Friendly Name `OAK health`, URL `https://<tên-service>.onrender.com/api/health`.
3. **Monitoring Interval**: 10 phút (dưới 15 phút là điều kiện duy nhất phải giữ).
4. Create Monitor. Dashboard sẽ hiện uptime; sau 7 ngày phải ≥ 99%.

Hoặc **cron-job.org** (free): **Create cronjob** → URL như trên → Schedule *Every 10 minutes* → Save.

Endpoint này cố tình rẻ: `GET /api/health` trả `{"success":true,"data":{"status":"ok"}}` và không chạm database, nên ping mỗi 10 phút không sinh tải và không đánh thức Supabase một cách vô ích. Ping cũng không thay thế được trang: client vẫn có banner "OAK đang khởi động…" cho lần hiếm hoi service vẫn kịp ngủ.

---

## 9. Đo lường ẩn danh (`POST /api/events`)

Các trang gọi `OAK.track(name, meta)` (`ui/assets/js/oak-api.js`) → `POST /api/events` → mỗi sự kiện một dòng trong bảng `events`. Không tài khoản, không cookie riêng, không PII: `session_hash` là digest một chiều theo ngày, tự đổi mỗi ngày và mỗi lần deploy, nên đếm được *lượt truy cập* chứ không lần ra được *người*. Route tự chặn ở 60 request/phút cho mỗi IP (bộ đếm in-memory, mất khi restart) và tự loại các giá trị `meta` trông giống email/số điện thoại. Chi tiết hợp đồng: `server/README.md` mục *Đo lường ẩn danh*.

Không cần cấu hình gì khi deploy — bảng `events` được tạo bằng `CREATE TABLE IF NOT EXISTS` lúc boot như mọi bảng khác.

Đọc số hằng tuần bằng `tools/sql/weekly.sql`: mở **Supabase → SQL Editor** (hoặc `psql "$DATABASE_URL"`), dán từng truy vấn trong 5 truy vấn — tuần này so tuần trước, lượt truy cập theo ngày, phễu tìm kiếm → wizard → đặt lịch, blog CTA có dẫn tới đặt lịch không, và lượt truy cập đến từ đâu. File chỉ đọc, không ghi gì.

---

## 10. Tra cứu địa chỉ qua proxy (`GET /api/geo/search`)

Route này tồn tại vì mạng Việt Nam không vào được `openstreetmap.org`, nên máy chủ hỏi giúp người đọc. Điều kiện duy nhất: host deploy phải ra ngoài được tới `nominatim.openstreetmap.org`.

Mọi lượt tra cứu đi ra từ **một** IP egress của host, qua **một** hàng đợi nối tiếp cách nhau `1.1s` — trần chung cho cả site là khoảng **54 lượt/phút**, bất kể có bao nhiêu người đang tìm cùng lúc. Mỗi IP người dùng được **10 lượt/phút** (bộ đếm in-memory theo cửa sổ cố định).

Cache in-memory giữ 200 câu trả lời trong 10 phút. Cả cache lẫn bộ đếm đều nằm trong bộ nhớ một tiến trình nên **mất sạch mỗi lần deploy hoặc restart** — đúng như thiết kế, không phải lỗi.

Không cần cấu hình gì khi deploy.

Nếu Nominatim chặn IP egress của host, cách xử lý là liên hệ Nominatim hoặc chuyển sang nhà cung cấp geocoding khác — không phải sửa code.

---

## 11. Nhập liệu tự động từ link salon (`POST /api/partner/import`)

Đối tác dán link trang salon của mình, server đọc và điền vào hồ sơ những cột còn trống. Đây là route **duy nhất** trong app gọi ra ngoài tới một host do người dùng nhập — mọi request đi qua `server/src/lib/safe-fetch.js`.

Trên thẻ nhập liệu có ô tích thứ hai, mặc định tắt: **ghi đè** (`overwrite: true` trong body, chỉ đúng giá trị boolean mới được tính). Khi bật, những gì trang nói sẽ ghi đè lên dữ liệu đang có — kể cả tên salon, ảnh bìa, thư viện ảnh và cả tuần giờ mở cửa (xoá rồi ghi lại) — nhưng cột nào trang không có thì vẫn giữ nguyên, và **dịch vụ không bao giờ bị xoá** (mỗi lượt đặt lịch trỏ tới một service id): dịch vụ trùng tên chỉ được cập nhật giá và thời lượng, mỗi thứ chỉ khi trang thực sự ghi ra — mức 0 đ và 60 phút mà `import-extract.js` điền tạm chỉ dùng cho dòng thêm mới, không ghi đè giá hay thời lượng đối tác đã nhập (JSON-LD không có trường thời lượng, nên trang web thường chỉ nói giá). Ghi đè có đổi địa chỉ mà không geocode được thì toạ độ cũ bị xoá — ghim cũ nằm dưới địa chỉ mới là bản đồ chỉ sai đường. Cột `published` không bao giờ bị route này đụng tới, ở cả hai chế độ. Lựa chọn của đối tác được ghi vào `salon_imports.summary`.

Ngoại lệ của quy tắc "chỉ điền cột trống": **quận và tỉnh/thành đi liền một cặp**. Lúc đăng ký, `auth.js` ghi sẵn `city = 'TP.HCM'` và bỏ trống `district`, nên nếu xét từng cột riêng thì salon ở Đà Nẵng sẽ nhận quận Hải Châu nằm dưới thành phố TP.HCM. Vì vậy: `district` còn trống thì ghi cả hai (vị trí trên hồ sơ vẫn là giá trị mặc định lúc đăng ký), `district` đã có thì giữ nguyên cả hai (đối tác đã tự chọn vị trí). Ở chế độ ghi đè, cặp này cũng phải đủ hai nửa mới được ghi: trang chỉ có `addressLocality` là trang chỉ nói tỉnh/thành, ghi riêng nó sẽ để quận đối tác tự nhập nằm dưới một thành phố khác — cùng một sự lệch, chỉ đến từ phía ngược lại.

Server sẽ mở kết nối ra ngoài tới:

- `api-booksalon.kiotviet.vn` — đọc `/tenant` và `/services` (không cần token, chỉ header `x-retailer-code`).
- **Trang web bất kỳ** mà đối tác dán vào (kể cả `*.web-store.online`), để đọc JSON-LD/OpenGraph.
- Host chứa ảnh của trang đó, để **tải ảnh về lưu ở kho của mình** (Supabase Storage hoặc `server/uploads`) — không bao giờ hotlink.
- `nominatim.openstreetmap.org` — **một** lượt geocode cho mỗi lần nhập. Mạng Việt Nam không vào được host này (xem mục 10), nên bước này hỏng là chuyện bình thường ở local: hồ sơ chỉ thiếu toạ độ, không phải lỗi.

Giới hạn cố định trong code, không cấu hình bằng env:

| Giới hạn | Giá trị |
|---|---|
| Số lần nhập | 3 lần / 10 phút / tài khoản đối tác (bộ đếm in-memory, mất khi restart) |
| Timeout mỗi request | 10s |
| Redirect | tối đa 3 hop, mỗi hop kiểm tra lại host |
| Kích thước HTML | 2MB |
| Ảnh | tối đa 6 ảnh, mỗi ảnh ≤ 5MB, chỉ `jpeg/png/webp` |
| Dịch vụ | tối đa 200 dòng mỗi lần nhập |

Chặn SSRF: chỉ `http`/`https`, cổng mặc định, không kèm user/password; hostname được resolve trước và **từ chối nếu bất kỳ địa chỉ nào là nội bộ** (0/8, 10/8, 100.64/10 CGNAT, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4 trở lên — multicast/reserved/broadcast, `::1`, `::`, `fc00::/7`, `fe80::/10`, v4-mapped). Link Facebook/Instagram/TikTok/Zalo/YouTube **không bao giờ được fetch** — chỉ lưu thành social link.

Nếu host deploy chặn egress, route này trả `502 UPSTREAM_ERROR` và đối tác nhập tay như trước — không có bước cấu hình nào cần làm khi deploy. Bảng `salon_imports` (lưu link + thời điểm đồng ý + tóm tắt kết quả) được tạo bằng `CREATE TABLE IF NOT EXISTS` lúc boot như mọi bảng khác.
