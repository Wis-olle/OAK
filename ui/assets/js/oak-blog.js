const OAK_BLOG_PAGE_SIZE = 9;
const OAK_DEFAULT_AVATAR = 'assets/images/img-b79c0642dd.jpg';

/* The five service categories a post may be filed under, labelled the way the rest of the
   site labels them, so one dictionary entry covers both. */
const OAK_POST_CATEGORIES = [
    { value: 'nail', label: 'Nail' },
    { value: 'hair', label: 'Tóc' },
    { value: 'skincare', label: 'Chăm sóc da' },
    { value: 'spa', label: 'Spa & Massage' },
    { value: 'eyelash', label: 'Nối mi' },
];

const OAK_SOCIAL_HOSTS = {
    'facebook.com': 'facebook', 'www.facebook.com': 'facebook',
    'm.facebook.com': 'facebook', 'mobile.facebook.com': 'facebook',
    'instagram.com': 'instagram', 'www.instagram.com': 'instagram',
    'm.instagram.com': 'instagram',
    'tiktok.com': 'tiktok', 'www.tiktok.com': 'tiktok', 'm.tiktok.com': 'tiktok',
    'vm.tiktok.com': 'tiktok', 'vt.tiktok.com': 'tiktok',
    'youtube.com': 'youtube', 'www.youtube.com': 'youtube',
    'm.youtube.com': 'youtube', 'youtu.be': 'youtube',
    'zalo.me': 'zalo', 'www.zalo.me': 'zalo',
    'zalo.com': 'zalo', 'www.zalo.com': 'zalo',
};

function oakYoutubeVideoId(parsed) {
    if (parsed.hostname === 'youtu.be') {
        return parsed.pathname.split('/').filter(Boolean)[0] || null;
    }
    if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v');
    }
    const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)\/?$/);
    return match ? match[1] : null;
}

