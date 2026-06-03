"use strict";

import { appState, settings, selectedNo, markUpdated, scheduleSave } from "../store.js";
import { renderFormatStrip, renderExpandedFormats } from "../features/formats.js";
import { refreshFormatGroupToggle } from "../features/format-groups.js";
import { STATUS } from "../constants.js";
import { buildTabPayload } from "../payload.js";
import { utf8ByteLength } from "../payload.js";
import { qrcodegen } from "../libs/qrcodegen.js";
import { makePatientTagPicker, getPatientTags, setPatientTags, getStatusOptions } from "../features/tags.js";
import { makeRoomInput, formatPatientLabel } from "../features/room.js";
import { isPatientTransferred } from "../features/move-patient.js";
import { t } from "../i18n.js";
import { scanQR, isScannerSupported } from "../features/qr-scan.js";
import { buildTimestampHeader } from "../features/qr-protocol.js";
import { createEditToggle } from "../features/edit-toggle.js";
import { statusClass } from "./home.js";

let qrVisible = false;
let nameToggle = null; // createEditToggle で初期化

// 詳細画面・ホーム編集モード共通のステータス巡回。
//   - タップ: 白→黄→緑→灰→白 を巡回 (青はサイクル外、青のタップは白に戻る)
//   - 長押し: 白 → 青 / それ以外 → 白
// 青は「新着 (取込で追加された患者) / 注意」を任意で示すスロット。
export const STATUS_CYCLE = [STATUS.NONE, STATUS.YELLOW, STATUS.GREEN, STATUS.GRAY];

export function nextStatusInCycle(current) {
  const idx = STATUS_CYCLE.indexOf(current);
  // 青などサイクル外から短タップで戻ると idx=-1 → 0 (= NONE) になる
  return STATUS_CYCLE[(idx + 1 + STATUS_CYCLE.length) % STATUS_CYCLE.length] || STATUS.YELLOW;
}

export function statusOnLongPress(current) {
  // 白からの長押しのみ青へ。青を含むそれ以外は全て白へ強制リセット。
  return current === STATUS.NONE ? STATUS.BLUE : STATUS.NONE;
}

// ステータス選択ポップアップ (患者画面・ホーム編集モード共用)。色＋形マークの
// 大きいボックスを横1行で出す。単一選択なので「選んだら閉じる」(close-on-select)。
//   patientIdx: 0-based。onChange(newStatus): 選択後の view 再描画 (caller 責務)。
export function openStatusPicker(patientIdx, onChange) {
  const p = appState.patients[patientIdx];
  const overlay = document.getElementById("statusPickerOverlay");
  const list = document.getElementById("statusPickerList");
  if (!p || !overlay || !list) return;
  list.textContent = "";
  // 色名テキスト/タイトルは出さず色＋形マークのみ。ラベルは aria-label で SR 対応。
  for (const opt of getStatusOptions()) {
    const box = document.createElement("button");
    box.type = "button";
    box.className = "statusPickerBox" + (p.status === opt.status ? " selected" : "");
    const fg = opt.color === "#ffffff" ? "#111827" : "#fff";
    box.style.cssText = `background:${opt.color};border:2px solid ${opt.borderColor};color:${fg};`;
    box.textContent = opt.mark; // 無印(白)は空
    box.title = opt.label;
    box.setAttribute("aria-label", opt.label);
    box.addEventListener("click", () => {
      p.status = opt.status;
      markUpdated(patientIdx + 1);
      scheduleSave();
      overlay.classList.remove("active");
      if (onChange) onChange(opt.status);
    });
    list.appendChild(box);
  }
  overlay.classList.add("active");
}

// シンプルな「タップ vs 長押し」判定。長押し閾値 600ms。
export function bindTapOrLongPress(el, onTap, onLongPress, longMs = 600) {
  let timer = null;
  let longFired = false;
  let started = false;

  const start = () => {
    started = true;
    longFired = false;
    timer = setTimeout(() => {
      longFired = true;
      onLongPress();
    }, longMs);
  };
  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    started = false;
  };
  const finish = () => {
    if (!started) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (!longFired) onTap();
    started = false;
  };

  el.addEventListener("pointerdown", (e) => { e.preventDefault(); start(); });
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
// Status buttons
// ============================

// ステータススウォッチ (色+記号) を現在ステータスに合わせて更新する。
// v8.7+: ステータス表示は名前ボタンから専用スウォッチボタンへ移動。名前ボタンは
// 編集トリガーになり、色は持たない (中立)。外部呼び出し互換のため同名で残置。
export function setSelectedStatusButtons(status) {
  const sw = document.getElementById("detailStatusBtn");
  if (!sw) return;
  const opt = getStatusOptions().find(o => o.status === status) || getStatusOptions()[0];
  const fg = opt.color === "#ffffff" ? "#111827" : "#fff";
  sw.style.background = opt.color;
  sw.style.border = `2px solid ${opt.borderColor}`;
  sw.style.color = fg;
  sw.textContent = opt.mark; // 白(none)も記号(−)を持つ
}

// ============================
// renderDetail
// ============================

