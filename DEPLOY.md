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

Trong Render dashboard → service `oak-demo` → **Environment**, thêm 3 biến ([render.yaml](render.yaml) đã khai báo sẵn dạng `sync: false`):

| Biến | Giá trị |
|------|---------|
| `DATABASE_URL` | URI Session pooler ở trên (đã điền mật khẩu) |
| `SUPABASE_URL` | Project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |

Sau đó **Save & Deploy** (hoặc push commit mới). Lần boot đầu tiên server tự tạo bảng và seed dữ liệu mẫu vào Supabase.

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
npm start      # dev DB mặc định: postgres://postgres:postgres@localhost:5432/oak
npm test       # smoke test, dùng DB riêng oak_test (tự xoá sạch mỗi lần chạy)
```

Không đặt `SUPABASE_URL` khi chạy local → ảnh upload rơi về thư mục `server/uploads` như cũ.

---

## 4. Build lại CSS (Tailwind)

`ui/assets/css/oak-tailwind.css` được build sẵn (không còn Tailwind Play CDN chạy trong trình duyệt) và **đã commit** vào repo — deploy không cần bước build nào.

Toàn bộ tooling build nằm ở `tools/tailwind/` (ngoài thư mục `ui/` — vì mọi thứ trong `ui/` đều được server phục vụ công khai).

Chỉ cần chạy lại khi **thêm/đổi class Tailwind trong `ui/*.html` hoặc `ui/assets/js/oak-api.js`**, hoặc khi sửa token trong `ui/assets/js/oak-tailwind-config.js`:

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
- **Render free tier**: service ngủ sau ~15 phút không truy cập, request kế tiếp chờ ~30–60s để thức dậy. Dữ liệu giờ đã an toàn ở Supabase; chỉ còn trải nghiệm chậm lúc thức dậy. Khi go-live chính thức: nâng **Starter** (~7 USD/tháng) để bỏ cold start, rồi gắn tên miền riêng (**Settings → Custom Domains**, SSL tự động).
- **Backup**: Supabase tự backup hằng ngày (giữ 7 ngày ở gói free).
