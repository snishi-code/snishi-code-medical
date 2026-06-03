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

// v8.2+: 設定 (formats / formatGroups / tags / clearTargets / qr 設定) は
// 「ユーザー共通」(= 1 ユーザー内の全ワークスペースで共通) にする。同じ bundles
// ストア内に予約 ID で置き、listBundles では除外する (= ワークスペース一覧に出さない)。
// DB スキーマ変更は不要。
//
// ユーザー機能 (案B): 1 端末を複数人で共有し、人ごとにデータを切り替える。
//   - `__users__`        : ユーザー登録簿 (予約レコード 1 個)
//   - `__settings__::<userId>` : ユーザーごとの設定レコード
//   - 病棟レコードに `userId` を付与し、listBundles を現ユーザーで絞り込む
//   - 旧 `__settings__` (ユーザー無し時代の単一設定) は backfill で
//     `__settings__::<usr_default>` に改名される
const SETTINGS_PREFIX = "__settings__";
const USERS_ID = "__users__";
// ユーザーごとの設定レコード ID を解決する。
function settingsIdFor(userId) {
  return `${SETTINGS_PREFIX}::${userId || ""}`;
}
// listBundles / 病棟列挙で除外すべき予約 ID か。
function isReservedId(id) {
  return id === USERS_ID || id === SETTINGS_PREFIX || (typeof id === "string" && id.startsWith(SETTINGS_PREFIX));
}
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

// 現在ユーザー ID (localStorage、同期 read)。ACTIVE_KEY と同じ手口。
const CURRENT_USER_KEY = "hospital_rounds_current_user_id";

// 既定ユーザー ID (backfill で作られる最初のユーザー)。
const DEFAULT_USER_ID = "usr_default";

export const STORAGE_KEYS = Object.freeze({
  db: DB_NAME,
  store: STORE_NAME,
  defaultWorkspace: DEFAULT_WORKSPACE_ID,
  activeKey: ACTIVE_KEY,
  currentUserKey: CURRENT_USER_KEY,
  usersId: USERS_ID,
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
// 現在ユーザーポインタ (localStorage) + ユーザー登録簿 (IDB の __users__ レコード)
// ============================

export function getCurrentUserId() {
  if (typeof localStorage === "undefined") return DEFAULT_USER_ID;
  return localStorage.getItem(CURRENT_USER_KEY) || DEFAULT_USER_ID;
}

export function setCurrentUserId(id) {
  if (typeof localStorage === "undefined") return;
  if (!id || typeof id !== "string") return;
  localStorage.setItem(CURRENT_USER_KEY, id);
}

// ============================
// オンボーディング / ユーザー再選択 (localStorage・同期 read)
// ============================
//
// - 初回起動 (onboardedAt 未設定) = 名前 + 同意のポップアップを出す合図。
// - ユーザー再選択 = 最後の確認から一定期間 (既定 1 日) 経過で起動時に選択画面。
//   インターバルは将来 UI から変えられるよう localStorage に持たせる器だけ用意し、
//   現状は設定 UI を出さない (既定値を返すだけ)。
const ONBOARDED_KEY = "hospital_rounds_onboarded_at";
const LAST_USER_CONFIRM_KEY = "hospital_rounds_last_user_confirm_at";
const USER_RESELECT_INTERVAL_KEY = "hospital_rounds_user_reselect_interval_ms";
const DEFAULT_USER_RESELECT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 日

export function getOnboardedAt() {
  if (typeof localStorage === "undefined") return 0;
  return parseInt(localStorage.getItem(ONBOARDED_KEY) || "0", 10) || 0;
}
export function setOnboardedAt(ts) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ONBOARDED_KEY, String(ts || Date.now()));
}
export function getLastUserConfirmAt() {
  if (typeof localStorage === "undefined") return 0;
  return parseInt(localStorage.getItem(LAST_USER_CONFIRM_KEY) || "0", 10) || 0;
}
export function setLastUserConfirmAt(ts) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LAST_USER_CONFIRM_KEY, String(ts || Date.now()));
}
// 将来 UI から変更可能にする器 (現状は setter を呼ぶ箇所が無い)。
export function getUserReselectIntervalMs() {
  if (typeof localStorage === "undefined") return DEFAULT_USER_RESELECT_INTERVAL_MS;
  const v = parseInt(localStorage.getItem(USER_RESELECT_INTERVAL_KEY) || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_USER_RESELECT_INTERVAL_MS;
}
export function setUserReselectIntervalMs(ms) {
  if (typeof localStorage === "undefined") return;
  if (Number.isFinite(ms) && ms >= 0) localStorage.setItem(USER_RESELECT_INTERVAL_KEY, String(ms));
}
// 起動時にユーザー再選択を促すべきか。
export function isUserReselectDue() {
  const last = getLastUserConfirmAt();
  if (!last) return true;
  return (Date.now() - last) >= getUserReselectIntervalMs();
}

// 既定ユーザー名 (i18n)。getDefaultWorkspaceLabel と同じ理由で関数経由。
export function getDefaultUserName() {
  return t("user.default.name");
}

export function newUserId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `usr_${ts}_${rand}`;
}

