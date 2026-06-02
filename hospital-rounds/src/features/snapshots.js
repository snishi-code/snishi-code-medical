"use strict";

// ============================================================================
// スナップショット / 復元 — 独立モジュール
//
// 設計方針 (依頼者と合意):
//   - **独立**: 専用 IndexedDB (hospital-rounds-snapshots) に閉じる。患者データ本体
//     (bundles DB)・イベントログとは別。Git 的な差分履歴は持たない (全状態のコピー)。
//   - **個人情報を含む**: スナップショットは患者レコードそのものを含むので、ログより
//     厳しく「少なく・短く」保持する。
//   - **撮るタイミング = 破壊操作の直前**: 記録クリア / 患者一括移動 / 病棟削除 / 取込追加。
//     ＋ 画面遷移直前の「浅いアンドゥ」(nav) を直近 2 枚だけリング保持。
//   - **保持**: 病棟ごと、破壊操作前は「その日の最初の 1 枚」(同日再操作では撮り増やさ
//     ない＝『昨日』が消えない)。nav は直近 2 枚。すべて 14 日で自動失効。
//   - **復元は履歴保持 (Git revert 型)**: 復元する前に現状を 1 枚撮ってから差し替えるので
//     「復元の取り消し」もできる。復元した事実はイベントログに記録 (呼び出し側が記録)。
//
// 公開 API:
//   initSnapshots()            起動時: 期限切れ間引き
//   captureSnapshot(reason)    現アクティブ病棟の患者を 1 枚撮る (dedup 込み)
//   listRestorePoints(wsId?)   復元候補一覧 (新しい順) — 設定の復元 UI 用
//   restoreSnapshot(id)        指定スナップショットへ復元 (現状を先に撮る)。要 UI 再描画
//   deleteRestorePoint(id)     1 枚削除
//   REASON                     撮影理由の定数
// ============================================================================

import { getActiveWorkspaceId } from "../storage.js";
import { appState, setAppState, saveNow } from "../store.js";

const DB_NAME = "hospital-rounds-snapshots";
const DB_VERSION = 1;
const STORE = "snapshots";

const TTL_DAYS = 14;     // 失効日数 (PII のため短め)
const NAV_KEEP = 2;      // 病棟ごとに保持する nav スナップショット数

export const REASON = Object.freeze({
  CLEAR: "clear",            // 記録クリア (診察開始) 直前
  MOVE: "move",              // 患者一括移動 直前
  DELETE: "delete",          // 病棟削除 直前
  IMPORT: "import",          // 取込で現病棟に追記 直前
  RESTORE_UNDO: "restore_undo", // 復元の直前 (復元の取り消し用)
  NAV: "nav",                // 画面遷移直前の浅いアンドゥ
});

function isDestructive(reason) { return reason !== REASON.NAV; }

// ============================
// 低レベル IDB (このモジュール専用 DB)
// ============================

let _dbPromise = null;
function hasIndexedDb() { return typeof indexedDB !== "undefined" && indexedDB !== null; }

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
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("wsId", "wsId", { unique: false });
        store.createIndex("t", "t", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn("snapshots open failed:", req.error); resolve(null); };
    req.onblocked = () => resolve(null);
  });
  return _dbPromise;
}

function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }
function reqDone(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

// ============================
// helpers
// ============================

function clonePatients(patients) {
  try { return JSON.parse(JSON.stringify(Array.isArray(patients) ? patients : [])); }
  catch (_) { return []; }
}

// 変化検出用の軽量ハッシュ (nav の重複撮影スキップ用)。
function hashPatients(patients) {
  let s = "";
  try { s = JSON.stringify(patients); } catch (_) { s = ""; }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

// ローカル日付キー (YYYYMMDD)。
function localDayKey(t) {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

async function listForWs(db, wsId) {
  try {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("wsId");
    return await reqDone(idx.getAll(IDBKeyRange.only(wsId)));
  } catch (e) { console.warn("snapshots listForWs failed:", e); return []; }
}

// ============================
// 公開 API
// ============================

// 現アクティブ病棟の患者を 1 枚撮る。dedup:
//   - nav: 直近スナップショットと内容が同じなら撮らない
//   - 破壊操作: その病棟で同じ日に既に破壊前スナップショットがあれば撮らない (初回優先)
export async function captureSnapshot(reason) {
  const wsId = getActiveWorkspaceId();
  if (!wsId) return;
  const db = await openDb();
  if (!db) return;
  const t = Date.now();
  const patients = clonePatients(appState.patients);
  const sig = hashPatients(patients);

  const existing = await listForWs(db, wsId);
  if (reason === REASON.NAV) {
    const newest = existing.slice().sort((a, b) => b.t - a.t)[0];
    if (newest && newest.sig === sig) return; // 変化なし
  } else {
    const today = localDayKey(t);
    const sameDayDestructive = existing.some(s => isDestructive(s.reason) && localDayKey(s.t) === today);
    if (sameDayDestructive) return; // その日の初回だけ残す
  }

  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ wsId, t, reason, title: appState.title || "", patients, sig });
    await txDone(tx);
  } catch (e) {
    console.warn("captureSnapshot add failed:", e);
    return;
  }
  await pruneWs(db, wsId);
}

