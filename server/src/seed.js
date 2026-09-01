/*
 * OAK Beauty — demo seed data (Vietnamese).
 *
 * Runs once, automatically, only when the `users` table is empty (see db.js).
 *
 * DEMO ACCOUNTS — every seeded account uses the password: Oak@1234
 *
 *   khach@oak.vn     Ngọc Anh          customer   (has bookings, reviews,
 *                                                  notifications, favorites)
 *   doitac@oak.vn    Thu Trang         partner    owns "Lala Nail Studio"
 *   nhanvien@oak.vn  Lan Khuê          staff      holds the "Lan Khuê" roster row at
 *                                                 Lala Nail Studio
 *
 * Filler accounts (same password), so the data set looks realistic:
 *
 *   hoangyen@oak.vn  Hoàng Yến         customer
 *   baolong@oak.vn   Trần Bảo Long     customer
 *
 * ONE SALON PER PARTNER. The console derives its salon from the signed-in owner and
 * shows exactly one, so a partner owning two would leave the second unreachable:
 *
 *   doitac@oak.vn      Thu Trang        -> Lala Nail Studio
 *   minhchau@oak.vn    Lê Minh Châu     -> Maison de Beauté
 *   diemquynh@oak.vn   Vũ Diễm Quỳnh    -> The Hair Studio
 *   tuyetnhung@oak.vn  Phạm Tuyết Nhung -> Glow Skincare Clinic
 *   hamy@oak.vn        Nguyễn Hà My     -> The Muse Beauty Bar
 *   quochuy@oak.vn     Đặng Quốc Huy    -> The Bare Studio
 *
 * All `image` values are real files under ui/assets/images/.
 */

import bcrypt from 'bcryptjs';
import { todayISO } from './lib/time.js';
import {
  WELCOME_DESCRIPTION,
  WELCOME_IMAGE,
  WELCOME_NOTICE_BODY,
  WELCOME_NOTICE_TITLE,
  WELCOME_PERCENT,
  WELCOME_TITLE,
  welcomeCode,
  welcomeWindow,
} from './lib/welcome-promotion.js';

const DEMO_PASSWORD = 'Oak@1234';
const IMG = (file) => `assets/images/${file}`;

const USERS = [
  {
    name: 'Ngọc Anh',
    email: 'khach@oak.vn',
    phone: '0901 234 567',
    role: 'customer',
    avatar: IMG('img-9c5bb8590d.jpg'),
    city: 'TP.HCM',
    district: 'Quận 1',
    created_at: '2026-03-14T09:12:00.000Z',
  },
  {
    name: 'Thu Trang',
    email: 'doitac@oak.vn',
    phone: '0902 345 678',
    role: 'partner',
    avatar: IMG('img-77a799e9a6.jpg'),
    city: 'TP.HCM',
    district: 'Quận 1',
    created_at: '2026-01-08T03:40:00.000Z',
  },
  {
    name: 'Hoàng Yến',
    email: 'hoangyen@oak.vn',
    phone: '0903 456 789',
    role: 'customer',
    avatar: IMG('img-9884f7dbb5.jpg'),
    city: 'TP.HCM',
    district: 'Quận 3',
    created_at: '2026-04-02T11:05:00.000Z',
  },
  {
    name: 'Trần Bảo Long',
    email: 'baolong@oak.vn',
    phone: '0904 567 890',
    role: 'customer',
    avatar: IMG('img-676e58158d.jpg'),
    city: 'TP.HCM',
    district: 'Quận Bình Thạnh',
    created_at: '2026-05-21T07:28:00.000Z',
  },
  {
    name: 'Lê Minh Châu',
    email: 'minhchau@oak.vn',
    phone: '0905 678 901',
    role: 'partner',
    avatar: IMG('img-817bbf045c.jpg'),
    city: 'TP.HCM',
    district: 'Quận 1',
    created_at: '2026-01-19T02:15:00.000Z',
  },
  {
    name: 'Đặng Quốc Huy',
    email: 'quochuy@oak.vn',
    phone: '0906 789 012',
    role: 'partner',
    avatar: IMG('img-900737538f.jpg'),
    city: 'TP.HCM',
    district: 'Quận 2',
    created_at: '2026-02-05T04:50:00.000Z',
  },
  {
    name: 'Vũ Diễm Quỳnh',
    email: 'diemquynh@oak.vn',
    phone: '0907 890 123',
    role: 'partner',
    avatar: IMG('img-02a07813e8.jpg'),
    city: 'TP.HCM',
    district: 'Quận 1',
    created_at: '2026-01-27T06:20:00.000Z',
  },
  {
    name: 'Phạm Tuyết Nhung',
    email: 'tuyetnhung@oak.vn',
    phone: '0908 901 234',
    role: 'partner',
    avatar: IMG('img-054821048a.jpg'),
    city: 'TP.HCM',
    district: 'Quận 1',
    created_at: '2026-02-11T08:05:00.000Z',
  },
  {
    name: 'Nguyễn Hà My',
    email: 'hamy@oak.vn',
    phone: '0909 012 345',
    role: 'partner',
    avatar: IMG('img-b1f10d0d07.jpg'),
    city: 'TP.HCM',
    district: 'Quận 3',
    created_at: '2026-02-24T01:35:00.000Z',
  },
  // Appended, never inserted in the middle: everything below keys off the ids these rows
  // are given in this order. The demo's technician, holding the roster row of the same
  // name at Lala Nail Studio — claimed a few lines further down.
  {
    name: 'Lan Khuê',
    email: 'nhanvien@oak.vn',
    phone: '0910 123 456',
    role: 'staff',
    avatar: IMG('img-2121254c08.jpg'),
    city: 'TP.HCM',
    district: 'Quận 1',
    created_at: '2026-08-20T01:50:00.000Z',
  },
];

