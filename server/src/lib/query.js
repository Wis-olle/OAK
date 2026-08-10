/*
 * Request-shaping helpers shared by the list endpoints. Nothing here throws:
 * bad query input degrades to a sensible default instead of a 500.
 */

const MAX_LIMIT = 50;
const EARTH_RADIUS_KM = 6371;

/** ?page=&limit= -> {page, limit, offset}, clamped so a client cannot ask for everything. */
export function parsePagination(query, defaultLimit) {
  const page = Math.max(1, Number.parseInt(query?.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query?.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

/** JSON text column -> array. Always an array, even when the column is null or corrupt. */
export function parseJsonArray(value) {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Great-circle distance in km, rounded to 1 decimal. null when a coordinate is missing. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const points = [lat1, lng1, lat2, lng2];
  if (points.some((value) => value === null || value === undefined || Number.isNaN(Number(value)))) {
    return null;
  }

  const [radLat1, radLng1, radLat2, radLng2] = points.map((value) => (Number(value) * Math.PI) / 180);
  const deltaLat = radLat2 - radLat1;
  const deltaLng = radLng2 - radLng1;
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(deltaLng / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  return Math.round(km * 10) / 10;
}
