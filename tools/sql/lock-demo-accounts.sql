-- OAK Beauty — khoá các tài khoản demo đã lỡ được seed vào database production.
--
-- Chạy MỘT LẦN, thủ công, trên database Render/Supabase: dán toàn bộ file này vào
-- Supabase SQL editor, hoặc `psql "$DATABASE_URL" -f tools/sql/lock-demo-accounts.sql`.
-- Chỉ cần chạy trên database đã được seed *trước khi* có chốt shouldSeedDemo()
-- (server/src/seed.js); database mới từ nay không còn tự seed ở production nữa.
--
-- Vì sao: lần boot đầu tiên của production trước đây tự đổ dữ liệu demo vào Supabase —
-- mười tài khoản @oak.vn dùng chung đúng một mật khẩu mà server/README.md in ra công
-- khai, trong đó doitac@oak.vn đang sở hữu một salon đã publish. Ai đọc repo cũng đăng
-- nhập được vào console của salon đó. Kèm theo là một token mời nhân viên cố định, cũng
-- nằm sẵn trong repo.
--
-- Cách khoá: thay password_hash bằng bcrypt của 32 byte ngẫu nhiên — không ai, kể cả
-- người chạy script này, biết mật khẩu mới. Hàng vẫn còn nguyên nên dữ liệu demo (salon,
-- dịch vụ, lịch, đánh giá) không mất, chỉ lối vào bị đóng. Muốn dùng lại một địa chỉ nào
-- đó thì đặt lại mật khẩu qua "Quên mật khẩu?" (DEPLOY.md §7).
--
-- password_changed_at được ghi cùng một câu lệnh với hash, đúng như quy ước của
-- src/routes/auth.js: nếu không, phiên đăng nhập nào đã cầm sẵn JWT vẫn dùng được vô thời
-- hạn dù mật khẩu đã đổi. middleware/auth.js so `iat` của token với cột này và loại mọi
-- token cũ hơn.
--
-- pgcrypto sinh hash dạng $2a$. bcryptjs 3.0.3 — thư viện route đăng nhập dùng
-- (src/routes/auth.js) — đọc đúng dạng này: đã kiểm chứng bằng compareSync trên một hash
-- do chính pgcrypto sinh ra, đúng mật khẩu trả true, sai trả false. Nghĩa là hash mới vẫn
-- hợp lệ với luồng đăng nhập, chỉ là không ai đoán nổi cái mật khẩu đằng sau nó.
--
-- Chạy lại bao nhiêu lần cũng vô hại: mỗi lần chỉ sinh một bí mật ngẫu nhiên khác cho
-- cùng những hàng đó và xoá lại một hàng đã xoá. Không địa chỉ nào ngoài @oak.vn bị đụng
-- tới — cả mười tài khoản seed đều thuộc domain này (xem USERS trong server/src/seed.js).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE users
SET password_hash = crypt(encode(gen_random_bytes(32), 'hex'), gen_salt('bf', 10)),
    password_changed_at = EXTRACT(EPOCH FROM now())::bigint
WHERE email LIKE '%@oak.vn';

-- DEMO_STAFF_INVITE_TOKEN (server/src/seed.js). Một lời mời nhận ghế nhân viên thật thì
-- là 32 byte ngẫu nhiên do console cấp; cái này là hằng số nằm trong repo, nên bất kỳ ai
-- cũng mở được link nhận ghế đó.
DELETE FROM staff_invites
WHERE token = '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

-- Những gì vừa đổi, để người chạy nhìn thấy đúng phạm vi đã chạm vào.
SELECT id, email, role, password_changed_at
FROM users
WHERE email LIKE '%@oak.vn'
ORDER BY email;

COMMIT;
