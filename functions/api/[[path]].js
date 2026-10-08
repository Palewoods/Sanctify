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
    if(path === 'me' && method === 'GET') return json({ user:publicUser(ctx.user) });
    if(path === 'signup' && method === 'POST') return await signup(ctx);
    if(path === 'login' && method === 'POST') return await login(ctx);
    if(path === 'logout' && method === 'POST') return await logout(ctx);
    if(path === 'account' && method === 'DELETE') return await deleteAccount(ctx);
    if(path === 'moderator' && method === 'POST') return await enterModerator(ctx);
    if(path === 'moderator' && method === 'DELETE') return await leaveModerator(ctx);
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
  const { results } = await ctx.db.prepare(
    `SELECT p.id, p.category, p.title, substr(p.body, 1, 240) AS excerpt, p.created_at, p.last_activity,
            p.reply_count, p.prayer_count, u.username, a.updated_at AS avatar_v
       FROM posts p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN avatars a ON a.user_id = p.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.last_activity DESC, p.id DESC
      LIMIT ? OFFSET ?`
  ).bind(...args, PAGE_SIZE + 1, page * PAGE_SIZE).all();
  return json({
    posts:results.slice(0, PAGE_SIZE).map(r => ({
      id:r.id, category:r.category, title:r.title, excerpt:r.excerpt, author:r.username || null, authorAvatar:r.username ? r.avatar_v || null : null,
      createdAt:r.created_at, lastActivity:r.last_activity, replies:r.reply_count, prayers:r.prayer_count
    })),
    more:results.length > PAGE_SIZE
  });
}

async function getPost(ctx, id){
  const post = await ctx.db.prepare(
    `SELECT p.*, u.username, a.updated_at AS avatar_v FROM posts p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN avatars a ON a.user_id = p.user_id WHERE p.id = ? AND p.deleted = 0`
  ).bind(id).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
  const { results } = await ctx.db.prepare(
    `SELECT r.id, r.user_id, r.body, r.created_at, u.username, a.updated_at AS avatar_v FROM replies r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN avatars a ON a.user_id = r.user_id
      WHERE r.post_id = ? AND r.deleted = 0 ORDER BY r.created_at ASC, r.id ASC LIMIT 500`
  ).bind(id).all();
  const user = ctx.user;
  const prayed = user ? !!(await ctx.db.prepare('SELECT 1 FROM prayers WHERE post_id = ? AND user_id = ?').bind(id, user.id).first()) : false;
  const canRemove = ownerId => !!user && (user.id === ownerId || user.admin);
  return json({
    post:{
      id:post.id, category:post.category, title:post.title, body:post.body, author:post.username || null, authorAvatar:post.username ? post.avatar_v || null : null,
      createdAt:post.created_at, replies:post.reply_count, prayers:post.prayer_count, prayed,
      mine:!!user && user.id === post.user_id, canRemove:canRemove(post.user_id)
    },
    replies:results.map(r => ({
      id:r.id, body:r.body, author:r.username || null, authorAvatar:r.username ? r.avatar_v || null : null, createdAt:r.created_at,
      mine:!!user && user.id === r.user_id, canRemove:canRemove(r.user_id)
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
  const post = await ctx.db.prepare('SELECT id FROM posts WHERE id = ? AND deleted = 0').bind(postId).first();
  if(!post) throw new HttpError(404, 'This post doesn’t exist or has been removed.');
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
  await ctx.db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(id).run();
  return json({ ok:true });
}

async function deleteReply(ctx, id){
  const user = requireUser(ctx);
  const reply = await ctx.db.prepare('SELECT user_id, post_id FROM replies WHERE id = ? AND deleted = 0').bind(id).first();
  if(!reply) throw new HttpError(404, 'This reply doesn’t exist or has already been removed.');
  if(reply.user_id !== user.id && !user.admin) throw new HttpError(403, 'You can only remove your own replies.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE replies SET deleted = 1 WHERE id = ?').bind(id),
    ctx.db.prepare('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?').bind(reply.post_id)
  ]);
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

/* ---------- News: everyone reads, moderators write ---------- */
const NEWS_PAGE = 10;
function requireModerator(ctx){
  const user = requireUser(ctx);
  if(!user.admin) throw new HttpError(403, 'Only moderators can post news.');
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
  const user = requireModerator(ctx);
  const data = await readBody(ctx, 30000);
  const title = cleanLine(data.title), body = cleanText(data.body);
  if(title.length < 3 || title.length > 140) throw new HttpError(400, 'Titles need 3 to 140 characters.');
  if(body.length < 10 || body.length > 10000) throw new HttpError(400, 'News posts need 10 to 10,000 characters.');
  if(id === null){
    await limit(ctx, 'news:' + user.id, 20, 60 * 60 * 1000, 'That’s a lot of news at once. Please wait a little before posting more.');
    const result = await ctx.db.prepare('INSERT INTO news (user_id, title, body, created_at) VALUES (?, ?, ?, ?)').bind(user.id, title, body, ctx.now).run();
    return json({ id:result.meta.last_row_id }, 201);
  }
  const found = await ctx.db.prepare('SELECT id FROM news WHERE id = ? AND deleted = 0').bind(id).first();
  if(!found) throw new HttpError(404, 'That news post wasn’t found.');
  await ctx.db.prepare('UPDATE news SET title = ?, body = ?, updated_at = ? WHERE id = ?').bind(title, body, ctx.now, id).run();
  return json({ id });
}

async function deleteNews(ctx, id){
  requireModerator(ctx);
  const found = await ctx.db.prepare('SELECT id FROM news WHERE id = ? AND deleted = 0').bind(id).first();
  if(!found) throw new HttpError(404, 'That news post wasn’t found.');
  await ctx.db.prepare('UPDATE news SET deleted = 1 WHERE id = ?').bind(id).run();
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
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(ctx.now, ctx.tokenHash, ctx.now).first();
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
  const modMode = !!user.mod_token;
  return { ...user, modMode, admin:modMode || admins.includes(user.username.toLowerCase()) };
}

function publicUser(user){
  return user ? { username:user.username, createdAt:user.created_at, admin:!!user.admin, modMode:!!user.modMode, avatar:user.avatar_v || null } : null;
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
