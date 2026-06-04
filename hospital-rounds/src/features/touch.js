"use strict";

// 「タップ vs 長押し」判定の共通ヘルパ。
//
// home / detail / memo / shared の患者ボタンが共通で使う。以前は detail.js が定義し
// home.js から import していたため detail.js ↔ home.js の循環 import になっていた
// (statusClass は逆向き)。ロジックは UI 非依存なのでここへ切り出して循環を断つ。
//
// スクロールを潰さないため pointerdown では preventDefault しない (要素を覆う患者ボタン
// 上で指を置いても縦スクロールが始まるよう、CSS 側で touch-action: pan-y を併用する)。
// 開始座標から MOVE_CANCEL px 以上動いたら「スクロール意図」とみなし、長押しもタップも
// 発火させずに native scroll へ譲る。
const MOVE_CANCEL = 10;

export function bindTapOrLongPress(el, onTap, onLongPress, longMs = 600) {
  let timer = null;
  let longFired = false;
  let started = false;
  let startX = 0;
  let startY = 0;

  const start = (e) => {
    started = true;
    longFired = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      longFired = true;
      onLongPress();
    }, longMs);
  };
  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    started = false;
  };
  const move = (e) => {
    if (!started) return;
    if (Math.abs(e.clientX - startX) > MOVE_CANCEL ||
        Math.abs(e.clientY - startY) > MOVE_CANCEL) {
      // 指が動いた = スクロール。長押しタイマーを止めタップも抑止する。
      cancel();
    }
  };
  const finish = () => {
    if (!started) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (!longFired) onTap();
    started = false;
  };

  el.addEventListener("pointerdown", start);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("pointercancel", cancel);
}
