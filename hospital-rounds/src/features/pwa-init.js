"use strict";

// PWA 初回起動時のデータ整理 UI。
//
// 背景:
//   iOS Safari の PWA は Safari と origin ストレージを共有しているため、
//   PWA をインストールする前にユーザがブラウザでテスト入力した内容が、
//   PWA を初めて起動した時点で「自動でそこにある」状態になる。これは
//   仕様で不可避だが、ユーザは「テスト時のゴミデータが本番アプリに残った」
//   と不安に感じるので、初回起動時に明示的に確認するダイアログを出す。
//
// 動作:
//   - PWA (standalone) として今回初めて起動したか判定 (= MARKER が未設定)
//   - そうであれば overlay を表示し、ユーザに 2 択を提示:
//       「削除して開始」 → IDB を削除 + 関連 localStorage を削除 → リロード
//       「続きから使う」 → 何もせず MARKER だけ書く
//   - 2 回目以降の起動では何もしない
//
// 呼び出し規約:
//   main.js から、await initStore() の "前" に await maybeShowPwaInitDialog()
//   を呼ぶ。「削除して開始」を選んだ場合は内部でリロードするので、戻ってこない。

import { STORAGE_KEYS } from "../storage.js";

const MARKER = "hospital_rounds_standalone_initialized";

// PWA standalone モードかを判定。
//   - 標準的なブラウザ: matchMedia('(display-mode: standalone)')
//   - iOS Safari (古い API): navigator.standalone
function isStandaloneLaunch() {
  try {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch (_) { /* ignore */ }
  if (window.navigator && window.navigator.standalone === true) return true;
  return false;
}

// IDB データベースを丸ごと削除。Promise 化。
function dropIndexedDb(dbName) {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(); return; }
    try {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => { console.warn("idb delete failed:", req.error); resolve(); };
      req.onblocked = () => { console.warn("idb delete blocked"); resolve(); };
    } catch (e) {
      console.warn("idb delete threw:", e);
      resolve();
    }
  });
}

// アプリ関連の localStorage キーをすべて削除 (legacy 含む)。
function clearAppLocalStorage() {
  if (typeof localStorage === "undefined") return;
  const keysToRemove = [
    STORAGE_KEYS.activeKey,
    STORAGE_KEYS.legacyBundle,
    STORAGE_KEYS.legacyState,
    STORAGE_KEYS.legacySettings,
    MARKER,
  ];
  for (const k of keysToRemove) {
    try { localStorage.removeItem(k); } catch (_) { /* ignore */ }
  }
}

// 初回起動なら overlay を出してユーザに尋ねる。それ以外なら no-op。
// 「削除して開始」を選んだ場合は内部で reload するため戻り値で区別する必要はない。
export async function maybeShowPwaInitDialog() {
  if (!isStandaloneLaunch()) return;
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(MARKER)) return; // 2 回目以降

  const overlay = document.getElementById("pwaInitOverlay");
  const clearBtn = document.getElementById("pwaInitClearBtn");
  const keepBtn = document.getElementById("pwaInitKeepBtn");
  if (!overlay || !clearBtn || !keepBtn) {
    // DOM が無ければマーカーだけ立てて諦める (継続使用扱い)
    localStorage.setItem(MARKER, "1");
    return;
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.remove("active");
      clearBtn.removeEventListener("click", onClear);
      keepBtn.removeEventListener("click", onKeep);
    };
    const onClear = async () => {
      cleanup();
      await dropIndexedDb(STORAGE_KEYS.db);
      clearAppLocalStorage();
      // 削除完了後、まっさらな状態でリロード。MARKER も削除済みなので
      // 次回起動でまた出てしまうが、リロード後は MARKER をすぐ立てる:
      try { localStorage.setItem(MARKER, "1"); } catch (_) { /* ignore */ }
      window.location.reload();
      // reload 後は新しいページ実行になる
    };
    const onKeep = () => {
      cleanup();
      try { localStorage.setItem(MARKER, "1"); } catch (_) { /* ignore */ }
      resolve();
    };
    clearBtn.addEventListener("click", onClear);
    keepBtn.addEventListener("click", onKeep);
    overlay.classList.add("active");
  });
}