// __users__ レコードの users 配列を読む (未保存なら [])。
export async function loadUsers() {
  try {
    const db = await openDb();
    if (!db) return [];
    const tx = db.transaction(STORE_NAME, "readonly");
    const rec = await idbReq(tx.objectStore(STORE_NAME).get(USERS_ID));
    if (rec && Array.isArray(rec.users)) return rec.users;
  } catch (e) {
    console.warn("idb load users failed:", e);
  }
  return [];
}

// __users__ レコードへ users 配列を書く。
async function saveUsers(users) {
  const db = await openDb();
  if (!db) return;
  const rec = { id: USERS_ID, users: Array.isArray(users) ? users : [], updatedAt: Date.now() };
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(rec);
    await idbTxDone(tx);
  } catch (e) {
    console.error("idb save users failed:", e);
    throw e;
  }
}

// 一覧用の正規化済みユーザー配列。
export async function listUsers() {
  const users = await loadUsers();
  return users.map(u => ({
    id: u.id,
    name: u.name || "",
    createdAt: u.createdAt || 0,
    activeWorkspaceId: u.activeWorkspaceId || "",
  }));
}

// 重複名チェック (大小文字・前後空白を無視せず厳密一致。except は自分自身の id)。
async function isDuplicateUserName(name, exceptId) {
  const trimmed = String(name || "").trim();
  const users = await loadUsers();
  return users.some(u => u.id !== exceptId && (u.name || "").trim() === trimmed);
}

export async function userNameExists(name, exceptId) {
  return isDuplicateUserName(name, exceptId);
}

// 新規ユーザーを登録して id を返す。重複名は呼び出し側で弾く想定だが二重防御。
export async function createUser(name) {
  const users = await loadUsers();
  const id = newUserId();
  users.push({
    id,
    name: String(name || "").trim(),
    createdAt: Date.now(),
    activeWorkspaceId: "",
    passhash: null, // パスワードの器 (今は常に null)
  });
  await saveUsers(users);
  return id;
}

export async function renameUser(id, name) {
  const users = await loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return;
  u.name = String(name || "").trim();
  await saveUsers(users);
}

export function getUserActiveWorkspaceId(users, id) {
  const u = (users || []).find(x => x.id === id);
  return u ? (u.activeWorkspaceId || "") : "";
}

export async function setUserActiveWorkspaceId(id, wsId) {
  const users = await loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return;
  u.activeWorkspaceId = String(wsId || "");
  await saveUsers(users);
}

