/* =========================================================
   Sanctify Community API: accounts, posts, and replies
   ---------------------------------------------------------
   A Cloudflare Pages Function that answers every request to /api/*.
   It needs a D1 database bound to this Pages project under the name DB
   (Cloudflare dashboard → Workers & Pages → sanctify → Settings → Bindings).
   The tables are created automatically on the first request.

   Optional environment variables (Settings → Variables and Secrets):
     ADMINS         comma-separated usernames of the site administrators. They can do everything a
                    moderator can, and they choose the moderators (on a member's page in Moderate).

   Moderators can remove any post or reply. They can also see and search every account, ban members (for a time or for good), remove
   everything a member has posted, review reported posts and replies, pin and lock threads, and read a
   log of every moderator action.

   Passwords are salted and hashed with PBKDF2; sign-ins are kept in an
   HttpOnly cookie, and only a hash of each session token is stored.
   Profile pictures are small JPEG, PNG, or WebP images (resized in the
   browser before upload), checked by their file signature and stored in D1.
   Profile banners are either one of the preset designs (stored by name)
   or a wide picture, checked and stored the same way.

   AutoMod turns back spam (links from brand-new accounts, too many links,
   shouting, long runs of one character, the same text posted twice) and
   hides a post or reply once several members report it, until a moderator
   restores it or keeps it removed. Moderators can switch it off.

   The Community Wiki: pages any member can write and edit, with every
   revision kept so a page can be compared or restored. Moderators can lock
   or remove a page.
   ========================================================= */

const CATEGORIES = ['general', 'prayer', 'faith', 'saints', 'study'];
const COOKIE = '__Host-sanctify';
const SESSION_DAYS = 30;
const PAGE_SIZE = 20;
const AVATAR_MAX_BYTES = 120 * 1024;
const BIO_MAX = 300;
const BANNER_MAX_BYTES = 300 * 1024;
// The preset banner designs (kept in step with BANNER_PRESETS in index.html)
const BANNER_PRESETS = ['stained-glass', 'starry-mantle', 'gold-leaf', 'easter-dawn', 'roses', 'cloister', 'advent', 'stella-maris', 'byzantine', 'ordinary-time', 'pentecost', 'lily'];
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
  `CREATE TABLE IF NOT EXISTS banners (
     user_id INTEGER PRIMARY KEY,
     preset TEXT,
     mime TEXT,
     data TEXT,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS held (
     kind TEXT NOT NULL,
     target_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (kind, target_id))`,
  `CREATE TABLE IF NOT EXISTS wiki_pages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     slug TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     created_by INTEGER,
     created_at INTEGER NOT NULL,
     updated_by INTEGER,
     updated_at INTEGER NOT NULL,
     revisions INTEGER NOT NULL DEFAULT 1,
     locked INTEGER NOT NULL DEFAULT 0,
     deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS wiki_pages_by_update ON wiki_pages (deleted, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS wiki_revisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     page_id INTEGER NOT NULL,
     user_id INTEGER,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     delta INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS wiki_revisions_by_page ON wiki_revisions (page_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS wiki_revisions_by_user ON wiki_revisions (user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS wiki_revisions_by_date ON wiki_revisions (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS profiles (
     user_id INTEGER PRIMARY KEY,
     bio TEXT NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS roles (
     user_id INTEGER PRIMARY KEY,
     role TEXT NOT NULL,
     by_user INTEGER,
     created_at INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO roles (user_id, role, by_user, created_at)
     SELECT DISTINCT s.user_id, 'moderator', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM mod_sessions m JOIN sessions s ON s.token_hash = m.token_hash
      WHERE m.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000`,
  `DELETE FROM mod_sessions`,
  `CREATE TABLE IF NOT EXISTS favorites (
     user_id INTEGER PRIMARY KEY,
     ids TEXT NOT NULL,
     updated_at INTEGER NOT NULL)`,
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
    if((m = path.match(/^banner\/([A-Za-z0-9_]{3,20})$/)) && (method === 'GET' || method === 'HEAD')) return await getBanner(ctx, m[1]);
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
    if(path === 'moderator') throw new HttpError(410, 'Moderators are now chosen by the site administrators, so there’s no password to enter.');
    if(path.startsWith('mod/')) return await modRoute(ctx, path.slice(4), method);
    if((m = path.match(/^(posts|replies)\/(\d+)\/report$/)) && method === 'POST') return await report(ctx, m[1] === 'posts' ? 'post' : 'reply', Number(m[2]));
    if((m = path.match(/^posts\/(\d+)\/(pin|lock)$/)) && method === 'POST') return await flagPost(ctx, Number(m[1]), m[2]);
    if((m = path.match(/^posts\/(\d+)\/move$/)) && method === 'POST') return await movePost(ctx, Number(m[1]));
    if((m = path.match(/^replies\/(\d+)$/)) && method === 'PUT') return await editReply(ctx, Number(m[1]));
    if(path === 'team' && method === 'GET') return await getTeam(ctx);
    if(path === 'news' && method === 'GET') return await listNews(ctx);
    if(path === 'news' && method === 'POST') return await saveNews(ctx, null);
    if((m = path.match(/^news\/(\d+)$/))){
      if(method === 'PUT') return await saveNews(ctx, Number(m[1]));
      if(method === 'DELETE') return await deleteNews(ctx, Number(m[1]));
    }
    if(path === 'account/avatar' && method === 'PUT') return await setAvatar(ctx);
    if(path === 'account/avatar' && method === 'DELETE') return await removeAvatar(ctx);
    if(path === 'account/profile' && method === 'PUT') return await setProfile(ctx);
    if(path === 'account/favorites' && method === 'PUT') return await setFavorites(ctx);
    if(path === 'wiki' && method === 'GET') return await listWiki(ctx);
    if(path === 'wiki/changes' && method === 'GET') return await wikiChanges(ctx);
    if(path === 'wiki/pages' && method === 'POST') return await createWikiPage(ctx);
    if((m = path.match(/^wiki\/pages\/([a-z0-9-]{1,80})$/))){
      if(method === 'GET') return await getWikiPage(ctx, m[1]);
      if(method === 'PUT') return await editWikiPage(ctx, m[1]);
    }
    if((m = path.match(/^wiki\/pages\/([a-z0-9-]{1,80})\/history$/)) && method === 'GET') return await wikiHistory(ctx, m[1]);
    if((m = path.match(/^wiki\/pages\/([a-z0-9-]{1,80})\/restore$/)) && method === 'POST') return await restoreWikiRevision(ctx, m[1]);
    if((m = path.match(/^wiki\/revisions\/(\d+)$/)) && method === 'GET') return await getWikiRevision(ctx, Number(m[1]));
    if(path === 'account/banner' && method === 'PUT') return await setBanner(ctx);
    if(path === 'account/banner' && method === 'DELETE') return await removeBanner(ctx);
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

  const row = name ? await ctx.db.prepare('SELECT u.id, u.username, u.pass_hash, u.salt, u.created_at, a.updated_at AS avatar_v, r.role FROM users u LEFT JOIN avatars a ON a.user_id = u.id LEFT JOIN roles r ON r.user_id = u.id WHERE u.username = ?').bind(name).first() : null;
  // Hash even when the user doesn't exist, so the response time doesn't reveal which usernames are real
  const hash = await hashPassword(String(password || ''), row ? row.salt : '00'.repeat(16));
  if(!row || !sameHash(hash, row.pass_hash)) throw new HttpError(401, 'That username and password don’t match.');
  const ban = await ctx.db.prepare('SELECT reason, until FROM bans WHERE user_id = ? AND (until IS NULL OR until > ?)').bind(row.id, ctx.now).first();
  if(ban) throw new HttpError(403, banMessage(ban));

  await ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(ctx.now).run();
  const user = { id:row.id, username:row.username, created_at:row.created_at, avatar_v:row.avatar_v, role:row.role };
  return json({ user:publicUser(withRole(ctx, user)) }, 200, { 'Set-Cookie':await startSession(ctx, row.id) });
}

