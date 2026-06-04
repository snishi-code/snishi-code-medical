"use strict";

import { appState, settings, selectedNo, markUpdated, scheduleSave } from "../store.js";
import { renderFormatStrip, renderExpandedFormats } from "../features/formats.js";
import { refreshFormatGroupToggle } from "../features/format-groups.js";
import { STATUS } from "../constants.js";
import { buildTabPayload } from "../payload.js";
import { utf8ByteLength } from "../payload.js";
import { qrcodegen } from "../libs/qrcodegen.js";
import { getPatientTags, getStatusMark } from "../features/tags.js";
import { formatPatientLabel } from "../features/room.js";
import { isPatientTransferred } from "../features/move-patient.js";
import { t } from "../i18n.js";
import { scanQR, isScannerSupported } from "../features/qr-scan.js";
import { buildTimestampHeader } from "../features/qr-protocol.js";
import { openPatientSheet } from "../features/patient-sheet.js";
import { statusClass } from "./home.js";

let qrVisible = false;

// シンプルな「タップ vs 長押し」判定。長押し閾値 600ms。
// スクロールを潰さないため pointerdown では preventDefault しない (要素を覆う
// 患者ボタン上で指を置いても縦スクロールが始まるよう、CSS 側で touch-action:
// pan-y を併用する)。開始座標から MOVE_CANCEL px 以上動いたら「スクロール意図」
// とみなし、長押しもタップも発火させずに native scroll へ譲る。
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

// ============================
// QR generation helpers
// ============================

// 患者画面 QR (平文 SOAP) のページ上限。qr-protocol.js の MAX_BYTES と整合。
const MAX_BYTES_PER_QR = 750;

// 患者画面 QR は EMR に接続された QR スキャナで「そのまま打鍵」される用途
// なので、各ページの内容は SOAP テキストそのままにする。多ページ時のページ
// 番号は QR カード UI 側 (qrPageMeta) に出すだけで、ペイロードには埋め込まない。
function splitTextToFitQr(raw, ecl) {
  const s = String(raw ?? "");
  if (utf8ByteLength(s) <= MAX_BYTES_PER_QR) {
    try {
      qrcodegen.QrCode.encodeText(s, ecl);
      return [s];
    } catch (_) { }
  }

  const cps = Array.from(s);
  const pages = [];
  let pos = 0;
  while (pos < cps.length) {
    let hi = cps.length;
    let lo = pos + 1;
    let best = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const chunk = cps.slice(pos, mid).join("");
      if (utf8ByteLength(chunk) > MAX_BYTES_PER_QR) { hi = mid - 1; continue; }
      try {
        qrcodegen.QrCode.encodeText(chunk, ecl);
        best = mid;
        lo = mid + 1;
      } catch (_e) {
        hi = mid - 1;
      }
    }
    if (best <= pos) throw new Error(t("detail.qr.tooLong"));
    pages.push(cps.slice(pos, best).join(""));
    pos = best;
  }
  return pages;
}

function drawQrToCanvas(qr, canvas) {
  const ctx = canvas.getContext("2d");
  const border = 4;
  const modules = qr.size + border * 2;
  const parentW = (canvas.parentElement && canvas.parentElement.clientWidth) ? canvas.parentElement.clientWidth : 800;
  const cssW = Math.max(240, Math.min(parentW, 980));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const scale = Math.max(2, Math.floor((cssW * dpr) / modules));
  const sizePx = modules * scale;
  canvas.width = sizePx;
  canvas.height = sizePx;
  canvas.style.width = "100%";
  canvas.style.height = "auto";
  canvas.style.maxWidth = cssW + "px";
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sizePx, sizePx);
  ctx.fillStyle = "#000000";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
  }
}

let qrPages = [];
let qrPageIndex = 0;