const SALONS = [
  {
    owner: 'doitac@oak.vn',
    name: 'Lala Nail Studio',
    slug: 'lala-nail-studio',
    description:
      'Không gian thư giãn đẳng cấp mang phong cách tối giản hiện đại. Lala Nail Studio tập trung vào nghệ thuật chăm sóc móng chuyên sâu, sử dụng sản phẩm organic và kỹ thuật viên dày dặn kinh nghiệm, mang đến trải nghiệm làm đẹp hoàn hảo.',
    address: '123 Lê Lợi, Phường Bến Nghé, Quận 1',
    district: 'Quận 1',
    phone: '028 3822 1456',
    image: IMG('img-d469cbe2a5.jpg'),
    open_time: '09:00',
    close_time: '21:00',
    lat: 10.7725,
    lng: 106.698,
    featured: 1,
    flagship: 1,
    tags: ['Nail', 'Cao cấp', 'Gần trung tâm'],
    amenities: ['Wifi miễn phí', 'Chỗ đậu xe', 'Phòng VIP', 'Nước uống miễn phí'],
    tour_url: 'https://my.matterport.com/show/?m=oak-lala-nail-studio',
  },
  {
    owner: 'minhchau@oak.vn',
    name: 'Maison de Beauté',
    slug: 'maison-de-beaute',
    description:
      'Viện làm đẹp mang hơi thở Pháp giữa lòng Sài Gòn. Maison de Beauté kết hợp dịch vụ chăm sóc móng, nối mi và chăm sóc da mặt trong một không gian ấm cúng, riêng tư cho từng khách hàng.',
    address: '12 Đồng Khởi, Quận 1',
    district: 'Quận 1',
    phone: '028 3829 7733',
    image: IMG('img-e94395d40e.jpg'),
    open_time: '09:30',
    close_time: '20:30',
    lat: 10.778,
    lng: 106.703,
    featured: 1,
    flagship: 0,
    tags: ['Nail', 'Nối mi', 'Phong cách Pháp'],
    amenities: ['Wifi miễn phí', 'Phòng riêng', 'Trà & bánh ngọt'],
    tour_url: 'https://my.matterport.com/show/?m=oak-maison-de-beaute',
  },
  {
    owner: 'diemquynh@oak.vn',
    name: 'The Hair Studio',
    slug: 'the-hair-studio',
    description:
      'Salon tóc chuyên sâu với đội ngũ stylist được đào tạo theo chuẩn Hàn Quốc. Từ cắt tạo kiểu, nhuộm thời trang đến phục hồi tóc hư tổn, mỗi mái tóc đều được thiết kế riêng theo dáng mặt và phong cách.',
    address: '45 Lê Thánh Tôn, Quận 1',
    district: 'Quận 1',
    phone: '028 3823 9011',
    image: IMG('img-c5600bb11b.jpg'),
    open_time: '08:30',
    close_time: '20:00',
    lat: 10.7765,
    lng: 106.701,
    featured: 0,
    flagship: 0,
    tags: ['Tóc', 'Chuẩn Hàn Quốc', 'Stylist riêng'],
    amenities: ['Wifi miễn phí', 'Gội massage đầu', 'Trà thảo mộc'],
    tour_url: null,
  },
  {
    owner: 'tuyetnhung@oak.vn',
    name: 'Glow Skincare Clinic',
    slug: 'glow-skincare-clinic',
    description:
      'Phòng khám chăm sóc da chuẩn y khoa, phác đồ cá nhân hoá cho từng loại da. Thiết bị nhập khẩu châu Âu cùng đội ngũ chuyên viên da liễu giàu kinh nghiệm giúp làn da phục hồi bền vững.',
    address: '89 Nguyễn Huệ, Quận 1',
    district: 'Quận 1',
    phone: '028 3821 6688',
    image: IMG('img-d8bcac81cb.jpg'),
    open_time: '09:00',
    close_time: '19:30',
    lat: 10.774,
    lng: 106.704,
    featured: 0,
    flagship: 0,
    tags: ['Chăm sóc da', 'Chuẩn y khoa', 'Trị mụn'],
    amenities: ['Wifi miễn phí', 'Chỗ đậu xe', 'Tư vấn soi da miễn phí'],
    tour_url: null,
  },
  {
    owner: 'hamy@oak.vn',
    name: 'The Muse Beauty Bar',
    slug: 'the-muse-beauty-bar',
    description:
      'Beauty bar đa dịch vụ dành cho phái đẹp bận rộn. Trị liệu spa thư giãn, nối mi và chăm sóc toàn thân được sắp xếp linh hoạt để bạn làm đẹp trọn vẹn chỉ trong một buổi hẹn.',
    address: '27 Võ Văn Tần, Phường 6, Quận 3',
    district: 'Quận 3',
    phone: '028 3930 4422',
    image: IMG('img-83c65fdb78.jpg'),
    open_time: '10:00',
    close_time: '21:30',
    lat: 10.777,
    lng: 106.689,
    featured: 1,
    flagship: 0,
    tags: ['Spa', 'Nối mi', 'Đa dịch vụ'],
    amenities: ['Wifi miễn phí', 'Phòng xông hơi', 'Chỗ đậu xe', 'Phòng VIP'],
    tour_url: null,
  },
  {
    owner: 'quochuy@oak.vn',
    name: 'The Bare Studio',
    slug: 'the-bare-studio',
    description:
      'Studio trị liệu tối giản chuyên massage và chăm sóc bàn chân. Không gian yên tĩnh, hương thảo mộc tự nhiên và kỹ thuật ấn huyệt truyền thống giúp cơ thể lấy lại cân bằng.',
    address: '18 Trần Não, Phường Bình An, Quận 2',
    district: 'Quận 2',
    phone: '028 3744 1290',
    image: IMG('img-6f4a0aaf3e.jpg'),
    open_time: '10:00',
    close_time: '22:00',
    lat: 10.788,
    lng: 106.7185,
    featured: 0,
    flagship: 0,
    tags: ['Massage', 'Trị liệu', 'Không gian yên tĩnh'],
    amenities: ['Wifi miễn phí', 'Chỗ đậu xe', 'Trà thảo mộc', 'Phòng đôi'],
    tour_url: null,
  },
];

