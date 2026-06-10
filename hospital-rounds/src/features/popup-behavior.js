"use strict";

// ============================
// 中央ポップアップ挙動ルール (フォーカス・ポリシー)
//
// 方針 (依頼者と合意):
//   ポップアップを「開いただけ」では input / textarea へ focus しない。
//   ユーザーが入力欄 (またはそれを開く add/rename 等) を**明示タップした時だけ** focus する。
//   入力しない項目もあるのに先頭欄へ勝手にフォーカス → キーボードが飛び出す、を防ぐ。
//
// 各画面で `setTimeout(() => inp.focus())` を散らさず、popup open / 明示フォーカスは
// 必ずこの 2 関数を経由させる (= フォーカス可否の判断を 1 箇所に集約する)。
//   - openPopup(overlay, opts) ............. overlay を開く。既定は自動フォーカスしない。
//   - focusPopupInput(el, opts) ............ 明示アクション (add/rename/エラー復帰等) での
//                                            単一入力フォーカス。default で許可される唯一の経路。
//
// 例外 (= 開いた瞬間に focus したい単一入力系) は openPopup に { autoFocus:true } を渡すか、
// overlay に data-autofocus 属性を付ける。これにより「例外も中央ルール経由」を保つ。
// data-no-backdrop-close (背景タップで閉じない) とは別概念なので混同しないこと。
// ============================

// overlay 内 / el 自身 から「次フレームで」フォーカスする小ヘルパ。
// 描画直後 (DOM 反映前) の focus 取りこぼしを避けるため setTimeout(0) で当てる。
// el が見つからない / focus 不可なら静かに何もしない。
function deferFocus(el, select) {
  if (!el || typeof el.focus !== "function") return;
  setTimeout(() => {
    try {
      el.focus();
      if (select && typeof el.select === "function") el.select();
    } catch (_) { /* 失われた DOM 等は無視 */ }
  }, 0);
}

// overlay 内のフォーカス対象を解決する。明示指定 > [data-autofocus] > 最初の入力欄。
function resolveFocusTarget(overlay, target) {
  if (target instanceof Element) return target;
  if (typeof target === "string") return overlay ? overlay.querySelector(target) : null;
  if (!overlay) return null;
  return overlay.querySelector("[data-autofocus]") || overlay.querySelector("input, textarea, select");
}

// ポップアップ overlay を開く (.active を付ける)。
// 既定: 自動フォーカスしない。opts.autoFocus===true (または overlay[data-autofocus]) の
// 時だけ、opts.focusTarget (要素 / セレクタ / 省略時は overlay 内の最初の入力欄) へ focus する。
// opts.select=true で focus 後に全選択 (rename 等の上書き入力向け)。
export function openPopup(overlay, opts = {}) {
  if (!overlay) return;
  overlay.classList.add("active");
  const autoFocus = opts.autoFocus === true || overlay.hasAttribute("data-autofocus");
  if (!autoFocus) return; // 既定: 何もしない (= 開いただけでは focus しない)
  deferFocus(resolveFocusTarget(overlay, opts.focusTarget), opts.select === true);
}

// 明示アクション (「+ 追加」「リネーム」クリックで入力欄が現れた / 入力エラーで復帰させたい等)
// による単一入力フォーカス。ポップアップ open 時の自動フォーカスとは別カテゴリ
// (ユーザーが入力する意思を示したアクション直後なので focus してよい)。
// opts.select=true で全選択 (既存名を即上書きできる rename 向け)。
export function focusPopupInput(el, opts = {}) {
  deferFocus(el, opts.select === true);
}
