"use strict";

// PHI が ブラウザの autofill DB 経由で別 origin に漏れるのを防ぐため、
// アプリ内の全 input / textarea に `autocomplete="off"` を強制する。
//
// Chrome 等は単一の `autocomplete="off"` を無視する場合があるため、念のため
// `autocomplete="off"` と `name=""` 化（既存の name は維持）の両方を効かせ、
// さらに 1Password 等のパスワードマネージャもスキップさせる `data-1p-ignore`
// `data-lpignore` を併用する。
//
// 静的 HTML 由来の要素は起動時に一括処理、JS で動的生成される要素は
// MutationObserver で随時処理する。`autocomplete` を明示している要素
// （例: `autocomplete="off"` を既に持つもの、将来「ON にしたい」と判断
// された要素）は尊重し、上書きしない。

function harden(el) {
  if (!el || el.nodeType !== 1) return;
  if (!el.hasAttribute("autocomplete")) {
    el.setAttribute("autocomplete", "off");
  }
  if (!el.hasAttribute("data-1p-ignore")) el.setAttribute("data-1p-ignore", "");
  if (!el.hasAttribute("data-lpignore")) el.setAttribute("data-lpignore", "true");
}

function hardenAllUnder(root) {
  if (!root) return;
  // root 自身も対象に
  if (root.matches?.("input, textarea")) harden(root);
  root.querySelectorAll?.("input, textarea").forEach(harden);
}

export function initNoAutofill() {
  // 1) 起動時の DOM 一括処理
  hardenAllUnder(document.body);

  // 2) 以降に追加される要素は MutationObserver で随時処理
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) hardenAllUnder(node);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
