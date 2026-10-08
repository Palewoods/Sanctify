/* =========================================================
   Sanctify Community API: accounts, posts, and replies
   ---------------------------------------------------------
   A Cloudflare Pages Function that answers every request to /api/*.
   It needs a D1 database bound to this Pages project under the name DB
   (Cloudflare dashboard → Workers & Pages → sanctify → Settings → Bindings).
   The tables are created automatically on the first request.

   Optional environment variables (Settings → Variables and Secrets):
     ADMINS         comma-separated usernames allowed to remove any post or reply
     MOD_PASSWORD   a secret: any signed-in member who enters it on their Account page
                    becomes a moderator on that device, until they sign out or leave moderator mode

   Moderators can also see and search every account, ban members (for a time or for good), remove
   everything a member has posted, review reported posts and replies, pin and lock threads, and read a
   log of every moderator action.

   Passwords are salted and hashed with PBKDF2; sign-ins are kept in an
   HttpOnly cookie, and only a hash of each session token is stored.
   Profile pictures are small JPEG, PNG, or WebP images (resized in the
   browser before upload), checked by their file signature and stored in D1.
   ========================================================= */

const CATEGORIES = ['general', 'prayer', 'faith', 'saints', 'study'];
const COOKIE = '__Host-sanctify';
const SESSION_DAYS = 30;
const PAGE_SIZE = 20;
const AVATAR_MAX_BYTES = 120 * 1024;
const AVATAR_TYPES = { 'image/jpeg':[0xFF, 0xD8, 0xFF], 'image/png':[0x89, 0x50, 0x4E, 0x47], 'image/webp':[0x52, 0x49, 0x46, 0x46] };
// Badges a site administrator can give, and badges members earn on their own devices (kept in step with index.html)
const APPOINTED = {
  founder:['Founder', 'gold'], team:['Sanctify Team', 'wine'], moderator:['Moderator', 'teal'], helper:['Community Helper', 'green'],
  clergy:['Clergy', 'purple'], religious:['Religious', 'indigo'], catechist:['Catechist', 'amber'], scholar:['Scholar', 'indigo'],
  artist:['Artist', 'rose'], musician:['Musician', 'rose'], contributor:['Contributor', 'green'], supporter:['Supporter', 'gold']
};
const BADGE_COLORS = ['gold', 'wine', 'teal', 'green', 'purple', 'indigo', 'amber', 'rose'];
const EARNED_KEYS = new Set([
  'rosary-1', 'rosary-10', 'rosary-50', 'rosary-150', 'chaplet-1', 'chaplet-30', 'sacredheart-1', 'sacredheart-9', 'stations-1', 'stations-14',
  'mass-10', 'mass-52', 'confession-1', 'confession-12', 'examen-7', 'scripture-10', 'angelus-30', 'streak-7', 'streak-30', 'streak-100', 'streak-365',
  'days-100', 'novena-1', 'novena-5', 'bible-1', 'bible-50', 'bible-260', 'bible-1000', 'saints-10', 'saints-100', 'saints-500', 'books-10', 'books-100', 'quiz-10'
]);
const RESERVED_NAMES = new Set(['admin', 'administrator', 'moderator', 'mod', 'sanctify', 'staff', 'support', 'system', 'pope', 'vatican']);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     pass_hash TEXT NOT NULL,
     salt TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL,
     expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS posts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     category TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_activity INTEGER NOT NULL,
     reply_count INTEGER NOT NULL DEFAULT 0,
     prayer_count INTEGER NOT NULL DEFAULT 0,
     deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS posts_by_activity ON posts (deleted, last_activity DESC)`,
  `CREATE TABLE IF NOT EXISTS replies (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id INTEGER NOT NULL,
     user_id INTEGER NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS replies_by_post ON replies (post_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS prayers (
     post_id INTEGER NOT NULL,
     user_id INTEGER NOT NULL,
     PRIMARY KEY (post_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS avatars (
     user_id INTEGER PRIMARY KEY,
     mime TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS news (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER,
     deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS news_by_date ON news (deleted, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS bans (
     user_id INTEGER PRIMARY KEY,
     reason TEXT NOT NULL DEFAULT '',
     until INTEGER,
     by_user INTEGER,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     target_id INTEGER NOT NULL,
     post_id INTEGER NOT NULL,
     reporter_id INTEGER NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     UNIQUE (kind, target_id, reporter_id))`,
  `CREATE INDEX IF NOT EXISTS reports_open ON reports (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS mutes (
     user_id INTEGER PRIMARY KEY,
     reason TEXT NOT NULL DEFAULT '',
     until INTEGER,
     by_user INTEGER,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS warnings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     by_user INTEGER,
     message TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     seen_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS warnings_by_user ON warnings (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS mod_notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     by_user INTEGER,
     note TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS blocked_words (
     word TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS edits (
     kind TEXT NOT NULL,
     target_id INTEGER NOT NULL,
     edited_at INTEGER NOT NULL,
     PRIMARY KEY (kind, target_id))`,
  `CREATE TABLE IF NOT EXISTS notify_seen (
     user_id INTEGER PRIMARY KEY,
     seen_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS user_badges (
     user_id INTEGER NOT NULL,
     badge TEXT NOT NULL,
     label TEXT NOT NULL,
     color TEXT NOT NULL,
     by_user INTEGER,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, badge))`,
  `CREATE TABLE IF NOT EXISTS earned_badges (
     user_id INTEGER NOT NULL,
     badge TEXT NOT NULL,
     earned_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, badge))`,
  `CREATE TABLE IF NOT EXISTS post_flags (
     post_id INTEGER PRIMARY KEY,
     pinned INTEGER NOT NULL DEFAULT 0,
     locked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS mod_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     mod_id INTEGER,
     action TEXT NOT NULL,
     target TEXT NOT NULL DEFAULT '',
     detail TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mod_log_by_date ON mod_log (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS mod_sessions (
     token_hash TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS limits (
     key TEXT PRIMARY KEY,
     count INTEGER NOT NULL,
     reset_at INTEGER NOT NULL)`
];

class HttpError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

let schemaReady = null;
function ensureSchema(db){
  if(!schemaReady) schemaReady = db.batch(SCHEMA.map(sql => db.prepare(sql))).catch(err => { schemaReady = null; throw err; });
  return schemaReady;
}

export async function onRequest({ request, env }){
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method;

  if(!env.DB) return json({ error:'The Community isn’t switched on yet. Please check back soon.', setup:true }, 503);

  // Only this site may change anything (a second line of defense after SameSite cookies)
  if(method !== 'GET' && method !== 'HEAD'){
    const origin = request.headers.get('Origin');
    if(origin && origin !== url.origin) return json({ error:'This request came from another site and was blocked.' }, 403);
  }

  try{
    await ensureSchema(env.DB);
    const ctx = { request, env, db:env.DB, now:Date.now(), url };
    let m;
    if((m = path.match(/^avatar\/([A-Za-z0-9_]{3,20})$/)) && (method === 'GET' || method === 'HEAD')) return await getAvatar(ctx, m[1]);
    ctx.user = await currentUser(ctx);
    if(path === 'me' && method === 'GET') return await getMe(ctx);
    if(path === 'notifications' && method === 'GET') return await getNotifications(ctx);
    if(path === 'notifications/seen' && method === 'POST') return await markNotificationsSeen(ctx);
    if(path === 'badges/sync' && method === 'POST') return await syncBadges(ctx);
    if((m = path.match(/^users\/([A-Za-z0-9_]{3,20})$/)) && method === 'GET') return await getProfile(ctx, m[1]);
    if(path === 'signup' && method === 'POST') return await signup(ctx);
    if(path === 'login' && method === 'POST') return await login(ctx);
    if(path === 'logout' && method === 'POST') return await logout(ctx);
    if(path === 'account' && method === 'DELETE') return await deleteAccount(ctx);
    if(path === 'moderator' && method === 'POST') return await enterModerator(ctx);
    if(path === 'moderator' && method === 'DELETE') return await leaveModerator(ctx);
    if(path.startsWith('mod/')) return await modRoute(ctx, path.slice(4), method);
    if((m = path.match(/^(posts|replies)\/(\d+)\/report$/)) && method === 'POST') return await report(ctx, m[1] === 'posts' ? 'post' : 'reply', Number(m[2]));
    if((m = path.match(/^posts\/(\d+)\/(pin|lock)$/)) && method === 'POST') return await flagPost(ctx, Number(m[1]), m[2]);
    if((m = path.match(/^posts\/(\d+)\/move$/)) && method === 'POST') return await movePost(ctx, Number(m[1]));
    if((m = path.match(/^replies\/(\d+)$/)) && method === 'PUT') return await editReply(ctx, Number(m[1]));
    if(path === 'news' && method === 'GET') return await listNews(ctx);
    if(path === 'news' && method === 'POST') return await saveNews(ctx, null);
    if((m = path.match(/^news\/(\d+)$/))){
      if(method === 'PUT') return await saveNews(ctx, Number(m[1]));
      if(method === 'DELETE') return await deleteNews(ctx, Number(m[1]));
    }
    if(path === 'account/avatar' && method === 'PUT') return await setAvatar(ctx);
    if(path === 'account/avatar' && method === 'DELETE') return await removeAvatar(ctx);
    if(path === 'posts' && method === 'GET') return await listPosts(ctx);
    if(path === 'posts' && method === 'POST') return await createPost(ctx);
    if((m = path.match(/^posts\/(\d+)$/))){
      if(method === 'GET') return await getPost(ctx, Number(m[1]));
      if(method === 'DELETE') return await deletePost(ctx, Number(m[1]));
      if(method === 'PUT') return await editPost(ctx, Number(m[1]));
    }
    if((m = path.match(/^posts\/(\d+)\/replies$/)) && method === 'POST') return await createReply(ctx, Number(m[1]));
    if((m = path.match(/^posts\/(\d+)\/pray$/)) && method === 'POST') return await togglePrayer(ctx, Number(m[1]));
    if((m = path.match(/^replies\/(\d+)$/)) && method === 'DELETE') return await deleteReply(ctx, Number(m[1]));
    return json({ error:'Not found.' }, 404);
  }catch(err){
    if(err instanceof HttpError) return json({ error:err.message }, err.status);
    console.error(err);
    return json({ error:'Something went wrong. Please try again in a moment.' }, 500);
  }
}

/* ---------- Accounts ---------- */
async function signup(ctx){
  const { username, password } = await readBody(ctx);
  const name = String(username || '').trim();
  if(!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, 'Usernames are 3 to 20 letters, numbers, or underscores.');
  if(RESERVED_NAMES.has(name.toLowerCase())) throw new HttpError(400, 'That username is reserved. Please choose another.');
  checkPassword(password);
  await limit(ctx, 'signup:' + await ipKey(ctx), 5, 60 * 60 * 1000, 'Too many new accounts from this network. Please try again later.');

  const taken = await ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').bind(name).first();
  if(taken) throw new HttpError(409, 'That username is taken. Please choose another.');

  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(password, salt);
  let result;
  try{
    result = await ctx.db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
      .bind(name, hash, salt, ctx.now).run();
  }catch(err){
    if(/UNIQUE/i.test(String(err && err.message))) throw new HttpError(409, 'That username is taken. Please choose another.');
    throw err;
  }
  const user = { id:result.meta.last_row_id, username:name, created_at:ctx.now };
  return json({ user:publicUser(withRole(ctx, user)) }, 201, { 'Set-Cookie':await startSession(ctx, user.id) });
}

async function login(ctx){
  const { username, password } = await readBody(ctx);
  const name = String(username || '').trim();
  await limit(ctx, 'login:' + await ipKey(ctx), 10, 15 * 60 * 1000, 'Too many sign-in attempts. Please wait a few minutes and try again.');
  await limit(ctx, 'login-user:' + name.toLowerCase(), 10, 15 * 60 * 1000, 'Too many sign-in attempts for this account. Please wait a few minutes and try again.');

  const row = name ? await ctx.db.prepare('SELECT u.id, u.username, u.pass_hash, u.salt, u.created_at, a.updated_at AS avatar_v FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.username = ?').bind(name).first() : null;
  // Hash even when the user doesn't exist, so the response time doesn't reveal which usernames are real
  const hash = await hashPassword(String(password || ''), row ? row.salt : '00'.repeat(16));
  if(!row || !sameHash(hash, row.pass_hash)) throw new HttpError(401, 'That username and password don’t match.');
  const ban = await ctx.db.prepare('SELECT reason, until FROM bans WHERE user_id = ? AND (until IS NULL OR until > ?)').bind(row.id, ctx.now).first();
  if(ban) throw new HttpError(403, banMessage(ban));

  await ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(ctx.now).run();
  const user = { id:row.id, username:row.username, created_at:row.created_at, avatar_v:row.avatar_v };
  return json({ user:publicUser(withRole(ctx, user)) }, 200, { 'Set-Cookie':await startSession(ctx, row.id) });
}

async function logout(ctx){
  const token = readCookie(ctx.request, COOKIE);
  if(token){
    const hash = await sha256(token);
    await ctx.db.batch([
      ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash),
      ctx.db.prepare('DELETE FROM mod_sessions WHERE token_hash = ?').bind(hash)
    ]);
  }
  return json({ ok:true }, 200, { 'Set-Cookie':clearCookie() });
}

// Removes the account and signs out everywhere. Posts and replies stay, shown as "Former member".
async function deleteAccount(ctx){
  const user = requireUser(ctx);
  const { password } = await readBody(ctx);
  const row = await ctx.db.prepare('SELECT pass_hash, salt FROM users WHERE id = ?').bind(user.id).first();
  if(!row || !sameHash(await hashPassword(String(password || ''), row.salt), row.pass_hash)) throw new HttpError(401, 'That password isn’t right.');
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM mod_sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id = ?)').bind(user.id),
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM avatars WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
  ]);
  return json({ ok:true }, 200, { 'Set-Cookie':clearCookie() });
}

/* ---------- Profile pictures ---------- */
async function setAvatar(ctx){
  const user = requireUser(ctx);
  const { image } = await readBody(ctx, 200000);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+\/]+={0,2})$/.exec(String(image || ''));
  if(!m) throw new HttpError(400, 'Please choose a JPEG, PNG, or WebP picture.');
  let bytes;
  try{ bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)); }catch(err){ throw new HttpError(400, 'That picture couldn’t be read.'); }
  if(bytes.length > AVATAR_MAX_BYTES) throw new HttpError(413, 'That picture is too large. Please choose a smaller one.');
  const sig = AVATAR_TYPES[m[1]];
  const webpOk = m[1] !== 'image/webp' || String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if(bytes.length < 12 || !sig.every((b, i) => bytes[i] === b) || !webpOk) throw new HttpError(400, 'That file isn’t a valid picture.');
  await limit(ctx, 'avatar:' + user.id, 10, 60 * 60 * 1000, 'You’ve changed your picture several times recently. Please try again later.');
  await ctx.db.prepare('INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at')
    .bind(user.id, m[1], m[2], ctx.now).run();
  return json({ user:publicUser({ ...user, avatar_v:ctx.now }) });
}

async function removeAvatar(ctx){
  const user = requireUser(ctx);
  await ctx.db.prepare('DELETE FROM avatars WHERE user_id = ?').bind(user.id).run();
  return json({ user:publicUser({ ...user, avatar_v:null }) });
}

// Serves a member's picture; the ?v= version in the URL changes whenever the picture does
async function getAvatar(ctx, name){
  const row = await ctx.db.prepare('SELECT a.mime, a.data FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.username = ?').bind(name).first();
  if(!row) return new Response('Not found', { status:404, headers:{ 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' } });
  const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
  return new Response(bytes, { status:200, headers:{
    'Content-Type':row.mime, 'Cache-Control':'public, max-age=86400', 'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; sandbox", 'Content-Disposition':'inline'
  }});
}

/* ---------- Posts and replies ---------- */
async function listPosts(ctx){
  const q = ctx.url.searchParams;
  const page = Math.max(0, Math.min(500, parseInt(q.get('page') || '0', 10) || 0));
  const where = ['p.deleted = 0'];
  const args = [];
  const category = q.get('category');
  if(category && category !== 'all'){
    if(!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category.');
    where.push('p.category = ?'); args.push(category);
  }
  if(q.get('mine') === '1'){
    const user = requireUser(ctx);
    where.push('p.user_id = ?'); args.push(user.id);
  }
  const search = cleanLine(q.get('q')).slice(0, 80);
  if(search){
    const like = '%' + search.replace(/[\\%_]/g, c => '\\' + c) + '%';
    where.push(`(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')`); args.push(like, like);
  }
  const { results } = await ctx.db.prepare(
    `SELECT p.id, p.category, p.title, substr(p.body, 1, 240) AS excerpt, p.created_at, p.last_activity,
            p.reply_count, p.prayer_count, u.username, a.updated_at AS avatar_v, COALESCE(f.pinned, 0) AS pinned, COALESCE(f.locked, 0) AS locked
       FROM posts p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN avatars a ON a.user_id = p.user_id LEFT JOIN post_flags f ON f.post_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(f.pinned, 0) DESC, p.last_activity DESC, p.id DESC
      LIMIT ? OFFSET ?`
  ).bind(...args, PAGE_SIZE + 1, page * PAGE_SIZE).all();
  return json({
    posts:results.slice(0, PAGE_SIZE).map(r => ({
      id:r.id, category:r.category, title:r.title, excerpt:r.excerpt, author:r.username || null, authorAvatar:r.username ? r.avatar_v || null : null,
      createdAt:r.created_at, lastActivity:r.last_activity, replies:r.reply_count, prayers:r.prayer_count, pinned:!!r.pinned, locked:!!r.locked
    })),
    more:results.length > PAGE_SIZE
  });
}

async function getPost(ctx, id){
  const post = await ctx.db.prepare(
    `SELECT p.*, u.username, a.updated_at AS avatar_v, COALESCE(f.pinned, 0) AS pinned, COALESCE(f.locked, 0) AS locked
            , e.edited_at
       FROM posts p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN avatars a ON a.user_id = p.user_id LEFT JOIN post_flags f ON f.post_id = p.id
            LEFT JOIN edits e ON e.kind = 'post' AND e.target_id = p.id
      WHERE p.id = ? AND p.deleted = 0`
  ).bind(id).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
  const { results } = await ctx.db.prepare(
    `SELECT r.id, r.user_id, r.body, r.created_at, u.username, a.updated_at AS avatar_v, e.edited_at FROM replies r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN avatars a ON a.user_id = r.user_id
       LEFT JOIN edits e ON e.kind = 'reply' AND e.target_id = r.id
      WHERE r.post_id = ? AND r.deleted = 0 ORDER BY r.created_at ASC, r.id ASC LIMIT 500`
  ).bind(id).all();
  const user = ctx.user;
  const authorIds = [...new Set([post.user_id, ...results.map(r => r.user_id)])];
  const shown = {};
  if(authorIds.length){
    const { results:rows } = await ctx.db.prepare(`SELECT user_id, label, color FROM user_badges WHERE user_id IN (${authorIds.map(() => '?').join(',')}) ORDER BY created_at`).bind(...authorIds).all();
    rows.forEach(b => { (shown[b.user_id] = shown[b.user_id] || []).push({ label:b.label, color:b.color }); });
  }
  const prayed = user ? !!(await ctx.db.prepare('SELECT 1 FROM prayers WHERE post_id = ? AND user_id = ?').bind(id, user.id).first()) : false;
  const canRemove = ownerId => !!user && (user.id === ownerId || user.admin);
  return json({
    post:{
      id:post.id, category:post.category, title:post.title, body:post.body, author:post.username || null, authorAvatar:post.username ? post.avatar_v || null : null,
      createdAt:post.created_at, replies:post.reply_count, prayers:post.prayer_count, prayed,
      mine:!!user && user.id === post.user_id, canRemove:canRemove(post.user_id),
      pinned:!!post.pinned, locked:!!post.locked, canModerate:!!user && !!user.admin, editedAt:post.edited_at || null,
      authorBadges:(shown[post.user_id] || []).slice(0, 3)
    },
    replies:results.map(r => ({
      id:r.id, body:r.body, author:r.username || null, authorAvatar:r.username ? r.avatar_v || null : null, createdAt:r.created_at,
      mine:!!user && user.id === r.user_id, canRemove:canRemove(r.user_id), editedAt:r.edited_at || null,
      authorBadges:(shown[r.user_id] || []).slice(0, 3)
    }))
  });
}

async function createPost(ctx){
  const user = requireUser(ctx);
  const data = await readBody(ctx);
  const category = String(data.category || '');
  if(!CATEGORIES.includes(category)) throw new HttpError(400, 'Please choose a category.');
  const title = cleanLine(data.title);
  if(title.length < 3 || title.length > 120) throw new HttpError(400, 'Titles are 3 to 120 characters.');
  const body = cleanText(data.body);
  if(body.length < 1 || body.length > 5000) throw new HttpError(400, 'Posts are 1 to 5,000 characters.');
  await checkPosting(ctx, user, [title, body]);
  await limit(ctx, 'post:' + user.id, 5, 15 * 60 * 1000, 'You’ve posted several times in a short while. Please wait a few minutes before posting again.');
  const result = await ctx.db.prepare(
    'INSERT INTO posts (user_id, category, title, body, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(user.id, category, title, body, ctx.now, ctx.now).run();
  return json({ id:result.meta.last_row_id }, 201);
}

async function createReply(ctx, postId){
  const user = requireUser(ctx);
  const data = await readBody(ctx);
  const body = cleanText(data.body);
  if(body.length < 1 || body.length > 3000) throw new HttpError(400, 'Replies are 1 to 3,000 characters.');
  await checkPosting(ctx, user, [body]);
  const post = await ctx.db.prepare('SELECT p.id, COALESCE(f.locked, 0) AS locked FROM posts p LEFT JOIN post_flags f ON f.post_id = p.id WHERE p.id = ? AND p.deleted = 0').bind(postId).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
  if(post.locked && !user.admin) throw new HttpError(403, 'This thread is locked, so it can’t take new replies.');
  await limit(ctx, 'reply:' + user.id, 20, 15 * 60 * 1000, 'You’ve replied many times in a short while. Please wait a few minutes.');
  const [result] = await ctx.db.batch([
    ctx.db.prepare('INSERT INTO replies (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').bind(postId, user.id, body, ctx.now),
    ctx.db.prepare('UPDATE posts SET reply_count = reply_count + 1, last_activity = ? WHERE id = ?').bind(ctx.now, postId)
  ]);
  return json({ id:result.meta.last_row_id }, 201);
}

async function deletePost(ctx, id){
  const user = requireUser(ctx);
  const post = await ctx.db.prepare('SELECT user_id FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has already been removed.');
  if(post.user_id !== user.id && !user.admin) throw new HttpError(403, 'You can only remove your own posts.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(id),
    ctx.db.prepare(`UPDATE reports SET status = 'resolved' WHERE status = 'open' AND post_id = ?`).bind(id)
  ]);
  if(post.user_id !== user.id) await logMod(ctx, 'remove-post', 'post ' + id, '');
  return json({ ok:true });
}

async function deleteReply(ctx, id){
  const user = requireUser(ctx);
  const reply = await ctx.db.prepare('SELECT user_id, post_id FROM replies WHERE id = ? AND deleted = 0').bind(id).first();
  if(!reply) throw new HttpError(404, 'This reply doesn’t exist or has already been removed.');
  if(reply.user_id !== user.id && !user.admin) throw new HttpError(403, 'You can only remove your own replies.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE replies SET deleted = 1 WHERE id = ?').bind(id),
    ctx.db.prepare('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?').bind(reply.post_id),
    ctx.db.prepare(`UPDATE reports SET status = 'resolved' WHERE status = 'open' AND kind = 'reply' AND target_id = ?`).bind(id)
  ]);
  if(reply.user_id !== user.id) await logMod(ctx, 'remove-reply', 'reply ' + id + ' on post ' + reply.post_id, '');
  return json({ ok:true });
}

// "I'm praying for this": one per member per post, pressed again to undo
async function togglePrayer(ctx, postId){
  const user = requireUser(ctx);
  const post = await ctx.db.prepare('SELECT id FROM posts WHERE id = ? AND deleted = 0').bind(postId).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
  await limit(ctx, 'pray:' + user.id, 60, 10 * 60 * 1000, 'Please slow down a little.');
  const added = await ctx.db.prepare('INSERT OR IGNORE INTO prayers (post_id, user_id) VALUES (?, ?)').bind(postId, user.id).run();
  const prayed = added.meta.changes > 0;
  if(!prayed) await ctx.db.prepare('DELETE FROM prayers WHERE post_id = ? AND user_id = ?').bind(postId, user.id).run();
  await ctx.db.prepare(`UPDATE posts SET prayer_count = MAX(prayer_count ${prayed ? '+' : '-'} 1, 0) WHERE id = ?`).bind(postId).run();
  const row = await ctx.db.prepare('SELECT prayer_count FROM posts WHERE id = ?').bind(postId).first();
  return json({ prayed, prayers:row.prayer_count });
}

/* ---------- Posting rules ---------- */
async function setting(ctx, key){
  const row = await ctx.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
async function activeMute(ctx, userId){
  return ctx.db.prepare('SELECT reason, until FROM mutes WHERE user_id = ? AND (until IS NULL OR until > ?)').bind(userId, ctx.now).first();
}
function muteMessage(m){
  return 'You’re muted' + (m.until ? ' until ' + new Date(m.until).toISOString().slice(0, 10) : '') + ', so you can read and pray but not post or reply.' + (m.reason ? ' Reason: ' + m.reason : '');
}
async function checkPosting(ctx, user, texts){
  if(user.admin) return;
  if(await setting(ctx, 'readonly') === '1') throw new HttpError(403, 'The Community is read-only for a little while. Please check back soon.');
  const mute = await activeMute(ctx, user.id);
  if(mute) throw new HttpError(403, muteMessage(mute));
  const { results } = await ctx.db.prepare('SELECT word FROM blocked_words').all();
  const hay = texts.join(' ').toLowerCase();
  for(const { word } of results){
    const w = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if(new RegExp('(^|[^\\p{L}\\p{N}])' + w + '($|[^\\p{L}\\p{N}])', 'u').test(hay)) throw new HttpError(400, 'Please rephrase: your post uses a word that isn’t allowed in the Community.');
  }
}

/* ---------- Editing your own posts and replies ---------- */
async function editPost(ctx, id){
  const user = requireUser(ctx);
  const post = await ctx.db.prepare('SELECT user_id FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
  if(post.user_id !== user.id) throw new HttpError(403, 'You can only edit your own posts.');
  const data = await readBody(ctx);
  const title = cleanLine(data.title), body = cleanText(data.body);
  if(title.length < 3 || title.length > 120) throw new HttpError(400, 'Titles are 3 to 120 characters.');
  if(body.length < 1 || body.length > 5000) throw new HttpError(400, 'Posts are 1 to 5,000 characters.');
  await checkPosting(ctx, user, [title, body]);
  await limit(ctx, 'edit:' + user.id, 30, 15 * 60 * 1000, 'You’ve made a lot of edits. Please wait a few minutes.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE posts SET title = ?, body = ? WHERE id = ?').bind(title, body, id),
    ctx.db.prepare('INSERT INTO edits (kind, target_id, edited_at) VALUES (?, ?, ?) ON CONFLICT(kind, target_id) DO UPDATE SET edited_at = excluded.edited_at').bind('post', id, ctx.now)
  ]);
  return json({ ok:true });
}
async function editReply(ctx, id){
  const user = requireUser(ctx);
  const reply = await ctx.db.prepare('SELECT user_id FROM replies WHERE id = ? AND deleted = 0').bind(id).first();
  if(!reply) throw new HttpError(404, 'This reply doesn’t exist or has been removed.');
  if(reply.user_id !== user.id) throw new HttpError(403, 'You can only edit your own replies.');
  const body = cleanText((await readBody(ctx)).body);
  if(body.length < 1 || body.length > 3000) throw new HttpError(400, 'Replies are 1 to 3,000 characters.');
  await checkPosting(ctx, user, [body]);
  await limit(ctx, 'edit:' + user.id, 30, 15 * 60 * 1000, 'You’ve made a lot of edits. Please wait a few minutes.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE replies SET body = ? WHERE id = ?').bind(body, id),
    ctx.db.prepare('INSERT INTO edits (kind, target_id, edited_at) VALUES (?, ?, ?) ON CONFLICT(kind, target_id) DO UPDATE SET edited_at = excluded.edited_at').bind('reply', id, ctx.now)
  ]);
  return json({ ok:true });
}

/* ---------- You: your status, notifications, and public profiles ---------- */
async function getMe(ctx){
  const readonly = await setting(ctx, 'readonly') === '1';
  const user = ctx.user;
  if(!user) return json({ user:null, readonly });
  const mute = await activeMute(ctx, user.id);
  const seen = await ctx.db.prepare('SELECT seen_at FROM notify_seen WHERE user_id = ?').bind(user.id).first();
  const since = seen ? seen.seen_at : ctx.now - 30 * 86400000;
  const unread = (await ctx.db.prepare(
    `SELECT (SELECT COUNT(*) FROM replies r JOIN posts p ON p.id = r.post_id
              WHERE p.user_id = ? AND r.user_id != ? AND r.deleted = 0 AND p.deleted = 0 AND r.created_at > ?)
          + (SELECT COUNT(*) FROM warnings WHERE user_id = ? AND seen_at IS NULL) AS n`
  ).bind(user.id, user.id, since, user.id).first()).n;
  return json({ user:{ ...publicUser(user), muted:mute ? { until:mute.until || null, reason:mute.reason } : null, unread }, readonly });
}

async function getNotifications(ctx){
  const user = requireUser(ctx);
  const seen = await ctx.db.prepare('SELECT seen_at FROM notify_seen WHERE user_id = ?').bind(user.id).first();
  const since = seen ? seen.seen_at : ctx.now - 30 * 86400000;
  const replies = (await ctx.db.prepare(
    `SELECT r.id, r.post_id, p.title, substr(r.body, 1, 180) AS excerpt, r.created_at, u.username, a.updated_at AS avatar_v
       FROM replies r JOIN posts p ON p.id = r.post_id LEFT JOIN users u ON u.id = r.user_id LEFT JOIN avatars a ON a.user_id = r.user_id
      WHERE p.user_id = ? AND r.user_id != ? AND r.deleted = 0 AND p.deleted = 0
      ORDER BY r.created_at DESC LIMIT 40`).bind(user.id, user.id).all()).results;
  const warnings = (await ctx.db.prepare('SELECT id, message, created_at, seen_at FROM warnings WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(user.id).all()).results;
  return json({
    replies:replies.map(r => ({ id:r.id, postId:r.post_id, postTitle:r.title, excerpt:r.excerpt, createdAt:r.created_at, author:r.username || null, authorAvatar:r.username ? r.avatar_v || null : null, unread:r.created_at > since })),
    warnings:warnings.map(w => ({ id:w.id, message:w.message, createdAt:w.created_at, unread:!w.seen_at }))
  });
}

async function markNotificationsSeen(ctx){
  const user = requireUser(ctx);
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO notify_seen (user_id, seen_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET seen_at = excluded.seen_at').bind(user.id, ctx.now),
    ctx.db.prepare('UPDATE warnings SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL').bind(ctx.now, user.id)
  ]);
  return json({ ok:true });
}

async function getProfile(ctx, name){
  const u = await ctx.db.prepare('SELECT u.id, u.username, u.created_at, a.updated_at AS avatar_v FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.username = ?').bind(name).first();
  if(!u) throw new HttpError(404, 'There’s no member by that name.');
  const counts = await ctx.db.prepare(
    'SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ? AND deleted = 0) AS posts, (SELECT COUNT(*) FROM replies WHERE user_id = ? AND deleted = 0) AS replies, (SELECT COUNT(*) FROM prayers WHERE user_id = ?) AS prayers'
  ).bind(u.id, u.id, u.id).first();
  const { results } = await ctx.db.prepare(
    `SELECT id, category, title, substr(body, 1, 200) AS excerpt, created_at, reply_count, prayer_count FROM posts WHERE user_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 20`
  ).bind(u.id).all();
  const badges = await badgesFor(ctx, u.id);
  return json({
    profile:{ id:u.id, username:u.username, createdAt:u.created_at, avatar:u.avatar_v || null, posts:counts.posts, replies:counts.replies, prayers:counts.prayers, administrator:siteAdmin(ctx, u.username), badges },
    posts:results.map(p => ({ id:p.id, category:p.category, title:p.title, excerpt:p.excerpt, createdAt:p.created_at, lastActivity:p.created_at, replies:p.reply_count, prayers:p.prayer_count, author:u.username, authorAvatar:u.avatar_v || null }))
  });
}

/* ---------- Badges ---------- */
async function badgesFor(ctx, userId){
  const appointed = (await ctx.db.prepare('SELECT badge, label, color, created_at FROM user_badges WHERE user_id = ? ORDER BY created_at').bind(userId).all()).results;
  const earned = (await ctx.db.prepare('SELECT badge, earned_at FROM earned_badges WHERE user_id = ? ORDER BY earned_at').bind(userId).all()).results;
  return {
    appointed:appointed.map(b => ({ key:b.badge, label:b.label, color:b.color, since:b.created_at })),
    earned:earned.map(b => b.badge).filter(k => EARNED_KEYS.has(k))
  };
}

// A member's device sends the badges it has earned (prayer and reading are kept on the device)
async function syncBadges(ctx){
  const user = requireUser(ctx);
  const data = await readBody(ctx, 4000);
  const keys = [...new Set((Array.isArray(data.keys) ? data.keys : []).map(String).filter(k => EARNED_KEYS.has(k)))];
  await limit(ctx, 'badges:' + user.id, 30, 60 * 60 * 1000, 'Please try again later.');
  if(keys.length) await ctx.db.batch(keys.map(k => ctx.db.prepare('INSERT OR IGNORE INTO earned_badges (user_id, badge, earned_at) VALUES (?, ?, ?)').bind(user.id, k, ctx.now)));
  return json({ ok:true, saved:keys.length });
}

function requireSiteAdmin(ctx){
  const user = requireUser(ctx);
  if(!user.site) throw new HttpError(403, 'Only site administrators can give or remove badges.');
  return user;
}

async function giveBadge(ctx, id){
  requireSiteAdmin(ctx);
  const target = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  const data = await readBody(ctx, 1000);
  let key = String(data.badge || ''), label, color;
  if(APPOINTED[key]) [label, color] = APPOINTED[key];
  else if(key === 'custom'){
    label = cleanLine(data.label).slice(0, 30);
    color = BADGE_COLORS.includes(data.color) ? data.color : 'gold';
    if(label.length < 2) throw new HttpError(400, 'Give the badge a name of at least 2 characters.');
    key = 'custom-' + toHex(crypto.getRandomValues(new Uint8Array(4)));
  } else throw new HttpError(400, 'Choose a badge.');
  if(await ctx.db.prepare('SELECT 1 FROM user_badges WHERE user_id = ? AND badge = ?').bind(id, key).first()) throw new HttpError(400, 'That account already has this badge.');
  const count = (await ctx.db.prepare('SELECT COUNT(*) AS n FROM user_badges WHERE user_id = ?').bind(id).first()).n;
  if(count >= 12) throw new HttpError(400, 'That account already has 12 badges.');
  await ctx.db.prepare('INSERT INTO user_badges (user_id, badge, label, color, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, key, label, color, ctx.user.id, ctx.now).run();
  await logMod(ctx, 'give-badge', target.username, label);
  return modUser(ctx, id);
}

async function takeBadge(ctx, id, key){
  requireSiteAdmin(ctx);
  const row = await ctx.db.prepare('SELECT b.label, u.username FROM user_badges b JOIN users u ON u.id = b.user_id WHERE b.user_id = ? AND b.badge = ?').bind(id, key).first();
  if(!row) throw new HttpError(404, 'That badge isn’t on this account.');
  await ctx.db.prepare('DELETE FROM user_badges WHERE user_id = ? AND badge = ?').bind(id, key).run();
  await logMod(ctx, 'take-badge', row.username, row.label);
  return modUser(ctx, id);
}

/* ---------- Moderation ---------- */
async function logMod(ctx, action, target, detail){
  await ctx.db.prepare('INSERT INTO mod_log (mod_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ctx.user ? ctx.user.id : null, action, String(target || '').slice(0, 200), String(detail || '').slice(0, 300), ctx.now).run();
}
function banMessage(ban){
  return 'This account has been banned' + (ban.until ? ' until ' + new Date(ban.until).toISOString().slice(0, 10) : '') + '.' + (ban.reason ? ' Reason: ' + ban.reason : '');
}
function siteAdmin(ctx, username){
  return String(ctx.env.ADMINS || '').split(',').map(x => x.trim().toLowerCase()).includes(String(username || '').toLowerCase());
}

async function report(ctx, kind, id){
  const user = requireUser(ctx);
  const data = await readBody(ctx, 2000);
  const reason = cleanLine(data.reason).slice(0, 300);
  const row = kind === 'post'
    ? await ctx.db.prepare('SELECT id AS post_id, user_id FROM posts WHERE id = ? AND deleted = 0').bind(id).first()
    : await ctx.db.prepare('SELECT post_id, user_id FROM replies WHERE id = ? AND deleted = 0').bind(id).first();
  if(!row) throw new HttpError(404, 'That has already been removed.');
  if(row.user_id === user.id) throw new HttpError(400, 'You can delete your own posts instead of reporting them.');
  await limit(ctx, 'report:' + user.id, 10, 60 * 60 * 1000, 'You’ve sent several reports. Please wait a little before sending more.');
  await ctx.db.prepare('INSERT OR IGNORE INTO reports (kind, target_id, post_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(kind, id, row.post_id, user.id, reason, ctx.now).run();
  return json({ ok:true });
}

async function flagPost(ctx, id, which){
  requireModerator(ctx);
  const data = await readBody(ctx, 200);
  const on = data.on ? 1 : 0;
  const post = await ctx.db.prepare('SELECT title FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
  const col = which === 'pin' ? 'pinned' : 'locked';
  await ctx.db.prepare(`INSERT INTO post_flags (post_id, ${col}) VALUES (?, ?) ON CONFLICT(post_id) DO UPDATE SET ${col} = excluded.${col}`).bind(id, on).run();
  await logMod(ctx, (on ? '' : 'un') + which, 'post ' + id, post.title);
  return json({ ok:true, [col]:!!on });
}

async function modRoute(ctx, sub, method){
  requireModerator(ctx);
  let m;
  if(sub === 'overview' && method === 'GET') return await modOverview(ctx);
  if(sub === 'users' && method === 'GET') return await modUsers(ctx);
  if((m = sub.match(/^users\/(\d+)$/)) && method === 'GET') return await modUser(ctx, Number(m[1]));
  if((m = sub.match(/^users\/(\d+)\/ban$/))){
    if(method === 'POST') return await banUser(ctx, Number(m[1]));
    if(method === 'DELETE') return await unbanUser(ctx, Number(m[1]));
  }
  if((m = sub.match(/^users\/(\d+)\/content$/)) && method === 'DELETE') return await removeContent(ctx, Number(m[1]), true);
  if(sub === 'reports' && method === 'GET') return await modReports(ctx);
  if((m = sub.match(/^reports\/(\d+)$/)) && method === 'DELETE') return await dismissReport(ctx, Number(m[1]));
  if(sub === 'log' && method === 'GET') return await modLogList(ctx);
  if((m = sub.match(/^users\/(\d+)\/mute$/))){
    if(method === 'POST') return await muteUser(ctx, Number(m[1]));
    if(method === 'DELETE') return await unmuteUser(ctx, Number(m[1]));
  }
  if((m = sub.match(/^users\/(\d+)\/warn$/)) && method === 'POST') return await warnUser(ctx, Number(m[1]));
  if((m = sub.match(/^users\/(\d+)\/notes$/)) && method === 'POST') return await addNote(ctx, Number(m[1]));
  if((m = sub.match(/^notes\/(\d+)$/)) && method === 'DELETE') return await deleteNote(ctx, Number(m[1]));
  if((m = sub.match(/^users\/(\d+)\/badges$/)) && method === 'POST') return await giveBadge(ctx, Number(m[1]));
  if((m = sub.match(/^users\/(\d+)\/badges\/([a-z0-9-]{1,40})$/)) && method === 'DELETE') return await takeBadge(ctx, Number(m[1]), m[2]);
  if(sub === 'settings' && method === 'GET') return await getSettings(ctx);
  if(sub === 'settings' && method === 'PUT') return await putSettings(ctx);
  throw new HttpError(404, 'Not found.');
}

async function movePost(ctx, id){
  requireModerator(ctx);
  const category = String((await readBody(ctx, 200)).category || '');
  if(!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category.');
  const post = await ctx.db.prepare('SELECT title, category FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
  await ctx.db.prepare('UPDATE posts SET category = ? WHERE id = ?').bind(category, id).run();
  await logMod(ctx, 'move', 'post ' + id, post.category + ' → ' + category);
  return json({ ok:true, category });
}

async function guardTarget(ctx, id, verb){
  const target = await ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  if(target.id === ctx.user.id) throw new HttpError(400, `You can’t ${verb} your own account.`);
  if(siteAdmin(ctx, target.username)) throw new HttpError(403, `Site administrators can’t be ${verb === 'mute' ? 'muted' : 'warned'}.`);
  return target;
}

async function muteUser(ctx, id){
  const target = await guardTarget(ctx, id, 'mute');
  const data = await readBody(ctx, 2000);
  const days = Number(data.days) || 0;
  if(days && (days < 0 || days > 3650)) throw new HttpError(400, 'Choose how long the mute lasts.');
  const reason = cleanLine(data.reason).slice(0, 300);
  await ctx.db.prepare('INSERT INTO mutes (user_id, reason, until, by_user, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, until = excluded.until, by_user = excluded.by_user, created_at = excluded.created_at')
    .bind(id, reason, days ? ctx.now + days * 86400000 : null, ctx.user.id, ctx.now).run();
  await logMod(ctx, 'mute', target.username, (days ? days + (days === 1 ? ' day' : ' days') : 'until unmuted') + (reason ? ' · ' + reason : ''));
  return modUser(ctx, id);
}

async function unmuteUser(ctx, id){
  const target = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  await ctx.db.prepare('DELETE FROM mutes WHERE user_id = ?').bind(id).run();
  await logMod(ctx, 'unmute', target.username, '');
  return modUser(ctx, id);
}

async function warnUser(ctx, id){
  const target = await guardTarget(ctx, id, 'warn');
  const message = cleanText((await readBody(ctx, 4000)).message);
  if(message.length < 3 || message.length > 1000) throw new HttpError(400, 'Warnings are 3 to 1,000 characters.');
  await ctx.db.prepare('INSERT INTO warnings (user_id, by_user, message, created_at) VALUES (?, ?, ?, ?)').bind(id, ctx.user.id, message, ctx.now).run();
  await logMod(ctx, 'warn', target.username, message.slice(0, 120));
  return modUser(ctx, id);
}

async function addNote(ctx, id){
  const target = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  const note = cleanText((await readBody(ctx, 4000)).note);
  if(note.length < 1 || note.length > 1000) throw new HttpError(400, 'Notes are 1 to 1,000 characters.');
  await ctx.db.prepare('INSERT INTO mod_notes (user_id, by_user, note, created_at) VALUES (?, ?, ?, ?)').bind(id, ctx.user.id, note, ctx.now).run();
  await logMod(ctx, 'add-note', target.username, '');
  return modUser(ctx, id);
}

async function deleteNote(ctx, id){
  const row = await ctx.db.prepare('SELECT user_id FROM mod_notes WHERE id = ?').bind(id).first();
  if(!row) throw new HttpError(404, 'That note doesn’t exist.');
  await ctx.db.prepare('DELETE FROM mod_notes WHERE id = ?').bind(id).run();
  return modUser(ctx, row.user_id);
}

async function getSettings(ctx){
  const { results } = await ctx.db.prepare('SELECT word FROM blocked_words ORDER BY word').all();
  return json({ readonly:await setting(ctx, 'readonly') === '1', words:results.map(r => r.word) });
}

async function putSettings(ctx){
  const data = await readBody(ctx, 20000);
  const changes = [];
  if(typeof data.readonly === 'boolean'){
    await ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('readonly', data.readonly ? '1' : '0').run();
    changes.push(data.readonly ? 'Community read-only' : 'Community open');
  }
  if(Array.isArray(data.words)){
    const words = [...new Set(data.words.map(w => cleanLine(w).toLowerCase()).filter(w => w.length >= 2 && w.length <= 40))].slice(0, 300);
    await ctx.db.batch([ctx.db.prepare('DELETE FROM blocked_words'), ...words.map(w => ctx.db.prepare('INSERT INTO blocked_words (word, created_at) VALUES (?, ?)').bind(w, ctx.now))]);
    changes.push(words.length + (words.length === 1 ? ' blocked word' : ' blocked words'));
  }
  if(changes.length) await logMod(ctx, 'settings', '', changes.join(' · '));
  return getSettings(ctx);
}

async function modOverview(ctx){
  const n = async sql => (await ctx.db.prepare(sql).bind(...(sql.includes('?') ? [ctx.now] : [])).first()).n;
  return json({
    accounts:await n('SELECT COUNT(*) AS n FROM users'),
    posts:await n('SELECT COUNT(*) AS n FROM posts WHERE deleted = 0'),
    replies:await n('SELECT COUNT(*) AS n FROM replies WHERE deleted = 0'),
    reports:await n(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`),
    banned:await n('SELECT COUNT(*) AS n FROM bans WHERE until IS NULL OR until > ?'),
    muted:await n('SELECT COUNT(*) AS n FROM mutes WHERE until IS NULL OR until > ?'),
    readonly:await setting(ctx, 'readonly') === '1',
    news:await n('SELECT COUNT(*) AS n FROM news WHERE deleted = 0')
  });
}

const USER_COLUMNS = `u.id, u.username, u.created_at, a.updated_at AS avatar_v,
  (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.deleted = 0) AS posts,
  (SELECT COUNT(*) FROM replies r WHERE r.user_id = u.id AND r.deleted = 0) AS replies,
  (SELECT MAX(t) FROM (SELECT MAX(created_at) AS t FROM posts WHERE user_id = u.id UNION ALL SELECT MAX(created_at) FROM replies WHERE user_id = u.id)) AS last_post,
  (SELECT COUNT(*) FROM reports rp WHERE rp.status = 'open' AND ((rp.kind = 'post' AND rp.target_id IN (SELECT id FROM posts WHERE user_id = u.id)) OR (rp.kind = 'reply' AND rp.target_id IN (SELECT id FROM replies WHERE user_id = u.id)))) AS reports,
  EXISTS (SELECT 1 FROM mod_sessions ms JOIN sessions s ON s.token_hash = ms.token_hash WHERE s.user_id = u.id AND ms.expires_at > ?) AS mod_now,
  b.reason AS ban_reason, b.until AS ban_until, b.created_at AS banned_at,
  mu.reason AS mute_reason, mu.until AS mute_until, mu.created_at AS muted_at`;
const USER_JOINS = `FROM users u LEFT JOIN avatars a ON a.user_id = u.id LEFT JOIN bans b ON b.user_id = u.id AND (b.until IS NULL OR b.until > ?)
  LEFT JOIN mutes mu ON mu.user_id = u.id AND (mu.until IS NULL OR mu.until > ?)`;
function modUserJson(ctx, r){
  return {
    id:r.id, username:r.username, createdAt:r.created_at, avatar:r.avatar_v || null, posts:r.posts, replies:r.replies, lastPost:r.last_post || null,
    reports:r.reports, moderator:!!r.mod_now || siteAdmin(ctx, r.username), siteAdmin:siteAdmin(ctx, r.username),
    ban:r.banned_at ? { reason:r.ban_reason, until:r.ban_until || null, since:r.banned_at } : null,
    mute:r.muted_at ? { reason:r.mute_reason, until:r.mute_until || null, since:r.muted_at } : null
  };
}

async function modUsers(ctx){
  const q = ctx.url.searchParams;
  const page = Math.max(0, Math.min(500, parseInt(q.get('page') || '0', 10) || 0));
  const search = cleanLine(q.get('q')).slice(0, 40).replace(/[\\%_]/g, c => '\\' + c);
  const filter = q.get('filter') || 'all';
  const where = ['u.username LIKE ? ESCAPE \'\\\''];
  if(filter === 'banned') where.push('b.user_id IS NOT NULL');
  if(filter === 'muted') where.push('mu.user_id IS NOT NULL');
  if(filter === 'reported') where.push(`EXISTS (SELECT 1 FROM reports rp WHERE rp.status = 'open' AND ((rp.kind = 'post' AND rp.target_id IN (SELECT id FROM posts WHERE user_id = u.id)) OR (rp.kind = 'reply' AND rp.target_id IN (SELECT id FROM replies WHERE user_id = u.id))))`);
  const order = q.get('sort') === 'active' ? 'last_post DESC NULLS LAST, u.id DESC' : q.get('sort') === 'name' ? 'u.username COLLATE NOCASE ASC' : 'u.created_at DESC, u.id DESC';
  const { results } = await ctx.db.prepare(
    `SELECT ${USER_COLUMNS} ${USER_JOINS} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(ctx.now, ctx.now, ctx.now, '%' + search + '%', 31, page * 30).all();
  const total = (await ctx.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
  return json({ users:results.slice(0, 30).map(r => modUserJson(ctx, r)), more:results.length > 30, total });
}

async function modUser(ctx, id){
  const row = await ctx.db.prepare(`SELECT ${USER_COLUMNS} ${USER_JOINS} WHERE u.id = ?`).bind(ctx.now, ctx.now, ctx.now, id).first();
  if(!row) throw new HttpError(404, 'That account doesn’t exist.');
  const posts = (await ctx.db.prepare('SELECT id, title, substr(body, 1, 200) AS excerpt, created_at, deleted FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(id).all()).results;
  const replies = (await ctx.db.prepare(
    `SELECT r.id, r.post_id, p.title AS post_title, substr(r.body, 1, 200) AS excerpt, r.created_at, r.deleted
       FROM replies r LEFT JOIN posts p ON p.id = r.post_id WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`).bind(id).all()).results;
  const warnings = (await ctx.db.prepare('SELECT w.id, w.message, w.created_at, w.seen_at, u.username FROM warnings w LEFT JOIN users u ON u.id = w.by_user WHERE w.user_id = ? ORDER BY w.created_at DESC LIMIT 30').bind(id).all()).results;
  const notes = (await ctx.db.prepare('SELECT n.id, n.note, n.created_at, u.username FROM mod_notes n LEFT JOIN users u ON u.id = n.by_user WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50').bind(id).all()).results;
  return json({
    user:modUserJson(ctx, row),
    badges:await badgesFor(ctx, id),
    warnings:warnings.map(w => ({ id:w.id, message:w.message, createdAt:w.created_at, seen:!!w.seen_at, by:w.username || null })),
    notes:notes.map(n => ({ id:n.id, note:n.note, createdAt:n.created_at, by:n.username || null })),
    posts:posts.map(p => ({ id:p.id, title:p.title, excerpt:p.excerpt, createdAt:p.created_at, removed:!!p.deleted })),
    replies:replies.map(r => ({ id:r.id, postId:r.post_id, postTitle:r.post_title, excerpt:r.excerpt, createdAt:r.created_at, removed:!!r.deleted }))
  });
}

async function banUser(ctx, id){
  const me = ctx.user;
  const target = await ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  if(target.id === me.id) throw new HttpError(400, 'You can’t ban your own account.');
  if(siteAdmin(ctx, target.username)) throw new HttpError(403, 'Site administrators can’t be banned.');
  const data = await readBody(ctx, 2000);
  const days = Number(data.days) || 0;
  if(days && (days < 0 || days > 3650)) throw new HttpError(400, 'Choose how long the ban lasts.');
  const until = days ? ctx.now + days * 86400000 : null;
  const reason = cleanLine(data.reason).slice(0, 300);
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO bans (user_id, reason, until, by_user, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, until = excluded.until, by_user = excluded.by_user, created_at = excluded.created_at')
      .bind(id, reason, until, me.id, ctx.now),
    ctx.db.prepare('DELETE FROM mod_sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id = ?)').bind(id),
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id)
  ]);
  await logMod(ctx, 'ban', target.username, (days ? days + (days === 1 ? ' day' : ' days') : 'permanent') + (reason ? ' · ' + reason : ''));
  if(data.removeContent) await removeContent(ctx, id, false);
  return modUser(ctx, id);
}

async function unbanUser(ctx, id){
  const target = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  await ctx.db.prepare('DELETE FROM bans WHERE user_id = ?').bind(id).run();
  await logMod(ctx, 'unban', target.username, '');
  return modUser(ctx, id);
}

async function removeContent(ctx, id, respond){
  const target = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  const counts = await ctx.db.prepare(
    'SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ? AND deleted = 0) AS posts, (SELECT COUNT(*) FROM replies WHERE user_id = ? AND deleted = 0) AS replies'
  ).bind(id, id).first();
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE reports SET status = 'resolved' WHERE status = 'open' AND ((kind = 'post' AND target_id IN (SELECT id FROM posts WHERE user_id = ?)) OR (kind = 'reply' AND target_id IN (SELECT id FROM replies WHERE user_id = ?)))`).bind(id, id),
    ctx.db.prepare('UPDATE posts SET deleted = 1 WHERE user_id = ? AND deleted = 0').bind(id),
    ctx.db.prepare('UPDATE replies SET deleted = 1 WHERE user_id = ? AND deleted = 0').bind(id),
    ctx.db.prepare('UPDATE posts SET reply_count = (SELECT COUNT(*) FROM replies r WHERE r.post_id = posts.id AND r.deleted = 0) WHERE id IN (SELECT DISTINCT post_id FROM replies WHERE user_id = ?)').bind(id)
  ]);
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  await logMod(ctx, 'remove-all', target.username, `${n(counts.posts, 'post', 'posts')}, ${n(counts.replies, 'reply', 'replies')}`);
  return respond ? modUser(ctx, id) : null;
}

async function modReports(ctx){
  const { results } = await ctx.db.prepare(
    `SELECT rp.id, rp.kind, rp.target_id, rp.post_id, rp.reason, rp.created_at, ru.username AS reporter, p.title AS post_title,
            CASE rp.kind WHEN 'post' THEN substr(p.body, 1, 400) ELSE substr(rr.body, 1, 400) END AS excerpt,
            CASE rp.kind WHEN 'post' THEN pu.username ELSE rru.username END AS author,
            CASE rp.kind WHEN 'post' THEN p.user_id ELSE rr.user_id END AS author_id,
            (SELECT COUNT(*) FROM reports x WHERE x.status = 'open' AND x.kind = rp.kind AND x.target_id = rp.target_id) AS times
       FROM reports rp
       LEFT JOIN users ru ON ru.id = rp.reporter_id
       LEFT JOIN posts p ON p.id = rp.post_id
       LEFT JOIN users pu ON pu.id = p.user_id
       LEFT JOIN replies rr ON rp.kind = 'reply' AND rr.id = rp.target_id
       LEFT JOIN users rru ON rru.id = rr.user_id
      WHERE rp.status = 'open' ORDER BY rp.created_at DESC LIMIT 100`
  ).all();
  return json({ reports:results.map(r => ({
    id:r.id, kind:r.kind, targetId:r.target_id, postId:r.post_id, postTitle:r.post_title, reason:r.reason, createdAt:r.created_at,
    reporter:r.reporter || null, author:r.author || null, authorId:r.author_id || null, excerpt:r.excerpt || '', times:r.times
  })) });
}

async function dismissReport(ctx, id){
  const r = await ctx.db.prepare(`SELECT kind, target_id FROM reports WHERE id = ? AND status = 'open'`).bind(id).first();
  if(!r) throw new HttpError(404, 'That report has already been handled.');
  await ctx.db.prepare(`UPDATE reports SET status = 'dismissed' WHERE status = 'open' AND kind = ? AND target_id = ?`).bind(r.kind, r.target_id).run();
  await logMod(ctx, 'dismiss-report', r.kind + ' ' + r.target_id, '');
  return json({ ok:true });
}

async function modLogList(ctx){
  const { results } = await ctx.db.prepare(
    'SELECT l.id, l.action, l.target, l.detail, l.created_at, u.username FROM mod_log l LEFT JOIN users u ON u.id = l.mod_id ORDER BY l.created_at DESC, l.id DESC LIMIT 150'
  ).all();
  return json({ log:results.map(r => ({ id:r.id, action:r.action, target:r.target, detail:r.detail, createdAt:r.created_at, by:r.username || null })) });
}

/* ---------- News: everyone reads, moderators write ---------- */
const NEWS_PAGE = 10;
function requireModerator(ctx, message = 'Only moderators can do that.'){
  const user = requireUser(ctx);
  if(!user.admin) throw new HttpError(403, message);
  return user;
}

async function listNews(ctx){
  const page = Math.max(0, Math.min(500, parseInt(ctx.url.searchParams.get('page') || '0', 10) || 0));
  const { results } = await ctx.db.prepare(
    `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, u.username, a.updated_at AS avatar_v
       FROM news n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN avatars a ON a.user_id = n.user_id
      WHERE n.deleted = 0 ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`
  ).bind(NEWS_PAGE + 1, page * NEWS_PAGE).all();
  return json({
    news:results.slice(0, NEWS_PAGE).map(r => ({
      id:r.id, title:r.title, body:r.body, author:r.username || null, authorAvatar:r.username ? r.avatar_v || null : null,
      createdAt:r.created_at, updatedAt:r.updated_at || null
    })),
    more:results.length > NEWS_PAGE,
    canWrite:!!(ctx.user && ctx.user.admin)
  });
}

async function saveNews(ctx, id){
  const user = requireModerator(ctx, 'Only moderators can post news.');
  const data = await readBody(ctx, 30000);
  const title = cleanLine(data.title), body = cleanText(data.body);
  if(title.length < 3 || title.length > 140) throw new HttpError(400, 'Titles need 3 to 140 characters.');
  if(body.length < 10 || body.length > 10000) throw new HttpError(400, 'News posts need 10 to 10,000 characters.');
  if(id === null){
    await limit(ctx, 'news:' + user.id, 20, 60 * 60 * 1000, 'That’s a lot of news at once. Please wait a little before posting more.');
    const result = await ctx.db.prepare('INSERT INTO news (user_id, title, body, created_at) VALUES (?, ?, ?, ?)').bind(user.id, title, body, ctx.now).run();
    await logMod(ctx, 'publish-news', 'news ' + result.meta.last_row_id, title);
    return json({ id:result.meta.last_row_id }, 201);
  }
  const found = await ctx.db.prepare('SELECT id FROM news WHERE id = ? AND deleted = 0').bind(id).first();
  if(!found) throw new HttpError(404, 'That news post wasn’t found.');
  await ctx.db.prepare('UPDATE news SET title = ?, body = ?, updated_at = ? WHERE id = ?').bind(title, body, ctx.now, id).run();
  await logMod(ctx, 'edit-news', 'news ' + id, title);
  return json({ id });
}

async function deleteNews(ctx, id){
  requireModerator(ctx);
  const found = await ctx.db.prepare('SELECT id FROM news WHERE id = ? AND deleted = 0').bind(id).first();
  if(!found) throw new HttpError(404, 'That news post wasn’t found.');
  await ctx.db.prepare('UPDATE news SET deleted = 1 WHERE id = ?').bind(id).run();
  await logMod(ctx, 'delete-news', 'news ' + id, '');
  return json({ ok:true });
}

/* ---------- Moderator mode ---------- */
// The password is the Cloudflare secret MOD_PASSWORD. Both sides are hashed before comparing, so the
// comparison takes the same time however many characters match. Tries are limited per device and per member.
async function enterModerator(ctx){
  const user = requireUser(ctx);
  const secret = ctx.env.MOD_PASSWORD;
  if(!secret) throw new HttpError(503, 'Moderator access isn’t set up yet.');
  await limit(ctx, 'mod-ip:' + await ipKey(ctx), 5, 15 * 60 * 1000, 'Too many tries. Please wait 15 minutes and try again.');
  await limit(ctx, 'mod-user:' + user.id, 5, 15 * 60 * 1000, 'Too many tries. Please wait 15 minutes and try again.');
  const body = await readBody(ctx, 1000);
  const password = typeof body.password === 'string' ? body.password : '';
  if(!password || password.length > 128 || !sameHash(await sha256(password), await sha256(secret))){
    throw new HttpError(403, 'That moderator password isn’t right.');
  }
  await ctx.db.prepare('INSERT INTO mod_sessions (token_hash, expires_at) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at')
    .bind(ctx.tokenHash, user.session_expires).run();
  await logMod(ctx, 'moderator-on', '', '');
  return json({ user:publicUser(withRole(ctx, { ...user, mod_token:ctx.tokenHash })) });
}

async function leaveModerator(ctx){
  const user = requireUser(ctx);
  await ctx.db.prepare('DELETE FROM mod_sessions WHERE token_hash = ?').bind(ctx.tokenHash).run();
  return json({ user:publicUser(withRole(ctx, { ...user, mod_token:null })) });
}

/* ---------- Sessions ---------- */
async function currentUser(ctx){
  const token = readCookie(ctx.request, COOKIE);
  if(!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  ctx.tokenHash = await sha256(token);
  const row = await ctx.db.prepare(
    `SELECT u.id, u.username, u.created_at, a.updated_at AS avatar_v, s.expires_at AS session_expires, m.token_hash AS mod_token
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN avatars a ON a.user_id = u.id
     LEFT JOIN mod_sessions m ON m.token_hash = s.token_hash AND m.expires_at > ?
     LEFT JOIN bans b ON b.user_id = u.id AND (b.until IS NULL OR b.until > ?)
     WHERE s.token_hash = ? AND s.expires_at > ? AND b.user_id IS NULL`
  ).bind(ctx.now, ctx.now, ctx.tokenHash, ctx.now).first();
  return row ? withRole(ctx, row) : null;
}

async function startSession(ctx, userId){
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await ctx.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, ctx.now + maxAge * 1000).run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(){ return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }

function withRole(ctx, user){
  const admins = String(ctx.env.ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const modMode = !!user.mod_token, site = admins.includes(user.username.toLowerCase());
  return { ...user, modMode, site, admin:modMode || site };
}

function publicUser(user){
  return user ? { username:user.username, createdAt:user.created_at, admin:!!user.admin, modMode:!!user.modMode, siteAdmin:!!user.site, avatar:user.avatar_v || null } : null;
}

function requireUser(ctx){
  if(!ctx.user) throw new HttpError(401, 'Please sign in first.');
  return ctx.user;
}

/* ---------- Helpers ---------- */
async function limit(ctx, key, max, windowMs, message){
  const row = await ctx.db.prepare('SELECT count, reset_at FROM limits WHERE key = ?').bind(key).first();
  if(row && row.reset_at > ctx.now){
    if(row.count >= max) throw new HttpError(429, message);
    await ctx.db.prepare('UPDATE limits SET count = count + 1 WHERE key = ?').bind(key).run();
  } else {
    await ctx.db.prepare('INSERT INTO limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at')
      .bind(key, ctx.now + windowMs).run();
    if(Math.random() < 0.05) await ctx.db.prepare('DELETE FROM limits WHERE reset_at < ?').bind(ctx.now).run();
  }
}

async function ipKey(ctx){
  return (await sha256('ip:' + (ctx.request.headers.get('CF-Connecting-IP') || 'unknown'))).slice(0, 32);
}

async function readBody(ctx, max = 20000){
  const type = ctx.request.headers.get('Content-Type') || '';
  if(!type.includes('application/json')) throw new HttpError(415, 'Expected JSON.');
  const text = await ctx.request.text();
  if(text.length > max) throw new HttpError(413, 'That’s too long.');
  try{
    const data = JSON.parse(text);
    if(!data || typeof data !== 'object') throw new Error('not an object');
    return data;
  }catch(err){
    throw new HttpError(400, 'Could not read the request.');
  }
}

function checkPassword(password){
  if(typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if(password.length > 128) throw new HttpError(400, 'Passwords can be at most 128 characters.');
}

function cleanLine(value){ return String(value || '').replace(/\s+/g, ' ').trim(); }

function cleanText(value){
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function readCookie(request, name){
  const header = request.headers.get('Cookie') || '';
  for(const part of header.split(';')){
    const i = part.indexOf('=');
    if(i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function hashPassword(password, saltHex){
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt:fromHex(saltHex), iterations:100000 }, key, 256);
  return toHex(new Uint8Array(bits));
}

async function sha256(text){
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

function sameHash(a, b){
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes){ return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(hex){ return new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16))); }

function json(data, status = 200, headers = {}){
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers }
  });
}