function showQrError(msg) {
  const qrError = document.getElementById("qrError");
  const qrCanvas = document.getElementById("qrCanvas");
  if (qrError) { qrError.style.display = "block"; qrError.textContent = String(msg); }
  if (qrCanvas) {
    const ctx = qrCanvas.getContext("2d");
    qrCanvas.width = 860;
    qrCanvas.height = 220;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, qrCanvas.width, qrCanvas.height);
    ctx.fillStyle = "#111827";
    ctx.font = "16px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(t("detail.qr.renderFailed"), 16, 40);
  }
}

function clearQrError() {
  const qrError = document.getElementById("qrError");
  if (qrError) { qrError.style.display = "none"; qrError.textContent = ""; }
}

// 患者ヘッダ直下に「他ワークスペースへ移動済」の控えめなバナーを出す。
// 元 ws の患者として履歴として残った状態 (転棟マーカー) のみ表示。
function renderTransferredBanner(p) {
  const host = document.getElementById("detailTransferredBannerHost");
  if (!host) return;
  host.textContent = "";
  if (!isPatientTransferred(p)) return;
  const banner = document.createElement("div");
  banner.className = "detailTransferredBanner";
  const d = new Date(p.transferredAt);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  banner.textContent = t("move.banner", { dest: p.transferredTo || "?", date: ymd });
  host.appendChild(banner);
}

function syncQrToggleButtons() {
  const b = document.getElementById("qrToggleBtn");
  if (!b) return;
  b.classList.toggle("editActive", qrVisible);
  b.setAttribute("aria-pressed", qrVisible ? "true" : "false");
}

export function renderQrIfNeeded() {
  const qrWrap = document.getElementById("qrWrap");
  if (!qrWrap) return;
  qrWrap.classList.toggle("active", qrVisible);
  syncQrToggleButtons();
  if (!qrVisible) return;

  const qrTextPreview = document.getElementById("qrTextPreview");
  const qrCanvas = document.getElementById("qrCanvas");
  if (qrTextPreview) qrTextPreview.textContent = buildTabPayload(selectedNo);
  clearQrError();

  try {
    const ecl = qrcodegen.QrCode.Ecc.LOW;
    qrPages = splitTextToFitQr(buildTabPayload(selectedNo), ecl);
    qrPageIndex = Math.min(qrPageIndex, Math.max(0, qrPages.length - 1));
    renderQrPage(ecl);
  } catch (e) {
    showQrError(e && e.message ? e.message : String(e));
  }
}

function renderQrPage(ecl) {
  const qrCanvas = document.getElementById("qrCanvas");
  const qrPageMeta = document.getElementById("qrPageMeta");
  const qrPrevBtn = document.getElementById("qrPrevBtn");
  const qrNextBtn = document.getElementById("qrNextBtn");

  const total = qrPages.length || 0;
  if (total <= 0) { if (qrPageMeta) qrPageMeta.textContent = ""; return; }
  const i = Math.max(0, Math.min(qrPageIndex, total - 1));
  qrPageIndex = i;
  const text = qrPages[i];

  if (qrPageMeta) qrPageMeta.textContent = `(${i + 1}/${total})`;
  if (qrPrevBtn) qrPrevBtn.disabled = i === 0;
  if (qrNextBtn) qrNextBtn.disabled = i === total - 1;

  if (qrCanvas) {
    const qr = qrcodegen.QrCode.encodeText(text, ecl);
    drawQrToCanvas(qr, qrCanvas);
  }
}

export function initQrNavButtons() {
  const qrPrevBtn = document.getElementById("qrPrevBtn");
  const qrNextBtn = document.getElementById("qrNextBtn");
  const ecl = qrcodegen.QrCode.Ecc.LOW;
  if (qrPrevBtn) qrPrevBtn.addEventListener("click", () => {
    if (qrPageIndex > 0) { qrPageIndex--; renderQrPage(ecl); }
  });
  if (qrNextBtn) qrNextBtn.addEventListener("click", () => {
    if (qrPageIndex < qrPages.length - 1) { qrPageIndex++; renderQrPage(ecl); }
  });
}

// ============================
// O-list editor row
// ============================

