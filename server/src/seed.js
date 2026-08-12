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
    created_at: '2026-07-24T09:05:00.000Z',
  },
  // Completed and deliberately left un-reviewed, so there is always a booking the
  // review flow can be exercised against.
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
    created_at: '2026-08-05T02:35:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    title: 'Ưu đãi 20% cho thành viên mới',
    body: 'Nhập mã OAKNEW20 khi đặt lịch để được giảm 20% cho buổi hẹn đầu tiên, áp dụng đến 30/09/2026.',
    type: 'promotion',
    read: 0,
    created_at: '2026-08-01T01:00:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    title: 'Nhắc lịch hẹn sắp tới',
    body: 'Bạn có lịch hẹn tại The Muse Beauty Bar vào ngày 25/08/2026 lúc 15:30. Vui lòng đến sớm 10 phút.',
    type: 'reminder',
    read: 1,
    created_at: '2026-08-09T08:15:00.000Z',
  },
  {
    user: 'khach@oak.vn',
    title: 'Chia sẻ cảm nhận của bạn',
    body: 'Buổi hẹn tại Lala Nail Studio đã hoàn tất. Hãy dành 1 phút đánh giá để giúp salon phục vụ tốt hơn nhé!',
    type: 'review',
    read: 1,
    created_at: '2026-07-18T04:00:00.000Z',
  },
];

const FAVORITES = [
  { user: 'khach@oak.vn', salon: 'lala-nail-studio', created_at: '2026-04-11T03:20:00.000Z' },
  { user: 'khach@oak.vn', salon: 'the-muse-beauty-bar', created_at: '2026-06-29T12:10:00.000Z' },
];

const PROMOTIONS = [
  {
    salon: null,
    code: 'OAKNEW20',
    type: 'discount',
    title: 'Chào mừng thành viên mới - Giảm 20%',
    description: 'Giảm 20% cho buổi hẹn đầu tiên tại bất kỳ salon nào thuộc hệ thống OAK Beauty.',
    discount_percent: 20,
    discount_amount: null,
    image: IMG('img-064bab706d.jpg'),
    starts_at: '2026-08-01',
    ends_at: '2026-09-30',
  },
  {
    salon: null,
    code: 'OAKSUMMER',
    type: 'discount',
    title: 'Ưu đãi hè rực rỡ',
    description: 'Giảm 15% toàn bộ dịch vụ spa và chăm sóc da trong mùa hè này.',
    discount_percent: 15,
    discount_amount: null,
    image: IMG('img-3e0a9ec5ac.jpg'),
    starts_at: '2026-07-15',
    ends_at: '2026-09-15',
  },
  {
    salon: 'lala-nail-studio',
    code: 'LALAGEL100',
    type: 'discount',
    title: 'Giảm 100.000đ cho dịch vụ sơn gel',
    description: 'Áp dụng cho tất cả dịch vụ sơn gel tại Lala Nail Studio, từ thứ Hai đến thứ Năm.',
    discount_percent: null,
    discount_amount: 100000,
    image: IMG('img-93e56c2a14.jpg'),
    starts_at: '2026-08-01',
    ends_at: '2026-09-30',
  },
  {
    salon: 'the-muse-beauty-bar',
    code: 'MUSESPA25',
    type: 'discount',
    title: 'Trị liệu spa giảm 25%',
    description: 'Ưu đãi 25% cho gói trị liệu OAK Signature khi đặt lịch trước 3 ngày.',
    discount_percent: 25,
    discount_amount: null,
    image: IMG('img-83c65fdb78.jpg'),
    starts_at: '2026-08-05',
    ends_at: '2026-10-05',
  },
  {
    salon: 'the-hair-studio',
    code: 'HAIR200K',
    type: 'discount',
    title: 'Phục hồi tóc - Giảm ngay 200.000đ',
    description: 'Giảm 200.000đ cho liệu trình phục hồi Keratin và nhuộm màu thời trang.',
    discount_percent: null,
    discount_amount: 200000,
    image: IMG('img-c5600bb11b.jpg'),
    starts_at: '2026-08-01',
    ends_at: '2026-08-31',
  },
  // Combos price a bundle of services instead of discounting one; `service_names`
  // is resolved to real service ids inside seed().
  {
    salon: 'lala-nail-studio',
    code: 'LALACOMBO480',
    type: 'combo',
    title: 'Combo Sơn gel + Chăm sóc chân',
    description: 'Trọn gói sơn gel cơ bản và chăm sóc chân chuyên sâu trong cùng một buổi hẹn.',
    discount_percent: null,
    discount_amount: null,
    original_price: 600000,
    sale_price: 480000,
    service_names: ['Sơn Gel Cơ Bản', 'Chăm Sóc Chân Chuyên Sâu'],
    image: IMG('img-8f601b429a.jpg'),
    starts_at: '2026-08-01',
    ends_at: '2026-10-31',
  },
  {
    salon: 'lala-nail-studio',
    code: 'LALACOMBO720',
    type: 'combo',
    title: 'Combo Đắp gel + Nail art',
    description: 'Đắp gel nối móng kèm thiết kế nail art cầu kỳ, tiết kiệm 180.000đ.',
    discount_percent: null,
    discount_amount: null,
    original_price: 900000,
    sale_price: 720000,
    service_names: ['Đắp Gel Nối Móng', 'Thiết Kế Nail Art Cầu Kỳ'],
    image: IMG('img-c92fbe9a51.jpg'),
    starts_at: '2026-08-01',
    ends_at: '2026-10-31',
  },
];