function oakIsSocialResource(parsed, platform) {
    if (platform === 'facebook') {
        if (/^\/(?:reel|reels)\/[\w.-]+\/?$/.test(parsed.pathname) ||
            /^\/[\w.-]+\/(?:posts|videos)\/[\w.-]+\/?$/.test(parsed.pathname)) {
            return true;
        }
        if (parsed.pathname === '/watch' || parsed.pathname === '/watch/') {
            return /^[\w.-]+$/.test(parsed.searchParams.get('v') || '');
        }
        const required = {
            '/story.php': 'story_fbid',
            '/permalink.php': 'story_fbid',
            '/photo.php': 'fbid',
        }[parsed.pathname];
        return required ? /^[\w.-]+$/.test(parsed.searchParams.get(required) || '') : false;
    }
    if (platform === 'instagram') {
        return /^\/(?:p|reel|reels|tv)\/[\w.-]+\/?$/.test(parsed.pathname);
    }
    if (platform === 'youtube') {
        return /^[\w-]+$/.test(oakYoutubeVideoId(parsed) || '');
    }
    if (platform === 'tiktok') {
        if (parsed.hostname === 'vm.tiktok.com' || parsed.hostname === 'vt.tiktok.com') {
            return /^\/[\w-]{4,}\/?$/.test(parsed.pathname);
        }
        return /^\/@[^/]+\/(?:video|photo)\/[\w.-]+\/?$/.test(parsed.pathname);
    }
    return platform === 'zalo' &&
        /^\/(?:s|article|post|posts|video|photo)\/[\w.-]+(?:\/[^?#]*)?$/.test(parsed.pathname);
}

function oakParsedSocialUrl(url) {
    let parsed;
    try {
        parsed = new URL((url || '').trim());
    } catch (error) {
        return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
        return null;
    }
    const platform = OAK_SOCIAL_HOSTS[parsed.hostname] || null;
    return platform && oakIsSocialResource(parsed, platform) ? { parsed, platform } : null;
}

function oakDetectSocialPlatform(url) {
    const source = oakParsedSocialUrl(url);
    return source ? source.platform : null;
}

function oakToEmbedUrl(url) {
    const source = oakParsedSocialUrl(url);
    if (!source || source.platform !== 'youtube') {
        return null;
    }
    return 'https://www.youtube.com/embed/' + oakYoutubeVideoId(source.parsed);
}

function oakSafeSocialUrl(url) {
    const value = (url || '').trim();
    return oakDetectSocialPlatform(value) ? value : '';
}

function oakEmptyPostForm(type = 'article') {
    return {
        type,
        title: '',
        content: '',
        video_url: '',
        excerpt: '',
        image: '',
        category: '',
        has_social_source: false,
        source_url: '',
    };
}

function oakBlogFeed() {
    return {
        tabs: [
            { value: '', label: 'Tất cả' },
            { value: 'article', label: 'Bài viết' },
            { value: 'video', label: 'Video' },
        ],
        categories: OAK_POST_CATEGORIES,
        posts: [],
        scope: 'community',
        type: '',
        category: '',
        page: 1,
        total: 0,
        loading: true,
        /* An empty feed means "nothing posted yet"; this means "we never got an answer". */
        loadError: false,
        loadToken: 0,
        user: null,
        salon: null,
        composerOpen: false,
        editingPost: null,
        previewing: false,
        previewPayload: null,
        saving: false,
        uploading: false,
        uploadGeneration: 0,
        deletingId: null,
        error: '',
        form: oakEmptyPostForm(),

        async init() {
            this.user = await OAK.me();
            if (this.user && this.user.role === 'partner') {
                try {
                    this.salon = await OAK.api('/api/partner/salon');
                } catch (error) {
                    this.salon = null;
                }
            }
            await this.reloadFirstPage();
            if (OAK.qs('compose') === '1' && this.user) {
                this.openComposer();
            }
        },

        async loadPage(requestedPage, append) {
            const token = ++this.loadToken;
            this.loading = true;
            try {
                const endpoint = this.scope === 'mine' ? '/api/posts/mine' : '/api/posts';
                let path = endpoint + '?limit=' + OAK_BLOG_PAGE_SIZE + '&page=' + requestedPage;
                if (this.type) {
                    path += '&type=' + encodeURIComponent(this.type);
                }
                if (this.category) {
                    path += '&category=' + encodeURIComponent(this.category);
                }
                const rows = await OAK.api(path);
                if (token !== this.loadToken) {
                    return;
                }
                this.posts = append ? this.posts.concat(rows) : rows;
                this.total = rows.meta.total;
                this.page = requestedPage;
                this.loadError = false;
            } catch (error) {
                if (token !== this.loadToken) {
                    return;
                }
                if (requestedPage === 1 || this.scope === 'mine') {
                    this.posts = [];
                    this.total = 0;
                    this.page = 1;
                    this.loadError = true;
                }
                OAK.toast(error.message, 'error');
            } finally {
                if (token === this.loadToken) {
                    this.loading = false;
                }
            }
        },

        reloadFirstPage() {
            return this.loadPage(1, false);
        },

        async selectScope(value) {
            if (value === 'mine' && !this.user) {
                return;
            }
            if (this.scope === value) {
                return;
            }
            this.closeComposer();
            this.scope = value;
            this.type = '';
            this.category = '';
            this.posts = [];
            this.total = 0;
            this.page = 1;
            this.loadError = false;
            await this.reloadFirstPage();
        },

        async selectType(value) {
            if (this.type === value) {
                return;
            }
            this.type = value;
            await this.reloadFirstPage();
        },

        async selectCategory(value) {
            if (this.category === value) {
                return;
            }
            this.category = value;
            await this.reloadFirstPage();
        },

        /** The label for a stored category value; '' for a post filed under none. */
        categoryLabel(value) {
            const match = OAK_POST_CATEGORIES.find((item) => item.value === value);
            return match ? match.label : '';
        },

        loadMore() {
            if (!this.loading && this.posts.length < this.total) {
                return this.loadPage(this.page + 1, true);
            }
        },

        avatarOf(author) {
            return (author && author.avatar) || OAK_DEFAULT_AVATAR;
        },

        salonUrl(salon) {
            return 'salon-profile.html?salon=' + encodeURIComponent(salon.slug);
        },

        platformLabel(platform) {
            return {
                facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok',
                youtube: 'YouTube', zalo: 'Zalo',
            }[platform] || platform;
        },

        safeSourceUrl(source) {
            return oakSafeSocialUrl(source && source.url);
        },

        canManage(post) {
            return this.scope === 'mine' && post?.can_manage === true;
        },

        get detectedPlatform() {
            return oakDetectSocialPlatform(this.form.source_url);
        },

        get safePreviewVideoUrl() {
            const url = this.previewPayload && this.previewPayload.video_url;
            return /^https:\/\/www\.youtube\.com\/embed\/[\w-]+$/.test(url || '') ? url : '';
        },

        resetComposer(type = 'article') {
            this.uploadGeneration += 1;
            this.uploading = false;
            this.editingPost = null;
            this.form = oakEmptyPostForm(type);
            this.previewing = false;
            this.previewPayload = null;
            this.error = '';
            const fileInput = document.getElementById('post-image');
            if (fileInput) {
                fileInput.value = '';
            }
        },

        /* A guest comes back to the composer, not just to the feed: ?compose=1 is what
           init() reads to reopen it once the round trip is done. The destination goes
           through requireLogin so an unreachable server still says so instead of being
           mistaken for a signed-out visitor. */
        async openComposer() {
            if (!this.user) {
                const params = new URLSearchParams(location.search);
                params.set('compose', '1');
                await OAK.requireLogin('blog.html?' + params.toString());
                return;
            }
            this.resetComposer();
            this.composerOpen = true;
        },

        editPost(post) {
            if (!this.canManage(post)) {
                return;
            }
            this.uploadGeneration += 1;
            this.uploading = false;
            this.editingPost = post;
            this.form = {
                type: post.type,
                title: post.title || '',
                content: post.content || '',
                video_url: post.video_url || '',
                excerpt: post.excerpt || '',
                image: post.image || '',
                category: post.category || '',
                has_social_source: this.user?.role === 'partner' && Boolean(post.source),
                source_url: this.user?.role === 'partner' && post.source ? post.source.url : '',
            };
            this.previewing = false;
            this.previewPayload = null;
            this.error = '';
            this.composerOpen = true;
        },

        closeComposer() {
            if (this.saving) {
                return;
            }
            const type = this.form.type;
            this.composerOpen = false;
            this.resetComposer(type);
        },

        async uploadImage(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) {
                return;
            }
            const generation = ++this.uploadGeneration;
            this.uploading = true;
            try {
                const data = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(new Error('Không đọc được tệp ảnh.'));
                    reader.readAsDataURL(file);
                });
                const upload = await OAK.api('/api/uploads', {
                    method: 'POST', body: { filename: file.name, data },
                });
                if (generation !== this.uploadGeneration) {
                    return;
                }
                this.form = { ...this.form, image: upload.url };
            } catch (error) {
                if (generation === this.uploadGeneration) {
                    OAK.toast(error.message, 'error');
                }
            } finally {
                if (generation === this.uploadGeneration) {
                    this.uploading = false;
                }
            }
        },

        excerptFrom(content) {
            const text = content.replace(/\s+/g, ' ').trim();
            return text.length > 180 ? text.slice(0, 177) + '…' : text;
        },

        socialPayload() {
            if (this.user?.role !== 'partner') {
                return { body: {} };
            }
            if (this.form.has_social_source) {
                const sourceUrl = this.form.source_url.trim();
                if (!oakDetectSocialPlatform(sourceUrl)) {
                    return { error: 'Link phải trỏ trực tiếp đến một bài viết hoặc video được hỗ trợ.' };
                }
                return { body: { source_url: sourceUrl } };
            }
            if (this.editingPost?.source) {
                return { body: { source_url: '' } };
            }
            return { body: {} };
        },

        buildPayload() {
            const title = this.form.title.trim();
            if (!title) {
                return { error: 'Vui lòng nhập tiêu đề bài viết.' };
            }
            const social = this.socialPayload();
            if (social.error) {
                return social;
            }
            const category = this.form.category || null;
            if (this.form.type === 'article') {
                const content = this.form.content.trim();
                if (!content) {
                    return { error: 'Vui lòng nhập nội dung bài viết.' };
                }
                return { body: {
                    type: 'article', title, content, excerpt: this.excerptFrom(content),
                    image: this.form.image || null, category, ...social.body,
                } };
            }
            const videoUrl = oakToEmbedUrl(this.form.video_url);
            if (!videoUrl) {
                return { error: 'Vui lòng nhập đường dẫn video YouTube.' };
            }
            return { body: {
                type: 'video', title, video_url: videoUrl,
                excerpt: this.form.excerpt.trim() || null, category, ...social.body,
            } };
        },

        /* A new post is published from its preview; an edit may be saved straight from the
           form, because its author has already seen the post as it stands. */
        submitComposer() {
            if (!this.editingPost) {
                this.showPreview();
                return;
            }
            const payload = this.buildPayload();
            if (payload.error) {
                this.error = payload.error;
                return;
            }
            this.error = '';
            this.previewPayload = payload.body;
            return this.publish();
        },

        showPreview() {
            const payload = this.buildPayload();
            if (payload.error) {
                this.error = payload.error;
                return;
            }
            this.error = '';
            this.previewPayload = payload.body;
            this.previewing = true;
        },

        async publish() {
            if (!this.previewPayload) {
                this.previewing = false;
                return;
            }
            this.error = '';
            this.saving = true;
            try {
                const editing = this.editingPost;
                const body = editing
                    ? Object.fromEntries(Object.entries(this.previewPayload).filter(([key]) => key !== 'type'))
                    : this.previewPayload;
                if (editing) {
                    await OAK.api('/api/posts/' + editing.id, { method: 'PATCH', body });
                } else {
                    await OAK.api('/api/posts', { method: 'POST', body });
                }
                this.saving = false;
                this.closeComposer();
                await this.reloadFirstPage();
                OAK.toast(editing ? 'Đã cập nhật bài viết.' : 'Đã đăng bài viết của bạn.');
            } catch (error) {
                this.error = error.message;
            } finally {
                this.saving = false;
            }
        },

        async removePost(post) {
            if (!this.canManage(post)) {
                return;
            }
            if (!window.confirm('Bạn có chắc muốn xoá bài viết này?')) {
                return;
            }
            this.deletingId = post.id;
            try {
                await OAK.api('/api/posts/' + post.id, { method: 'DELETE' });
                await this.reloadFirstPage();
                OAK.toast('Đã xoá bài viết.');
            } catch (error) {
                OAK.toast(error.message, 'error');
            } finally {
                this.deletingId = null;
            }
        },
    };
}