// ============================
// Patient meta button
// ============================

// 詳細ヘッダーの「患者メタボタン」を現在の患者で再描画する。1つのボタンに
//   ステータス色/形マーク + 部屋番号+氏名 + タグ概要
// をまとめて表示し、タップで患者シート (openPatientSheet) を開く。ホームの
// patientBtn と同じ色クラス・形マークを流用して見た目を統一する。
export function renderPatientMetaBtn() {
  const btn = document.getElementById("detailPatientMetaBtn");
  if (!btn) return;
  const p = appState.patients[selectedNo - 1];
  if (!p) return;
  btn.textContent = "";
  btn.className = "patientBtn detailPatientMetaBtn " + statusClass(p.status);

  // 形マーク (色だけに依存しない。白(none)はマーク無し)
  if (p.status && p.status !== STATUS.NONE) {
    const mark = document.createElement("span");
    mark.className = "patientBtnMark";
    mark.textContent = getStatusMark(p.status);
    mark.setAttribute("aria-hidden", "true");
    btn.appendChild(mark);
  }

  // 部屋番号 + 氏名
  const label = document.createElement("span");
  label.className = "detailMetaLabel";
  const labelText = formatPatientLabel(p, String(selectedNo));
  label.textContent = labelText;
  btn.appendChild(label);
  btn.setAttribute("aria-label", labelText);

  // タグ概要 (設定タグ順。患者が持つ分だけ。多数ははみ出し横スクロール)
  const tagSet = new Set(getPatientTags(selectedNo - 1));
  const ordered = (settings.tags || []).filter(tg => tagSet.has(tg));
  if (ordered.length) {
    const tags = document.createElement("span");
    tags.className = "detailMetaTags";
    for (const tg of ordered) {
      const chip = document.createElement("span");
      chip.className = "detailMetaTagChip";
      chip.textContent = tg;
      tags.appendChild(chip);
    }
    btn.appendChild(tags);
  }
}

// ============================
// renderDetail
// ============================

export function renderDetail(syncDetailMemoDisplay) {
  qrVisible = false;
  const p = appState.patients[selectedNo - 1];
  const sText = document.getElementById("sText");
  const aText = document.getElementById("aText");
  const pText = document.getElementById("pText");
  const detailSharedText = document.getElementById("detailSharedText");
  const oFreeText = document.getElementById("oFreeText");

  if (syncDetailMemoDisplay) syncDetailMemoDisplay();

  // 患者メタボタン (ステータス色/形 + 部屋+氏名 + タグ概要)
  renderPatientMetaBtn();
  renderTransferredBanner(p);
  refreshFormatGroupToggle();

  if (sText) sText.value = p.s;
  if (aText) aText.value = p.a.text;
  if (pText) pText.value = p.p.text;
  if (detailSharedText) detailSharedText.value = p.shared || "";
  if (oFreeText) oFreeText.value = String(p.oFree ?? "");

  // 各パネル: ヘッダーに ☰ ランチャー、本文上に実効グループの展開入力欄
  renderFormatStrip("S", document.getElementById("sFormatStrip"));
  renderFormatStrip("O", document.getElementById("oFormatStrip"));
  renderFormatStrip("A", document.getElementById("aFormatStrip"));
  renderFormatStrip("P", document.getElementById("pFormatStrip"));
  renderExpandedFormats("S", document.getElementById("sExpanded"));
  renderExpandedFormats("O", document.getElementById("oExpanded"));
  renderExpandedFormats("A", document.getElementById("aExpanded"));
  renderExpandedFormats("P", document.getElementById("pExpanded"));

  renderQrIfNeeded();
}

// ============================
// Detail event bindings
// ============================

