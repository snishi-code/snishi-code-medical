"use strict";

// ============================================================================
// イベントログ (研究用テレメトリ) — 独立モジュール
//
// 設計方針 (依頼者と合意):
//   - **完全に独立**: 専用の IndexedDB (hospital-rounds-eventlog) に閉じる。
//     患者データ (bundles DB) やスナップショットとは別DB。単体で精査・書出・消去できる。
//   - **個人情報を残さない**: 1 イベント = { t: 時刻ms, u: userId(乱数ID), k: 種別 }。
//     患者名・pid は載せない。userId は誰=人物ではなく端末内の乱数IDなので非PII。
//   - **将来の余地**: イベントは任意フィールドを許す形 (…extra)。将来「アクセス監査」
//     等で識別子を足したくなったら、別 kind + 任意フィールドで後付け可能 (スキーマ移行不要)。
//   - **外部送信ゼロ**: fetch 等は一切しない。端末内のみ。JSON 書出はユーザー操作で。
//   - **365日ローリング保持**: 起動時に古いイベントを間引く (生データの長期保持はしない)。
//     長期トレンドが要るようになったら、その時に日次集計層を足す (今は作らない)。
//
// 公開 API:
//   initEventLog()         起動時: 古いイベント間引き + ライフサイクル配線 + app_open 記録
//   logEvent(kind, extra?) 1 イベント追記 (fire-and-forget・例外を投げない)
//   exportEventLog()       全イベントを JSON 用オブジェクトで返す
//   clearEventLog()        全消去 (設定の「ログ消去」用)
//   EVENT                  種別の定数
// ============================================================================

import { getCurrentUserId } from "../storage.js";

const DB_NAME = "hospital-rounds-eventlog";
const DB_VERSION = 1;
const STORE = "events";

// 生イベントの保持日数 (これを超えたものは起動時に削除)。
const RETENTION_DAYS = 365;

// イベント種別。値は wire キーなので i18n 対象外 (データ層の定数)。
export const EVENT = Object.freeze({
  APP_OPEN: "app_open",       // 起動 / 初回読込
  APP_VISIBLE: "app_visible", // 前面化 (タブ復帰 / アプリ復帰)
  APP_HIDDEN: "app_hidden",   // 背面化 / 離脱
  USER_SWITCH: "user_switch", // ユーザー切替
  WS_SWITCH: "ws_switch",     // 病棟切替
  PATIENT_EDIT: "patient_edit", // 患者レコード更新 (無記名・誰かは残さない)
  CLEAR: "clear",             // 記録クリア (診察開始)
  QR_SHOW: "qr_show",         // QR 表示 (将来 kind 付与でカルテ記載/共有を区別)
  SNAPSHOT_RESTORE: "snapshot_restore", // スナップショットから復元
});

const EXPORT_FORMAT = "hospital-rounds-eventlog";
const EXPORT_SCHEMA = 1;

// ============================
// 低レベル IDB (このモジュール専用 DB)
// ============================

let _dbPromise = null;

function hasIndexedDb() {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDb() {
  if (_dbPromise) return _dbPromise;
  if (!hasIndexedDb()) { _dbPromise = Promise.resolve(null); return _dbPromise; }
  _dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (_) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { autoIncrement: true });
        store.createIndex("t", "t", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // delete/version 変更要求時に自接続を閉じて解放 (設定画面 reset の fail-closed 削除が
      // 自分の接続で onblocked になり永久に完了しないのを防ぐ)。storage.js openDb と同じ。
      db.onversionchange = () => { try { db.close(); } catch (_) {} _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { console.warn("eventlog open failed:", req.error); resolve(null); };
    req.onblocked = () => resolve(null);
  });
  return _dbPromise;
}

function txDone(tx) {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
function reqDone(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

// ============================
// 公開 API
// ============================

// 1 イベント追記。fire-and-forget・例外は飲み込む (ログ取りで本処理を壊さない)。
export function logEvent(kind, extra) {
  try {
    const ev = { t: Date.now(), u: getCurrentUserId(), k: String(kind || "") };
    if (extra && typeof extra === "object") {
      // 任意フィールドを許す (将来余地)。ただし患者名等の PII を入れないのは呼び出し側の責務。
      for (const key of Object.keys(extra)) ev[key] = extra[key];
    }
    (async () => {
      const db = await openDb();
      if (!db) return;
      try { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).add(ev); await txDone(tx); }
      catch (e) { console.warn("logEvent append failed:", e); }
    })();
  } catch (e) {
    console.warn("logEvent failed:", e);
  }
}

// RETENTION_DAYS を超える古いイベントを削除。戻り値: 削除件数。
async function pruneOld() {
  const db = await openDb();
  if (!db) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const idx = tx.objectStore(STORE).index("t");
    let n = 0;
    await new Promise((res, rej) => {
      const cur = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
      cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); n++; c.continue(); } else res(); };
      cur.onerror = () => rej(cur.error);
    });
    await txDone(tx);
    return n;
  } catch (e) { console.warn("eventlog prune failed:", e); return 0; }
}

// 全イベントを取得して JSON 用オブジェクトにまとめる。
export async function exportEventLog() {
  const db = await openDb();
  let events = [];
  if (db) {
    try { const tx = db.transaction(STORE, "readonly"); events = await reqDone(tx.objectStore(STORE).getAll()); }
    catch (e) { console.warn("exportEventLog failed:", e); }
  }
  return { format: EXPORT_FORMAT, schema: EXPORT_SCHEMA, exportedAt: new Date().toISOString(), events: Array.isArray(events) ? events : [] };
}

// 全消去。
export async function clearEventLog() {
  const db = await openDb();
  if (!db) return;
  try { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).clear(); await txDone(tx); }
  catch (e) { console.warn("clearEventLog failed:", e); }
}

// 起動時: 古いイベント間引き → ライフサイクル配線 → app_open を記録。
export function initEventLog() {
  pruneOld();
  logEvent(EVENT.APP_OPEN);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      logEvent(document.visibilityState === "hidden" ? EVENT.APP_HIDDEN : EVENT.APP_VISIBLE);
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => { logEvent(EVENT.APP_HIDDEN); });
  }
}
