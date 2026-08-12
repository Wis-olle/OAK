// Authenticated profile updates.
import express from 'express';
import { db } from '../db.js';
import { isDistrictInCity } from '../lib/locations.js';
import { isSafeMediaUrl } from '../lib/urls.js';
import { httpError, requireAuth, selectPublicUser } from '../middleware/auth.js';

const router = express.Router();

// Columns a customer may change about themselves. Email, role and password_hash are
// deliberately absent: changing those is not a profile edit.
const EDITABLE_COLUMNS = ['name', 'phone', 'avatar', 'city', 'district'];

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const assignments = [];
    const values = [];

    // The SET list is assembled from the whitelist above, so only the values ever come
    // from the request; a key the client invented can never reach the SQL.
    for (const column of EDITABLE_COLUMNS) {
      if (!(column in body)) {
        continue;
      }
      if (typeof body[column] !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', 'Thông tin cá nhân phải là chuỗi ký tự.');
      }
      if (column === 'avatar' && !isSafeMediaUrl(body[column])) {
        throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh đại diện không hợp lệ.');
      }
      assignments.push(`${column} = ?`);
      values.push(body[column]);
    }

    // Validate the resulting pair (an unchanged field falls back to what is stored) so a
    // direct PATCH cannot save a district that does not belong to the city.
    const city = 'city' in body ? body.city : req.user.city;
    const district = 'district' in body ? body.district : req.user.district;
    if (city && district && !isDistrictInCity(city, district)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Quận/Huyện không thuộc Tỉnh/Thành phố đã chọn.');
    }

    if (assignments.length === 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật.');
    }

    await db.prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`).run(
      ...values,
      req.user.id,
    );

    res.json({ success: true, data: { user: await selectPublicUser.get(req.user.id) } });
  } catch (error) {
    next(error);
  }
});

export default router;
