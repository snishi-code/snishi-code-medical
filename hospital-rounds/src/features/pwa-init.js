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
//       「削除して開始」 → 全アプリデータ (本体/eventlog/snapshots の 3 IDB +
//                          全 localStorage) を削除して完全に初期状態へ → リロード
//       「続きから使う」 → 何もせず MARKER だけ書く
//   - 2 回目以降の起動では何もしない
//
// 呼び出し規約:
//   main.js から、await initStore() の "前" に await maybeShowPwaInitDialog()
//   を呼ぶ。「削除して開始」を選んだ場合は内部でリロードするので、戻ってこない。

import { t } from "../i18n.js";
import { dropAllAppIndexedDbs } from "./idb-wipe.js";

const MARKER = "hospital_rounds_standalone_initialized";

// localStorage キーは "hospital_rounds_" (アンダースコア) で統一。
// 「完全に初期化」はこの prefix で一掃する (origin 共有なので全消しは他アプリを巻き込む)。
// IndexedDB の全削除は features/idb-wipe.js (fail-closed) に集約。
const LS_PREFIX = "hospital_rounds_";

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

// アプリの localStorage キーをすべて削除する。origin 共有のため localStorage.clear()
// は他アプリを巻き込むので使わず、LS_PREFIX のキーだけを一掃する (将来キーが増えても
// prefix が揃っていれば自動でカバーされる)。
function clearAppLocalStorage() {
  if (typeof localStorage === "undefined") return;
  // 反復中の removeItem で index がずれないよう、対象キーを先に集めてから消す。
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
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
      // 二重押し防止。削除が確認できるまで cleanup/marker/reload はしない (fail-closed)。
      clearBtn.disabled = true;
      keepBtn.disabled = true;
      try {
        await dropAllAppIndexedDbs();
      } catch (e) {
        // 削除が確認できなかった (別タブが DB 接続を握って blocked 等)。患者データが
        // 残ったまま「初期化済み」にしてはいけない。dialog を出したまま再試行を促す。
        console.error("pwa init: data wipe failed:", e);
        clearBtn.disabled = false;
        keepBtn.disabled = false;
        alert(t("pwa.init.wipeFailed"));
        return;
      }
      clearAppLocalStorage();
      cleanup();
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
