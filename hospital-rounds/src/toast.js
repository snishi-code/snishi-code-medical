"use strict";

// 控えめな一時通知 (トースト)。画面下中央に数秒だけ出て自動で消える。
// 「保存しました」などバックグラウンド処理の完了をユーザーに知らせる用途。
// 文言は呼び出し側で t() 済みのものを渡す (このモジュールは i18n を持たない)。

let _hideTimer = 0;

export function showToast(message, { ms = 2000, vibrate = true } = {}) {
  // DOM 不在環境 (単体テスト等) では何もしない。データ層 (store.js) からも
  // 保存失敗通知のために呼ばれるため、document 非依存で安全に no-op する。
  if (typeof document === "undefined" || !document.body) return;
  let el = document.getElementById("appToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "appToast";
    el.className = "appToast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = String(message || "");
  // reflow を挟んで transition を確実に効かせる
  void el.offsetWidth;
  el.classList.add("show");
  if (vibrate && typeof navigator !== "undefined" && navigator.vibrate) {
    try { navigator.vibrate(15); } catch (_) {}
  }
  clearTimeout(_hideTimer);
  _hideTimer = setTimeout(() => el.classList.remove("show"), ms);
}