const POSTS = [
  {
    author: 'doitac@oak.vn',
    type: 'article',
    title: 'Xu hướng nail Hàn Quốc 2026: Tối giản nhưng tinh tế',
    slug: 'xu-huong-nail-han-quoc-2026',
    excerpt:
      'Năm 2026 đánh dấu sự trở lại của những bộ móng tối giản: form ngắn, tone trong trẻo và điểm nhấn nhỏ đặt đúng chỗ.',
    content:
      'Nếu vài năm trước các mẫu nail Hàn Quốc chuộng đá đính dày và hoạ tiết phủ kín, thì năm 2026 xu hướng đã đảo chiều hoàn toàn. Bảng màu chủ đạo là các tone sữa, hồng phấn và be ấm - những sắc độ gần với màu da, tôn bàn tay mà vẫn giữ được vẻ chỉn chu khi đi làm.\n\nForm móng cũng ngắn lại. Dáng vuông bo tròn và oval ngắn lên ngôi vì vừa dễ sinh hoạt, vừa hạn chế gãy móng. Thay vì phủ kín hoạ tiết, kỹ thuật viên chỉ đặt một điểm nhấn duy nhất: một đường kẻ mảnh ở chân móng, một chấm ánh kim, hoặc lớp tráng gương mờ trên một ngón duy nhất.\n\nĐiều quan trọng nhất của xu hướng này lại nằm ở phần ít ai để ý: nền móng. Bộ móng tối giản chỉ đẹp khi da quanh móng sạch, form đều và bề mặt gel phẳng mịn. Vì vậy hãy ưu tiên salon làm kỹ khâu cắt da và dũa form, thay vì chỉ nhìn vào bộ ảnh mẫu.',
    video_url: null,
    image: IMG('img-c92fbe9a51.jpg'),
    created_at: '2026-07-02T02:00:00.000Z',
  },
  {
    author: 'quochuy@oak.vn',
    type: 'article',
    title: 'Chăm sóc da mùa mưa Sài Gòn: 5 bước không thể bỏ qua',
    slug: 'cham-soc-da-mua-mua-sai-gon',
    excerpt:
      'Độ ẩm cao, mưa bất chợt và máy lạnh cả ngày khiến da vừa bí vừa mất nước. Đây là quy trình tối giản mà hiệu quả cho mùa mưa.',
    content:
      'Mùa mưa ở TP.HCM có một nghịch lý: không khí ngoài trời ẩm tới mức bết dính, nhưng da lại thường xuyên mất nước vì ngồi phòng máy lạnh gần như cả ngày. Hệ quả là da vừa bóng dầu ở vùng chữ T, vừa khô căng ở hai bên má.\n\nQuy trình phù hợp nhất lúc này là quy trình tối giản. Làm sạch bằng sữa rửa mặt dịu nhẹ, độ pH quanh 5.5, ngày hai lần và không chà xát mạnh. Sau đó cấp ẩm bằng lớp mỏng dạng gel thay vì kem đặc, để da không bị bí trong thời tiết ẩm.\n\nĐừng bỏ kem chống nắng chỉ vì trời âm u - tia UVA vẫn xuyên qua mây và kính cửa sổ. Cuối cùng, hạn chế thử sản phẩm mới liên tục trong giai đoạn này; da đang mất cân bằng rất dễ phản ứng, và bạn sẽ không biết thủ phạm là sản phẩm nào. Nếu tình trạng mụn kéo dài quá ba tuần, hãy đến chuyên viên da liễu để được soi da và xây dựng phác đồ riêng.',
    video_url: null,
    image: IMG('img-5b691ffccb.jpg'),
    created_at: '2026-07-15T03:30:00.000Z',
  },
  {
    author: 'minhchau@oak.vn',
    type: 'article',
    title: 'Phục hồi tóc hư tổn sau nhuộm: Lộ trình 8 tuần',
    slug: 'phuc-hoi-toc-hu-ton-sau-nhuom',
    excerpt:
      'Tóc khô xơ, chẻ ngọn và mất độ đàn hồi sau khi tẩy nhuộm hoàn toàn có thể cải thiện, nhưng cần đúng thứ tự và đủ kiên nhẫn.',
    content:
      'Sau khi tẩy hoặc nhuộm màu sáng, lớp biểu bì tóc bị nâng lên và một phần keratin bên trong bị rửa trôi. Đó là lý do tóc trở nên khô, rối và mất độ đàn hồi. Tin tốt là cấu trúc này có thể được bù đắp, nhưng không thể xong trong một buổi hấp dầu.\n\nHai tuần đầu tiên nên tập trung vào việc ngưng gây thêm tổn thương: hạ nhiệt độ máy sấy, tạm dừng máy duỗi và ép, gội bằng dầu gội không sulfate. Từ tuần thứ ba, bổ sung liệu trình phục hồi tại salon mỗi 7-10 ngày để nạp lại keratin và lipid cho sợi tóc.\n\nTừ tuần thứ sáu trở đi, khi tóc đã bớt xốp, mới nên tính đến việc chỉnh lại màu hoặc cắt tỉa phần ngọn chẻ. Song song đó, hãy duy trì mặt nạ dưỡng tại nhà một đến hai lần mỗi tuần. Sau 8 tuần, phần lớn khách hàng lấy lại được độ bóng và độ đàn hồi rõ rệt - miễn là không quay lại tẩy tóc giữa chừng.',
    video_url: null,
    image: IMG('img-c5600bb11b.jpg'),
    created_at: '2026-07-24T07:15:00.000Z',
  },
  {
    author: 'quochuy@oak.vn',
    type: 'article',
    title: 'Chọn spa trị liệu: 6 tiêu chí người Sài Gòn nên biết',
    slug: 'chon-spa-tri-lieu-6-tieu-chi',
    excerpt:
      'Giữa hàng trăm lựa chọn, đâu là dấu hiệu của một spa trị liệu thực sự chỉn chu? Sáu tiêu chí dưới đây sẽ giúp bạn sàng lọc nhanh.',
    content:
      'Tiêu chí đầu tiên luôn là vệ sinh. Khăn, ga giường và dụng cụ phải được thay mới cho từng khách, và bạn hoàn toàn có quyền hỏi về quy trình tiệt trùng. Thứ hai là sự minh bạch: bảng giá rõ ràng, không phát sinh chi phí giữa buổi trị liệu.\n\nThứ ba, hãy chú ý đến bước tư vấn trước liệu trình. Một spa nghiêm túc sẽ hỏi về tình trạng sức khoẻ, vùng đau mỏi và mức lực massage bạn mong muốn, thay vì áp dụng một quy trình giống nhau cho mọi khách. Thứ tư là chuyên môn của kỹ thuật viên - chứng chỉ đào tạo và số năm kinh nghiệm nên được công khai.\n\nHai tiêu chí cuối cùng thiên về trải nghiệm: không gian cần đủ yên tĩnh và riêng tư, còn chính sách đặt lịch phải linh hoạt, cho phép dời hoặc huỷ trong khoảng thời gian hợp lý. Khi cả sáu yếu tố này đều đạt, khả năng cao bạn đã tìm được nơi đáng để quay lại lâu dài.',
    video_url: null,
    image: IMG('img-432c4666c7.jpg'),
    created_at: '2026-08-03T04:45:00.000Z',
  },
  {
    author: 'doitac@oak.vn',
    type: 'video',
    title: 'Video: Quy trình chăm sóc da cơ bản cho người mới bắt đầu',
    slug: 'video-quy-trinh-cham-soc-da-co-ban',
    excerpt:
      'Chỉ với vài bước nền tảng, người mới hoàn toàn có thể xây dựng một chu trình chăm sóc da gọn nhẹ mà vẫn hiệu quả.',
    content:
      'Video hướng dẫn trọn vẹn các bước cơ bản của một chu trình chăm sóc da: làm sạch, cân bằng, dưỡng ẩm và chống nắng. Đây là bộ khung tối thiểu mà bất kỳ loại da nào cũng cần trước khi nghĩ tới các sản phẩm đặc trị.\n\nĐiểm mấu chốt nằm ở sự đều đặn chứ không phải số lượng sản phẩm. Hãy duy trì bộ bốn bước này ít nhất bốn tuần trước khi bổ sung thêm bất kỳ hoạt chất mới nào, để da có thời gian thích nghi và bạn dễ nhận ra sản phẩm nào thực sự phù hợp.',
    video_url: 'https://www.youtube.com/embed/5JJ-cW4vYy0',
    image: IMG('img-5b691ffccb.jpg'),
    created_at: '2026-06-20T06:00:00.000Z',
  },
  {
    author: 'quochuy@oak.vn',
    type: 'video',
    title: 'Video: Routine chăm sóc da phù hợp cho mọi loại da',
    slug: 'video-routine-cham-soc-da-moi-loai-da',
    excerpt:
      'Da dầu, da khô hay da hỗn hợp đều dùng chung một bộ khung routine - khác biệt nằm ở kết cấu sản phẩm bạn chọn.',
    content:
      'Chuyên viên của Glow Skincare Clinic phân tích cách điều chỉnh một chu trình chăm sóc da chuẩn cho từng loại da, từ da dầu mụn đến da khô nhạy cảm. Bộ khung các bước gần như giống nhau, thứ thay đổi là kết cấu và nồng độ hoạt chất.\n\nLưu ý quan trọng: hãy thử sản phẩm mới trên một vùng da nhỏ trước khi dùng cho toàn mặt, và chỉ thêm một hoạt chất mới mỗi lần. Nếu da có dấu hiệu kích ứng kéo dài, hãy dừng lại và tới gặp chuyên viên da liễu thay vì tự đổi sản phẩm liên tục.',
    video_url: 'https://www.youtube.com/embed/RiFhMDCnCM8',
    image: IMG('img-bdddd609ce.jpg'),
    created_at: '2026-08-06T09:30:00.000Z',
  },
];

