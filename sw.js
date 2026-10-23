// Sanctify service worker: lets the site open offline after a first visit.
// Pages are fetched network-first (so updates appear right away) and fall back
// to the cached copy when offline. Icons, fonts, and the site's own files are served from cache.
const VERSION = 'sanctify-v46';   // bump when icons or other cached files change
const BIBLE = 'sanctify-bible-1';   // Bible chapters never change, so they keep their own cache across updates
const PRECACHE = [
  './',
  'index.html',
  '404.html',
  'favicon.svg',
  'favicon.ico',
  'favicon-32.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'site.webmanifest'
];
// The stylesheet, library, and code that index.html links, each with a fingerprint of its contents (tools/stamp.py)
const APP_FILES = /(?:app\/[\w.-]+\.(?:js|css)|lang\/\w+\.js)\?v=[0-9a-f]+/g;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(async cache => {
    // Straight from the server, never the browser's own cache, so the page kept is the page just published
    await cache.addAll(PRECACHE.map(u => new Request(u, { cache:'reload' })));
    // So the site opens offline straight after a first visit, keep the files this version of the page uses
    const page = await (await cache.match('index.html')).text();
    const files = [...new Set((page.match(APP_FILES) || []).filter(f => f.startsWith('app/')))];
    await cache.addAll(files);
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== BIBLE).map(k => caches.delete(k))))
      // Older versions kept data files without a version in their name (hymns.json and the like) for good; let them refresh
      .then(() => caches.open(BIBLE)).then(cache => cache.keys().then(reqs => Promise.all(reqs
        .filter(r => /\/data\/(?!texts\/)[^/]+\.json$/.test(new URL(r.url).pathname)).map(r => cache.delete(r)))))
      .then(() => self.clients.claim())
  );
});

// A file with a fingerprint (app.js?v=…, saint-3.1a2b3c4d.json) replaces its earlier versions in the cache
function sameFile(a, b){
  if(a.pathname === b.pathname) return a.search !== b.search;
  const strip = p => p.replace(/\.[0-9a-f]{8}(\.json)$/, '$1');
  return /\/data\/texts\//.test(a.pathname) && strip(a.pathname) === strip(b.pathname);
}
async function store(cache, req, res){
  await cache.put(req, res);
  const url = new URL(req.url);
  if(!url.search.includes('v=') && !url.pathname.includes('/data/texts/')) return;
  const old = (await cache.keys()).filter(r => sameFile(url, new URL(r.url)));
  await Promise.all(old.map(r => cache.delete(r)));
}
function cacheFor(url){
  return url.pathname.includes('/bible/') || url.pathname.includes('/books/') || url.pathname.includes('/catechism/') || url.pathname.includes('/data/texts/') ? BIBLE : VERSION;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin === location.origin && url.pathname.startsWith('/api/')) return;   // Community posts and accounts are always live

  // Pages: network first, cached copy when offline
  if(req.mode === 'navigate'){
    event.respondWith(
      fetch(req, { cache:'no-cache' })   // always check the server for a newer page when online
        .then(res => {
          const isHome = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
          if(res.ok && url.origin === location.origin && isHome){
            const copy = res.clone();
            caches.open(VERSION).then(cache => cache.put('index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('index.html').then(hit => hit || caches.match(req)))
    );
    return;
  }

  // Bible chapters, book sections, the Catechism outline, and entry texts (whose names change with their contents):
  // from the device once read, with no background refresh, to save data. Other data files refresh like the rest of the site.
  if(url.origin === location.origin && cacheFor(url) === BIBLE){
    event.respondWith(
      caches.open(BIBLE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(res => {
        if(res.ok) store(cache, req, res.clone());
        return res;
      })))
    );
    return;
  }

  // Our own files and Google Fonts: serve from cache, refresh in the background
  const cacheable = url.origin === location.origin
    || url.hostname === 'fonts.googleapis.com'
    || url.hostname === 'fonts.gstatic.com';
  if(!cacheable) return;   // Wikipedia pictures and other sites go straight to the network

  event.respondWith(
    caches.open(VERSION).then(cache =>
      cache.match(req).then(hit => {
        // A file with a fingerprint never changes, so once it's kept there's nothing to refresh
        if(hit && url.origin === location.origin && url.search.includes('v=')) return hit;
        const network = fetch(req)
          .then(res => { if(res.ok || res.type === 'opaque') store(cache, req, res.clone()); return res; })
          .catch(() => hit);
        return hit || network;
      })
    )
  );
});

