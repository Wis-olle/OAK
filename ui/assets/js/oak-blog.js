const OAK_BLOG_PAGE_SIZE = 9;
/* A reload restores what was on screen in ONE request, and the API caps a request at 50
   rows, so five pages is as far back as that trick reaches. Beyond it the reader lands on
   the fifth page's worth and taps "Tải thêm" again. */
const OAK_BLOG_MAX_RESTORE_PAGE = 5;
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
        composerOpener: null,
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
            await this.loadPage(this.readUrl(), false);
            this.watchLanguageSwitch();
            // A draft is somebody's own paragraph and outranks ?compose=1, which only ever
            // says "reopen an empty composer".
            if (this.restoreComposerDraft()) {
                return;
            }
            if (OAK.qs('compose') === '1' && this.user) {
                this.openComposer();
            }
        },

        /* Choosing English reloads the page, and the composer is the one place on the blog
           where that could throw away something written rather than merely chosen. But the
           VI/EN pair is injected into the top bar, and an open composer makes that bar inert
           the way every modal here does, so while a draft is on screen the switch is out of
           reach and the page ends some other way instead: a refresh, Back, the address bar.
           'pagehide' is the event all of those share, the reload behind the switch included,
           so the stash hangs off both and is written whichever way this page goes. */
        watchLanguageSwitch() {
            const stash = () => {
                if (this.composerOpen) {
                    OAK.saveDraft('composer', {
                        form: this.form,
                        editingId: this.editingPost ? this.editingPost.id : null,
                        userId: this.user ? this.user.id : null,
                    });
                }
            };
            window.addEventListener('oak:lang-change', stash);
            window.addEventListener('pagehide', stash);
        },

        /** True once a draft has reopened the composer, so init() stops there. */
        restoreComposerDraft() {
            // Asked before the draft is taken, because taking it clears it: a session that
            // expired over the reload must not also swallow what was written.
            if (!this.user) {
                return false;
            }
            const draft = OAK.takeDraft('composer');
            if (!draft || !draft.form) {
                return false;
            }
            // sessionStorage outlives a sign-out in the same tab, so on a shared device the
            // next account would otherwise find the previous one's unpublished paragraph
            // waiting in the composer under its own name.
            if (draft.userId !== this.user.id) {
                return false;
            }
            if (draft.editingId) {
                const post = this.posts.find((item) => item.id === draft.editingId);
                // The post is on a later page of the feed or behind another filter. Reopening
                // its text as a new post would publish a second copy of it, so the draft is
                // dropped instead — the post itself is still whatever was last saved.
                if (!post) {
                    return false;
                }
                this.editPost(post);
            } else {
                this.resetComposer();
                this.showComposer();
            }
            // editPost() refuses a post this account cannot manage, and then there is no
            // composer to put the text back into.
            if (!this.composerOpen) {
                return false;
            }
            this.form = draft.form;
            return true;
        },

        /* What the address bar says the feed was showing, applied to this component, and the
           page number to open on. Only values this page offers are taken: a hand-typed
           ?category=zzz would otherwise light no chip and filter the feed to nothing. */
        readUrl() {
            const scope = OAK.qs('scope');
            if (scope === 'mine' && this.user) {
                this.scope = 'mine';
            }
            const type = OAK.qs('type');
            if (this.tabs.some((tab) => tab.value === type)) {
                this.type = type;
            }
            const category = OAK.qs('category');
            if (this.categories.some((item) => item.value === category)) {
                this.category = category;
            }
            const page = Number.parseInt(OAK.qs('page'), 10);
            return Math.min(Math.max(page || 1, 1), OAK_BLOG_MAX_RESTORE_PAGE);
        },

        /* The address bar mirrors what is on screen, so a reload, a Back or a link sent to
           somebody else opens the same feed. The same shape ket-qua-tim-kiem.html uses: only
           the keys this page owns are written or removed, so ?compose=1 rides along
           untouched. Called from loadPage, which is the one place that knows what landed. */
        syncUrl() {
            const params = new URLSearchParams(location.search);
            const state = {
                scope: this.scope === 'community' ? '' : this.scope,
                type: this.type,
                category: this.category,
                page: this.page > 1 ? String(this.page) : '',
            };
            Object.keys(state).forEach((key) => {
                if (state[key]) {
                    params.set(key, state[key]);
                } else {
                    params.delete(key);
                }
            });
            const search = params.toString();
            history.replaceState(null, '', search ? location.pathname + '?' + search : location.pathname);
        },

        /* Asked for page N without appending — which is what a restored ?page=N is — this
           reads the first N pages as one request, so the feed holds the same rows two taps
           of "Tải thêm" would have left on it and `page` still says where the next tap
           starts. Appending is always one page onto the end. */
        async loadPage(requestedPage, append) {
            const token = ++this.loadToken;
            this.loading = true;
            try {
                const endpoint = this.scope === 'mine' ? '/api/posts/mine' : '/api/posts';
                const size = append ? OAK_BLOG_PAGE_SIZE : requestedPage * OAK_BLOG_PAGE_SIZE;
                let path = endpoint + '?limit=' + size + '&page=' + (append ? requestedPage : 1);
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
                this.syncUrl();
            } catch (error) {
                if (token !== this.loadToken) {
                    return;
                }
                /* A load that was not appending owns the whole list, whatever page
                   number it asked for — a restored ?page=2 included — so its failure is the
                   one that must say so rather than leave the feed reading "no posts yet".
                   An append keeps the rows already on screen. */
                if (!append || this.scope === 'mine') {
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
            this.showComposer();
        },

        /* Opening the composer is opening a dialog: the page behind it goes inert (:inert
           on header/main/footer in blog.html), stops scrolling under it, and the caret
           moves onto the dialog's own heading — without that the next Tab walks the feed
           behind it, which is exactly what inert is there to prevent. */
        showComposer() {
            this.composerOpener = document.activeElement;
            this.composerOpen = true;
            document.body.classList.add('overflow-hidden');
            this.$nextTick(() => {
                const heading = document.getElementById('composer-title');
                if (heading) {
                    heading.focus();
                }
            });
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
            this.showComposer();
        },

        closeComposer() {
            if (this.saving) {
                return;
            }
            // Closing is the one unambiguous "I do not want this" the page offers, so the
            // stash goes with it. Without this a draft written before a bfcache round trip
            // (Back then Forward runs no init(), so nothing consumes it) comes back on the
            // next reload after the reader threw it away.
            OAK.takeDraft('composer');
            const type = this.form.type;
            this.composerOpen = false;
            document.body.classList.remove('overflow-hidden');
            this.resetComposer(type);
            const opener = this.composerOpener;
            this.composerOpener = null;
            // Not on this line: `:inert="composerOpen || null"` on the landmarks is an Alpine
            // effect flushed in a microtask, so <main> is still inert here and focus() on
            // anything inside it — which every opener is — is silently dropped.
            this.$nextTick(() => {
                // The button can be gone: publishing reloads the feed, and "Sửa" belongs to
                // a card that may no longer be on the first page.
                if (opener && document.contains(opener)) {
                    opener.focus();
                }
            });
        },

        async uploadImage(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) {
                return;
            }
            const generation = ++this.uploadGeneration;
            this.uploading = true;
            try {
                let payload = await OAK.compressImage(file, { maxEdge: 1600 });
                if (!payload) {
                    const data = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(new Error('Không đọc được tệp ảnh.'));
                        reader.readAsDataURL(file);
                    });
                    payload = { filename: file.name, data };
                }
                const upload = await OAK.api('/api/uploads', { method: 'POST', body: payload });
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
            if (!window.confirm('Bạn có chắc muốn xóa bài viết này?')) {
                return;
            }
            this.deletingId = post.id;
            try {
                await OAK.api('/api/posts/' + post.id, { method: 'DELETE' });
                await this.reloadFirstPage();
                OAK.toast('Đã xóa bài viết.');
            } catch (error) {
                OAK.toast(error.message, 'error');
            } finally {
                this.deletingId = null;
            }
        },
    };
}
