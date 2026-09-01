-- OAK Beauty — khoá các tài khoản demo đã lỡ được seed vào database production.
--
-- Chạy MỘT LẦN, thủ công, trên database Render/Supabase: dán toàn bộ file này vào
-- Supabase SQL editor, hoặc `psql "$DATABASE_URL" -f tools/sql/lock-demo-accounts.sql`.
-- Chỉ cần chạy trên database đã được seed *trước khi* có chốt shouldSeedDemo()
-- (server/src/seed.js); database mới từ nay không còn tự seed ở production nữa.
--
-- Vì sao: lần boot đầu tiên của production trước đây tự đổ dữ liệu demo vào Supabase —
-- mười tài khoản dùng chung đúng một mật khẩu mà server/README.md in ra công khai, trong
-- đó doitac@oak.vn đang sở hữu một salon đã publish. Ai đọc repo cũng đăng nhập được vào
-- console của salon đó. Kèm theo là một token mời nhân viên cố định, cũng nằm sẵn trong
-- repo, tức là link nhận ghế nhân viên cũng công khai.
--
-- Script khoá ba lối vào của mười tài khoản đó, trong một transaction:
--
--   1. password_hash thành bcrypt của 32 byte ngẫu nhiên — không ai, kể cả người chạy
--      script này, biết mật khẩu mới.
--   2. email chuyển sang `<id>-demo@oak.invalid`. oak.vn không phải domain của OAK
--      (domain sản phẩm là oakbeauty.vn), nên chừng nào mười địa chỉ đó còn có thể là hộp
--      thư thật của một ai đó thì "Quên mật khẩu?" vẫn là một đường vào. Theo RFC 2606
--      thì .invalid không bao giờ phân giải được, nên đường đó đóng hẳn. Cách đặt tên
--      mượn của luồng xoá tài khoản trong src/routes/users.js (ở đó là
--      `deleted+<id>@oak.invalid`, khác tiền tố nên hai bên không bao giờ đụng nhau).
--   3. Mọi link đặt lại mật khẩu đang treo của mười tài khoản đó bị xoá, cùng lý do với
--      RETIRE_USER_RESETS của src/routes/auth.js sau mỗi lần đổi mật khẩu. Bảng tên là
--      `password_resets`.
--
-- password_changed_at được ghi cùng một câu lệnh với hash, đúng quy ước của
-- src/routes/auth.js: nếu không, phiên nào đã cầm sẵn JWT vẫn dùng được vô thời hạn dù
-- mật khẩu đã đổi. Lấy clock_timestamp() chứ không phải now() (now() là mốc lúc
-- transaction bắt đầu) và cộng 1 giây, vì middleware/auth.js:58 so
-- `iat < password_changed_at` bằng dấu bé hơn nghiêm ngặt trên số giây tròn — token phát
-- ra trong chính giây này cũng phải chết.
--
-- pgcrypto sinh hash dạng $2a$. bcryptjs 3.0.3 — thư viện route đăng nhập dùng
-- (src/routes/auth.js) — đọc đúng dạng này: đã kiểm chứng bằng compareSync trên một hash
-- do chính pgcrypto sinh ra, đúng mật khẩu trả true, sai trả false. Nghĩa là hash mới vẫn
-- hợp lệ với luồng đăng nhập, chỉ là không ai đoán nổi mật khẩu đằng sau nó. Trên Supabase
-- extension nằm ở schema `extensions`, nên có SET LOCAL search_path ở dưới.
--
-- Chạy lại bao nhiêu lần cũng vô hại, và lần thứ hai không ghi một hàng nào: mười tài
-- khoản đó lúc ấy đã mang địa chỉ .invalid, mà bước khoá chỉ chạm những hàng chưa khoá.
-- Các câu báo cáo và kiểm tra vẫn chạy đủ, nên chạy lại là cách xem lại hiện trạng.
--
-- Mười địa chỉ dưới đây được liệt kê đích danh, lấy từ USERS trong server/src/seed.js —
-- không dùng LIKE '%@oak.vn', để không một tài khoản thật nào trùng khuôn mà bị khoá lây.
--
-- SCRIPT NÀY CHỈ ĐÓNG LỐI ĐĂNG NHẬP. Sáu salon demo vẫn còn và vẫn publish; xem mục
-- TÙY CHỌN ở cuối file nếu muốn gỡ chúng khỏi trang khách.

BEGIN;

-- Supabase để pgcrypto ở schema `extensions`, Postgres local để ở `public`; khai cả hai
-- thì cùng một file chạy được ở cả hai nơi. SET LOCAL nên nó hết hiệu lực khi COMMIT.
SET LOCAL search_path = public, extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Danh sách id tính đúng một lần rồi dùng lại cho mọi câu lệnh bên dưới: sau bước UPDATE
-- thì email đã đổi, không còn tìm lại bằng địa chỉ cũ được nữa. Bảng tạm sống hết session
-- (ON COMMIT PRESERVE ROWS) nên các câu kiểm tra sau COMMIT vẫn dùng được nó.
-- Điều kiện thứ hai là dạng địa chỉ sau khi đã khoá: nhờ nó, lần chạy thứ hai vẫn nhận ra
-- đúng mười tài khoản đó để báo cáo và kiểm tra, dù không còn gì để ghi nữa.
DROP TABLE IF EXISTS pg_temp.demo_accounts;

