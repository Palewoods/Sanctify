// Sanctify service worker: lets the site open offline after a first visit.
// Pages are fetched network-first (so updates appear right away) and fall back
// to the cached copy when offline. Icons and fonts are served from cache.
const VERSION = 'sanctify-v36';   // bump when icons or other cached files change
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

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== BIBLE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

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

  // Bible chapters, book sections, the Catechism outline, and entry texts: from the device once read, with no background refresh, to save data
  if(url.origin === location.origin && (url.pathname.includes('/bible/') || url.pathname.includes('/books/') || url.pathname.includes('/catechism/') || url.pathname.includes('/data/'))){
    event.respondWith(
      caches.open(BIBLE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(res => {
        if(res.ok) cache.put(req, res.clone());
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
        const network = fetch(req)
          .then(res => { if(res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; })
          .catch(() => hit);
        return hit || network;
      })
    )
  );
});