const POST_COMMENTS = [
  {
    post: 'xu-huong-nail-han-quoc-2026',
    user: 'khach@oak.vn',
    content:
      'Bài viết đúng gu mình quá. Mình cũng đang chuyển sang form ngắn tone sữa, đi làm nhìn gọn gàng hẳn.',
    created_at: '2026-07-03T08:12:00.000Z',
  },
  {
    post: 'xu-huong-nail-han-quoc-2026',
    user: 'hoangyen@oak.vn',
    content: 'Cho mình hỏi tone be ấm có hợp với da ngăm không ạ? Mình sợ bị nhợt tay.',
    created_at: '2026-07-05T01:47:00.000Z',
  },
  {
    post: 'cham-soc-da-mua-mua-sai-gon',
    user: 'baolong@oak.vn',
    content:
      'Mình bỏ kem chống nắng mấy hôm trời mưa thật, đọc xong mới biết là sai. Cảm ơn bài viết nhé!',
    created_at: '2026-07-17T10:05:00.000Z',
  },
  {
    post: 'phuc-hoi-toc-hu-ton-sau-nhuom',
    user: 'khach@oak.vn',
    content:
      'Mình vừa tẩy tóc tháng trước, đang làm theo lộ trình này tới tuần thứ tư và thấy tóc mềm hơn rõ.',
    created_at: '2026-08-02T03:33:00.000Z',
  },
  {
    post: 'video-routine-cham-soc-da-moi-loai-da',
    user: 'hoangyen@oak.vn',
    content: 'Routine gọn mà dễ theo, mình duy trì hơn một tháng rồi và da đỡ khô hẳn.',
    created_at: '2026-08-08T13:20:00.000Z',
  },
];

