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
    const res = await fetch(new URL('./docs-images/precache-list.json', SCOPE).href, { cache: 'no-cache' }); // network-ok: 同一オリジンの静的アセット precache のみ。ユーザーデータ送信なし
    if (res && res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        const urls = list.map((name) => new URL(`./docs-images/${name}`, SCOPE).href);
        await Promise.allSettled(urls.map((u) => cache.add(u)));
      }
    }
  } catch (_) { /* first install offline: shell only, images fill in on next online visit */ }
}

// 自動更新の無効化 = 意図的な「不変性 (immutability)」設計。【セキュリティ要件・変更厳禁】
//   一度インストールされた PWA は、その後 origin から配信される内容に一切影響されない:
//     - skipWaiting() を呼ばない    → 新しい SW は 'waiting' に留まり発火しない
//     - clients.claim() を呼ばない  → 既存インストールは古い SW を使い続ける
//     - index.html は cache-first    → アプリ本体コードは install 時点で凍結される
//     - 登録側 (index.html) も registration.update() / updatefound を配線していない
//   狙い: 配信元が信用できるのは「install の瞬間」だけ、と割り切る。install 後に
//     (a) コードの瑕疵が後から「勝手に直って」臨床端末の挙動が変わる、
//     (b) デプロイ環境やアカウントが乗っ取られ悪性コードが既存インストールへ波及する、
//     のどちらも起こさない。可搬性(patchability)より完全性(integrity)を優先する設計。
//   トレードオフ: 正規の修正も既存端末には届かない。更新は「アンインストール →
//     再インストール」のみ (= ユーザーが明示的に再信頼する操作を要求する)。
//   ⚠️ skipWaiting / clients.claim / registration.update / 自動更新プロンプトを
//      足すと、この保証が壊れる。追加しないこと。
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
      return fetch(e.request).then((res) => { // network-ok: 同一オリジン GET のみ(上の origin チェック済み)のキャッシュ通過。外部送信なし
        if (res && res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(new URL('./', SCOPE).href));
    })
  );
});
