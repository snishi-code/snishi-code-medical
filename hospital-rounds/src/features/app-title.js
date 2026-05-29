"use strict";

// ============================
// アプリヘッダーのタイトル + ワークスペース名 入力欄
//
// - タイトルは「端末固定」(localStorage 経由で永続化、live state に反映)。
//   普段は readonly。鉛筆 (createEditToggle) でだけ編集可能
//   タップ (非編集時) → ホーム遷移
//
// - ワークスペース名は「アクティブ ws の label」(IDB の bundles テーブル):
//   - 普段は readonly。タップで WS picker を開く (features/ws-picker.js)
//   - 鉛筆 (createEditToggle) で editable に切替 → blur/Enter で renameBundle
//   v7.6.0 で「常時 readonly + 設定画面 rename」にしたが、v7.6.1 で「ヘッダー
//   でも鉛筆経由で rename 可」を復活させた。設定画面の rename と二系統並立
//
// 公開 API:
//   initAppTitle({ titleToggleSetter, navToHome })
//     - getTitleToggle: createEditToggle の戻り値を後で受け取る getter
//     - navToHome: タイトル input をタップ (非編集時) → ホームへ
//   refreshAppWsLabel()
//     - active ws の label を IDB から取得して input に反映 (ws 切替時に呼ぶ)
//   updateAppTitle(newTitle)
//     - タイトル変更 (input イベント or 別 view から呼ぶ用)
//   syncInputSize(inp)
//     - field-sizing 未対応ブラウザの size 属性同期
// ============================

import { appState, updateDeviceTitle, scheduleSave } from "../store.js";
import { listBundles, getActiveWorkspaceId } from "../storage.js";
import { t } from "../i18n.js";

// field-sizing 未対応ブラウザ向けの size 属性同期。
export function syncInputSize(inp) {
  if (!inp) return;
  const len = (inp.value || "").length || 1;
  inp.size = Math.max(2, Math.min(20, len));
}

// タイトル文字列を端末固定の永続値として保存し、live state にも反映。
// bundle 側 meta.title も整合させるため save も発火。
export function updateAppTitle(val) {
  updateDeviceTitle(val || t("app.title"));
  document.title = appState.title;
  scheduleSave();
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

// v8.9: ヘッダーの鉛筆 (編集トグル) は撤去。
//   - タイトル: ただのラベル (編集は設定画面 → updateAppTitle / refreshAppTitle)
//   - WS 名: readonly のまま。タップ→WSピッカー (ws-picker.js が配線)、リネームもピッカー内
export function initAppTitle() {
  const appTitleInput = document.getElementById("appTitleInput");
  const appWsLabelInput = document.getElementById("appWsLabelInput");

  if (appTitleInput) {
    appTitleInput.value = appState.title;
    document.title = appState.title;
    syncInputSize(appTitleInput);
  }

  if (appWsLabelInput) {
    refreshAppWsLabel();
    appWsLabelInput.readOnly = true;
    appWsLabelInput.placeholder = t("header.ws.placeholder");
  }
}

// 設定画面でタイトルを変更した時にヘッダー表示を最新化する。
export function refreshAppTitle() {
  const appTitleInput = document.getElementById("appTitleInput");
  if (appTitleInput) {
    appTitleInput.value = appState.title;
    syncInputSize(appTitleInput);
  }
  document.title = appState.title;
}