CREATE TEMP TABLE demo_accounts ON COMMIT PRESERVE ROWS AS
SELECT id, email AS email_before, role,
       (email = id::text || '-demo@oak.invalid') AS already_locked
FROM users
WHERE email IN (
  'khach@oak.vn',
  'doitac@oak.vn',
  'hoangyen@oak.vn',
  'baolong@oak.vn',
  'minhchau@oak.vn',
  'quochuy@oak.vn',
  'diemquynh@oak.vn',
  'tuyetnhung@oak.vn',
  'hamy@oak.vn',
  'nhanvien@oak.vn'
) OR email = id::text || '-demo@oak.invalid';

-- Chạy thử: đây đúng là những hàng sắp bị chạm tới. Rỗng nghĩa là database này chưa từng
-- bị seed. already_locked = true nghĩa là hàng đó đã khoá ở một lần chạy trước và lần này
-- không bị ghi lại.
SELECT id, email_before, role, already_locked FROM demo_accounts ORDER BY email_before;

-- Chỉ những hàng chưa khoá: nhờ vậy lần chạy thứ hai không ghi một hàng nào, thay vì băm
-- lại một mật khẩu vốn đã không ai biết và dời lại mốc password_changed_at.
UPDATE users
SET password_hash = crypt(encode(gen_random_bytes(32), 'hex'), gen_salt('bf', 10)),
    email = id::text || '-demo@oak.invalid',
    password_changed_at = EXTRACT(EPOCH FROM clock_timestamp())::bigint + 1
WHERE id IN (SELECT id FROM demo_accounts WHERE NOT already_locked);

DELETE FROM password_resets
WHERE user_id IN (SELECT id FROM demo_accounts);

-- DEMO_STAFF_INVITE_TOKEN (server/src/seed.js). Một lời mời nhận ghế nhân viên thật thì
-- là 32 byte ngẫu nhiên do console cấp; cái này là hằng số nằm trong repo, nên bất kỳ ai
-- cũng mở được link nhận ghế đó.
DELETE FROM staff_invites
WHERE token = '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

COMMIT;

-- Báo cáo sau khi đã ghi: mười hàng, địa chỉ cũ bên cạnh địa chỉ mới, để người chạy nhìn
-- thấy đúng phạm vi đã chạm vào.
SELECT d.id, d.email_before, u.email AS email_after, u.role, u.password_changed_at
FROM demo_accounts d
JOIN users u ON u.id = d.id
ORDER BY d.email_before;

/* ==========================================================================
 * Kiểm tra sau khi khoá — chỉ đọc, không ghi.
 *
 * Khoá mười tài khoản chưa phải là xong. Trong quãng thời gian console demo còn mở, bất
 * kỳ ai cũng có thể đã tự nhận một ghế nhân viên ở salon demo bằng link mời công khai,
 * hoặc được mời vào đó từ chính console demo. Những lối vào ấy mang địa chỉ của người
 * khác nên không có gì ở trên chạm tới chúng.
 *
 * CHƯA XONG cho tới khi CẢ HAI câu dưới đây trả về 0 hàng. Nếu có hàng, xử lý từng hàng
 * một bằng tay (gỡ user_id khỏi hàng staff, xoá hàng staff_invites) rồi chạy lại kiểm tra.
 * ========================================================================== */

-- (a) Người ngoài đang giữ một ghế nhân viên ở salon do tài khoản demo sở hữu.
SELECT st.id AS staff_id, st.name AS staff_name, s.name AS salon_name,
       u.id AS user_id, u.email
FROM staff st
JOIN salons s ON s.id = st.salon_id
JOIN users u ON u.id = st.user_id
WHERE s.owner_id IN (SELECT id FROM demo_accounts)
  AND st.user_id NOT IN (SELECT id FROM demo_accounts);

-- (b) Lời mời nhận ghế còn sót ở salon demo. Token seed đã bị xoá trong transaction trên,
-- nên bất cứ hàng nào còn lại ở đây đều là lời mời phát ra sau lúc seed, từ chính console
-- demo — đã dùng (used = 1) hay chưa thì cũng vậy; hai cột đó in ra để nhìn rõ.
SELECT i.token, i.used, i.created_at, i.created_by, s.name AS salon_name
FROM staff_invites i
JOIN staff st ON st.id = i.staff_id
JOIN salons s ON s.id = st.salon_id
WHERE s.owner_id IN (SELECT id FROM demo_accounts);

/* ==========================================================================
 * TÙY CHỌN — KHÔNG chạy tự động. Bỏ dấu chú thích ở hai dòng cuối nếu muốn.
 *
 * Sáu salon demo có địa chỉ bịa và, sau khi khoá, có chủ mà không ai đăng nhập được nữa:
 * một khách thật tìm thấy chúng vẫn đặt lịch được, và cái lịch đó rơi vào một console
 * không còn ai mở. Gỡ publish là cách đóng cửa đó; giữ lại là để trang khách không trống
 * trơn lúc chưa có salon thật. Người vận hành tự quyết.
 *
 * Hai dòng dưới tự đứng một mình, không cần bảng tạm ở trên, nên chạy lúc nào cũng được:
 * chúng nhận ra tài khoản demo qua chính dạng địa chỉ mà bước khoá đã ghi.
 * ========================================================================== */

-- UPDATE salons SET published = 0
-- WHERE owner_id IN (SELECT id FROM users WHERE email = id::text || '-demo@oak.invalid');