async function logout(ctx){
  const token = readCookie(ctx.request, COOKIE);
  if(token){
    const hash = await sha256(token);
    await ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
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
    ctx.db.prepare('DELETE FROM roles WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM favorites WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM avatars WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM profiles WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM banners WHERE user_id = ?').bind(user.id),
    ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
  ]);
  return json({ ok:true }, 200, { 'Set-Cookie':clearCookie() });
}

/* ---------- Profile pictures ---------- */
// Checks an uploaded picture (a data: URL) by its file signature; returns its type and base64 data
function readPicture(image, maxBytes){
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+\/]+={0,2})$/.exec(String(image || ''));
  if(!m) throw new HttpError(400, 'Please choose a JPEG, PNG, or WebP picture.');
  let bytes;
  try{ bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)); }catch(err){ throw new HttpError(400, 'That picture couldn’t be read.'); }
  if(bytes.length > maxBytes) throw new HttpError(413, 'That picture is too large. Please choose a smaller one.');
  const sig = AVATAR_TYPES[m[1]];
  const webpOk = m[1] !== 'image/webp' || String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if(bytes.length < 12 || !sig.every((b, i) => bytes[i] === b) || !webpOk) throw new HttpError(400, 'That file isn’t a valid picture.');
  return { mime:m[1], data:m[2] };
}

async function setAvatar(ctx){
  const user = requireUser(ctx);
  const { image } = await readBody(ctx, 200000);
  const pic = readPicture(image, AVATAR_MAX_BYTES);
  await limit(ctx, 'avatar:' + user.id, 10, 60 * 60 * 1000, 'You’ve changed your picture several times recently. Please try again later.');
  await ctx.db.prepare('INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at')
    .bind(user.id, pic.mime, pic.data, ctx.now).run();
  return json({ user:publicUser({ ...user, avatar_v:ctx.now }) });
}

async function removeAvatar(ctx){
  const user = requireUser(ctx);
  await ctx.db.prepare('DELETE FROM avatars WHERE user_id = ?').bind(user.id).run();
  return json({ user:publicUser({ ...user, avatar_v:null }) });
}

/* ---------- Profile banners ---------- */
// What a profile shows: null, { preset:'name' }, or { image:version } for an uploaded picture
function bannerJson(row){
  if(!row || !row.banner_v) return null;
  return row.banner_preset ? { preset:row.banner_preset } : { image:row.banner_v };
}

async function setBanner(ctx){
  const user = requireUser(ctx);
  const body = await readBody(ctx, 450000);
  await limit(ctx, 'banner:' + user.id, 15, 60 * 60 * 1000, 'You’ve changed your banner several times recently. Please try again later.');
  if(body.preset !== undefined){
    if(!BANNER_PRESETS.includes(body.preset)) throw new HttpError(400, 'Please choose one of the banner designs.');
    await ctx.db.prepare('INSERT INTO banners (user_id, preset, mime, data, updated_at) VALUES (?, ?, NULL, NULL, ?) ON CONFLICT(user_id) DO UPDATE SET preset = excluded.preset, mime = NULL, data = NULL, updated_at = excluded.updated_at')
      .bind(user.id, body.preset, ctx.now).run();
    return json({ banner:{ preset:body.preset } });
  }
  const pic = readPicture(body.image, BANNER_MAX_BYTES);
  await ctx.db.prepare('INSERT INTO banners (user_id, preset, mime, data, updated_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET preset = NULL, mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at')
    .bind(user.id, pic.mime, pic.data, ctx.now).run();
  return json({ banner:{ image:ctx.now } });
}

async function removeBanner(ctx){
  const user = requireUser(ctx);
  await ctx.db.prepare('DELETE FROM banners WHERE user_id = ?').bind(user.id).run();
  return json({ banner:null });
}