// ユーザーを削除し、そのユーザーに属する全病棟レコード + 設定レコードも消す。
// 戻り値: { users: 残ったユーザー配列, workspaceIds: 削除した病棟 ID 配列 }。
// workspaceIds は呼び出し側がスナップショット DB の purge に使う (PII を別 DB に
// 残さないため。snapshots.purgeSnapshotsForWorkspaces を参照)。
export async function deleteUser(id) {
  const db = await openDb();
  if (!db) return [];
  // 1) このユーザーの病棟 id を集める
  const victimWsIds = [];
  try {
    const txR = db.transaction(STORE_NAME, "readonly");
    const all = await idbReq(txR.objectStore(STORE_NAME).getAll());
    for (const r of all) {
      if (!isReservedId(r.id) && r.userId === id) victimWsIds.push(r.id);
    }
  } catch (e) {
    console.warn("deleteUser: scan failed:", e);
  }
  // 2) 病棟 + 設定レコードを削除
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const wsId of victimWsIds) store.delete(wsId);
    store.delete(settingsIdFor(id));
    await idbTxDone(tx);
  } catch (e) {
    console.error("deleteUser: delete failed:", e);
    throw e;
  }
  // 3) 登録簿から除去
  const users = (await loadUsers()).filter(u => u.id !== id);
  await saveUsers(users);
  return { users, workspaceIds: victimWsIds };
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

