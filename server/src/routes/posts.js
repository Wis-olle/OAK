// Content feed: articles and videos plus their comments.
import express from 'express';
import { db } from '../db.js';
import { parsePagination } from '../lib/query.js';
import { SocialSourceError, validateSocialSource } from '../lib/social-source.js';
import { slugify } from '../lib/text.js';
import { isSafeMediaUrl } from '../lib/urls.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

const DEFAULT_LIMIT = 9;
const TYPES = ['article', 'video'];
// The five service categories a post may be filed under, so the blog can point at the
// matching salons. A post without one is still valid — the field is optional.
const CATEGORIES = ['nail', 'hair', 'skincare', 'spa', 'eyelash'];

// Only an https YouTube embed URL may reach the blog's <iframe :src>. Any other value
// (javascript:, data:, an arbitrary site) would execute or frame attacker content for
// every visitor, so it is rejected before the post is stored.
const YOUTUBE_EMBED = /^https:\/\/www\.youtube\.com\/embed\/[\w-]+(\?[\w=&-]*)?$/;

const selectPostBySlug = db.prepare(`
  SELECT p.id, p.slug, p.type, p.title, p.excerpt, p.content, p.video_url, p.image, p.created_at,
         p.source_platform, p.source_url, p.category,
         u.name AS author_name, u.avatar AS author_avatar,
         s.id AS salon_id, s.name AS salon_name, s.slug AS salon_slug
  FROM posts p
  LEFT JOIN users u ON u.id = p.author_id
  LEFT JOIN salons s ON s.id = p.salon_id
  WHERE p.slug = ?
`);

const selectComments = db.prepare(`
  SELECT c.id, c.content, c.created_at, u.name AS user_name, u.avatar AS user_avatar
  FROM post_comments c
  LEFT JOIN users u ON u.id = c.user_id
  WHERE c.post_id = ?
  ORDER BY c.created_at, c.id
`);

const selectPostExists = db.prepare('SELECT 1 FROM posts WHERE id = ?');
const selectSlugTaken = db.prepare('SELECT 1 FROM posts WHERE slug = ?');
const selectOwnedSalon = db.prepare(
  'SELECT id, name, slug FROM salons WHERE owner_id = ? ORDER BY id LIMIT 1',
);
const selectSourceTaken = db.prepare(
  'SELECT 1 FROM posts WHERE source_url = ?',
);
const selectOtherSourceTaken = db.prepare('SELECT 1 FROM posts WHERE source_url = ? AND id != ?');
const selectOwnedPost = db.prepare('SELECT * FROM posts WHERE id = ? AND author_id = ?');

const insertPost = db.prepare(
  'INSERT INTO posts (author_id, salon_id, type, title, slug, excerpt, content, video_url, image, source_platform, source_url, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const insertComment = db.prepare(
  'INSERT INTO post_comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
);

/** Append -2, -3, ... until the slug is free, like uniqueSalonSlug in routes/auth.js. */
async function uniquePostSlug(title) {
  const base = slugify(title) || 'bai-viet';
  let slug = base;
  let suffix = 1;
  while (await selectSlugTaken.get(slug)) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
}

/** A non-empty trimmed string from the request body, or null. */
function textField(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function requirePostId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
  }
  return id;
}

function validatePostFields(fields) {
  if (!TYPES.includes(fields.type)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Loại bài viết phải là article hoặc video.');
  }
  const title = textField(fields.title);
  if (!title) {
    throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập tiêu đề bài viết.');
  }
  const content = textField(fields.content);
  if (fields.type === 'article' && !content) {
    throw httpError(400, 'VALIDATION_ERROR', 'Bài viết dạng chữ cần có nội dung.');
  }
  const videoUrl = textField(fields.video_url);
  if (fields.type === 'video' && !videoUrl) {
    throw httpError(400, 'VALIDATION_ERROR', 'Bài viết dạng video cần có đường dẫn video.');
  }
  if (videoUrl && !YOUTUBE_EMBED.test(videoUrl)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn video phải là liên kết nhúng YouTube hợp lệ (https://www.youtube.com/embed/...).');
  }
  const image = textField(fields.image);
  if (!isSafeMediaUrl(image)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh không hợp lệ.');
  }
  const category = textField(fields.category);
  if (category && !CATEGORIES.includes(category)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Chủ đề bài viết không hợp lệ.');
  }
  return {
    type: fields.type, title, excerpt: textField(fields.excerpt), content,
    video_url: videoUrl, image, category,
  };
}

function validatedSocialSource(sourceUrl, claimedPlatform) {
  try {
    return validateSocialSource(sourceUrl, claimedPlatform);
  } catch (error) {
    if (error instanceof SocialSourceError) {
      throw httpError(400, 'VALIDATION_ERROR', error.message);
    }
    throw error;
  }
}

function toComment(row) {
  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    user: { name: row.user_name, avatar: row.user_avatar },
  };
}