const INSERT_USER =
  'INSERT INTO users (name, email, phone, password_hash, role, avatar, city, district, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_SALON =
  'INSERT INTO salons (owner_id, name, slug, description, address, district, city, phone, image, open_time, close_time, lat, lng, verified, featured, flagship, tags, amenities, tour_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)';
const INSERT_SALON_PHOTO =
  'INSERT INTO salon_photos (salon_id, image, caption, sort) VALUES (?, ?, ?, ?)';
const INSERT_SERVICE =
  'INSERT INTO services (salon_id, category, subcategory, name, description, price, duration_min, image, featured, is_package, price_is_from, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';
const INSERT_STAFF =
  'INSERT INTO staff (salon_id, name, title, specialty, bio, image, rating, years_experience, portfolio, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';
const INSERT_STAFF_SCHEDULE =
  'INSERT INTO staff_schedule (staff_id, weekday, "start", "end", is_off) VALUES (?, ?, ?, ?, ?)';
const INSERT_STAFF_SERVICE =
  'INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)';
const INSERT_BOOKING =
  'INSERT INTO bookings (user_id, salon_id, service_id, staff_id, code, date, time, status, note, total_price, customer_name, customer_phone, payment_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_REVIEW =
  'INSERT INTO reviews (user_id, salon_id, service_id, staff_id, booking_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_FAVORITE =
  'INSERT INTO favorites (user_id, salon_id, created_at) VALUES (?, ?, ?)';
