"use strict";

import { appState, selectedNo, saveSettings } from "../store.js";
import { exitAllEdits } from "./edit-toggle.js";

export function showView(which, pushState = true) {
  // ビューを切り替える前に、どこかで開いていた編集モードを必ず閉じる
  exitAllEdits();
  if (pushState) {
    history.pushState({ view: which }, "", "");
  }
  const homeView = document.getElementById("homeView");
  const memoView = document.getElementById("memoView");
  const sharedView = document.getElementById("sharedView");
  const settingsView = document.getElementById("settingsView");
  const detailView = document.getElementById("detailView");
  const docsViewEl = document.getElementById("docsView");

  if (homeView) homeView.classList.toggle("active", which === "home");
  if (memoView) memoView.classList.toggle("active", which === "memo");
  if (sharedView) sharedView.classList.toggle("active", which === "shared");
  if (settingsView) settingsView.classList.toggle("active", which === "settings");
  if (detailView) detailView.classList.toggle("active", which === "detail");
  if (docsViewEl) docsViewEl.classList.toggle("active", which === "docs");

  // ヘッダーのナビボタンを CSS の attribute selector で active 表示する
  // ためのフラグ。html[data-view="memo"] #headerMemoBtn { ... } などで使う
  document.documentElement.dataset.view = which;

  if (which !== "shared") {
    const sharedQrWrap = document.getElementById("sharedQrWrap");
    if (sharedQrWrap) sharedQrWrap.classList.remove("active");
  }

  window.scrollTo(0, 0);
}

export function syncDetailMemoDisplay() {
  const detailMemoText = document.getElementById("detailMemoText");
  if (!detailMemoText) return;
  const p = appState.patients[selectedNo - 1];
  detailMemoText.value = String(p?.memo ?? "");
}

export function lastMemoNo() {
  for (let i = appState.patients.length; i >= 1; i--) {
    const m = String(appState.patients[i - 1]?.memo ?? "").trim();
    if (m) return i;
  }
  return 0;
}

export function lastSharedNo() {
  for (let i = appState.patients.length; i >= 1; i--) {
    const m = String(appState.patients[i - 1]?.shared ?? "").trim();
    if (m) return i;
  }
  return 0;
}

// ============================
// Nav buttons (header tabs)
// ============================
// header の Memo/Shared/Settings/Home ボタン → 該当 view の renderer を
// 走らせて showView。render 関数群は呼び出し側の renderers factory から
// 注入する (依存を明示)。
export function createNavigators(deps) {
  const { doRenderHome, doRenderMemo, doRenderShared, renderSettings } = deps;

  function navToMemo() {
    doRenderMemo();
    showView("memo");
  }
  function navToShared() {
    doRenderShared();
    showView("shared");
  }
  function navToHome() {
    // home に戻るタイミングで settings をフラッシュ (画面遷移時の確実な保存)
    saveSettings();
    doRenderHome();
    showView("home");
  }
  function navToSettings() {
    renderSettings();
    showView("settings");
  }

  return { navToMemo, navToShared, navToHome, navToSettings };
}

// ============================
// Docs ページ ナビゲーション
// ============================
// 説明書 (アプリ内ヘルプ) は DOCS_BUNDLE に bundle 化されているため、外部
// ネットワークも service-worker キャッシュも要らない。iframe.srcdoc に
// 文字列ベースで流し込む。
// 画像 URL のプレースホルダ `__BASE__/` は現在の base URL (deploy 先による
// 違い: prod は /hospital-rounds/、test サブドメインは /) に置換される。
// `import.meta.env.BASE_URL` は vite-plugin-singlefile が `./` に上書き
// するので使わず、document.baseURI から導出する。
export function createDocsOpener(deps) {
  const { docsBundle } = deps;
  const docsBase = new URL("./", document.baseURI).pathname;

  return function openDocsPage(pageName) {
    const iframe = document.getElementById("docsIframe");
    if (!iframe) return;
    const key = pageName.endsWith(".html") ? pageName : pageName + ".html";
    const html = (docsBundle[key] || docsBundle["index.html"] || "")
      .replaceAll("__BASE__/", docsBase);
    iframe.srcdoc = html;
    showView("docs");
  };
}