function sourceOf(row) {
  return row.source_platform && row.source_url
    ? { platform: row.source_platform, url: row.source_url }
    : null;
}

function salonOf(row) {
  return row.salon_id
    ? { id: row.salon_id, name: row.salon_name, slug: row.salon_slug }
    : null;
}

/** The full post shape, shared by the detail route and the create response. */
async function loadPost(slug) {
  const row = await selectPostBySlug.get(slug);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    title: row.title,
    excerpt: row.excerpt,
    content: row.content,
    video_url: row.video_url,
    image: row.image,
    category: row.category,
    created_at: row.created_at,
    author: { name: row.author_name, avatar: row.author_avatar },
    source: sourceOf(row),
    salon: salonOf(row),
    comments: (await selectComments.all(row.id)).map(toComment),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_LIMIT);
    const conditions = [];
    const params = [];

    if (TYPES.includes(req.query.type)) {
      conditions.push('p.type = ?');
      params.push(req.query.type);
    }

    if (CATEGORIES.includes(req.query.category)) {
      conditions.push('p.category = ?');
      params.push(req.query.category);
    }

    // Posts have no tags column, so a tag is matched as free text over title and excerpt.
    const tag = textField(req.query.tag);
    if (tag) {
      conditions.push('(p.title ILIKE ? OR p.excerpt ILIKE ?)');
      params.push(`%${tag}%`, `%${tag}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { total } = await db
      .prepare(`SELECT COUNT(*) AS total FROM posts p ${where}`)
      .get(...params);
    const rows = await db
      .prepare(
        `SELECT p.id, p.slug, p.type, p.title, p.excerpt, p.image, p.video_url, p.created_at,
                p.source_platform, p.source_url, p.category,
                u.name AS author_name, u.avatar AS author_avatar,
                s.id AS salon_id, s.name AS salon_name, s.slug AS salon_slug,
                (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count
         FROM posts p
         LEFT JOIN users u ON u.id = p.author_id
         LEFT JOIN salons s ON s.id = p.salon_id
         ${where}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        type: row.type,
        title: row.title,
        excerpt: row.excerpt,
        image: row.image,
        video_url: row.video_url,
        category: row.category,
        created_at: row.created_at,
        author: { name: row.author_name, avatar: row.author_avatar },
        source: sourceOf(row),
        salon: salonOf(row),
        comment_count: row.comment_count,
      })),
      meta: { page, limit, total },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_LIMIT);
    const params = [req.user.id];
    const conditions = ['p.author_id = ?'];
    if (req.query.type !== undefined) {
      if (!TYPES.includes(req.query.type)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Loại bài viết phải là article hoặc video.');
      }
      conditions.push('p.type = ?');
      params.push(req.query.type);
    }
    if (req.query.category !== undefined) {
      if (!CATEGORIES.includes(req.query.category)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Chủ đề bài viết không hợp lệ.');
      }
      conditions.push('p.category = ?');
      params.push(req.query.category);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const { total } = await db.prepare(`SELECT COUNT(*) AS total FROM posts p ${where}`).get(...params);
    const rows = await db.prepare(`
      SELECT p.*, u.name AS author_name, u.avatar AS author_avatar,
             s.name AS salon_name, s.slug AS salon_slug,
             (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count
      FROM posts p
      LEFT JOIN users u ON u.id = p.author_id
      LEFT JOIN salons s ON s.id = p.salon_id
      ${where}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        type: row.type,
        title: row.title,
        excerpt: row.excerpt,
        content: row.content,
        video_url: row.video_url,
        image: row.image,
        category: row.category,
        created_at: row.created_at,
        author: { name: row.author_name, avatar: row.author_avatar },
        source: sourceOf(row),
        salon: salonOf(row),
        can_manage: true,
        comment_count: row.comment_count,
      })),
      meta: { page, limit, total },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      type,
      title,
      content,
      video_url: videoUrl,
      excerpt,
      image,
      category,
      source_platform: sourcePlatform,
      source_url: sourceUrl,
    } = req.body ?? {};

    const clean = validatePostFields({ type, title, content, video_url: videoUrl, excerpt, image, category });

    const hasSocialSource = sourcePlatform !== undefined || sourceUrl !== undefined;
    let source = null;
    const salon = req.user.role === 'partner' ? await selectOwnedSalon.get(req.user.id) : null;
    if (req.user.role === 'partner' && !salon) {
      throw httpError(403, 'FORBIDDEN', 'Tài khoản đối tác chưa có salon để đăng bài.');
    }
    if (hasSocialSource) {
      if (req.user.role !== 'partner') {
        throw httpError(403, 'FORBIDDEN', 'Chức năng này chỉ dành cho tài khoản đối tác.');
      }
      source = validatedSocialSource(sourceUrl, sourcePlatform);
      if (await selectSourceTaken.get(source.url)) {
        throw httpError(409, 'DUPLICATE_SOURCE', 'Bài viết từ đường dẫn này đã có trên Blog OAK.');
      }
    }

    const slug = await uniquePostSlug(clean.title);
    try {
      await insertPost.run(
        req.user.id,
        salon?.id ?? null,
        type,
        clean.title,
        slug,
        clean.excerpt,
        clean.content,
        clean.video_url,
        clean.image,
        source?.platform ?? null,
        source?.url ?? null,
        clean.category,
        new Date().toISOString(),
      );
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'idx_posts_source_url') {
        throw httpError(409, 'DUPLICATE_SOURCE', 'Bài viết từ đường dẫn này đã có trên Blog OAK.');
      }
      throw error;
    }

    res.json({ success: true, data: await loadPost(slug) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = requirePostId(req.params.id);
    const current = await selectOwnedPost.get(id, req.user.id);
    if (!current) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
    }
    const body = req.body ?? {};
    const allowed = ['title', 'excerpt', 'content', 'video_url', 'image', 'category', 'source_url', 'source_platform'];
    for (const key of ['id', 'author_id', 'salon_id', 'slug', 'type']) {
      if (Object.hasOwn(body, key)) {
        throw httpError(400, 'VALIDATION_ERROR', `Không thể thay đổi ${key}.`);
      }
    }
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      throw httpError(400, 'VALIDATION_ERROR', `Trường không được hỗ trợ: ${unknown[0]}.`);
    }
    if (!allowed.some((key) => Object.hasOwn(body, key))) {
      throw httpError(400, 'VALIDATION_ERROR', 'Không có thông tin nào để cập nhật.');
    }
    const touchesSocialSource = Object.hasOwn(body, 'source_url') || Object.hasOwn(body, 'source_platform');
    if (touchesSocialSource && req.user.role !== 'partner') {
      throw httpError(403, 'FORBIDDEN', 'Chức năng này chỉ dành cho tài khoản đối tác.');
    }
    if (current.type === 'article' && Object.hasOwn(body, 'video_url')) {
      throw httpError(400, 'VALIDATION_ERROR', 'Bài viết dạng chữ không nhận đường dẫn video.');
    }
    if (current.type === 'video' && Object.hasOwn(body, 'content')) {
      throw httpError(400, 'VALIDATION_ERROR', 'Bài viết dạng video không nhận nội dung bài viết.');
    }
    const merged = validatePostFields({
      type: current.type,
      title: Object.hasOwn(body, 'title') ? body.title : current.title,
      excerpt: Object.hasOwn(body, 'excerpt') ? body.excerpt : current.excerpt,
      content: Object.hasOwn(body, 'content') ? body.content : current.content,
      video_url: Object.hasOwn(body, 'video_url') ? body.video_url : current.video_url,
      image: Object.hasOwn(body, 'image') ? body.image : current.image,
      category: Object.hasOwn(body, 'category') ? body.category : current.category,
    });

    let sourcePlatform = current.source_platform;
    let sourceUrl = current.source_url;
    let salonId = current.salon_id;
    if (Object.hasOwn(body, 'source_url')) {
      if (body.source_url === null || (typeof body.source_url === 'string' && body.source_url.trim() === '')) {
        const claimClears = body.source_platform === null
          || (typeof body.source_platform === 'string' && body.source_platform.trim() === '');
        if (Object.hasOwn(body, 'source_platform') && !claimClears) {
          throw httpError(400, 'VALIDATION_ERROR', 'Không được khai báo nền tảng khi xoá link nguồn.');
        }
        sourcePlatform = null;
        sourceUrl = null;
      } else {
        const source = validatedSocialSource(body.source_url, body.source_platform);
        if (await selectOtherSourceTaken.get(source.url, id)) {
          throw httpError(409, 'DUPLICATE_SOURCE', 'Bài viết từ đường dẫn này đã có trên Blog OAK.');
        }
        if (salonId === null) {
          const salon = await selectOwnedSalon.get(req.user.id);
          if (!salon) {
            throw httpError(403, 'FORBIDDEN', 'Tài khoản đối tác chưa có salon để gắn nguồn bài viết.');
          }
          salonId = salon.id;
        }
        sourcePlatform = source.platform;
        sourceUrl = source.url;
      }
    } else if (Object.hasOwn(body, 'source_platform')) {
      throw httpError(400, 'VALIDATION_ERROR', 'Cần gửi source_url khi thay đổi nền tảng nguồn.');
    }

    try {
      const result = await db.prepare(`UPDATE posts SET title = ?, excerpt = ?, content = ?, video_url = ?, image = ?,
        category = ?, salon_id = ?, source_platform = ?, source_url = ?
        WHERE id = ? AND author_id = ?`).run(
        merged.title,
        merged.excerpt,
        merged.content,
        merged.video_url,
        merged.image,
        merged.category,
        salonId,
        sourcePlatform,
        sourceUrl,
        id,
        req.user.id,
      );
      if (result.changes === 0) {
        throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
      }
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'idx_posts_source_url') {
        throw httpError(409, 'DUPLICATE_SOURCE', 'Bài viết từ đường dẫn này đã có trên Blog OAK.');
      }
      throw error;
    }
    res.json({ success: true, data: await loadPost(current.slug) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = requirePostId(req.params.id);
    await db.withTransaction(async (tx) => {
      const owned = await tx.get('SELECT 1 FROM posts WHERE id = ? AND author_id = ?', id, req.user.id);
      if (!owned) {
        throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
      }
      await tx.run('DELETE FROM post_comments WHERE post_id = ?', id);
      const deleted = await tx.run('DELETE FROM posts WHERE id = ? AND author_id = ?', id, req.user.id);
      if (deleted.changes !== 1) {
        // Ownership may change between the scoped read and delete. Throwing inside the
        // transaction rolls the comment deletion back along with the failed post delete.
        throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
      }
    });
    res.json({ success: true, data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(postId) || !(await selectPostExists.get(postId))) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
    }

    const content = textField(req.body?.content);
    if (!content) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập nội dung bình luận.');
    }

    const createdAt = new Date().toISOString();
    const { lastInsertRowid } = await insertComment.run(postId, req.user.id, content, createdAt);

    res.json({
      success: true,
      data: toComment({
        id: Number(lastInsertRowid),
        content,
        created_at: createdAt,
        user_name: req.user.name,
        user_avatar: req.user.avatar,
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const post = await loadPost(req.params.slug);
    if (!post) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
    }
    res.json({ success: true, data: post });
  } catch (error) {
    next(error);
  }
});

export default router;
