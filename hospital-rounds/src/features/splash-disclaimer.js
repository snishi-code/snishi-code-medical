"use strict";

// 月 1 回程度の頻度で「これは個人メモであり正式な医療記録ではない」旨を
// ユーザに思い出させるスプラッシュ。
//
// 動作:
//   - localStorage に最終表示日時を記録 (ms)
//   - PERIOD_MS (30 日) 以上経過していたら overlay を表示
//   - 「確認しました」ボタンで閉じる + 最終表示日時を更新
//
// 呼び出し規約:
//   main.js から home 描画後 / applyI18n() 後に await で 1 回呼ぶ。
//   表示しない場合は即座に resolve する no-op。

import { t } from "../i18n.js";

const LAST_SHOWN_KEY = "hospital_rounds_disclaimer_last_shown_ms";
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function shouldShow() {
  if (typeof localStorage === "undefined") return false;
  const raw = localStorage.getItem(LAST_SHOWN_KEY);
  if (!raw) return true;
  const last = parseInt(raw, 10);
  if (!Number.isFinite(last)) return true;
  return (Date.now() - last) >= PERIOD_MS;
}

export function markDisclaimerShown() {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(LAST_SHOWN_KEY, String(Date.now())); } catch (_) { /* ignore */ }
}
const markShown = markDisclaimerShown;

export async function maybeShowDisclaimer() {
  if (!shouldShow()) return;
  const overlay = document.getElementById("disclaimerOverlay");
  const closeBtn = document.getElementById("disclaimerCloseBtn");
  const titleEl = document.getElementById("disclaimerTitle");
  const bodyEl = document.getElementById("disclaimerBody");
  if (!overlay || !closeBtn) {
    markShown();
    return;
  }
  if (titleEl) titleEl.textContent = t("disclaimer.title");
  if (bodyEl) bodyEl.textContent = t("disclaimer.body");
  closeBtn.textContent = t("disclaimer.ack");

  await new Promise((resolve) => {
    const onClose = () => {
      closeBtn.removeEventListener("click", onClose);
      overlay.classList.remove("active");
      markShown();
      resolve();
    };
    closeBtn.addEventListener("click", onClose);
    overlay.classList.add("active");
  });
}
