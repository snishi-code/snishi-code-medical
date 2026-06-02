"use strict";

// ============================
// アプリヘッダーのユーザー名 + ワークスペース名 入力欄
//
// ユーザー機能 (案B): ヘッダーのタイトル枠は「現ユーザー名」を表示する。
//   - 普段は readonly。タップで user picker を開く (features/user-picker.js が配線)
//   - リネームは user picker / 設定画面のユーザー管理で行う
//   ※ ホーム遷移は「家」ボタン (homeNavBtn) が担う
//
// - ワークスペース名は「アクティブ ws の label」(IDB の bundles テーブル):
//   - 普段は readonly。タップで WS picker を開く (features/ws-picker.js)
//   - リネームはピッカー内 / 設定画面
//
// 公開 API:
//   initAppTitle()        - 起動時にユーザー名 + ws 名を入力欄へ反映
//   refreshAppUserName()  - 現ユーザー名を input に反映 (ユーザー切替/リネーム時に呼ぶ)
//   refreshAppWsLabel()   - active ws の label を IDB から取得して input に反映
//   syncInputSize(inp)    - field-sizing 未対応ブラウザの size 属性同期
// ============================

import { appState, getCurrentUserName } from "../store.js";
import { listBundles, getActiveWorkspaceId } from "../storage.js";
import { t } from "../i18n.js";

// field-sizing 未対応ブラウザ向けの size 属性同期。
export function syncInputSize(inp) {
  if (!inp) return;
  const len = (inp.value || "").length || 1;
  inp.size = Math.max(2, Math.min(20, len));
}

// 現ユーザー名をヘッダーのタイトル枠へ反映。
export function refreshAppUserName() {
  const appTitleInput = document.getElementById("appTitleInput");
  if (!appTitleInput) return;
  const name = getCurrentUserName() || appState.title || t("app.title");
  appTitleInput.value = name;
  document.title = name;
  syncInputSize(appTitleInput);
}

// アクティブワークスペースの label を IDB から取得 → ヘッダー入力欄へ反映
export async function refreshAppWsLabel() {
  const inp = document.getElementById("appWsLabelInput");
  if (!inp) return;
  try {
    const activeId = getActiveWorkspaceId();
    const all = await listBundles();
    const me = all.find(r => r.id === activeId);
    inp.value = me ? (me.label || t("io.ws.untitled")) : "";
  } catch (e) {
    console.warn("refreshAppWsLabel failed:", e);
  }
}

// ヘッダー入力欄の初期化。タイトル枠 = 現ユーザー名 (readonly、タップで user picker)、
// WS 名 = active ws label (readonly、タップで ws picker)。クリック配線は各 picker が行う。
export function initAppTitle() {
  const appTitleInput = document.getElementById("appTitleInput");
  const appWsLabelInput = document.getElementById("appWsLabelInput");

  if (appTitleInput) {
    appTitleInput.readOnly = true;
    appTitleInput.placeholder = t("header.user.placeholder");
    refreshAppUserName();
  }

  if (appWsLabelInput) {
    refreshAppWsLabel();
    appWsLabelInput.readOnly = true;
    appWsLabelInput.placeholder = t("header.ws.placeholder");
  }
}