// IndexedDB が実際に開けるか (= 永続化が効くか) を返す。db=null の no-op 保存を
// 「保存できていない事実」として扱いたい durable な経路 (病棟切替・患者移動など) が
// 事前判定に使う。fire-and-forget の autosave はこれを見ない (従来どおり no-op 許容)。
export async function isStorageAvailable() {
  return (await openDb()) !== null;
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

export async function saveBundle(bundle, id, label, userIdOverride) {
  const targetId = id || getActiveWorkspaceId();
  const db = await openDb();
  if (!db) return; // IDB 不可環境 (テスト等) は no-op
  // label が未指定なら既存レコードの label を温存。新規作成だけ default label。
  // userId は: 明示指定 > 既存レコードの温存 > 現ユーザー の優先順。
  let finalLabel = label;
  let finalUserId = userIdOverride || null;
  try {
    const txR = db.transaction(STORE_NAME, "readonly");
    const existing = await idbReq(txR.objectStore(STORE_NAME).get(targetId));
    if (existing) {
      if (finalLabel == null && typeof existing.label === "string") finalLabel = existing.label;
      if (finalUserId == null && typeof existing.userId === "string" && existing.userId) finalUserId = existing.userId;
    }
  } catch (_) { /* ignore */ }
  if (finalLabel == null) {
    finalLabel = (targetId === DEFAULT_WORKSPACE_ID) ? getDefaultWorkspaceLabel() : "";
  }
  if (finalUserId == null) finalUserId = getCurrentUserId();
  const rec = {
    id: targetId,
    userId: finalUserId,
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
    const currentUserId = getCurrentUserId();
    return all
      // 予約レコード (__users__ / __settings__::*) は病棟ではない
      .filter(r => !isReservedId(r.id))
      // 現ユーザーに属する病棟だけ
      .filter(r => r.userId === currentUserId)
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

// 全ユーザー横断で病棟レコードを列挙する (current user で絞らない)。
// 端末まるごとエクスポート用。userId 付きで返す。
export async function listAllWorkspaces() {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    const all = await idbReq(tx.objectStore(STORE_NAME).getAll());
    return all
      .filter(r => !isReservedId(r.id))
      .map(r => ({
        id: r.id,
        userId: r.userId || "",
        label: r.label || "",
        title: r.title || "",
        updatedAt: r.updatedAt || 0,
      }));
  } catch (e) {
    console.warn("idb listAll failed:", e);
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
export async function createWorkspaceRecord(label, bundle, userIdOverride) {
  const id = newWorkspaceId();
  await saveBundle(bundle, id, String(label || ""), userIdOverride);
  return id;
}

// ============================
// 設定 (ユーザーごと: __settings__::<userId>)
// ============================
//
// 関数名は据え置き (全ワークスペース共通だった v8.2 の名残)。実体は現ユーザーの
// 設定レコードを読み書きする。明示的に userId を渡せば任意ユーザーの設定も触れる
// (端末まるごとエクスポート等)。

// 設定オブジェクトを読む。未保存なら null。
export async function loadGlobalSettings(userId) {
  const uid = userId || getCurrentUserId();
  try {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction(STORE_NAME, "readonly");
    const rec = await idbReq(tx.objectStore(STORE_NAME).get(settingsIdFor(uid)));
    if (rec && rec.settings && typeof rec.settings === "object") return rec.settings;
  } catch (e) {
    console.warn("idb load settings failed:", e);
  }
  return null;
}

// 設定オブジェクトを書く。
export async function saveGlobalSettings(settings, userId) {
  const db = await openDb();
  if (!db) return; // IDB 不可環境 (テスト等) は no-op
  const uid = userId || getCurrentUserId();
  const rec = { id: settingsIdFor(uid), settings, updatedAt: Date.now() };
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(rec);
    await idbTxDone(tx);
  } catch (e) {
    console.error("idb save settings failed:", e);
    throw e;
  }
}

// ============================
// ユーザー機能の起動時 backfill (冪等)
// ============================
//
// `__users__` が無ければ「一度だけ」既存データをデフォルトユーザー配下へ移行する:
//   (a) usr_default を作成 (名前は i18n 既定)
//   (b) 既存の全病棟レコードに userId=usr_default を付与
//   (c) 旧 __settings__ を __settings__::usr_default へ改名
//   (d) currentUser ポインタ = usr_default、その activeWorkspaceId = 現 active ws
// 2 回目以降は何もしない (currentUser ポインタが消えた場合だけ先頭ユーザーへ補正)。
export async function ensureUsersInitialized() {
  const db = await openDb();
  if (!db) return; // IDB 不可環境 (テスト等) は移行対象なし

  // 既に初期化済みか
  let usersRec = null;
  try {
    const txR = db.transaction(STORE_NAME, "readonly");
    usersRec = await idbReq(txR.objectStore(STORE_NAME).get(USERS_ID));
  } catch (_) { /* ignore */ }
  if (usersRec && Array.isArray(usersRec.users) && usersRec.users.length) {
    // currentUser ポインタが現存ユーザーを指しているか確認 (壊れていたら先頭に補正)
    const ids = usersRec.users.map(u => u.id);
    if (!ids.includes(getCurrentUserId())) setCurrentUserId(usersRec.users[0].id);
    return;
  }

  // --- 一度きりの backfill ---
  let all = [];
  try {
    const txR = db.transaction(STORE_NAME, "readonly");
    all = await idbReq(txR.objectStore(STORE_NAME).getAll());
  } catch (_) { /* ignore */ }

  const activeWsId = getActiveWorkspaceId();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    // (b) 既存病棟に userId を付与
    for (const r of all) {
      if (isReservedId(r.id)) continue;
      if (!r.userId) { r.userId = DEFAULT_USER_ID; store.put(r); }
    }
    // (c) 旧 __settings__ を __settings__::usr_default へ改名
    const oldSettings = all.find(r => r.id === SETTINGS_PREFIX);
    if (oldSettings && oldSettings.settings) {
      store.put({ id: settingsIdFor(DEFAULT_USER_ID), settings: oldSettings.settings, updatedAt: oldSettings.updatedAt || Date.now() });
      store.delete(SETTINGS_PREFIX);
    }
    // (a)(d) 登録簿を作成
    store.put({
      id: USERS_ID,
      users: [{
        id: DEFAULT_USER_ID,
        name: getDefaultUserName(),
        createdAt: Date.now(),
        activeWorkspaceId: activeWsId,
        passhash: null,
      }],
      updatedAt: Date.now(),
    });
    await idbTxDone(tx);
  } catch (e) {
    console.error("ensureUsersInitialized: backfill failed:", e);
  }
  setCurrentUserId(DEFAULT_USER_ID);
}

// ============================
// Test hooks
// ============================

export function _resetDbForTests() {
  _dbPromise = null;
}