// Serves an uploaded banner picture; like pictures, the ?v= version changes with it
async function getBanner(ctx, name){
  const row = await ctx.db.prepare('SELECT b.mime, b.data FROM banners b JOIN users u ON u.id = b.user_id WHERE u.username = ? AND b.data IS NOT NULL').bind(name).first();
  if(!row) return new Response('Not found', { status:404, headers:{ 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' } });
  const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
  return new Response(bytes, { status:200, headers:{
    'Content-Type':row.mime, 'Cache-Control':'public, max-age=86400', 'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; sandbox", 'Content-Disposition':'inline'
  }});
}

/* ---------- The description on a member's profile ---------- */
async function setProfile(ctx){
  const user = requireUser(ctx);
  const data = await readBody(ctx, 4000);
  const bio = cleanText(data.bio).replace(/\n{3,}/g, '\n\n');
  if(bio.length > BIO_MAX) throw new HttpError(400, `Your description can be up to ${BIO_MAX} characters.`);
  if(bio){
    try{ await checkPosting(ctx, user, [bio]); }
    catch(err){ throw err.status === 400 && /isn’t allowed/.test(err.message) ? new HttpError(400, 'Please rephrase: your description uses a word that isn’t allowed in the Community.') : err; }
  }
  await limit(ctx, 'profile:' + user.id, 20, 60 * 60 * 1000, 'You’ve changed your description several times recently. Please try again later.');
  if(bio) await ctx.db.prepare('INSERT INTO profiles (user_id, bio, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio, updated_at = excluded.updated_at')
    .bind(user.id, bio, ctx.now).run();
  else await ctx.db.prepare('DELETE FROM profiles WHERE user_id = ?').bind(user.id).run();
  return json({ bio });
}

// Serves a member's picture; the ?v= version in the URL changes whenever the picture does
// The prayers, saints, and readings a member has saved, shown on their profile only if they choose
const FAVORITES_MAX = 60;
async function setFavorites(ctx){
  const user = requireUser(ctx);
  const data = await readBody(ctx, 4000);
  await limit(ctx, 'favorites:' + user.id, 60, 60 * 60 * 1000, 'Please try again in a little while.');
  if(!data.show){
    await ctx.db.prepare('DELETE FROM favorites WHERE user_id = ?').bind(user.id).run();
    return json({ favorites:null });
  }
  const ids = [...new Set((Array.isArray(data.ids) ? data.ids : []).map(String).filter(id => /^[A-Za-z0-9_-]{1,40}$/.test(id)))].slice(0, FAVORITES_MAX);
  await ctx.db.prepare('INSERT INTO favorites (user_id, ids, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET ids = excluded.ids, updated_at = excluded.updated_at')
    .bind(user.id, JSON.stringify(ids), ctx.now).run();
  return json({ favorites:ids });
}

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
            p.reply_count, p.prayer_count, u.username, a.updated_at AS avatar_v, COALESCE(f.pinned, 0) AS pinned, COALESCE(f.locked, 0) AS locked,
            (mp.user_id IS NOT NULL) AS prayed
       FROM posts p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN avatars a ON a.user_id = p.user_id LEFT JOIN post_flags f ON f.post_id = p.id
            LEFT JOIN prayers mp ON mp.post_id = p.id AND mp.user_id = ?
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(f.pinned, 0) DESC, p.last_activity DESC, p.id DESC
      LIMIT ? OFFSET ?`
  ).bind(ctx.user ? ctx.user.id : 0, ...args, PAGE_SIZE + 1, page * PAGE_SIZE).all();
  return json({
    posts:results.slice(0, PAGE_SIZE).map(r => ({
      id:r.id, category:r.category, title:r.title, excerpt:r.excerpt, author:r.username || null, authorAvatar:r.username ? r.avatar_v || null : null,
      createdAt:r.created_at, lastActivity:r.last_activity, replies:r.reply_count, prayers:r.prayer_count, prayed:!!r.prayed, pinned:!!r.pinned, locked:!!r.locked
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
  await noRepeat(ctx, user, 'posts', body);
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
  await noRepeat(ctx, user, 'replies', body);
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
  await autoMod(ctx, user, texts);
}

/* ---------- AutoMod ---------- */
const AUTOMOD_LINK_DAYS = 1;      // new accounts wait this long before sharing links to other sites
const AUTOMOD_MAX_LINKS = 4;
const AUTOMOD_REPORTS = 3;        // default number of reports that hides a post or reply
async function autoModOn(ctx){ return await setting(ctx, 'automod') !== '0'; }
// Links to other sites (links to Sanctify itself are always welcome)
function outsideLinks(text){
  return (text.match(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi) || []).filter(u => !/^(?:https?:\/\/)?(?:www\.)?sanctify\.pages\.dev(?:[\/?#]|$)/i.test(u)).length;
}
async function autoMod(ctx, user, texts){
  if(!(await autoModOn(ctx))) return;
  const text = texts.join('\n');
  const block = async (rule, message) => {
    await logAuto(ctx, 'automod-block', user.username, rule + ': ' + text.replace(/\s+/g, ' ').slice(0, 120));
    throw new HttpError(400, message);
  };
  const links = outsideLinks(text);
  if(links && ctx.now - user.created_at < AUTOMOD_LINK_DAYS * 86400000)
    await block('link from a new account', 'New accounts can share links to other sites after their first day. Links to pages on Sanctify are always fine: use “Link a page.”');
  if(links > AUTOMOD_MAX_LINKS) await block('too many links', `Please share no more than ${AUTOMOD_MAX_LINKS} links to other sites at a time.`);
  const letters = text.match(/\p{L}/gu) || [];
  const upper = text.match(/\p{Lu}/gu) || [];
  if(letters.length >= 30 && upper.length / letters.length > 0.7) await block('shouting', 'Please don’t write in all capital letters: it reads as shouting.');
  if(/(\S)\1{11,}/u.test(text)) await block('repeated characters', 'Please remove the long run of repeated characters.');
}
// AutoMod's own entries in the moderation log
async function logAuto(ctx, action, target, detail){
  await ctx.db.prepare('INSERT INTO mod_log (mod_id, action, target, detail, created_at) VALUES (NULL, ?, ?, ?, ?)')
    .bind(action, String(target || '').slice(0, 200), String(detail || '').slice(0, 300), ctx.now).run();
}
// The same words posted twice within an hour are almost always a double tap or spam
async function noRepeat(ctx, user, table, body){
  if(user.admin || !(await autoModOn(ctx))) return;
  const dup = await ctx.db.prepare(`SELECT 1 AS x FROM ${table} WHERE user_id = ? AND body = ? AND deleted = 0 AND created_at > ? LIMIT 1`).bind(user.id, body, ctx.now - 3600000).first();
  if(dup) throw new HttpError(400, 'You’ve already posted that. If it didn’t appear, try refreshing the page.');
}
// Hides a reported post or reply once enough different members have reported it
async function autoHide(ctx, kind, id){
  if(!(await autoModOn(ctx))) return;
  const need = Number(await setting(ctx, 'automod_reports')) || AUTOMOD_REPORTS;
  const n = await ctx.db.prepare(`SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE status = 'open' AND kind = ? AND target_id = ?`).bind(kind, id).first();
  if(!n || n.n < need) return;
  const row = kind === 'post'
    ? await ctx.db.prepare('SELECT p.id, p.user_id, p.title AS label, u.username FROM posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.deleted = 0').bind(id).first()
    : await ctx.db.prepare('SELECT r.id, r.user_id, r.post_id, substr(r.body, 1, 80) AS label, u.username FROM replies r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.deleted = 0').bind(id).first();
  if(!row) return;
  if(row.username && siteAdmin(ctx, row.username)) return;
  const steps = [ctx.db.prepare('INSERT OR IGNORE INTO held (kind, target_id, created_at) VALUES (?, ?, ?)').bind(kind, id, ctx.now)];
  if(kind === 'post') steps.push(ctx.db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(id));
  else steps.push(ctx.db.prepare('UPDATE replies SET deleted = 1 WHERE id = ?').bind(id), ctx.db.prepare('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?').bind(row.post_id));
  await ctx.db.batch(steps);
  await logAuto(ctx, 'automod-hide', kind + ' ' + id, `${n.n} reports · ${row.username || 'former member'} · ${row.label || ''}`);
}
// A moderator brings back something AutoMod hid
async function restoreHeld(ctx, kind, id){
  const held = await ctx.db.prepare('SELECT 1 AS x FROM held WHERE kind = ? AND target_id = ?').bind(kind, id).first();
  if(!held) throw new HttpError(404, 'Only posts and replies hidden by AutoMod can be restored.');
  const steps = [
    ctx.db.prepare('DELETE FROM held WHERE kind = ? AND target_id = ?').bind(kind, id),
    ctx.db.prepare(`UPDATE reports SET status = 'dismissed' WHERE status = 'open' AND kind = ? AND target_id = ?`).bind(kind, id)
  ];
  if(kind === 'post') steps.push(ctx.db.prepare('UPDATE posts SET deleted = 0 WHERE id = ?').bind(id));
  else {
    const r = await ctx.db.prepare('SELECT post_id FROM replies WHERE id = ?').bind(id).first();
    steps.push(ctx.db.prepare('UPDATE replies SET deleted = 0 WHERE id = ?').bind(id));
    if(r) steps.push(ctx.db.prepare('UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?').bind(r.post_id));
  }
  await ctx.db.batch(steps);
  await logMod(ctx, 'restore', kind + ' ' + id, 'hidden by AutoMod');
  return json({ ok:true });
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
  const u = await ctx.db.prepare(`SELECT u.id, u.username, u.created_at, a.updated_at AS avatar_v, pr.bio, bn.preset AS banner_preset, bn.updated_at AS banner_v, ro.role, fv.ids AS favorites
     FROM users u LEFT JOIN roles ro ON ro.user_id = u.id LEFT JOIN favorites fv ON fv.user_id = u.id LEFT JOIN avatars a ON a.user_id = u.id LEFT JOIN profiles pr ON pr.user_id = u.id LEFT JOIN banners bn ON bn.user_id = u.id WHERE u.username = ?`).bind(name).first();
  if(!u) throw new HttpError(404, 'There’s no member by that name.');
  const counts = await ctx.db.prepare(
    'SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ? AND deleted = 0) AS posts, (SELECT COUNT(*) FROM replies WHERE user_id = ? AND deleted = 0) AS replies, (SELECT COUNT(*) FROM prayers WHERE user_id = ?) AS prayers'
  ).bind(u.id, u.id, u.id).first();
  const { results } = await ctx.db.prepare(
    `SELECT id, category, title, substr(body, 1, 200) AS excerpt, created_at, reply_count, prayer_count FROM posts WHERE user_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 20`
  ).bind(u.id).all();
  const badges = await badgesFor(ctx, u.id);
  const replies = (await ctx.db.prepare(
    `SELECT r.id, r.post_id, p.title, substr(r.body, 1, 200) AS excerpt, r.created_at FROM replies r JOIN posts p ON p.id = r.post_id AND p.deleted = 0
      WHERE r.user_id = ? AND r.deleted = 0 ORDER BY r.created_at DESC LIMIT 20`).bind(u.id).all()).results;
  const wikiCounts = await ctx.db.prepare(
    `SELECT (SELECT COUNT(*) FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id AND p.deleted = 0 WHERE r.user_id = ?) AS edits,
            (SELECT COUNT(*) FROM wiki_pages WHERE created_by = ? AND deleted = 0) AS pages,
            (SELECT COUNT(DISTINCT r.page_id) FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id AND p.deleted = 0 WHERE r.user_id = ?) AS touched`).bind(u.id, u.id, u.id).first();
  const wikiEdits = (await ctx.db.prepare(
    `SELECT r.id, r.summary, r.delta, r.created_at, p.slug, p.title, (r.id = (SELECT MIN(id) FROM wiki_revisions x WHERE x.page_id = r.page_id)) AS created
       FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id AND p.deleted = 0 WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 25`).bind(u.id).all()).results;
  return json({
    replies:replies.map(r => ({ id:r.id, postId:r.post_id, postTitle:r.title, excerpt:r.excerpt, createdAt:r.created_at })),
    wiki:{ edits:wikiCounts.edits, pages:wikiCounts.pages, touched:wikiCounts.touched,
      recent:wikiEdits.map(r => ({ id:r.id, slug:r.slug, title:r.title, summary:r.summary, delta:r.delta, createdAt:r.created_at, created:!!r.created })) },
    profile:{ id:u.id, username:u.username, createdAt:u.created_at, avatar:u.avatar_v || null, banner:bannerJson(u), bio:u.bio || '', posts:counts.posts, replies:counts.replies, prayers:counts.prayers, administrator:siteAdmin(ctx, u.username), moderator:u.role === 'moderator', badges, favorites:readFavorites(u.favorites) },
    posts:results.map(p => ({ id:p.id, category:p.category, title:p.title, excerpt:p.excerpt, createdAt:p.created_at, lastActivity:p.created_at, replies:p.reply_count, prayers:p.prayer_count, author:u.username, authorAvatar:u.avatar_v || null }))
  });
}

function readFavorites(text){
  if(!text) return null;
  try{ const ids = JSON.parse(text); return Array.isArray(ids) ? ids : null; }catch(err){ return null; }
}

/* ---------- The Community Wiki ---------- */
const WIKI_BODY_MAX = 20000;
// The page's address: its title in plain letters, or for a title in another alphabet (Зарваниця, Θεοτόκος)
// a short code made from it. index.html makes addresses the same way.
function wikiSlug(title){
  const clean = cleanLine(title);
  const latin = clean.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
  if(latin.length >= 2 || !/\p{L}/u.test(clean)) return latin;
  let h = 0x811c9dc5;
  for(const ch of clean.toLowerCase()){ h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'page-' + h.toString(36);
}
function wikiExcerpt(body){
  return String(body || '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[#*>_`-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
async function wikiPageRow(ctx, slug, withDeleted){
  return ctx.db.prepare(`SELECT p.*, cu.username AS creator, uu.username AS editor,
      (SELECT MAX(id) FROM wiki_revisions r WHERE r.page_id = p.id) AS rev
    FROM wiki_pages p LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users uu ON uu.id = p.updated_by
    WHERE p.slug = ?${withDeleted ? '' : ' AND p.deleted = 0'}`).bind(slug).first();
}
function wikiPageJson(p){
  return { slug:p.slug, title:p.title, body:p.body, createdAt:p.created_at, createdBy:p.creator || null, updatedAt:p.updated_at,
    updatedBy:p.editor || null, revisions:p.revisions, locked:!!p.locked, revision:p.rev };
}
function readWikiInput(data){
  const title = cleanLine(data.title), body = cleanText(data.body), summary = cleanLine(data.summary).slice(0, 200);
  if(title.length < 2 || title.length > 100) throw new HttpError(400, 'Page titles are 2 to 100 characters.');
  if(!wikiSlug(title)) throw new HttpError(400, 'Please give the page a title with some letters or numbers in it.');
  if(body.length < 20) throw new HttpError(400, 'Please write at least a sentence or two.');
  if(body.length > WIKI_BODY_MAX) throw new HttpError(400, `Wiki pages can be up to ${WIKI_BODY_MAX.toLocaleString('en-US')} characters.`);
  return { title, body, summary };
}

async function listWiki(ctx){
  const q = cleanLine(ctx.url.searchParams.get('q')).slice(0, 80);
  const sort = ctx.url.searchParams.get('sort') === 'recent' ? 'p.updated_at DESC' : 'p.title COLLATE NOCASE';
  const args = [];
  let where = 'p.deleted = 0';
  if(q){ where += ' AND (p.title LIKE ? OR p.body LIKE ?)'; args.push('%' + q + '%', '%' + q + '%'); }
  const { results } = await ctx.db.prepare(
    `SELECT p.slug, p.title, substr(p.body, 1, 400) AS body, p.updated_at, p.revisions, p.locked, u.username AS editor
       FROM wiki_pages p LEFT JOIN users u ON u.id = p.updated_by WHERE ${where} ORDER BY ${sort} LIMIT 300`).bind(...args).all();
  return json({ pages:results.map(p => ({ slug:p.slug, title:p.title, excerpt:wikiExcerpt(p.body), updatedAt:p.updated_at, updatedBy:p.editor || null, revisions:p.revisions, locked:!!p.locked })) });
}

async function wikiChanges(ctx){
  const { results } = await ctx.db.prepare(
    `SELECT r.id, r.summary, r.delta, r.created_at, p.slug, p.title, u.username,
            (r.id = (SELECT MIN(id) FROM wiki_revisions x WHERE x.page_id = r.page_id)) AS created
       FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id AND p.deleted = 0 LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.id DESC LIMIT 50`).all();
  return json({ changes:results.map(r => ({ id:r.id, slug:r.slug, title:r.title, summary:r.summary, delta:r.delta, createdAt:r.created_at, user:r.username || null, created:!!r.created })) });
}

async function getWikiPage(ctx, slug){
  const p = await wikiPageRow(ctx, slug, false);
  if(!p) throw new HttpError(404, 'There’s no wiki page by that name yet.');
  return json({ page:wikiPageJson(p) });
}

async function createWikiPage(ctx){
  const user = requireUser(ctx);
  const data = await readBody(ctx, 60000);
  const { title, body, summary } = readWikiInput(data);
  await checkPosting(ctx, user, [title, body, summary]);
  const slug = wikiSlug(title);
  const existing = await ctx.db.prepare('SELECT slug, deleted FROM wiki_pages WHERE slug = ?').bind(slug).first();
  if(existing) throw new HttpError(409, existing.deleted ? 'A page with that title was removed by the moderators. Please choose another title.' : 'There’s already a page with that title. You can edit it instead.');
  await limit(ctx, 'wikinew:' + user.id, 6, 60 * 60 * 1000, 'You’ve started several pages recently. Please wait a little before starting another.');
  await limit(ctx, 'wiki:' + user.id, 40, 60 * 60 * 1000, 'You’ve made many edits in a short while. Please wait a little.');
  const res = await ctx.db.prepare('INSERT INTO wiki_pages (slug, title, body, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(slug, title, body, user.id, ctx.now, user.id, ctx.now).run();
  await ctx.db.prepare('INSERT INTO wiki_revisions (page_id, user_id, title, body, summary, delta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(res.meta.last_row_id, user.id, title, body, summary || 'Started the page', body.length, ctx.now).run();
  return json({ page:wikiPageJson(await wikiPageRow(ctx, slug, false)) }, 201);
}

async function saveWikiRevision(ctx, user, p, title, body, summary){
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO wiki_revisions (page_id, user_id, title, body, summary, delta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(p.id, user.id, title, body, summary, body.length - p.body.length, ctx.now),
    ctx.db.prepare('UPDATE wiki_pages SET title = ?, body = ?, updated_by = ?, updated_at = ?, revisions = revisions + 1 WHERE id = ?')
      .bind(title, body, user.id, ctx.now, p.id)
  ]);
  return json({ page:wikiPageJson(await wikiPageRow(ctx, p.slug, false)) });
}

async function editWikiPage(ctx, slug){
  const user = requireUser(ctx);
  const p = await wikiPageRow(ctx, slug, false);
  if(!p) throw new HttpError(404, 'There’s no wiki page by that name.');
  if(p.locked && !user.admin) throw new HttpError(403, 'The moderators have locked this page, so only they can edit it.');
  const data = await readBody(ctx, 60000);
  const { title, body, summary } = readWikiInput(data);
  if(data.base !== undefined && Number(data.base) !== p.rev) throw new HttpError(409, 'Someone else changed this page while you were editing. Copy your changes, reload the page, and add them again.');
  if(title === p.title && body === p.body) throw new HttpError(400, 'You haven’t changed anything yet.');
  await checkPosting(ctx, user, [title, body, summary]);
  await limit(ctx, 'wiki:' + user.id, 40, 60 * 60 * 1000, 'You’ve made many edits in a short while. Please wait a little.');
  return saveWikiRevision(ctx, user, p, title, body, summary);
}

async function wikiHistory(ctx, slug){
  const p = await wikiPageRow(ctx, slug, false);
  if(!p) throw new HttpError(404, 'There’s no wiki page by that name.');
  const { results } = await ctx.db.prepare(
    'SELECT r.id, r.title, r.summary, r.delta, r.created_at, u.username FROM wiki_revisions r LEFT JOIN users u ON u.id = r.user_id WHERE r.page_id = ? ORDER BY r.id DESC LIMIT 200'
  ).bind(p.id).all();
  return json({ page:{ slug:p.slug, title:p.title, locked:!!p.locked, revision:p.rev },
    revisions:results.map(r => ({ id:r.id, title:r.title, summary:r.summary, delta:r.delta, createdAt:r.created_at, user:r.username || null })) });
}

async function getWikiRevision(ctx, id){
  const r = await ctx.db.prepare(
    `SELECT r.id, r.title, r.body, r.summary, r.created_at, u.username, p.slug, p.title AS page_title, (SELECT MAX(id) FROM wiki_revisions x WHERE x.page_id = r.page_id) AS latest
       FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id AND p.deleted = 0 LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`).bind(id).first();
  if(!r) throw new HttpError(404, 'That version doesn’t exist.');
  return json({ revision:{ id:r.id, title:r.title, body:r.body, summary:r.summary, createdAt:r.created_at, user:r.username || null, slug:r.slug, pageTitle:r.page_title, latest:r.id === r.latest } });
}

async function restoreWikiRevision(ctx, slug){
  const user = requireUser(ctx);
  const p = await wikiPageRow(ctx, slug, false);
  if(!p) throw new HttpError(404, 'There’s no wiki page by that name.');
  if(p.locked && !user.admin) throw new HttpError(403, 'The moderators have locked this page, so only they can change it.');
  const data = await readBody(ctx, 200);
  const r = await ctx.db.prepare('SELECT title, body, created_at FROM wiki_revisions WHERE id = ? AND page_id = ?').bind(Number(data.revision), p.id).first();
  if(!r) throw new HttpError(404, 'That version doesn’t exist.');
  if(r.title === p.title && r.body === p.body) throw new HttpError(400, 'The page already reads like that version.');
  await checkPosting(ctx, user, [r.title, r.body]);
  await limit(ctx, 'wiki:' + user.id, 40, 60 * 60 * 1000, 'You’ve made many edits in a short while. Please wait a little.');
  return saveWikiRevision(ctx, user, p, r.title, r.body, 'Restored the version of ' + new Date(r.created_at).toISOString().slice(0, 10));
}

async function lockWikiPage(ctx, slug){
  const p = await wikiPageRow(ctx, slug, false);
  if(!p) throw new HttpError(404, 'There’s no wiki page by that name.');
  const on = (await readBody(ctx, 200)).on ? 1 : 0;
  await ctx.db.prepare('UPDATE wiki_pages SET locked = ? WHERE id = ?').bind(on, p.id).run();
  await logMod(ctx, on ? 'wiki-lock' : 'wiki-unlock', p.title, '');
  return json({ ok:true, locked:!!on });
}

async function deleteWikiPage(ctx, slug){
  const p = await wikiPageRow(ctx, slug, false);
  if(!p) throw new HttpError(404, 'There’s no wiki page by that name.');
  await ctx.db.prepare('UPDATE wiki_pages SET deleted = 1 WHERE id = ?').bind(p.id).run();
  await logMod(ctx, 'wiki-delete', p.title, `${p.revisions} revisions`);
  return json({ ok:true });
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
  await autoHide(ctx, kind, id);
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
  if((m = sub.match(/^users\/(\d+)\/bio$/)) && method === 'DELETE') return await clearBio(ctx, Number(m[1]));
  if((m = sub.match(/^users\/(\d+)\/avatar$/)) && method === 'DELETE') return await clearAvatar(ctx, Number(m[1]));
  if((m = sub.match(/^users\/(\d+)\/banner$/)) && method === 'DELETE') return await clearBanner(ctx, Number(m[1]));
  if((m = sub.match(/^restore\/(post|reply)\/(\d+)$/)) && method === 'POST') return await restoreHeld(ctx, m[1], Number(m[2]));
  if((m = sub.match(/^wiki\/([a-z0-9-]{1,80})\/lock$/)) && method === 'POST') return await lockWikiPage(ctx, m[1]);
  if((m = sub.match(/^wiki\/([a-z0-9-]{1,80})$/)) && method === 'DELETE') return await deleteWikiPage(ctx, m[1]);
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
  if((m = sub.match(/^users\/(\d+)\/role$/)) && method === 'PUT') return await setRole(ctx, Number(m[1]));
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
  if(!ctx.user.site && await isModerator(ctx, target.id)) throw new HttpError(403, `Only the site administrators can ${verb} a moderator.`);
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
  return json({ readonly:await setting(ctx, 'readonly') === '1', words:results.map(r => r.word),
    automod:await autoModOn(ctx), automodReports:Number(await setting(ctx, 'automod_reports')) || AUTOMOD_REPORTS });
}

async function putSettings(ctx){
  const data = await readBody(ctx, 20000);
  const changes = [];
  if(typeof data.readonly === 'boolean'){
    await ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('readonly', data.readonly ? '1' : '0').run();
    changes.push(data.readonly ? 'Community read-only' : 'Community open');
  }
  if(typeof data.automod === 'boolean'){
    await ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('automod', data.automod ? '1' : '0').run();
    changes.push(data.automod ? 'AutoMod on' : 'AutoMod off');
  }
  if(data.automodReports !== undefined){
    const n = Math.round(Number(data.automodReports));
    if(!(n >= 2 && n <= 20)) throw new HttpError(400, 'AutoMod can hide after 2 to 20 reports.');
    await ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('automod_reports', String(n)).run();
    changes.push(`AutoMod hides after ${n} reports`);
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
  EXISTS (SELECT 1 FROM roles ro WHERE ro.user_id = u.id AND ro.role = 'moderator') AS mod_now,
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
  ).bind(ctx.now, ctx.now, '%' + search + '%', 31, page * 30).all();
  const total = (await ctx.db.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
  return json({ users:results.slice(0, 30).map(r => modUserJson(ctx, r)), more:results.length > 30, total });
}

async function modUser(ctx, id){
  const row = await ctx.db.prepare(`SELECT ${USER_COLUMNS} ${USER_JOINS} WHERE u.id = ?`).bind(ctx.now, ctx.now, id).first();
  if(!row) throw new HttpError(404, 'That account doesn’t exist.');
  const posts = (await ctx.db.prepare('SELECT id, title, substr(body, 1, 200) AS excerpt, created_at, deleted FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(id).all()).results;
  const replies = (await ctx.db.prepare(
    `SELECT r.id, r.post_id, p.title AS post_title, substr(r.body, 1, 200) AS excerpt, r.created_at, r.deleted
       FROM replies r LEFT JOIN posts p ON p.id = r.post_id WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`).bind(id).all()).results;
  const warnings = (await ctx.db.prepare('SELECT w.id, w.message, w.created_at, w.seen_at, u.username FROM warnings w LEFT JOIN users u ON u.id = w.by_user WHERE w.user_id = ? ORDER BY w.created_at DESC LIMIT 30').bind(id).all()).results;
  const notes = (await ctx.db.prepare('SELECT n.id, n.note, n.created_at, u.username FROM mod_notes n LEFT JOIN users u ON u.id = n.by_user WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50').bind(id).all()).results;
  const profile = await ctx.db.prepare('SELECT bio FROM profiles WHERE user_id = ?').bind(id).first();
  const banner = await ctx.db.prepare('SELECT preset AS banner_preset, updated_at AS banner_v FROM banners WHERE user_id = ?').bind(id).first();
  return json({
    user:modUserJson(ctx, row),
    bio:profile ? profile.bio : '',
    banner:bannerJson(banner),
    badges:await badgesFor(ctx, id),
    warnings:warnings.map(w => ({ id:w.id, message:w.message, createdAt:w.created_at, seen:!!w.seen_at, by:w.username || null })),
    notes:notes.map(n => ({ id:n.id, note:n.note, createdAt:n.created_at, by:n.username || null })),
    posts:posts.map(p => ({ id:p.id, title:p.title, excerpt:p.excerpt, createdAt:p.created_at, removed:!!p.deleted })),
    replies:replies.map(r => ({ id:r.id, postId:r.post_id, postTitle:r.post_title, excerpt:r.excerpt, createdAt:r.created_at, removed:!!r.deleted }))
  });
}

async function clearBio(ctx, id){
  const row = await ctx.db.prepare('SELECT u.username, pr.bio FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id WHERE u.id = ?').bind(id).first();
  if(!row) throw new HttpError(404, 'That account doesn’t exist.');
  await ctx.db.prepare('DELETE FROM profiles WHERE user_id = ?').bind(id).run();
  await logMod(ctx, 'clear-bio', row.username, (row.bio || '').slice(0, 120));
  return modUser(ctx, id);
}

async function clearAvatar(ctx, id){
  const row = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if(!row) throw new HttpError(404, 'That account doesn’t exist.');
  await ctx.db.prepare('DELETE FROM avatars WHERE user_id = ?').bind(id).run();
  await logMod(ctx, 'clear-avatar', row.username, '');
  return modUser(ctx, id);
}

async function clearBanner(ctx, id){
  const row = await ctx.db.prepare('SELECT username FROM users WHERE id = ?').bind(id).first();
  if(!row) throw new HttpError(404, 'That account doesn’t exist.');
  await ctx.db.prepare('DELETE FROM banners WHERE user_id = ?').bind(id).run();
  await logMod(ctx, 'clear-banner', row.username, '');
  return modUser(ctx, id);
}

async function banUser(ctx, id){
  const me = ctx.user;
  const target = await ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  if(target.id === me.id) throw new HttpError(400, 'You can’t ban your own account.');
  if(siteAdmin(ctx, target.username)) throw new HttpError(403, 'Site administrators can’t be banned.');
  if(!me.site && await isModerator(ctx, target.id)) throw new HttpError(403, 'Only the site administrators can ban a moderator.');
  const data = await readBody(ctx, 2000);
  const days = Number(data.days) || 0;
  if(days && (days < 0 || days > 3650)) throw new HttpError(400, 'Choose how long the ban lasts.');
  const until = days ? ctx.now + days * 86400000 : null;
  const reason = cleanLine(data.reason).slice(0, 300);
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO bans (user_id, reason, until, by_user, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, until = excluded.until, by_user = excluded.by_user, created_at = excluded.created_at')
      .bind(id, reason, until, me.id, ctx.now),
    ctx.db.prepare('DELETE FROM roles WHERE user_id = ?').bind(id),
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
            (SELECT COUNT(*) FROM reports x WHERE x.status = 'open' AND x.kind = rp.kind AND x.target_id = rp.target_id) AS times,
            (SELECT 1 FROM held h WHERE h.kind = rp.kind AND h.target_id = rp.target_id) AS hidden
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
    reporter:r.reporter || null, author:r.author || null, authorId:r.author_id || null, excerpt:r.excerpt || '', times:r.times, hidden:!!r.hidden
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

/* ---------- The team, for the Credits page ---------- */
// The site administrators, the moderators, and members with the Founder or Sanctify Team badge
async function getTeam(ctx){
  const admins = String(ctx.env.ADMINS || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 20);
  const { results } = await ctx.db.prepare(
    `SELECT u.username, u.created_at, a.updated_at AS avatar_v, r.role,
            EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = u.id AND b.badge = 'founder') AS founder,
            EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = u.id AND b.badge = 'team') AS team
       FROM users u LEFT JOIN avatars a ON a.user_id = u.id LEFT JOIN roles r ON r.user_id = u.id
      WHERE r.role = 'moderator' ${admins.length ? `OR u.username IN (${admins.map(() => '?').join(', ')})` : ''}
         OR EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = u.id AND b.badge IN ('founder', 'team'))
      ORDER BY u.created_at LIMIT 60`).bind(...admins).all();
  return json({ members:results.map(r => ({
    username:r.username, avatar:r.avatar_v || null, admin:siteAdmin(ctx, r.username), moderator:r.role === 'moderator', founder:!!r.founder, team:!!r.team
  })) });
}

/* ---------- Moderators ---------- */
// Moderators are members the site administrators (ADMINS) have chosen. Making someone a moderator also
// gives them the Moderator badge, and taking the role away removes it.
async function isModerator(ctx, userId){
  return !!(await ctx.db.prepare(`SELECT 1 FROM roles WHERE user_id = ? AND role = 'moderator'`).bind(userId).first());
}

async function setRole(ctx, id){
  const me = requireUser(ctx);
  if(!me.site) throw new HttpError(403, 'Only the site administrators can choose moderators.');
  const target = await ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').bind(id).first();
  if(!target) throw new HttpError(404, 'That account doesn’t exist.');
  if(siteAdmin(ctx, target.username)) throw new HttpError(400, 'Site administrators already have every moderator tool.');
  const data = await readBody(ctx, 200);
  const [label, color] = APPOINTED.moderator;
  if(data.moderator){
    if(await ctx.db.prepare('SELECT 1 FROM bans WHERE user_id = ? AND (until IS NULL OR until > ?)').bind(id, ctx.now).first()) throw new HttpError(400, 'Lift the ban before making this member a moderator.');
    await ctx.db.batch([
      ctx.db.prepare(`INSERT INTO roles (user_id, role, by_user, created_at) VALUES (?, 'moderator', ?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, by_user = excluded.by_user, created_at = excluded.created_at`).bind(id, me.id, ctx.now),
      ctx.db.prepare(`INSERT OR IGNORE INTO user_badges (user_id, badge, label, color, by_user, created_at) VALUES (?, 'moderator', ?, ?, ?, ?)`).bind(id, label, color, me.id, ctx.now)
    ]);
    await logMod(ctx, 'make-moderator', target.username, '');
  } else {
    await ctx.db.batch([
      ctx.db.prepare('DELETE FROM roles WHERE user_id = ?').bind(id),
      ctx.db.prepare(`DELETE FROM user_badges WHERE user_id = ? AND badge = 'moderator'`).bind(id)
    ]);
    await logMod(ctx, 'remove-moderator', target.username, '');
  }
  return modUser(ctx, id);
}

/* ---------- Sessions ---------- */
async function currentUser(ctx){
  const token = readCookie(ctx.request, COOKIE);
  if(!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  ctx.tokenHash = await sha256(token);
  const row = await ctx.db.prepare(
    `SELECT u.id, u.username, u.created_at, a.updated_at AS avatar_v, s.expires_at AS session_expires, r.role
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN avatars a ON a.user_id = u.id
     LEFT JOIN roles r ON r.user_id = u.id
     LEFT JOIN bans b ON b.user_id = u.id AND (b.until IS NULL OR b.until > ?)
     WHERE s.token_hash = ? AND s.expires_at > ? AND b.user_id IS NULL`
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
  const moderator = user.role === 'moderator', site = admins.includes(user.username.toLowerCase());
  return { ...user, moderator, site, admin:moderator || site };
}

function publicUser(user){
  return user ? { username:user.username, createdAt:user.created_at, admin:!!user.admin, moderator:!!user.moderator, siteAdmin:!!user.site, avatar:user.avatar_v || null } : null;
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
