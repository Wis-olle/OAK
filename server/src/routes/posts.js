// Content feed: articles and videos plus their comments.
import express from 'express';
import { db } from '../db.js';
import { parsePagination } from '../lib/query.js';
import { slugify } from '../lib/text.js';
import { isSafeMediaUrl } from '../lib/urls.js';
import { httpError, requireAuth } from '../middleware/auth.js';

const router = express.Router();

const DEFAULT_LIMIT = 9;
const TYPES = ['article', 'video'];

// Only an https YouTube embed URL may reach the blog's <iframe :src>. Any other value
// (javascript:, data:, an arbitrary site) would execute or frame attacker content for
// every visitor, so it is rejected before the post is stored.
const YOUTUBE_EMBED = /^https:\/\/www\.youtube\.com\/embed\/[\w-]+(\?[\w=&-]*)?$/;

const selectPostBySlug = db.prepare(`
  SELECT p.id, p.slug, p.type, p.title, p.excerpt, p.content, p.video_url, p.image, p.created_at,
         u.name AS author_name, u.avatar AS author_avatar
  FROM posts p
  LEFT JOIN users u ON u.id = p.author_id
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

const insertPost = db.prepare(
  'INSERT INTO posts (author_id, type, title, slug, excerpt, content, video_url, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const insertComment = db.prepare(
  'INSERT INTO post_comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
);

/** Append -2, -3, ... until the slug is free, like uniqueSalonSlug in routes/auth.js. */
function uniquePostSlug(title) {
  const base = slugify(title) || 'bai-viet';
  let slug = base;
  let suffix = 1;
  while (selectSlugTaken.get(slug)) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
}

/** A non-empty trimmed string from the request body, or null. */
function textField(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function toComment(row) {
  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    user: { name: row.user_name, avatar: row.user_avatar },
  };
}

/** The full post shape, shared by the detail route and the create response. */
function loadPost(slug) {
  const row = selectPostBySlug.get(slug);
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
    created_at: row.created_at,
    author: { name: row.author_name, avatar: row.author_avatar },
    comments: selectComments.all(row.id).map(toComment),
  };
}

router.get('/', (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, DEFAULT_LIMIT);
    const conditions = [];
    const params = [];

    if (TYPES.includes(req.query.type)) {
      conditions.push('p.type = ?');
      params.push(req.query.type);
    }

    // Posts have no tags column, so a tag is matched as free text over title and excerpt.
    const tag = textField(req.query.tag);
    if (tag) {
      conditions.push('(p.title LIKE ? OR p.excerpt LIKE ?)');
      params.push(`%${tag}%`, `%${tag}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM posts p ${where}`).get(...params);
    const rows = db
      .prepare(
        `SELECT p.id, p.slug, p.type, p.title, p.excerpt, p.image, p.video_url, p.created_at,
                u.name AS author_name, u.avatar AS author_avatar,
                (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count
         FROM posts p
         LEFT JOIN users u ON u.id = p.author_id
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
        created_at: row.created_at,
        author: { name: row.author_name, avatar: row.author_avatar },
        comment_count: row.comment_count,
      })),
      meta: { page, limit, total },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, (req, res, next) => {
  try {
    const { type, title, content, video_url: videoUrl, excerpt, image } = req.body ?? {};

    if (!TYPES.includes(type)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Loại bài viết phải là article hoặc video.');
    }
    const cleanTitle = textField(title);
    if (!cleanTitle) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập tiêu đề bài viết.');
    }
    const cleanContent = textField(content);
    if (type === 'article' && !cleanContent) {
      throw httpError(400, 'VALIDATION_ERROR', 'Bài viết dạng chữ cần có nội dung.');
    }
    const cleanVideoUrl = textField(videoUrl);
    if (type === 'video' && !cleanVideoUrl) {
      throw httpError(400, 'VALIDATION_ERROR', 'Bài viết dạng video cần có đường dẫn video.');
    }
    if (cleanVideoUrl && !YOUTUBE_EMBED.test(cleanVideoUrl)) {
      throw httpError(
        400,
        'VALIDATION_ERROR',
        'Đường dẫn video phải là liên kết nhúng YouTube hợp lệ (https://www.youtube.com/embed/...).',
      );
    }
    const cleanImage = textField(image);
    if (!isSafeMediaUrl(cleanImage)) {
      throw httpError(400, 'VALIDATION_ERROR', 'Đường dẫn ảnh không hợp lệ.');
    }

    const slug = uniquePostSlug(cleanTitle);
    insertPost.run(
      req.user.id,
      type,
      cleanTitle,
      slug,
      textField(excerpt),
      cleanContent,
      cleanVideoUrl,
      cleanImage,
      new Date().toISOString(),
    );

    res.json({ success: true, data: loadPost(slug) });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/comments', requireAuth, (req, res, next) => {
  try {
    const postId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(postId) || !selectPostExists.get(postId)) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
    }

    const content = textField(req.body?.content);
    if (!content) {
      throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập nội dung bình luận.');
    }

    const createdAt = new Date().toISOString();
    const { lastInsertRowid } = insertComment.run(postId, req.user.id, content, createdAt);

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

router.get('/:slug', (req, res, next) => {
  try {
    const post = loadPost(req.params.slug);
    if (!post) {
      throw httpError(404, 'NOT_FOUND', 'Không tìm thấy bài viết này.');
    }
    res.json({ success: true, data: post });
  } catch (error) {
    next(error);
  }
});

export default router;
