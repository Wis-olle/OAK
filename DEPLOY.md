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

## 4. Lưu ý vận hành

- **Supabase free tier**: project bị *tạm dừng* nếu không có truy vấn nào trong 7 ngày liên tục; vào dashboard bấm **Restore** là chạy lại, dữ liệu không mất. Khi web có người dùng thật thường xuyên thì không bị.
- **Render free tier**: service ngủ sau ~15 phút không truy cập, request kế tiếp chờ ~30–60s để thức dậy. Dữ liệu giờ đã an toàn ở Supabase; chỉ còn trải nghiệm chậm lúc thức dậy. Khi go-live chính thức: nâng **Starter** (~7 USD/tháng) để bỏ cold start, rồi gắn tên miền riêng (**Settings → Custom Domains**, SSL tự động).
- **Backup**: Supabase tự backup hằng ngày (giữ 7 ngày ở gói free).
