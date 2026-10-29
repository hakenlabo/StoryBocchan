/*
 * Service Worker：アプリのファイルを端末に保存して、ネットがなくても開けるようにする（ホーム画面アプリ・iPadアプリ用）。
 * - ページ本体（index.html）はネット優先：つながっていれば毎回新しい版を取りに行く。つながらなければ保存した版。
 * - そのほかのファイルは保存した物を優先（?v= の版番号つきなので、版が変われば別のファイルとして取り直す）。
 * - VERSION を変えると、古い保存は消して入れ直す。tools/bump-version.sh で index.html・config.js と一緒に変える。
 * - file:// で開いたときは使われない（app.js が http/https のときだけ登録する）。
 */
const VERSION = '2026102901';
const CACHE = 'storybocchan-' + VERSION;
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  'css/app.css?v=2026102901',
  'js/config.js?v=2026102901',
  'js/util.js?v=2026102901',
  'js/model.js?v=2026102901',
  'js/storage.js?v=2026102901',
  'js/map.js?v=2026102901',
  'js/tray.js?v=2026102901',
  'js/timeline.js?v=2026102901',
  'js/draw.js?v=2026102901',
  'js/camera.js?v=2026102901',
  'js/vconte.js?v=2026102901',
  'js/clipboard.js?v=2026102901',
  'js/outline.js?v=2026102901',
  'js/zip.js?v=2026102901',
  'js/project.js?v=2026102901',
  'js/pdf.js?v=2026102901',
  'js/mp4.js?v=2026102901',
  'js/movie.js?v=2026102901',
  'js/images.js?v=2026102901',
  'js/app.js?v=2026102901',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('storybocchan-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      const copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
      return res;
    }).catch(function () { return caches.match('./index.html'); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  }));
});