export function renderDetail(syncDetailMemoDisplay) {
  qrVisible = false;
  const p = appState.patients[selectedNo - 1];
  const detailTitle = document.getElementById("detailTitle");
  const sText = document.getElementById("sText");
  const aText = document.getElementById("aText");
  const pText = document.getElementById("pText");
  const detailSharedText = document.getElementById("detailSharedText");
  const oFreeText = document.getElementById("oFreeText");

  // 名前ボタン（表示モード）の中身とステータス色
  const nameBtn = document.getElementById("detailNameBtn");
  if (nameBtn) {
    nameBtn.textContent = formatPatientLabel(p, String(selectedNo));
  }
  // 編集モード用の name input は隠れた状態で値だけ保持
  if (detailTitle) {
    detailTitle.value = String(p?.name ?? "");
    detailTitle.readOnly = false;
  }
  if (syncDetailMemoDisplay) syncDetailMemoDisplay();
  setSelectedStatusButtons(p.status);

  // 患者切替時は常に表示モードに戻す
  setDetailEditing(false);

  const detailRoomSlot = document.getElementById("detailRoomSlot");
  if (detailRoomSlot) {
    detailRoomSlot.textContent = "";
    const roomInp = makeRoomInput(p);
    roomInp.classList.add("detailRoomInput");
    detailRoomSlot.appendChild(roomInp);
  }

  const detailDoctorSlot = document.getElementById("detailDoctorSlot");
  if (detailDoctorSlot) {
    detailDoctorSlot.textContent = "";
    const picker = makePatientTagPicker(selectedNo - 1, () => renderInlineTags());
    detailDoctorSlot.appendChild(picker);
  }

  renderInlineTags();
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
  const detailTitle = document.getElementById("detailTitle");
  const detailMemoText = document.getElementById("detailMemoText");
  const sText = document.getElementById("sText");
  const aText = document.getElementById("aText");
  const pText = document.getElementById("pText");
  const detailSharedText = document.getElementById("detailSharedText");
  const oFreeText = document.getElementById("oFreeText");

  if (detailTitle) {
    detailTitle.addEventListener("input", () => {
      const p = appState.patients[selectedNo - 1];
      if (!p) return;
      const next = detailTitle.value;
      if (p.name !== next) {
        p.name = next;
      }
      markUpdated(selectedNo);
      scheduleSave();
      if (renderHomeFn) renderHomeFn();
    });
  }

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

// 患者ヘッダーのインラインタグを描画する。
// - 表示順は設定タグ配列の順
// - 長押しでそのタグを患者から外す（共通ヘルパ bindTapOrLongPress を流用）
// - はみ出し分は CSS の overflow-x: auto で横スクロール表示
function renderInlineTags() {
  const host = document.getElementById("detailInlineTags");
  if (!host) return;
  host.textContent = "";
  const p = appState.patients[selectedNo - 1];
  if (!p) return;
  const settingsOrder = settings.tags || [];
  const tagSet = new Set(getPatientTags(selectedNo - 1));
  const ordered = settingsOrder.filter(t => tagSet.has(t));

  for (const tagName of ordered) {
    const chip = document.createElement("span");
    chip.className = "inlineTagChip";
    chip.textContent = tagName;
    chip.title = t("tag.detail.removeHint", { name: tagName });
    bindTapOrLongPress(
      chip,
      () => { /* タップ単独は何もしない（誤タップ保護） */ },
      () => {
        const cur = getPatientTags(selectedNo - 1).filter(t => t !== tagName);
        setPatientTags(selectedNo - 1, cur);
        renderInlineTags();
      }
    );
    host.appendChild(chip);
  }
}

// 詳細画面の表示モード ↔ 編集モード切替。共通 createEditToggle を使う。
// 表示モード: 名前ボタン（ステータス色つき）。タップでサイクル / 長押しで白。
// 編集モード: 部屋・名前・タグの入力欄。外側クリックや別ビューで自動 exit。
function applyEditingDom(editing) {
  const display = document.getElementById("detailNameBtn");
  const editRow = document.getElementById("detailEditRow");
  if (display) display.style.display = editing ? "none" : "";
  if (editRow) editRow.style.display = editing ? "flex" : "none";
}

function setDetailEditing(on) {
  if (!nameToggle) return;
  if (on) nameToggle.enter();
  else nameToggle.exit();
}

export function initStatusButtons(renderHomeFn) {
  const nameBtn = document.getElementById("detailNameBtn");
  const statusBtn = document.getElementById("detailStatusBtn");
  const container = document.querySelector("#detailView .detailTop");

  // ステータススウォッチ: タップでステータス選択ポップアップ (旧: 鉛筆の位置)
  if (statusBtn) {
    statusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (nameToggle?.isEditing()) return;
      openStatusPicker(selectedNo - 1, (s) => {
        setSelectedStatusButtons(s);
        if (renderHomeFn) renderHomeFn();
        renderQrIfNeeded();
      });
    });
  }

  // 患者名タップで編集モードへ (旧: 鉛筆。名前=テキストなのでタップで編集が自然)
  nameToggle = createEditToggle({
    triggerBtn: nameBtn,
    container,
    onEnter: () => {
      applyEditingDom(true);
      const titleInput = document.getElementById("detailTitle");
      if (titleInput) { titleInput.focus(); titleInput.select(); }
    },
    onExit: () => {
      applyEditingDom(false);
      // 名前ボタンの表示を最新化
      const p = appState.patients[selectedNo - 1];
      const display = document.getElementById("detailNameBtn");
      if (display && p) display.textContent = formatPatientLabel(p, String(selectedNo));
    },
  });
}