// 4-6 gallery photos per salon, shown in ascending `sort` order.
const SALON_PHOTOS = [
  { salon: 'lala-nail-studio', image: IMG('img-d469cbe2a5.jpg'), caption: 'Không gian tiếp đón', sort: 1 },
  { salon: 'lala-nail-studio', image: IMG('img-38fdcde011.jpg'), caption: 'Khu chăm sóc móng tay', sort: 2 },
  { salon: 'lala-nail-studio', image: IMG('img-b03cbe60ec.jpg'), caption: 'Bảng màu sơn gel Hàn Quốc', sort: 3 },
  { salon: 'lala-nail-studio', image: IMG('img-c92fbe9a51.jpg'), caption: 'Tác phẩm nail art của khách', sort: 4 },
  { salon: 'lala-nail-studio', image: IMG('img-8f601b429a.jpg'), caption: 'Khu ngâm chân thảo mộc', sort: 5 },
  { salon: 'lala-nail-studio', image: IMG('img-6b4e144c13.jpg'), caption: 'Phòng VIP riêng tư', sort: 6 },

  { salon: 'maison-de-beaute', image: IMG('img-e94395d40e.jpg'), caption: 'Mặt tiền salon trên Đồng Khởi', sort: 1 },
  { salon: 'maison-de-beaute', image: IMG('img-47115b1263.jpg'), caption: 'Góc vẽ móng nghệ thuật', sort: 2 },
  { salon: 'maison-de-beaute', image: IMG('img-9c7add0d36.jpg'), caption: 'Khu nối mi riêng biệt', sort: 3 },
  { salon: 'maison-de-beaute', image: IMG('img-572db4c77b.jpg'), caption: 'Thành phẩm mi Volume Nga', sort: 4 },
  { salon: 'maison-de-beaute', image: IMG('img-8efa3099e2.jpg'), caption: 'Phòng chăm sóc da mặt', sort: 5 },

  { salon: 'the-hair-studio', image: IMG('img-c5600bb11b.jpg'), caption: 'Khu ghế cắt tạo kiểu', sort: 1 },
  { salon: 'the-hair-studio', image: IMG('img-3e0a9ec5ac.jpg'), caption: 'Bảng màu nhuộm thời trang', sort: 2 },
  { salon: 'the-hair-studio', image: IMG('img-064bab706d.jpg'), caption: 'Liệu trình phục hồi Keratin', sort: 3 },
  { salon: 'the-hair-studio', image: IMG('hero-f5a2cf86.jpg'), caption: 'Thành phẩm uốn xoăn lơi', sort: 4 },
  { salon: 'the-hair-studio', image: IMG('img-35e4838903.jpg'), caption: 'Quầy trà thảo mộc cho khách', sort: 5 },

  { salon: 'glow-skincare-clinic', image: IMG('img-d8bcac81cb.jpg'), caption: 'Sảnh chờ phòng khám', sort: 1 },
  { salon: 'glow-skincare-clinic', image: IMG('img-5b691ffccb.jpg'), caption: 'Phòng chăm sóc da chuẩn y khoa', sort: 2 },
  { salon: 'glow-skincare-clinic', image: IMG('img-bdddd609ce.jpg'), caption: 'Thiết bị soi da nhập khẩu', sort: 3 },
  { salon: 'glow-skincare-clinic', image: IMG('img-67d91cf90f.jpg'), caption: 'Khu peel da chuyên sâu', sort: 4 },

  { salon: 'the-muse-beauty-bar', image: IMG('img-83c65fdb78.jpg'), caption: 'Quầy beauty bar', sort: 1 },
  { salon: 'the-muse-beauty-bar', image: IMG('img-432c4666c7.jpg'), caption: 'Phòng trị liệu OAK Signature', sort: 2 },
  { salon: 'the-muse-beauty-bar', image: IMG('img-5491553dbe.jpg'), caption: 'Khu tẩy tế bào chết toàn thân', sort: 3 },
  { salon: 'the-muse-beauty-bar', image: IMG('img-7ffd22c3c9.jpg'), caption: 'Phòng xông hơi đá muối', sort: 4 },
  { salon: 'the-muse-beauty-bar', image: IMG('img-572db4c77b.jpg'), caption: 'Góc nối mi Hybrid', sort: 5 },

  { salon: 'the-bare-studio', image: IMG('img-6f4a0aaf3e.jpg'), caption: 'Không gian trị liệu tối giản', sort: 1 },
  { salon: 'the-bare-studio', image: IMG('img-5491553dbe.jpg'), caption: 'Phòng massage đôi', sort: 2 },
  { salon: 'the-bare-studio', image: IMG('img-432c4666c7.jpg'), caption: 'Góc tinh dầu thảo mộc', sort: 3 },
  { salon: 'the-bare-studio', image: IMG('img-7ffd22c3c9.jpg'), caption: 'Khu chăm sóc bàn chân', sort: 4 },
];

