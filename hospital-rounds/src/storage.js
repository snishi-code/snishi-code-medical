"use strict";

// Workspace-backed persistence on IndexedDB.
//
// データモデル:
//   - `bundles` object store の 1 レコード = 1 ワークスペース
//   - 「アクティブワークスペース」を 1 個だけ指し示すポインタを別管理
//     (= localStorage に保存。サイズが小さく同期 API で済むため)
//   - 編集中のオートセーブは常にアクティブワークスペースを上書きする
//   - 切替時はアクティブを保存 → 新ワークスペースをロード → live state 差し替え
//
// public surface (すべて async):
//   loadBundle(id?)            -> parsed bundle | null    (id 省略時は active)
//   saveBundle(b, id?, label?) -> void                    (id 省略時は active)
//   listBundles()              -> [{id, label, title, updatedAt}]
//   renameBundle(id, label)    -> void                    (label のみ書き換え)
//   deleteBundle(id)           -> void                    (active は拒否)
//   createWorkspaceRecord(label, bundle) -> id            (新規ワークスペースを作成)
//
//   getActiveWorkspaceId()     -> string  (active workspace の ID。同期)
//   setActiveWorkspaceId(id)   -> void    (同期)

import { BUNDLE_FORMAT, parseBundle } from "./bundle.js";
import { t } from "./i18n.js";

const DB_NAME = "hospital-rounds";
const DB_VERSION = 1;
const STORE_NAME = "bundles";

// 初回起動時 / v4 系からのマイグレーション時に既定で active になる ID。
// 既存ユーザの "default" レコードがそのままアクティブになる。
const DEFAULT_WORKSPACE_ID = "default";

// v8.2+: 設定 (formats / formatGroups / tags / clearTargets / qr 設定) は全ワークスペース
// 共通 (グローバル) にする。同じ bundles ストア内に予約 ID で 1 レコードだけ置き、
// listBundles では除外する (= ワークスペース一覧に出さない)。DB スキーマ変更は不要。
const GLOBAL_SETTINGS_ID = "__settings__";
// "default" ワークスペースの表示名。i18n 化のため関数経由で参照する。
// (export const をベタ文字列にすると module 評価時に t() を呼べないため)
export function getDefaultWorkspaceLabel() {
  return t("ws.default.label");
}

// active workspace ID は IDB ではなく localStorage に置く:
//   - 値は短い文字列 (= 容量問題なし)
//   - module 初期化や render 直前で同期に読みたい
//   - 別タブが workspace 切替したとき storage event で気付ける
const ACTIVE_KEY = "hospital_rounds_active_workspace_id";

// Device-wide app title (localStorage)。workspace 切替で reset されない。
const DEVICE_TITLE_KEY = "hospital_rounds_device_app_title";

export const STORAGE_KEYS = Object.freeze({
  db: DB_NAME,
  store: STORE_NAME,
  defaultWorkspace: DEFAULT_WORKSPACE_ID,
  activeKey: ACTIVE_KEY,
  deviceTitle: DEVICE_TITLE_KEY,
});

// ============================
// Active workspace pointer (localStorage)
// ============================

export function getActiveWorkspaceId() {
  if (typeof localStorage === "undefined") return DEFAULT_WORKSPACE_ID;
  return localStorage.getItem(ACTIVE_KEY) || DEFAULT_WORKSPACE_ID;
}

export function setActiveWorkspaceId(id) {
  if (typeof localStorage === "undefined") return;
  if (!id || typeof id !== "string") return;
  localStorage.setItem(ACTIVE_KEY, id);
}

// ============================
// Device-wide app title (localStorage)
// ============================

// 端末固定のタイトル。未設定なら "" を返す (caller 側でデフォルト文言を充てる)
export function getDeviceAppTitle() {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(DEVICE_TITLE_KEY) || "";
}

export function setDeviceAppTitle(title) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(DEVICE_TITLE_KEY, String(title || ""));
}

// ============================
// DB open (lazy, memoized)
// ============================

let _dbPromise = null;

function hasIndexedDb() {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDb() {
  if (_dbPromise) return _dbPromise;
  if (!hasIndexedDb()) {
    _dbPromise = Promise.resolve(null);
    return _dbPromise;
  }
  _dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("indexedDB open failed:", req.error);
      resolve(null);
    };
    req.onblocked = () => {
      console.warn("indexedDB open blocked");
      resolve(null);
    };
  });
  return _dbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ============================
// Public API
// ============================