// 病棟ごとの間引き: 14 日超を削除 + nav は直近 NAV_KEEP 枚だけ残す。
async function pruneWs(db, wsId) {
  const all = await listForWs(db, wsId);
  const cutoff = Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000;
  const toDelete = [];
  for (const s of all) if (s.t < cutoff) toDelete.push(s.id);
  // nav の超過分 (古いもの) を削除
  const navAlive = all.filter(s => s.reason === REASON.NAV && s.t >= cutoff).sort((a, b) => b.t - a.t);
  for (const s of navAlive.slice(NAV_KEEP)) toDelete.push(s.id);
  if (!toDelete.length) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const id of toDelete) store.delete(id);
    await txDone(tx);
  } catch (e) { console.warn("snapshots prune failed:", e); }
}

// 起動時: 全病棟の期限切れを間引く。
export async function initSnapshots() {
  const db = await openDb();
  if (!db) return;
  const cutoff = Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const idx = tx.objectStore(STORE).index("t");
    await new Promise((res, rej) => {
      const cur = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
      cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } else res(); };
      cur.onerror = () => rej(cur.error);
    });
    await txDone(tx);
  } catch (e) { console.warn("initSnapshots prune failed:", e); }
}

// 復元候補一覧 (新しい順)。UI 表示用に患者本体は返さず軽量メタだけ。
// 期限切れ (TTL_DAYS 超) は、間引き (initSnapshots/pruneWs) がまだ走っていなくても
// 候補に出さない (読み出し時 TTL 防御)。PII を含むため失効後は確実に隠す。
export async function listRestorePoints(wsId) {
  const id = wsId || getActiveWorkspaceId();
  const db = await openDb();
  if (!db) return [];
  const cutoff = Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000;
  const all = await listForWs(db, id);
  return all
    .filter(s => s.t >= cutoff)
    .sort((a, b) => b.t - a.t)
    .map(s => ({ id: s.id, t: s.t, reason: s.reason, count: Array.isArray(s.patients) ? s.patients.filter(p => p && (p.name || p.status !== "none")).length : 0 }));
}

// 指定スナップショットへ復元する (履歴保持型)。
//   1) 現状を RESTORE_UNDO として 1 枚撮る (復元の取り消し用)
//   2) 患者を差し替えて保存
//   呼び出し側は UI 再描画 + イベントログ記録を行う。戻り値: { ok, reason? }
export async function restoreSnapshot(id) {
  const db = await openDb();
  if (!db) return { ok: false, reason: "nodb" };
  let snap = null;
  try { const tx = db.transaction(STORE, "readonly"); snap = await reqDone(tx.objectStore(STORE).get(id)); }
  catch (e) { console.warn("restoreSnapshot get failed:", e); }
  if (!snap) return { ok: false, reason: "notfound" };
  // 現アクティブ病棟と一致する場合のみ復元 (UI は現病棟の候補だけ出す前提)
  if (snap.wsId !== getActiveWorkspaceId()) return { ok: false, reason: "wsmismatch" };
  // 期限切れは復元しない (読み出し時 TTL 防御。間引き未実行でも失効後の PII を戻さない)
  const cutoff = Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000;
  if (snap.t < cutoff) return { ok: false, reason: "expired" };

  // 1) 現状を「復元の取り消し」用に撮る (同日 dedup を避けるため直接 add)
  try {
    const patients = clonePatients(appState.patients);
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ wsId: snap.wsId, t: Date.now(), reason: REASON.RESTORE_UNDO, title: appState.title || "", patients, sig: hashPatients(patients) });
    await txDone(tx);
  } catch (e) { console.warn("restore undo snapshot failed:", e); }

  // 2) 差し替え (title=現ユーザー名は維持、患者だけ復元)
  setAppState({ v: 3, title: appState.title, patients: clonePatients(snap.patients) });
  await saveNow();
  await pruneWs(db, snap.wsId);
  return { ok: true };
}

export async function deleteRestorePoint(id) {
  const db = await openDb();
  if (!db) return;
  try { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(id); await txDone(tx); }
  catch (e) { console.warn("deleteRestorePoint failed:", e); }
}

// 指定した病棟 ID 群に属するスナップショットを全削除する。戻り値: 削除件数。
// ユーザー削除・病棟削除時に呼ぶ: スナップショットは患者 PII を含むので、本体 DB
// (bundles) から病棟が消えたらこちらにも残さない (= 「削除したのに端末内に残る」を防ぐ
// データ約束)。best-effort で、失敗しても削除フロー本体は止めない。
export async function purgeSnapshotsForWorkspaces(wsIds) {
  const ids = Array.isArray(wsIds) ? wsIds.filter(Boolean) : [];
  if (!ids.length) return 0;
  const db = await openDb();
  if (!db) return 0;
  let toDelete = [];
  try {
    // 各 wsId の主キーを 1 つの readonly tx 内で同期発行して集める
    // (await を挟まず発行 → tx が非アクティブ化しない)。
    const txR = db.transaction(STORE, "readonly");
    const idx = txR.objectStore(STORE).index("wsId");
    const keyLists = await Promise.all(ids.map(wsId => reqDone(idx.getAllKeys(IDBKeyRange.only(wsId)))));
    toDelete = keyLists.flat();
  } catch (e) { console.warn("purgeSnapshots scan failed:", e); return 0; }
  if (!toDelete.length) return 0;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const k of toDelete) store.delete(k);
    await txDone(tx);
  } catch (e) { console.warn("purgeSnapshots delete failed:", e); return 0; }
  return toDelete.length;
}

// テスト用: 次の openDb() を再実行できるよう memoized promise をリセットする。
// fake-indexeddb の差し替え後に呼ぶ。通常コードからは呼ばない。
export function _resetSnapshotsDbForTests() {
  _dbPromise = null;
}