const SERVICES = [
  // --- Lala Nail Studio ---
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Chăm sóc móng',
    name: 'Cắt da & Dưỡng móng cơ bản',
    description: 'Cắt da chết, tạo form móng và dưỡng ẩm vùng da quanh móng.',
    price: 150000,
    duration_min: 30,
    image: IMG('img-38fdcde011.jpg'),
  },
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Sơn gel',
    name: 'Sơn Gel Hàn Quốc',
    description: 'Sơn gel màu chuẩn tone Hàn Quốc, độ bám cao và lên màu chuẩn.',
    price: 250000,
    duration_min: 45,
    image: IMG('img-b03cbe60ec.jpg'),
    featured: 1,
  },
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Nối móng',
    name: 'Đắp Gel Nối Móng',
    description: 'Đắp gel kéo dài móng, tạo form theo yêu cầu, bền đẹp 3-4 tuần.',
    price: 450000,
    duration_min: 90,
    image: IMG('img-c92fbe9a51.jpg'),
  },
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Sơn gel',
    name: 'Sơn Gel Cơ Bản',
    description: 'Sơn gel một màu, hoàn thiện lớp bóng bảo vệ móng.',
    price: 250000,
    duration_min: 45,
    image: IMG('img-93e56c2a14.jpg'),
  },
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Nail art',
    name: 'Thiết Kế Nail Art Cầu Kỳ',
    description: 'Vẽ tay hoạ tiết theo mẫu riêng, đính đá và phụ kiện cao cấp.',
    price: 450000,
    duration_min: 90,
    image: IMG('img-c92fbe9a51.jpg'),
    featured: 1,
    price_is_from: 1,
  },
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Chăm sóc chân',
    name: 'Chăm Sóc Chân Chuyên Sâu',
    description: 'Ngâm chân thảo mộc, tẩy da chết, cắt da và dưỡng ẩm chuyên sâu.',
    price: 350000,
    duration_min: 60,
    image: IMG('img-8f601b429a.jpg'),
  },
  // A combo is a service in its own right: one row, one booking, duration_min = the sum of
  // the parts and price = the bundle price. The combo promotions below point at these, so
  // the offer on uu-dai.html deep-links into the wizard at the price it advertises instead
  // of handing the customer a code nothing can apply.
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Combo',
    name: 'Combo Sơn Gel + Chăm Sóc Chân',
    description: 'Sơn gel cơ bản và chăm sóc chân chuyên sâu trong cùng một buổi hẹn.',
    price: 480000,
    duration_min: 105,
    image: IMG('img-8f601b429a.jpg'),
    is_package: 1,
  },
  {
    salon: 'lala-nail-studio',
    category: 'nail',
    subcategory: 'Combo',
    name: 'Combo Đắp Gel + Nail Art',
    description: 'Đắp gel nối móng kèm thiết kế nail art cầu kỳ, tiết kiệm 180.000đ.',
    price: 720000,
    duration_min: 180,
    image: IMG('img-c92fbe9a51.jpg'),
    is_package: 1,
  },
  {
    salon: 'lala-nail-studio',
    category: 'amenity',
    name: 'Phòng VIP riêng tư',
    description: 'Phòng riêng yên tĩnh dành cho nhóm bạn hoặc khách cần không gian kín đáo.',
    price: 200000,
    duration_min: 60,
    image: IMG('img-6b4e144c13.jpg'),
  },

  // --- Maison de Beauté ---
  {
    salon: 'maison-de-beaute',
    category: 'nail',
    subcategory: 'Sơn gel',
    name: 'Nail Gel Hàn Quốc',
    description: 'Bộ sơn gel trọn gói theo bảng màu Hàn Quốc mới nhất.',
    price: 450000,
    duration_min: 60,
    image: IMG('img-b03cbe60ec.jpg'),
    featured: 1,
  },
  {
    salon: 'maison-de-beaute',
    category: 'nail',
    subcategory: 'Nail art',
    name: 'Vẽ móng nghệ thuật (Nail Art)',
    description: 'Nghệ thuật vẽ tay trên móng, hoạ tiết độc bản theo yêu cầu.',
    price: 550000,
    duration_min: 75,
    image: IMG('img-47115b1263.jpg'),
    price_is_from: 1,
  },
  {
    salon: 'maison-de-beaute',
    category: 'nail',
    subcategory: 'Chăm sóc tay',
    name: 'Chăm sóc da tay chuyên sâu',
    description: 'Tẩy da chết, ủ paraffin và massage bàn tay giúp da mềm mịn.',
    price: 320000,
    duration_min: 45,
    image: IMG('img-38fdcde011.jpg'),
  },
  {
    salon: 'maison-de-beaute',
    category: 'eyelash',
    subcategory: 'Nối mi',
    name: 'Nối mi Classic',
    description: 'Nối mi tỉ lệ 1:1, dáng mi tự nhiên phù hợp đi làm hằng ngày.',
    price: 350000,
    duration_min: 60,
    image: IMG('img-9c7add0d36.jpg'),
  },
  {
    salon: 'maison-de-beaute',
    category: 'eyelash',
    subcategory: 'Nối mi',
    name: 'Nối mi Volume Nga',
    description: 'Kỹ thuật quạt mi Volume cho hàng mi dày, mềm và nhẹ.',
    price: 650000,
    duration_min: 90,
    image: IMG('img-572db4c77b.jpg'),
    featured: 1,
  },
  {
    salon: 'maison-de-beaute',
    category: 'skincare',
    subcategory: 'Massage',
    name: 'Massage mặt',
    description: 'Massage thư giãn cơ mặt, nâng cơ nhẹ và tăng tuần hoàn máu.',
    price: 300000,
    duration_min: 45,
    image: IMG('img-8efa3099e2.jpg'),
  },

  // --- The Hair Studio ---
  {
    salon: 'the-hair-studio',
    category: 'hair',
    subcategory: 'Cắt tạo kiểu',
    name: 'Cắt tóc thiết kế',
    description: 'Gội, massage đầu, cắt tạo kiểu bởi Stylist chuyên nghiệp.',
    price: 350000,
    duration_min: 60,
    image: IMG('img-c5600bb11b.jpg'),
    featured: 1,
  },
  {
    salon: 'the-hair-studio',
    category: 'hair',
    subcategory: 'Nhuộm tóc',
    name: 'Nhuộm màu thời trang',
    description: 'Sử dụng thuốc nhuộm cao cấp, bảo vệ cấu trúc tóc.',
    price: 1200000,
    duration_min: 150,
    image: IMG('img-3e0a9ec5ac.jpg'),
  },
  {
    salon: 'the-hair-studio',
    category: 'hair',
    subcategory: 'Phục hồi tóc',
    name: 'Phục hồi Keratin',
    description: 'Liệu trình phục hồi chuyên sâu cho tóc hư tổn nặng.',
    price: 800000,
    duration_min: 120,
    image: IMG('img-064bab706d.jpg'),
  },
  {
    salon: 'the-hair-studio',
    category: 'hair',
    subcategory: 'Uốn tóc',
    name: 'Uốn xoăn lơi Hàn Quốc',
    description: 'Tạo nếp xoăn tự nhiên, bền đẹp.',
    price: 950000,
    duration_min: 180,
    image: IMG('hero-f5a2cf86.jpg'),
  },
  {
    salon: 'the-hair-studio',
    category: 'amenity',
    name: 'Trà thảo mộc',
    description: 'Trà thảo mộc pha nóng phục vụ miễn phí trong suốt buổi hẹn.',
    price: 0,
    duration_min: 10,
    image: IMG('img-35e4838903.jpg'),
  },

  // --- Glow Skincare Clinic ---
  {
    salon: 'glow-skincare-clinic',
    category: 'skincare',
    subcategory: 'Chăm sóc da mặt',
    name: 'Chăm sóc da mặt',
    description: 'Làm sạch sâu, cấp ẩm và phục hồi hàng rào bảo vệ da.',
    price: 450000,
    duration_min: 60,
    image: IMG('img-5b691ffccb.jpg'),
    featured: 1,
  },
  {
    salon: 'glow-skincare-clinic',
    category: 'skincare',
    subcategory: 'Trị liệu da',
    name: 'Trị liệu chuyên sâu',
    description: 'Phác đồ cá nhân hoá cho da mụn, thâm và lỗ chân lông to.',
    price: 890000,
    duration_min: 90,
    image: IMG('img-bdddd609ce.jpg'),
  },
  {
    salon: 'glow-skincare-clinic',
    category: 'skincare',
    subcategory: 'Trị liệu da',
    name: 'Peel da',
    description: 'Thay da sinh học bằng hoạt chất chuẩn y khoa, cải thiện sắc tố.',
    price: 1250000,
    duration_min: 75,
    image: IMG('img-67d91cf90f.jpg'),
  },
  {
    salon: 'glow-skincare-clinic',
    category: 'eyelash',
    subcategory: 'Uốn mi',
    name: 'Uốn mi Keratin',
    description: 'Uốn cong mi thật bằng dưỡng chất keratin, giữ nếp 6-8 tuần.',
    price: 450000,
    duration_min: 60,
    image: IMG('img-9c7add0d36.jpg'),
  },

  // --- The Muse Beauty Bar ---
  {
    salon: 'the-muse-beauty-bar',
    category: 'spa',
    subcategory: 'Massage',
    name: 'Trị liệu OAK Signature',
    description: 'Liệu trình đặc trưng của OAK kết hợp massage toàn thân và tinh dầu riêng.',
    price: 950000,
    duration_min: 90,
    image: IMG('img-432c4666c7.jpg'),
    featured: 1,
  },
  {
    salon: 'the-muse-beauty-bar',
    category: 'spa',
    subcategory: 'Massage',
    name: 'Trị liệu thảo mộc',
    description: 'Chườm túi thảo mộc nóng giúp giãn cơ và giảm căng thẳng.',
    price: 780000,
    duration_min: 75,
    image: IMG('img-35e4838903.jpg'),
  },
  {
    salon: 'the-muse-beauty-bar',
    category: 'spa',
    subcategory: 'Chăm sóc body',
    name: 'Tẩy tế bào chết hữu cơ',
    description: 'Tẩy da chết toàn thân bằng nguyên liệu hữu cơ, dưỡng ẩm sau liệu trình.',
    price: 520000,
    duration_min: 60,
    image: IMG('img-5491553dbe.jpg'),
  },
  {
    salon: 'the-muse-beauty-bar',
    category: 'eyelash',
    subcategory: 'Nối mi',
    name: 'Nối mi Hybrid',
    description: 'Kết hợp mi Classic và Volume tạo độ dày vừa phải, tự nhiên.',
    price: 500000,
    duration_min: 75,
    image: IMG('img-572db4c77b.jpg'),
  },
  {
    salon: 'the-muse-beauty-bar',
    category: 'amenity',
    name: 'Xông hơi đá muối Himalaya',
    description: 'Phòng xông hơi đá muối giúp thải độc và thư giãn trước liệu trình.',
    price: 180000,
    duration_min: 30,
    image: IMG('img-7ffd22c3c9.jpg'),
  },

  // --- The Bare Studio ---
  {
    salon: 'the-bare-studio',
    category: 'spa',
    subcategory: 'Gói trị liệu',
    name: 'Trọn Vẹn Yêu Thương',
    description: 'Gói trị liệu đôi trọn buổi gồm massage toàn thân, chăm sóc chân và xông hơi.',
    price: 2800000,
    duration_min: 120,
    image: IMG('img-6f4a0aaf3e.jpg'),
    is_package: 1,
  },
  {
    salon: 'the-bare-studio',
    category: 'spa',
    subcategory: 'Gói trị liệu',
    name: 'Ngày Thư Thái',
    description: 'Massage thư giãn toàn thân kết hợp ngâm chân thảo mộc.',
    price: 850000,
    duration_min: 90,
    image: IMG('img-5491553dbe.jpg'),
    is_package: 1,
  },
  {
    salon: 'the-bare-studio',
    category: 'spa',
    subcategory: 'Massage',
    name: 'Massage ấn huyệt cổ vai gáy',
    description: 'Kỹ thuật ấn huyệt truyền thống giảm đau mỏi cổ vai gáy do ngồi lâu.',
    price: 400000,
    duration_min: 45,
    image: IMG('img-432c4666c7.jpg'),
  },
];

