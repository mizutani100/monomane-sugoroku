/**
 * Service Worker（P4）
 * 方針:
 *  - アプリシェル（HTML/CSS/JS/アイコン）はキャッシュ優先。オフラインでも起動する
 *  - 地図タイルと被写体データはネットワーク優先＋キャッシュ退避（歩いた場所は再訪できる）
 *  - APIは常にネットワーク。キャッシュしない（採点・部屋の状態が古くなるため）
 */
const VERSION = "v5.9.1";
const SHELL_CACHE = `monomane-shell-${VERSION}`;
const RUNTIME_CACHE = `monomane-runtime-${VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./assets/css/app.css",
  "./assets/js/config.js",
  "./assets/js/app.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./manifest.webmanifest",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", (event) => {
  self.skipWaiting(); // 新しいSWを待機させず即座に有効化して、更新をすぐ反映する
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS.map((url) => new Request(url, { cache: "reload" }))))
      .catch((error) => console.warn("[sw] シェルのキャッシュに一部失敗", error))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API・写真は常に最新を取りに行く（キャッシュしない）
  if (url.pathname.includes("/api/")) return;

  // 地図タイル・被写体データ: ネットワーク優先、失敗時キャッシュ
  const isTile = url.hostname.includes("basemaps.cartocdn.com") || url.hostname.includes("tile.openstreetmap.org");
  const isData = url.pathname.endsWith(".geojson");
  if (isTile || isData) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // それ以外（アプリシェル）: キャッシュ優先
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && url.origin === self.location.origin) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
