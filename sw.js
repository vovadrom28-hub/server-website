const CACHE_NAME = 'smp-site-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/audio.js',
  '/rules.js',
  '/online.js',
  '/chat.js',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