const STAFF = [
  {
    salon: 'lala-nail-studio',
    name: 'Minh Hằng',
    title: 'Senior Nail Artist',
    specialty: 'Đắp gel, Thiết kế nail art',
    bio: 'Chuyên gia đắp gel và thiết kế nail art phức tạp. 5 năm kinh nghiệm.',
    image: IMG('img-424ffbe687.jpg'),
    rating: 5.0,
    years_experience: 5,
    portfolio: [IMG('img-c92fbe9a51.jpg'), IMG('img-b03cbe60ec.jpg'), IMG('img-93e56c2a14.jpg')],
  },
  {
    salon: 'lala-nail-studio',
    name: 'Lan Khuê',
    title: 'Nail Technician',
    specialty: 'Sơn gel, Chăm sóc móng hư tổn',
    bio: 'Thế mạnh về chăm sóc móng hư tổn và sơn gel chuẩn form.',
    image: IMG('img-2121254c08.jpg'),
    rating: 4.9,
    years_experience: 3,
    portfolio: [IMG('img-93e56c2a14.jpg'), IMG('img-38fdcde011.jpg'), IMG('img-b03cbe60ec.jpg')],
  },
  {
    salon: 'lala-nail-studio',
    name: 'Phương Vy',
    title: 'Spa Specialist',
    specialty: 'Massage tay chân, Trị liệu spa',
    bio: 'Chuyên viên massage tay chân và trị liệu spa chuyên sâu.',
    image: IMG('img-5aceef7edc.jpg'),
    rating: 4.8,
    years_experience: 4,
    portfolio: [IMG('img-8f601b429a.jpg'), IMG('img-38fdcde011.jpg'), IMG('img-5491553dbe.jpg')],
  },
  {
    salon: 'lala-nail-studio',
    name: 'Minh Anh',
    title: 'Senior Technician',
    specialty: 'Vẽ móng nghệ thuật, Đắp gel, Chăm sóc móng chuyên sâu',
    bio: 'Chuyên gia hàng đầu về vẽ móng nghệ thuật và đắp gel. Với sự tỉ mỉ và đôi mắt thẩm mỹ tinh tế, Minh Anh luôn mang đến những tác phẩm độc bản, tôn lên vẻ đẹp riêng biệt của từng khách hàng.',
    image: IMG('img-a0e747004e.jpg'),
    rating: 5.0,
    years_experience: 8,
    portfolio: [
      IMG('img-c92fbe9a51.jpg'),
      IMG('img-47115b1263.jpg'),
      IMG('img-b03cbe60ec.jpg'),
      IMG('img-93e56c2a14.jpg'),
    ],
  },
  {
    salon: 'maison-de-beaute',
    name: 'Lan Anh',
    title: 'Senior Technician',
    specialty: 'Nail art, Nối mi Classic',
    bio: 'Hơn 6 năm gắn bó với nghề, tỉ mỉ trong từng đường nét vẽ tay.',
    image: IMG('img-6dc8be31b2.jpg'),
    rating: 4.9,
    years_experience: 6,
    portfolio: [IMG('img-47115b1263.jpg'), IMG('img-9c7add0d36.jpg'), IMG('img-572db4c77b.jpg')],
  },
  {
    salon: 'maison-de-beaute',
    name: 'Ngọc Mai',
    title: 'Nail Specialist',
    specialty: 'Sơn gel, Chăm sóc da tay',
    bio: 'Chuyên chăm sóc da tay và sơn gel tone trầm sang trọng.',
    image: IMG('img-630e77b814.jpg'),
    rating: 4.8,
    years_experience: 4,
    portfolio: [IMG('img-b03cbe60ec.jpg'), IMG('img-38fdcde011.jpg'), IMG('img-8efa3099e2.jpg')],
  },
  {
    salon: 'the-hair-studio',
    name: 'Quang Huy',
    title: 'Senior Stylist',
    specialty: 'Cắt tóc thiết kế, Uốn Hàn Quốc',
    bio: 'Stylist được đào tạo tại Seoul, thế mạnh cắt layer và uốn xoăn lơi.',
    image: IMG('img-6b4e144c13.jpg'),
    rating: 4.9,
    years_experience: 7,
    portfolio: [
      IMG('img-c5600bb11b.jpg'),
      IMG('img-3e0a9ec5ac.jpg'),
      IMG('img-064bab706d.jpg'),
      IMG('hero-f5a2cf86.jpg'),
    ],
  },
  {
    salon: 'glow-skincare-clinic',
    name: 'Thùy Dương',
    title: 'Chuyên viên da liễu',
    specialty: 'Trị mụn, Peel da',
    bio: 'Chuyên viên da liễu với phác đồ trị mụn cá nhân hoá cho da nhạy cảm.',
    image: IMG('img-5f82a3ff84.jpg'),
    rating: 4.8,
    years_experience: 9,
    portfolio: [IMG('img-5b691ffccb.jpg'), IMG('img-bdddd609ce.jpg'), IMG('img-67d91cf90f.jpg')],
  },
  {
    salon: 'the-muse-beauty-bar',
    name: 'Kim Ngân',
    title: 'Spa Therapist',
    specialty: 'Massage tinh dầu, Trị liệu thảo mộc',
    bio: 'Bàn tay ấm và lực massage vừa phải, được khách quen yêu thích.',
    image: IMG('img-66c1c3331d.jpg'),
    rating: 4.7,
    years_experience: 5,
    portfolio: [IMG('img-432c4666c7.jpg'), IMG('img-35e4838903.jpg'), IMG('img-5491553dbe.jpg')],
  },
  {
    salon: 'the-bare-studio',
    name: 'Bảo Trân',
    title: 'Massage Therapist',
    specialty: 'Ấn huyệt cổ vai gáy, Chăm sóc bàn chân',
    bio: 'Thành thạo kỹ thuật ấn huyệt truyền thống, giúp giảm đau mỏi nhanh.',
    image: IMG('img-7ffd22c3c9.jpg'),
    rating: 4.9,
    years_experience: 10,
    portfolio: [IMG('img-6f4a0aaf3e.jpg'), IMG('img-5491553dbe.jpg'), IMG('img-7ffd22c3c9.jpg')],
  },
];

