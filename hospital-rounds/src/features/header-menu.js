"use strict";

// ============================
// ヘッダー右の ☰ ハンバーガーメニュー
//
// ☰ をタップ → メニューオーバーレイを開閉。各アイコン (設定 / データ管理 等)
// は HTML に常駐していて、それぞれの handler が click 時にこの module の
// `closeHeaderMenu` を呼んでオーバーレイを閉じる。
//
// 公開 API:
//   initHeaderMenu()  ... 初期配線 (起動時 1 回)
//   closeHeaderMenu() ... 他 module (reset / clearAll 等) から閉じたい時用
// ============================

function getOverlay() {
  return document.getElementById("headerMenuOverlay");
}

export function closeHeaderMenu() {
  const overlay = getOverlay();
  if (overlay) overlay.classList.remove("active");
}

export function openHeaderMenu() {
  const overlay = getOverlay();
  if (overlay) overlay.classList.add("active");
}

export function initHeaderMenu() {
  const btn = document.getElementById("headerMenuBtn");
  const overlay = getOverlay();
  if (btn) {
    btn.addEventListener("click", () => {
      if (overlay?.classList.contains("active")) closeHeaderMenu();
      else openHeaderMenu();
    });
  }
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeHeaderMenu();
    });
  }

  // 設定ボタン (v7.6+ でハンバーガー内に移動) の閉じる配線は main.js 側で
  // navToSettings と組み合わせて行う。ここは menu の開閉のみが責務。
}
