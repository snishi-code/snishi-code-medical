const CACHE = 'hospital-rounds-v11';

// SW のスコープ（=sw.js が置かれているディレクトリ）。本番では '/hospital-rounds/'、
// テスト(サブドメイン)では '/' になる。相対URL は self.registration.scope を起点に解決。
const SCOPE = self.registration ? self.registration.scope : self.location.href.replace(/[^/]*$/, '');

// Docs HTML/CSS are bundled into the app itself (see src/docs-bundle.js) so
// they work offline without ever touching the SW cache. The SW only pre-caches
// the app shell plus the docs *images* (best-effort) so that figures inside the
// embedded guide also render offline once the SW has installed.
const SHELL = [
  new URL('./', SCOPE).href,
  new URL('./index.html', SCOPE).href,
];

async function precacheAll() {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(SHELL.map((u) => cache.add(u)));
  // precache-list.json はファイル名の配列（例: ["foo.webp", "bar.webp"]）。
  // URL は SW スコープを起点に組み立てるので prod/test どちらの base でも動く。
  try {
    const res = await fetch(new URL('./docs-images/precache-list.json', SCOPE).href, { cache: 'no-cache' });
    if (res && res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        const urls = list.map((name) => new URL(`./docs-images/${name}`, SCOPE).href);
        await Promise.allSettled(urls.map((u) => cache.add(u)));
      }
    }
  } catch (_) { /* first install offline: shell only, images fill in on next online visit */ }
}

// 自動更新の無効化:
//   - skipWaiting() を呼ばないので、新しい SW は 'waiting' 状態に留まる
//   - clients.claim() を呼ばないので、既に開いている PWA は古い SW を使い続ける
//   - 結果として「ユーザが明示的にアプリを完全に閉じて開き直す」まで更新は適用されない
//   - 院内運用では「ホーム画面から削除 → 再追加」を更新フローとするため、これで十分
self.addEventListener('install', (e) => {
  e.waitUntil(precacheAll());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
});

// Cache-first with network fallback that fills the cache; on total failure, return the SPA shell.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res && res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(new URL('./', SCOPE).href));
    })
  );
});