// One row per staff, expanded to weekdays 1-6 (Mon-Sat) at insert time; `off` names
// the single weekday that staff does not work. Nobody works Sunday (no weekday-0 row).
const STAFF_SCHEDULE = [
  { staff: 'Minh Hằng', start: '09:00', end: '18:00', off: 2 },
  { staff: 'Lan Khuê', start: '10:00', end: '19:00', off: 3 },
  { staff: 'Phương Vy', start: '09:30', end: '18:30', off: 4 },
  { staff: 'Minh Anh', start: '10:00', end: '20:00', off: 1 },
  { staff: 'Lan Anh', start: '09:30', end: '19:30', off: 2 },
  { staff: 'Ngọc Mai', start: '10:00', end: '20:00', off: 5 },
  { staff: 'Quang Huy', start: '08:30', end: '18:00', off: 3 },
  { staff: 'Thùy Dương', start: '09:00', end: '17:30', off: 4 },
  { staff: 'Kim Ngân', start: '10:00', end: '20:30', off: 1 },
  { staff: 'Bảo Trân', start: '10:00', end: '21:00', off: 5 },
];

// Every active non-amenity service is covered by at least one staff member, otherwise
// it would never produce an availability slot.
const STAFF_SERVICES = [
  {
    staff: 'Minh Hằng',
    services: ['Sơn Gel Hàn Quốc', 'Sơn Gel Cơ Bản', 'Đắp Gel Nối Móng', 'Thiết Kế Nail Art Cầu Kỳ'],
  },
  {
    staff: 'Lan Khuê',
    services: ['Cắt da & Dưỡng móng cơ bản', 'Sơn Gel Cơ Bản', 'Sơn Gel Hàn Quốc'],
  },
  {
    staff: 'Phương Vy',
    services: ['Chăm Sóc Chân Chuyên Sâu', 'Cắt da & Dưỡng móng cơ bản'],
  },
  {
    staff: 'Minh Anh',
    services: [
      'Thiết Kế Nail Art Cầu Kỳ',
      'Đắp Gel Nối Móng',
      'Sơn Gel Hàn Quốc',
      'Sơn Gel Cơ Bản',
      'Chăm Sóc Chân Chuyên Sâu',
      // She performs every part of both combos, so she is the one who can take one.
      // Deliberate trade-off: a combo is the longest service she offers, so her generic
      // staff-profile grid (sized by her longest service) ends earlier than her shift.
      'Combo Sơn Gel + Chăm Sóc Chân',
      'Combo Đắp Gel + Nail Art',
    ],
  },
  {
    staff: 'Lan Anh',
    services: [
      'Vẽ móng nghệ thuật (Nail Art)',
      'Nail Gel Hàn Quốc',
      'Nối mi Classic',
      'Nối mi Volume Nga',
    ],
  },
  {
    staff: 'Ngọc Mai',
    services: ['Nail Gel Hàn Quốc', 'Chăm sóc da tay chuyên sâu', 'Massage mặt'],
  },
  {
    staff: 'Quang Huy',
    services: [
      'Cắt tóc thiết kế',
      'Nhuộm màu thời trang',
      'Phục hồi Keratin',
      'Uốn xoăn lơi Hàn Quốc',
    ],
  },
  {
    staff: 'Thùy Dương',
    services: ['Chăm sóc da mặt', 'Trị liệu chuyên sâu', 'Peel da', 'Uốn mi Keratin'],
  },
  {
    staff: 'Kim Ngân',
    services: [
      'Trị liệu OAK Signature',
      'Trị liệu thảo mộc',
      'Tẩy tế bào chết hữu cơ',
      'Nối mi Hybrid',
    ],
  },
  {
    staff: 'Bảo Trân',
    services: ['Trọn Vẹn Yêu Thương', 'Ngày Thư Thái', 'Massage ấn huyệt cổ vai gáy'],
  },
];

const BOOKINGS = [
  {
    user: 'khach@oak.vn',
    salon: 'lala-nail-studio',
    service: 'Thiết Kế Nail Art Cầu Kỳ',
    staff: 'Minh Anh',
    code: 'OAK-4K7P2M',
    date: '2026-08-12',
    time: '10:00',
    status: 'confirmed',
    note: 'Em muốn mẫu nail tone pastel nhẹ nhàng, ưu tiên form vuông bo tròn.',
    customer_name: 'Ngọc Anh',
    customer_phone: '0901 234 567',
    source: 'customer',
    created_at: '2026-08-05T02:30:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    salon: 'the-muse-beauty-bar',
    service: 'Trị liệu OAK Signature',
    staff: 'Kim Ngân',
    code: 'OAK-9XB3QT',
    date: '2026-08-25',
    time: '15:30',
    status: 'pending',
    note: null,
    customer_name: 'Ngọc Anh',
    customer_phone: '0901 234 567',
    source: 'customer',
    created_at: '2026-08-09T08:10:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    salon: 'lala-nail-studio',
    service: 'Sơn Gel Cơ Bản',
    staff: 'Minh Anh',
    code: 'OAK-2D8HRN',
    date: '2026-07-18',
    time: '09:30',
    status: 'completed',
    note: null,
    customer_name: 'Ngọc Anh',
    customer_phone: '0901 234 567',
    source: 'customer',
    created_at: '2026-07-12T06:45:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    salon: 'the-hair-studio',
    service: 'Phục hồi Keratin',
    staff: 'Quang Huy',
    code: 'OAK-6VC1LW',
    date: '2026-07-30',
    time: '14:00',
    status: 'cancelled',
    note: 'Bận công việc đột xuất nên xin phép huỷ lịch, hẹn salon dịp khác.',
    customer_name: 'Ngọc Anh',
    customer_phone: '0901 234 567',
    source: 'customer',
    created_at: '2026-07-24T09:05:00.000Z',
  },
  // Completed and deliberately left un-reviewed, so there is always a booking the
  // review flow can be exercised against.
  //
  // The one 'partner' row, so the demo shows a walk-in tier that is not empty. This one and
  // not the other completed row: Minh Anh's is what the profile demo leans on and carries the
  // seeded review, and it stays verified. And this row is the exact case the column exists
  // for — a visit typed at the counter against a phone number that happens to belong to a
  // real account, which user_id alone cannot tell apart from a booking that customer made.
  {
    user: 'khach@oak.vn',
    salon: 'lala-nail-studio',
    service: 'Chăm Sóc Chân Chuyên Sâu',
    staff: 'Phương Vy',
    code: 'OAK-7TJ5ZA',
    date: '2026-06-10',
    time: '11:00',
    status: 'completed',
    note: null,
    customer_name: 'Ngọc Anh',
    customer_phone: '0901 234 567',
    source: 'partner',
    created_at: '2026-06-04T03:15:00.000Z',
  },
];