export function initDetailEvents(renderHomeFn) {
  const detailMemoText = document.getElementById("detailMemoText");
  const sText = document.getElementById("sText");
  const aText = document.getElementById("aText");
  const pText = document.getElementById("pText");
  const detailSharedText = document.getElementById("detailSharedText");
  const oFreeText = document.getElementById("oFreeText");

  // 氏名編集は患者シート (openPatientSheet) に集約 (詳細ヘッダーから個別入力欄を撤去)。

  if (detailMemoText) {
    detailMemoText.addEventListener("input", () => {
      const p = appState.patients[selectedNo - 1];
      p.memo = String(detailMemoText.value ?? "");
      markUpdated(selectedNo);
      scheduleSave();
    });
  }

  if (sText) sText.addEventListener("input", () => {
    const p = appState.patients[selectedNo - 1];
    p.s = String(sText.value ?? "");
    markUpdated(selectedNo);
    scheduleSave();
    renderQrIfNeeded();
  });

  if (detailSharedText) {
    detailSharedText.addEventListener("input", () => {
      const p = appState.patients[selectedNo - 1];
      p.shared = String(detailSharedText.value ?? "");
      markUpdated(selectedNo);
      scheduleSave();
    });
  }

  if (aText) aText.addEventListener("input", () => {
    const p = appState.patients[selectedNo - 1];
    p.a.text = String(aText.value ?? "");
    markUpdated(selectedNo);
    scheduleSave();
    renderQrIfNeeded();
  });

  if (pText) pText.addEventListener("input", () => {
    const p = appState.patients[selectedNo - 1];
    p.p.text = String(pText.value ?? "");
    markUpdated(selectedNo);
    scheduleSave();
    renderQrIfNeeded();
  });

  if (oFreeText) oFreeText.addEventListener("input", () => {
    const p = appState.patients[selectedNo - 1];
    p.oFree = String(oFreeText.value ?? "");
    markUpdated(selectedNo);
    scheduleSave();
    renderQrIfNeeded();
  });

  const qrToggleBtn = document.getElementById("qrToggleBtn");
  if (qrToggleBtn) qrToggleBtn.addEventListener("click", () => {
    qrVisible = !qrVisible;
    renderQrIfNeeded();
  });

  // 受信側カメラボタン：QR カード内にあり、QR 表示中だけ見える。
  // 読み取り結果を現在の患者の受診メモへタイムスタンプ付きで追記する。
  const detailScanBtn = document.getElementById("detailScanBtn");
  if (detailScanBtn) {
    if (!isScannerSupported()) {
      detailScanBtn.disabled = true;
      detailScanBtn.title = t("qr.scanner.unsupported");
    }
    detailScanBtn.addEventListener("click", async () => {
      const text = await scanQR();
      if (text == null) return;
      const area = document.getElementById("detailMemoText");
      const p = appState.patients[selectedNo - 1];
      if (!area || !p) return;
      const cur = String(area.value || "");
      const sep = cur && !cur.endsWith("\n") ? "\n" : "";
      const next = cur + sep + buildTimestampHeader() + "\n" + text;
      area.value = next;
      p.memo = next;
      markUpdated(selectedNo);
      scheduleSave();
    });
  }
}

// 患者メタボタン → 患者シートを開く配線。シート内の編集 (ステータス/部屋/氏名/
// タグ) は onChange で「今見えている詳細」(メタボタン + QR) だけを再描画する。
//   関数名は main.js からの呼び出し互換のため initStatusButtons を踏襲。
//
// ホーム (renderHomeFn) はここでは描画しない。部屋番号を変えると doRenderHome →
// ensureRoomOrder が appState.patients を in-place ソートし、編集中の患者が別 index
// へ動く一方で detail の selectedNo は固定なので、メタボタンが「別患者」を指して
// しまう (患者取り違え) ためである。ホームは非表示なので即時更新は不要で、navToHome
// 時に正しい並びで再描画される (旧 detail も room 変更で home を再描画しなかった)。
export function initStatusButtons(_renderHomeFn) {
  const metaBtn = document.getElementById("detailPatientMetaBtn");
  if (!metaBtn) return;
  metaBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPatientSheet(selectedNo - 1, () => {
      renderPatientMetaBtn();
      renderQrIfNeeded();
    });
  });
}
