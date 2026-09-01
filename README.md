# OAK Beauty

Đặt lịch nail, tóc, chăm sóc da, spa và nối mi tại các salon ở TP.HCM: khách tìm salon
và đặt giờ, salon nhận lịch trong console của mình, kỹ thuật viên có trang riêng mang
theo được giữa các salon.

Repo có hai nửa, cùng chạy trong một tiến trình:

- **`server/`** — API Express (Node 24, ESM) trên Postgres. Nó cũng phục vụ luôn `ui/`
  dưới dạng file tĩnh, nên chỉ có một service để deploy.
- **`ui/`** — trang tĩnh: HTML + Alpine, CSS Tailwind đã build sẵn và commit vào
  `ui/assets/css/oak-tailwind.css`. Không có bước bundle nào cho JavaScript.

Đọc tiếp:

- [`server/README.md`](server/README.md) — chạy máy local, tài khoản demo, biến môi trường.
- [`DEPLOY.md`](DEPLOY.md) — Render + Supabase, và các bước build phải chạy tay sau khi
  sửa `ui/` (Tailwind, font icon, từ điển tiếng Anh).

Chạy test:

```
cd server && npm run test:unit      # đọc mã nguồn và markup, không cần database
cd server && node test/api-smoke.mjs # cần Postgres; tự dựng server và seed dữ liệu mẫu
```