// `booking` refers to the index in BOOKINGS above (null = standalone review).
const REVIEWS = [
  {
    user: 'khach@oak.vn',
    salon: 'lala-nail-studio',
    service: 'Sơn Gel Cơ Bản',
    staff: 'Minh Anh',
    booking: 2,
    rating: 5,
    comment:
      'Minh Anh làm móng cực kỳ tỉ mỉ. Lớp gel rất bền và form móng lên dáng hoàn hảo. Mẫu vẽ tay thì đẹp y như ảnh mẫu tôi đưa.',
    created_at: '2026-07-18T04:20:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    salon: 'the-muse-beauty-bar',
    service: 'Trị liệu thảo mộc',
    staff: 'Kim Ngân',
    booking: null,
    rating: 5,
    comment:
      'Không gian yên tĩnh, mùi tinh dầu dễ chịu. Sau buổi trị liệu vai gáy nhẹ hẳn, ngủ ngon hơn thấy rõ.',
    created_at: '2026-06-29T12:05:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    salon: 'the-hair-studio',
    service: 'Cắt tóc thiết kế',
    staff: 'Quang Huy',
    booking: null,
    rating: 4,
    comment:
      'Stylist tư vấn rất kỹ theo dáng mặt, kiểu tóc lên đẹp. Chỉ tiếc là hôm đó khá đông nên phải chờ thêm khoảng 20 phút.',
    created_at: '2026-05-16T10:40:00.000Z',
  },
];

const NOTIFICATIONS = [
  {
    user: 'khach@oak.vn',
    title: 'Lịch hẹn đã được xác nhận',
    body: 'Lala Nail Studio đã xác nhận lịch hẹn ngày 12/08/2026 lúc 10:00 với kỹ thuật viên Minh Anh.',
    type: 'booking',
    read: 0,
    // Index into BOOKINGS; null where the notification is about nothing bookable.
    booking: 0,
    created_at: '2026-08-05T02:35:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    // The one entry here that is not written out: db.js rewrites this notice on databases
    // seeded before the policy, and both have to end up saying the same sentence.
    title: WELCOME_NOTICE_TITLE,
    body: WELCOME_NOTICE_BODY,
    type: 'promotion',
    read: 0,
    booking: null,
    created_at: '2026-08-01T01:00:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    title: 'Nhắc lịch hẹn sắp tới',
    body: 'Bạn có lịch hẹn tại The Muse Beauty Bar vào ngày 25/08/2026 lúc 15:30. Vui lòng đến sớm 10 phút.',
    type: 'reminder',
    read: 1,
    booking: 1,
    created_at: '2026-08-09T08:15:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    title: 'Chia sẻ cảm nhận của bạn',
    body: 'Buổi hẹn tại Lala Nail Studio đã hoàn tất. Hãy dành 1 phút đánh giá để giúp salon phục vụ tốt hơn nhé!',
    type: 'review',
    read: 1,
    booking: 2,
    created_at: '2026-07-18T04:00:00.000Z',
  },
];

const FAVORITES = [
  { user: 'khach@oak.vn', salon: 'lala-nail-studio', created_at: '2026-04-11T03:20:00.000Z' },
  { user: 'khach@oak.vn', salon: 'the-muse-beauty-bar', created_at: '2026-06-29T12:10:00.000Z' },
];

/*
 * Promotions are not listed here any more. There is exactly one offer on OAK — the
 * welcome code a salon joins with (lib/welcome-promotion.js) — so every seeded salon
 * gets its own, generated from SALONS in seed() below rather than written out per salon.
 * The seeded cohort is the demo's newly-joined salons: their window opens on the day
 * the database is seeded.
 */

const INSERT_USER =
  'INSERT INTO users (name, email, phone, password_hash, role, avatar, city, district, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_SALON =
  'INSERT INTO salons (owner_id, name, slug, description, address, district, city, phone, image, open_time, close_time, lat, lng, verified, featured, flagship, tags, amenities, tour_url, published, created_at, welcome_promo_opt_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?, 1)';
const INSERT_SALON_PHOTO =
  'INSERT INTO salon_photos (salon_id, image, caption, sort) VALUES (?, ?, ?, ?)';
const INSERT_SERVICE =
  'INSERT INTO services (salon_id, category, subcategory, name, description, price, duration_min, image, featured, is_package, price_is_from, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';
const INSERT_STAFF =
  'INSERT INTO staff (salon_id, name, title, specialty, bio, image, rating, years_experience, portfolio, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';
const CLAIM_STAFF = 'UPDATE staff SET user_id = ?, claimed_at = ? WHERE id = ?';
// RETURNING spelled out: db.prepare appends ` RETURNING id` to an INSERT that lacks one,
// and this table's primary key is the token.
const INSERT_STAFF_INVITE =
  'INSERT INTO staff_invites (token, staff_id, created_by, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?) RETURNING token';
// DEMO DATA. A real invite token is 32 random bytes minted by the console; this one is a
// constant so a fresh database always carries the same openable claim link.
const DEMO_STAFF_INVITE_TOKEN =
  '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const INSERT_STAFF_SCHEDULE =
  'INSERT INTO staff_schedule (staff_id, weekday, "start", "end", is_off) VALUES (?, ?, ?, ?, ?)';
const INSERT_STAFF_SERVICE =
  'INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)';
// source is written like every other demo field rather than left to the column default,
// because there is no default: a NULL row means "from before this column existed", and a
// fresh install has no such rows. Without it every seeded visit would demo as pre-verification
// history and the verified tier — the one the profile is built around — would show zero.
const INSERT_BOOKING =
  'INSERT INTO bookings (user_id, salon_id, service_id, staff_id, code, date, time, status, note, total_price, customer_name, customer_phone, payment_method, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_REVIEW =
  'INSERT INTO reviews (user_id, salon_id, service_id, staff_id, booking_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_FAVORITE =
  'INSERT INTO favorites (user_id, salon_id, created_at) VALUES (?, ?, ?)';
const INSERT_NOTIFICATION =
  'INSERT INTO notifications (user_id, title, body, type, "read", booking_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
const INSERT_PROMOTION =
  'INSERT INTO promotions (salon_id, code, type, title, description, discount_percent, discount_amount, original_price, sale_price, service_ids, image, starts_at, ends_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';

/**
 * Whether an empty database should be filled with the demo data above.
 *
 * Demo data is for a developer's machine, never for a production database: every account
 * below shares one password that server/README.md prints in full, and the staff invite
 * below is a constant, so a seeded production database hands the console of a published
 * salon to anyone who reads the repo. The decision is a pure function so it can be proved
 * without a database; db.js is its only caller.
 *
 * `userCount` comes from `SELECT COUNT(*)`, which pg hands back as a string unless a type
 * parser is installed — db.js installs one, but Number() so both spellings answer alike.
 * Only the literal '1' opts in: an unrecognised SEED_DEMO typed into a production
 * dashboard meant something, but not necessarily this, and the safe reading is "no".
 */
