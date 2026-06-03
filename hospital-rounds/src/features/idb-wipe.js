"use strict";

// アプリの IndexedDB を fail-closed で削除する共通ユーティリティ。
//
// 2 つの「全消去」経路が単一ソースとして使う:
//   - PWA 初回「削除して開始」(features/pwa-init.js)
//   - 設定「全データを消去する」(main.js の resetBtn)
//
// fail-closed の要: onblocked / onerror / 例外は reject する。別タブ/ウィンドウが DB 接続を
// 握っていて deleteDatabase が blocked のまま等、「消えていない」のに成功扱いして reload する
// と、患者 PII が残ったまま「初期化済み」に見える (fail-open)。呼び出し側は全 DB の削除確認
// (resolve) が取れた時だけ marker/localStorage 消去/reload へ進むこと。

// IndexedDB 名は "hospital-rounds" (ハイフン) で統一 (本体 / eventlog / snapshots)。
const DB_PREFIX = "hospital-rounds";

// 1 つの IDB を削除。成功で resolve、確認できなければ reject。
export function dropIndexedDb(dbName) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { resolve(); return; }
    let settled = false;
    try {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => { if (!settled) { settled = true; resolve(); } };
      req.onerror = () => {
        if (settled) return;
        settled = true;
        console.warn("idb delete failed:", req.error);
        reject(req.error || new Error(`idb delete failed: ${dbName}`));
      };
      req.onblocked = () => {
        if (settled) return;
        settled = true;
        console.warn("idb delete blocked:", dbName);
        reject(new Error(`idb delete blocked: ${dbName}`));
      };
    } catch (e) {
      console.warn("idb delete threw:", e);
      reject(e);
    }
  });
}

// アプリの全 IndexedDB (本体 + eventlog + snapshots) を削除する。
// 既知の 3 つを必ず対象にし、databases() が使えれば DB_PREFIX の他 DB も拾う
// (将来 DB が増えた時の取りこぼし防止)。存在しない DB の削除は無害な no-op。
// いずれか 1 つでも reject すると Promise.all 全体が reject (= fail-closed)。
export async function dropAllAppIndexedDbs() {
  if (typeof indexedDB === "undefined") return;
  const names = new Set([
    DB_PREFIX,                    // "hospital-rounds"        本体 (病棟/ユーザー/設定)
    `${DB_PREFIX}-eventlog`,      // 無記名 利用ログ
    `${DB_PREFIX}-snapshots`,     // スナップショット (患者 PII 含む)
  ]);
  try {
    if (typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      for (const d of (dbs || [])) {
        if (d && typeof d.name === "string" && d.name.startsWith(DB_PREFIX)) names.add(d.name);
      }
    }
  } catch (_) { /* databases() 非対応環境は既知の 3 つだけで続行 */ }
  await Promise.all([...names].map(dropIndexedDb));
}
