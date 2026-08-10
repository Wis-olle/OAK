import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
// Overridable so a test run can boot a throwaway database instead of the dev one.
const dbFile = process.env.OAK_DB_FILE || path.join(dataDir, 'oak.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'customer' CHECK (role IN ('customer','partner')),
  avatar TEXT,
  city TEXT DEFAULT 'TP.HCM',
  district TEXT DEFAULT 'Quận 1',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS salons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users(id),
  name TEXT,
  slug TEXT UNIQUE,
  description TEXT,
  address TEXT,
  district TEXT,
  city TEXT,
  phone TEXT,
  image TEXT,
  open_time TEXT,
  close_time TEXT,
  lat REAL,
  lng REAL,
  verified INTEGER DEFAULT 1,
  featured INTEGER DEFAULT 0,
  flagship INTEGER DEFAULT 0,
  tags TEXT,
  amenities TEXT,
  tour_url TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS salon_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id INTEGER REFERENCES salons(id),
  image TEXT,
  caption TEXT,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id INTEGER REFERENCES salons(id),
  category TEXT CHECK (category IN ('hair','nail','skincare','spa','eyelash','amenity')),
  subcategory TEXT,
  name TEXT,
  description TEXT,
  price INTEGER,
  duration_min INTEGER,
  image TEXT,
  featured INTEGER DEFAULT 0,
  is_package INTEGER DEFAULT 0,
  price_is_from INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id INTEGER REFERENCES salons(id),
  name TEXT,
  title TEXT,
  specialty TEXT,
  bio TEXT,
  image TEXT,
  rating REAL DEFAULT 0,
  years_experience INTEGER DEFAULT 0,
  portfolio TEXT,
  active INTEGER DEFAULT 1
);

-- weekday: 0 = Sunday .. 6 = Saturday. "start"/"end" quoted for clarity, like "read".
CREATE TABLE IF NOT EXISTS staff_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER REFERENCES staff(id),
  weekday INTEGER,
  "start" TEXT,
  "end" TEXT,
  is_off INTEGER DEFAULT 0,
  UNIQUE (staff_id, weekday)
);

CREATE TABLE IF NOT EXISTS staff_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER REFERENCES staff(id),
  service_id INTEGER REFERENCES services(id),
  UNIQUE (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  salon_id INTEGER REFERENCES salons(id),
  service_id INTEGER REFERENCES services(id),
  staff_id INTEGER REFERENCES staff(id),
  code TEXT UNIQUE,
  date TEXT,
  time TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled')),
  note TEXT,
  total_price INTEGER,
  customer_name TEXT,
  customer_phone TEXT,
  payment_method TEXT DEFAULT 'at_salon',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  salon_id INTEGER REFERENCES salons(id),
  service_id INTEGER REFERENCES services(id),
  staff_id INTEGER REFERENCES staff(id),
  booking_id INTEGER REFERENCES bookings(id),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT
);

-- One review per booking, enforced by the database rather than by the route alone.
-- SQLite treats NULLs as distinct here, so standalone reviews (booking_id NULL) are
-- unaffected however many there are.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking_id ON reviews(booking_id);

-- Both columns are nullable so the two UNIQUE indexes can coexist; the CHECK is what
-- makes a row point at a salon or a service, never both and never neither.
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  salon_id INTEGER REFERENCES salons(id),
  service_id INTEGER REFERENCES services(id),
  created_at TEXT,
  UNIQUE (user_id, salon_id),
  UNIQUE (user_id, service_id),
  CHECK ((salon_id IS NULL) != (service_id IS NULL))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  title TEXT,
  body TEXT,
  type TEXT DEFAULT 'general',
  "read" INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salon_id INTEGER REFERENCES salons(id),
  code TEXT UNIQUE,
  type TEXT DEFAULT 'discount' CHECK (type IN ('discount','combo','flash_sale')),
  title TEXT,
  description TEXT,
  discount_percent INTEGER,
  discount_amount INTEGER,
  original_price INTEGER,
  sale_price INTEGER,
  service_ids TEXT,
  image TEXT,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER REFERENCES users(id),
  type TEXT CHECK (type IN ('article','video')),
  title TEXT,
  slug TEXT UNIQUE,
  excerpt TEXT,
  content TEXT,
  video_url TEXT,
  image TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER REFERENCES posts(id),
  user_id INTEGER REFERENCES users(id),
  content TEXT,
  created_at TEXT
);
`;

export const db = new DatabaseSync(dbFile);

db.exec('PRAGMA foreign_keys = ON');
db.exec(SCHEMA);

if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) {
  seed(db);
}