export async function loadBundle(id) {
  const targetId = id || getActiveWorkspaceId();
  try {
    const db = await openDb();
    if (db) {
      const tx = db.transaction(STORE_NAME, "readonly");
      const rec = await idbReq(tx.objectStore(STORE_NAME).get(targetId));
      if (rec && rec.bundle) {
        try { return parseBundle(rec.bundle); }
        catch (e) { console.warn("idb bundle parse failed:", e); }
      }
    }
  } catch (e) {
    console.warn("idb load failed:", e);
  }
  return null;
}

export async function saveBundle(bundle, id, label) {
  const targetId = id || getActiveWorkspaceId();
  const db = await openDb();
  if (!db) return; // IDB 不可環境 (テスト等) は no-op
  // label が未指定なら既存レコードの label を温存。新規作成だけ default label
  let finalLabel = label;
  if (finalLabel == null) {
    try {
      const txR = db.transaction(STORE_NAME, "readonly");
      const existing = await idbReq(txR.objectStore(STORE_NAME).get(targetId));
      if (existing && typeof existing.label === "string") finalLabel = existing.label;
    } catch (_) { /* ignore */ }
  }
  if (finalLabel == null) {
    finalLabel = (targetId === DEFAULT_WORKSPACE_ID) ? getDefaultWorkspaceLabel() : "";
  }
  const rec = {
    id: targetId,
    label: String(finalLabel),
    title: bundle?.sections?.meta?.title || "",
    updatedAt: Date.now(),
    bundle,
  };
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(rec);
    await idbTxDone(tx);
  } catch (e) {
    console.error("idb save failed:", e);
    throw e;
  }
}

export async function listBundles() {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    const all = await idbReq(tx.objectStore(STORE_NAME).getAll());
    return all
      .filter(r => r.id !== GLOBAL_SETTINGS_ID) // グローバル設定レコードは ws ではない
      .map(r => ({
      id: r.id,
      label: r.label || (r.id === DEFAULT_WORKSPACE_ID ? getDefaultWorkspaceLabel() : ""),
      title: r.title || "",
      updatedAt: r.updatedAt || 0,
    }));
  } catch (e) {
    console.warn("idb list failed:", e);
    return [];
  }
}

// 既存ワークスペースの label のみを書き換える (bundle / updatedAt / title は触らない)。
// active / 非 active を問わず使える。
export async function renameBundle(id, newLabel) {
  if (!id) throw new Error("renameBundle: id required");
  const db = await openDb();
  if (!db) return;
  try {
    const txR = db.transaction(STORE_NAME, "readonly");
    const existing = await idbReq(txR.objectStore(STORE_NAME).get(id));
    if (!existing) return;
    existing.label = String(newLabel || "");
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(existing);
    await idbTxDone(tx);
  } catch (e) {
    console.error("idb rename failed:", e);
    throw e;
  }
}

// active workspace は誤削除防止。それ以外は削除可。
export async function deleteBundle(id) {
  if (!id) throw new Error("delete: id required");
  if (id === getActiveWorkspaceId()) {
    throw new Error("cannot delete the active workspace");
  }
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    await idbTxDone(tx);
  } catch (e) {
    console.error("idb delete failed:", e);
    throw e;
  }
}

// 新規ワークスペースの ID を発番。
export function newWorkspaceId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ws_${ts}_${rand}`;
}

// 新規ワークスペースを作成して IDB に保存。switch はしない (caller の責務)。
// bundle が空ならアプリ既定の bundle 形を caller 側で構築して渡す想定。
export async function createWorkspaceRecord(label, bundle) {
  const id = newWorkspaceId();
  await saveBundle(bundle, id, String(label || ""));
  return id;
}

// ============================
// グローバル設定 (全ワークスペース共通)
// ============================

// 予約レコードから設定オブジェクトを読む。未保存なら null。
export async function loadGlobalSettings() {
  try {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction(STORE_NAME, "readonly");
    const rec = await idbReq(tx.objectStore(STORE_NAME).get(GLOBAL_SETTINGS_ID));
    if (rec && rec.settings && typeof rec.settings === "object") return rec.settings;
  } catch (e) {
    console.warn("idb load global settings failed:", e);
  }
  return null;
}

// 予約レコードへ設定オブジェクトを書く (全ワークスペース共通)。
export async function saveGlobalSettings(settings) {
  const db = await openDb();
  if (!db) return; // IDB 不可環境 (テスト等) は no-op
  const rec = { id: GLOBAL_SETTINGS_ID, settings, updatedAt: Date.now() };
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(rec);
    await idbTxDone(tx);
  } catch (e) {
    console.error("idb save global settings failed:", e);
    throw e;
  }
}

// ============================
// Test hooks
// ============================

export function _resetDbForTests() {
  _dbPromise = null;
}