const INSERT_NOTIFICATION =
  'INSERT INTO notifications (user_id, title, body, type, "read", created_at) VALUES (?, ?, ?, ?, ?, ?)';
const INSERT_PROMOTION =
  'INSERT INTO promotions (salon_id, code, type, title, description, discount_percent, discount_amount, original_price, sale_price, service_ids, image, starts_at, ends_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';
const INSERT_POST =
  'INSERT INTO posts (author_id, type, title, slug, excerpt, content, video_url, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_COMMENT =
  'INSERT INTO post_comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)';

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
    for (const service of SERVICES) {
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
        notification.created_at,
      );
    }

    for (const promotion of PROMOTIONS) {
      await tx.run(
        INSERT_PROMOTION,
        promotion.salon === null ? null : salonIds.get(promotion.salon),
        promotion.code,
        promotion.type,
        promotion.title,
        promotion.description,
        promotion.discount_percent,
        promotion.discount_amount,
        promotion.original_price ?? null,
        promotion.sale_price ?? null,
        promotion.service_names
          ? JSON.stringify(promotion.service_names.map((name) => serviceIds.get(name)))
          : null,
        promotion.image,
        promotion.starts_at,
        promotion.ends_at,
      );
    }

    const postIds = new Map();
    for (const post of POSTS) {
      const { lastInsertRowid } = await tx.run(
        INSERT_POST,
        userIds.get(post.author),
        post.type,
        post.title,
        post.slug,
        post.excerpt,
        post.content,
        post.video_url,
        post.image,
        post.created_at,
      );
      postIds.set(post.slug, Number(lastInsertRowid));
    }

    for (const comment of POST_COMMENTS) {
      await tx.run(
        INSERT_COMMENT,
        postIds.get(comment.post),
        userIds.get(comment.user),
        comment.content,
        comment.created_at,
      );
    }
  });
}
