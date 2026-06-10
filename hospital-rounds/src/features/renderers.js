"use strict";

// ============================
// Render orchestrator (factory)
//
// 各 view (home / detail / memo / shared) の render 関数を「お互いを呼び合える」
// 形でまとめて返す。main.js は createRenderers(...) を 1 度呼ぶだけ。
//
// なぜ factory にするか:
//   - doRenderMemo → navigateToPatient → doRenderDetail のように相互参照する
//   - showView / setSelectedNo / refresh QR 群を外から
//     注入することで、テストや別アプリへの移植が容易になる
//   - main.js を「組み立て役」に戻す。ここに居るべきロジックを抽出
//
// 注入する依存:
//   renderHome / renderDetail / renderMemoScreen / renderSharedScreen
//     - 各 view のレンダ関数 (views/*.js のもの)
//   setSelectedNo / showView
//     - store と navigation feature の primitives
//   refreshSharedQrIfActive / refreshMemoQrIfActive / refreshHomeQrIfActive
//   / refreshSettingsQrIfActive
//     - 開いてる QR を反映するため
// ============================

export function createRenderers(deps) {
  const {
    renderHome,
    renderDetail,
    renderMemoScreen,
    renderSharedScreen,
    setSelectedNo,
    showView,
    refreshSharedQrIfActive,
    refreshMemoQrIfActive,
    refreshHomeQrIfActive,
    refreshSettingsQrIfActive,
  } = deps;

  function doRenderHome() {
    renderHome((i) => {
      setSelectedNo(i);
      doRenderDetail();
      showView("detail");
    });
  }

  function doRenderDetail() {
    renderDetail();
  }

  function navigateToPatient(i) {
    // 共通の編集トグルが showView で自動 exit するので、ここでは個別 reset 不要
    setSelectedNo(i);
    doRenderDetail();
    showView("detail");
  }

  function doRenderMemo(opts) {
    renderMemoScreen(doRenderHome, opts, navigateToPatient);
  }

  function doRenderShared(opts) {
    renderSharedScreen(doRenderHome, opts, navigateToPatient);
  }

  // 現在のアクティブ view を見て該当 renderer を走らせ + 全 QR を再生成。
  // 設定 QR 受信や WS 切替で「画面全体を再描画したい」時のフック。
  function refreshPatientUI() {
    const viewId = document.querySelector(".view.active")?.id;
    if (viewId === "memoView") doRenderMemo();
    else if (viewId === "sharedView") doRenderShared();
    else if (viewId === "detailView") doRenderDetail();
    else if (viewId === "homeView") doRenderHome();
    refreshSharedQrIfActive();
    refreshMemoQrIfActive();
    refreshHomeQrIfActive();
    refreshSettingsQrIfActive();
  }

  return { doRenderHome, doRenderDetail, doRenderMemo, doRenderShared, navigateToPatient, refreshPatientUI };
}
