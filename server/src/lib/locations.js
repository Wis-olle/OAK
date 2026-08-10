// City → district lists: the single source of truth shared by the profile form (UI)
// and PATCH /api/users/me validation, so an impossible city/district pair can never be
// stored. The TP.HCM list matches the options rendered in ui/ho-so-ca-nhan.html.

export const CITY_DISTRICTS = {
  'TP.HCM': [
    'Quận 1', 'Quận 2', 'Quận 3', 'Quận 4', 'Quận 5', 'Quận 6', 'Quận 7', 'Quận 8',
    'Quận 9', 'Quận 10', 'Quận 11', 'Quận 12', 'Quận Bình Thạnh', 'Quận Bình Tân',
    'Quận Gò Vấp', 'Quận Phú Nhuận', 'Quận Tân Bình', 'Quận Tân Phú', 'Thủ Đức',
    'Huyện Bình Chánh', 'Huyện Cần Giờ', 'Huyện Củ Chi', 'Huyện Hóc Môn', 'Huyện Nhà Bè',
  ],
  'Hà Nội': [
    'Quận Ba Đình', 'Quận Hoàn Kiếm', 'Quận Tây Hồ', 'Quận Long Biên', 'Quận Cầu Giấy',
    'Quận Đống Đa', 'Quận Hai Bà Trưng', 'Quận Hoàng Mai', 'Quận Thanh Xuân',
    'Quận Hà Đông', 'Quận Nam Từ Liêm', 'Quận Bắc Từ Liêm',
  ],
  'Đà Nẵng': [
    'Quận Hải Châu', 'Quận Thanh Khê', 'Quận Sơn Trà', 'Quận Ngũ Hành Sơn',
    'Quận Liên Chiểu', 'Quận Cẩm Lệ', 'Huyện Hòa Vang',
  ],
};

/**
 * True when the district belongs to the city. A city outside the three the product
 * serves cannot be checked, so it passes: this guard only rejects a district that
 * provably contradicts a known city. Both sides are normalised to NFC so a request
 * sending decomposed (NFD) Vietnamese text cannot slip past the lookup.
 */
export function isDistrictInCity(city, district) {
  const districts = CITY_DISTRICTS[String(city).normalize('NFC')];
  return !districts || districts.includes(String(district).normalize('NFC'));
}
