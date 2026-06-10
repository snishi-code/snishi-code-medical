"use strict";

// ============================
// 中央 履歴・戻る操作モジュール (app-history)
//
// 端末の「戻る」操作を、画面遷移・一時ポップアップ・患者画面の inline 編集・
// memo/shared 鉛筆編集・アプリ終了確認まで一貫制御する唯一の場所。
// history.replaceState / pushState / back / popstate をここに集約し、
// navigation.showView() は表示切替に専念させる (showView は setHistoryPush 経由で
// pushView を呼ぶだけ)。
//
// 依存方向: app-history → navigation / formats / edit-toggle (一方向)。
// navigation は app-history を import せず setHistoryPush フックで受け取る (循環回避)。
//
// 戻る操作の優先順位 (onPopState):
//   0.   終了処理中 (_exiting): guard を通過して履歴の外へ抜ける (OK 後の 1 回だけ)
//   0.5  終了確認が開いている間の Back: 消費して確認を維持 (連打 bypass 防止)
//   1.   最前面の閉じられるポップアップを閉じる
//   2.   患者画面 inline 編集を破棄 (formats.cancelInlineFormatEdit)
//   3.   memo/shared 鉛筆編集を解除 (edit-toggle.isAnyEditing)
//   4.   guard 到達 (home で戻った): home を積み直してから終了確認 (guard 上に留まらない)
//   5.   通常 view 遷移
// ============================

import { showView } from "./navigation.js";
import { cancelInlineFormatEdit, closeFormatInputModal } from "./formats.js";
import { isAnyEditing, exitAllEdits } from "./edit-toggle.js";

// 戻る遷移時の view 別再描画ディスパッチ (home/memo/shared/detail/settings)。main.js が注入。
let _renderView = () => {};
// 終了確認 OK 後、guard を 1 回だけ通過して履歴外へ抜けるためのフラグ。
let _exiting = false;

// --- 一時ポップアップの開閉 (旧 main.js から移設) ---------------------------
// 「閉じられる一時ポップアップ」= active な .popupMenuOverlay のうち data-no-backdrop-close
// (初期化/免責/確認系の app ゲート) でないもの。formatInputOverlay (患者入力) は内部 state の
// cleanup が要るので専用 close を通す。
function closablePopups() {
  return [...document.querySelectorAll(".popupMenuOverlay.active")]
    .filter(ov => !ov.hasAttribute("data-no-backdrop-close"));
}
function closeOnePopupWithCleanup(ov) {
  if (!ov) return;
  if (ov.id === "formatInputOverlay") { closeFormatInputModal(); return; } // _currentSheet も破棄
  ov.classList.remove("active");
}
// 画面遷移時: view 横断の一時ポップアップを全部閉じる (患者入力シートは cleanup 付き) +
// 展開カードの inline 編集も view 横断で残さない (画面/患者をまたいだ未保存ドラフトを破棄。
// 戻ってくれば detail 全体が再描画されるので silent = 個別パネル再描画は不要)。
export function closeTransientPopups() {
  for (const ov of closablePopups()) closeOnePopupWithCleanup(ov);
  cancelInlineFormatEdit({ silent: true });
}
// 戻る操作用: 最前面の閉じられるポップアップを 1 つ閉じる。閉じたら true。
function closeTopClosablePopup() {
  const open = closablePopups();
  if (!open.length) return false;
  // 最前面 = z-index 最大 (同値なら DOM 後方)。
  let top = open[0], topZ = -Infinity;
  for (const ov of open) {
    const z = parseInt(getComputedStyle(ov).zIndex, 10);
    const zz = Number.isFinite(z) ? z : 0;
    if (zz >= topZ) { topZ = zz; top = ov; }
  }
  closeOnePopupWithCleanup(top);
  return true;
}

// --- history push (navigation から setHistoryPush 経由で呼ばれる) -----------
// 同一 view の連続 push を抑止 (detail→detail / home 連打を積まない = detail から
// 戻ると常に home)。
export function pushView(which) {
  if (history.state && history.state.view === which) return;
  history.pushState({ view: which }, "", "");
}

// --- 終了確認 ---------------------------------------------------------------
const exitOverlay = () => document.getElementById("exitConfirmOverlay");
const isExitConfirmOpen = () => !!exitOverlay()?.classList.contains("active");
const currentView = () => document.documentElement.dataset.view || "home";
// 戻る操作を「消費」して現在 view の履歴エントリを積み直す (画面遷移させない)。
const reconsumeBack = () => history.pushState({ view: currentView() }, "", "");

function onPopState(e) {
  // 0. 終了処理中: guard を通過して履歴の外へ抜ける (1 回だけ)。
  if (_exiting) { _exiting = false; history.back(); return; }
  // 0.5 終了確認が開いている間の Back は消費して確認を維持 (連打 bypass 防止 = 修正 #2)。
  if (isExitConfirmOpen()) { history.pushState({ view: "home" }, "", ""); return; }
  // 1. 最前面ポップアップを閉じる。
  if (closeTopClosablePopup()) { reconsumeBack(); return; }
  // 2. 患者画面 inline 編集を破棄 (active なら true = 修正 #3)。
  if (cancelInlineFormatEdit()) { reconsumeBack(); return; }
  // 3. memo/shared 鉛筆編集を解除 (画面遷移はせず編集だけ抜ける)。
  if (isAnyEditing()) { exitAllEdits(); reconsumeBack(); return; }
  const st = e.state || {};
  // 4. guard: home で戻った → home を積み直してから終了確認 (guard 上に留まらない = 修正 #2)。
  if (st.__exitGuard) {
    history.pushState({ view: "home" }, "", "");
    _renderView("home");
    exitOverlay()?.classList.add("active");
    return;
  }
  // 5. 通常 view 遷移 (showView の副作用: 一時 popup 閉じ/編集解除/NAV スナップショット)。
  const v = st.view || "home";
  showView(v, false);
  _renderView(v);
}

// OK = アプリ外へ戻ることを許可。
function onExitOk() {
  exitOverlay()?.classList.remove("active");
  _exiting = true;
  history.back(); // → onPopState step0 で guard を通過して履歴外へ
}
// キャンセル = home に残る (step4 で既に home を積み直し済みなので閉じるだけ)。
function onExitCancel() {
  exitOverlay()?.classList.remove("active");
}

// 起動時に配線する。renderView(v) = home/memo/shared/detail/settings の再描画ディスパッチ。
// root guard (最下層 __exitGuard + その上 home の 2 状態) を敷き、home で戻ると guard に当たる。
export function initAppHistory({ renderView } = {}) {
  if (typeof renderView === "function") _renderView = renderView;
  history.replaceState({ __exitGuard: true }, "", "");
  history.pushState({ view: "home" }, "", "");
  window.addEventListener("popstate", onPopState);
  document.getElementById("exitConfirmOkBtn")?.addEventListener("click", onExitOk);
  document.getElementById("exitConfirmCancelBtn")?.addEventListener("click", onExitCancel);
}
