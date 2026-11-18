/* 오프라인용: 앱 파일과 OpenCV 를 기기에 저장해 두고, 인터넷이 없어도 열리게 함 */
const CACHE = "score-reader-v1";
const FILES = ["./", "index.html", "app.js", "reader.js", "manifest.webmanifest", "vendor/opencv.js", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  // 앱 파일: 먼저 인터넷에서 새 버전을 받고, 안 되면 저장해 둔 것. OpenCV(큰 파일)는 저장해 둔 것을 먼저.
  if (u.pathname.endsWith("/vendor/opencv.js")) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