export function shouldSeedDemo(env, userCount) {
  if (Number(userCount) !== 0) {
    return false;
  }
  return env.NODE_ENV !== 'production' || env.SEED_DEMO === '1';
}

/**
 * Insert the full demo data set. Called only when the users table is empty.
 */
export async function seed(db) {
  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);

  await db.withTransaction(async (tx) => {
    const userIds = new Map();
    for (const user of USERS) {
      const { lastInsertRowid } = await tx.run(
        INSERT_USER,
        user.name,
        user.email,
        user.phone,
        passwordHash,
        user.role,
        user.avatar,
        user.city,
        user.district,
        user.created_at,
      );
      userIds.set(user.email, Number(lastInsertRowid));
    }

    const salonIds = new Map();
    for (const salon of SALONS) {
      const { lastInsertRowid } = await tx.run(
        INSERT_SALON,
        userIds.get(salon.owner),
        salon.name,
        salon.slug,
        salon.description,
        salon.address,
        salon.district,
        'TP.HCM',
        salon.phone,
        salon.image,
        salon.open_time,
        salon.close_time,
        salon.lat,
        salon.lng,
        salon.featured,
        salon.flagship,
        JSON.stringify(salon.tags),
        JSON.stringify(salon.amenities),
        salon.tour_url,
        '2026-01-20T00:00:00.000Z',
      );
      salonIds.set(salon.slug, Number(lastInsertRowid));
    }

    for (const photo of SALON_PHOTOS) {
      await tx.run(
        INSERT_SALON_PHOTO,
        salonIds.get(photo.salon),
        photo.image,
        photo.caption,
        photo.sort,
      );
    }

    const serviceIds = new Map();
    const servicePrices = new Map();
    // Menu position, counted per salon in the order the list is written here: the console
    // reorders from there, and every row needs a distinct value for a swap to mean anything.
    const menuPositions = new Map();
    for (const service of SERVICES) {
      const position = (menuPositions.get(service.salon) ?? 0) + 1;
      menuPositions.set(service.salon, position);
      const { lastInsertRowid } = await tx.run(
        INSERT_SERVICE,
        salonIds.get(service.salon),
        service.category,
        service.subcategory ?? null,
        service.name,
        service.description,
        service.price,
        service.duration_min,
        service.image,
        service.featured ?? 0,
        service.is_package ?? 0,
        service.price_is_from ?? 0,
        position,
      );
      serviceIds.set(service.name, Number(lastInsertRowid));
      servicePrices.set(service.name, service.price);
    }

    const staffIds = new Map();
    for (const member of STAFF) {
      const { lastInsertRowid } = await tx.run(
        INSERT_STAFF,
        salonIds.get(member.salon),
        member.name,
        member.title,
        member.specialty,
        member.bio,
        member.image,
        member.rating,
        member.years_experience,
        JSON.stringify(member.portfolio),
      );
      staffIds.set(member.name, Number(lastInsertRowid));
    }

    // One roster row that a person already stands behind, so the technician's side of the
    // product opens on something. In production these two columns are written by redeeming
    // a claim link — POST /api/auth/staff/register, or /api/staff-me/claim for somebody who
    // already had an account; here they are seeded.
    await tx.run(
      CLAIM_STAFF,
      userIds.get('nhanvien@oak.vn'),
      '2026-08-20T02:00:00.000Z',
      staffIds.get('Lan Khuê'),
    );
    // And one link still waiting on the row next to it, so the claim screen can be opened
    // without minting one from the console first. Demo data: see DEMO_STAFF_INVITE_TOKEN.
    const invitedAt = new Date();
    await tx.run(
      INSERT_STAFF_INVITE,
      DEMO_STAFF_INVITE_TOKEN,
      staffIds.get('Phương Vy'),
      userIds.get('doitac@oak.vn'),
      new Date(invitedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      invitedAt.toISOString(),
    );

    for (const shift of STAFF_SCHEDULE) {
      for (let weekday = 1; weekday <= 6; weekday += 1) {
        await tx.run(
          INSERT_STAFF_SCHEDULE,
          staffIds.get(shift.staff),
          weekday,
          shift.start,
          shift.end,
          weekday === shift.off ? 1 : 0,
        );
      }
    }

    for (const link of STAFF_SERVICES) {
      for (const serviceName of link.services) {
        await tx.run(INSERT_STAFF_SERVICE, staffIds.get(link.staff), serviceIds.get(serviceName));
      }
    }

    const bookingIds = [];
    for (const booking of BOOKINGS) {
      const { lastInsertRowid } = await tx.run(
        INSERT_BOOKING,
        userIds.get(booking.user),
        salonIds.get(booking.salon),
        serviceIds.get(booking.service),
        staffIds.get(booking.staff),
        booking.code,
        booking.date,
        booking.time,
        booking.status,
        booking.note,
        servicePrices.get(booking.service),
        booking.customer_name,
        booking.customer_phone,
        'at_salon',
        booking.source,
        booking.created_at,
      );
      bookingIds.push(Number(lastInsertRowid));
    }

    for (const review of REVIEWS) {
      await tx.run(
        INSERT_REVIEW,
        userIds.get(review.user),
        salonIds.get(review.salon),
        serviceIds.get(review.service),
        staffIds.get(review.staff),
        review.booking === null ? null : bookingIds[review.booking],
        review.rating,
        review.comment,
        review.created_at,
      );
    }

    for (const favorite of FAVORITES) {
      await tx.run(
        INSERT_FAVORITE,
        userIds.get(favorite.user),
        salonIds.get(favorite.salon),
        favorite.created_at,
      );
    }

    for (const notification of NOTIFICATIONS) {
      await tx.run(
        INSERT_NOTIFICATION,
        userIds.get(notification.user),
        notification.title,
        notification.body,
        notification.type,
        notification.read,
        notification.booking === null ? null : bookingIds[notification.booking],
        notification.created_at,
      );
    }

    // One offer per salon and nothing else: the same welcome code a salon signing up
    // today gets if it asks for one. service_ids stays NULL — it is on everything they do.
    // The demo salons are seeded as having asked: the column says so, so the console shows
    // the box ticked and lib/welcome-promotion.js does not offer them a second code.
    const welcome = welcomeWindow(todayISO());
    for (const salon of SALONS) {
      const salonId = salonIds.get(salon.slug);
      await tx.run(
        INSERT_PROMOTION,
        salonId,
        welcomeCode(salonId),
        'discount',
        WELCOME_TITLE,
        WELCOME_DESCRIPTION,
        WELCOME_PERCENT,
        // discount_amount, original_price, sale_price: a percentage says it all...
        null,
        null,
        null,
        // ...and service_ids stays empty, because the offer is on the whole menu.
        null,
        WELCOME_IMAGE,
        welcome.starts_at,
        welcome.ends_at,
      );
    }
  });
}
