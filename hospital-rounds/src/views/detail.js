"use strict";

import { appState, settings, selectedNo, markUpdated, scheduleSave, isPatientEmpty } from "../store.js";
import { renderFormatStrip, renderExpandedFormats, appendTextToProblemFreeNote } from "../features/formats.js";
import { captureUndoPoint, refreshUndoButtons } from "../features/patient-undo.js";
import { STATUS } from "../constants.js";
import { buildTabPayload } from "../payload.js";
import { utf8ByteLength } from "../payload.js";
import { qrcodegen } from "../libs/qrcodegen.js";
import { getPatientTags, getStatusMark } from "../features/tags.js";
import { formatPatientLabel } from "../features/room.js";
import { isPatientTransferred, openMovePatientModal } from "../features/move-patient.js";
import {
  deletePatientToTrash, permanentlyDeletePatient, restoreDeletedPatientToWorkspace,
  isTrashActive,
} from "../features/patient-lifecycle.js";
import { t } from "../i18n.js";
import { scanQR, isScannerSupported } from "../features/qr-scan.js";
import { buildTimestampHeader } from "../features/qr-protocol.js";
import { openPatientSheet } from "../features/patient-sheet.js";
import { statusClass } from "../features/status-ui.js";
import { bindTapOrLongPress } from "../features/touch.js";
import { icon } from "../icons.js";

// statusClass (status-ui.js) / bindTapOrLongPress (touch.js) は共通ヘルパへ移設し、
// detail.js ↔ home.js の循環 import を解消した。

let qrVisible = false;

// ============================
// QR generation helpers
// ============================

// 患者画面 QR (平文 SOAP) のページ上限。qr-protocol.js の MAX_BYTES と整合。
const MAX_BYTES_PER_QR = 750;

// 患者画面 QR は、電子カルテ端末の標準カメラ (Windows 11 など) で読み取り、表示された
// 平文を電子カルテへ貼り付ける用途。各ページの内容は SOAP テキストそのまま (暗号化しない)。
// 多ページ時のページ番号は QR カード UI 側 (qrPageMeta) に出すだけで、ペイロードには
// 埋め込まない (貼り付けた本文にページ番号が混ざらないように)。
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
  // aria/title は「タップで編集できる」ことが伝わる文言にする (見た目の主役は名前/部屋)。
  btn.setAttribute("aria-label", t("patientSheet.editAria", { label: labelText }));
  btn.title = t("patientSheet.editTitle");

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

  // 末尾に控えめな編集アイコン (鉛筆)。これが「ここはタップで編集できる」可視ヒント。
  // 右端固定 (margin-left:auto)。名前/タグの優先順位は変えない (装飾扱い・aria-hidden)。
  const editIcon = document.createElement("span");
  editIcon.className = "detailMetaEditIcon";
  editIcon.innerHTML = icon("edit", 15);
  editIcon.setAttribute("aria-hidden", "true");
  btn.appendChild(editIcon);
}

// ============================
// Patient lifecycle actions (患者管理: 転棟 / 削除 / 復元 / 完全削除)
// ============================

// 削除/復元成功後に呼ぶナビゲーション (= ホームへ戻る) と再描画フック。main.js が配線。
let _lifecycleCb = {};
export function initLifecycleActions(cb) { _lifecycleCb = cb || {}; }

// 二重クリック防止 (即時 await 系: 削除/完全削除)。転棟/復元はモーダルを開くだけなので
// API 側 (_busy) とモーダルで多重実行を防ぐ。
let _lifecycleBusy = false;

function lifecycleBtn(label, cls, onClick, iconName) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lifecycleBtn " + cls;
  if (iconName) {
    const ic = document.createElement("span");
    ic.className = "lifecycleBtnIcon";
    ic.innerHTML = icon(iconName, 16);
    ic.setAttribute("aria-hidden", "true");
    b.appendChild(ic);
  }
  const sp = document.createElement("span");
  sp.textContent = label;
  b.appendChild(sp);
  b.addEventListener("click", onClick);
  return b;
}

function afterLifecycleDone() {
  if (_lifecycleCb.navigateHome) _lifecycleCb.navigateHome();
}

// 詳細画面下部の「患者管理」エリアを現在の文脈で描画する:
//   通常病棟・通常患者 : 転棟 / 削除 (Trash 退避)
//   通常病棟・(移) 患者: 完全削除 のみ (転棟は不可)
//   削除済み病棟        : 転棟して復元 / 完全削除 + 注意書き
export function renderLifecycleActions(p) {
  const host = document.getElementById("detailLifecycleActions");
  if (!host) return;
  host.textContent = "";
  if (!p) return;
  const idx = selectedNo - 1;
  const trash = isTrashActive();

  if (trash) {
    const note = document.createElement("div");
    note.className = "lifecycleNote";
    note.textContent = t("trash.detail.note");
    host.appendChild(note);
  }

  const title = document.createElement("div");
  title.className = "lifecycleTitle";
  title.textContent = t("patient.lifecycle.actions.title");
  host.appendChild(title);

  const row = document.createElement("div");
  row.className = "lifecycleBtnRow";

  // 削除/完全削除 (即時 await): confirm → API → 失敗は通知して中断 / 成功はホームへ。
  const runDelete = (confirmKey, apiFn) => async () => {
    if (_lifecycleBusy) return;
    if (!confirm(t(confirmKey))) return;
    _lifecycleBusy = true;
    for (const b of row.querySelectorAll("button")) b.disabled = true;
    try {
      const res = await apiFn(idx);
      if (!res || !res.ok) { alert(t("patient.delete.failed")); return; }
      afterLifecycleDone();
    } finally {
      _lifecycleBusy = false;
    }
  };

  if (trash) {
    row.appendChild(lifecycleBtn(t("patient.restore"), "lifecycleRestore", () => {
      // 復元先 (通常病棟) を選んで restore API を呼ぶ。movePatients は使わない。
      openMovePatientModal(idx, afterLifecycleDone, {
        mode: "restore",
        onPick: async (wsId, label) => {
          const res = await restoreDeletedPatientToWorkspace(idx, wsId, label);
          if (!res || !res.ok) alert(t("patient.restore.failed"));
        },
      });
    }));
    row.appendChild(lifecycleBtn(
      t("patient.delete.permanentBtn"), "lifecycleDelete",
      runDelete("patient.delete.permanent.confirm", permanentlyDeletePatient), "delete",
    ));
  } else if (isPatientTransferred(p)) {
    // (移) 患者の削除は Trash へ送らず完全削除
    row.appendChild(lifecycleBtn(
      t("patient.delete.permanentBtn"), "lifecycleDelete",
      runDelete("patient.delete.permanent.confirm", permanentlyDeletePatient), "delete",
    ));
  } else if (isPatientEmpty(p)) {
    // 空スロット (初期 50 患者など): 転棟は出さない (移す中身が無い)。削除は Trash
    // 退避でなく単純な空スロット除去 (30日保存しない。データ層でも空は permanent に回る)。
    row.appendChild(lifecycleBtn(
      t("patient.delete"), "lifecycleDelete",
      runDelete("patient.delete.emptySlot.confirm", permanentlyDeletePatient), "delete",
    ));
  } else {
    row.appendChild(lifecycleBtn(t("patient.move"), "lifecycleMove", () => {
      openMovePatientModal(idx, afterLifecycleDone);
    }));
    row.appendChild(lifecycleBtn(
      t("patient.delete"), "lifecycleDelete",
      runDelete("patient.delete.toTrash.confirm", deletePatientToTrash), "delete",
    ));
  }
  host.appendChild(row);
}

// ============================
// renderDetail
// ============================

export function renderDetail() {
  qrVisible = false;
  const p = appState.patients[selectedNo - 1];

  // 患者メタボタン (ステータス色/形 + 部屋+氏名 + タグ概要)
  renderPatientMetaBtn();
  renderTransferredBanner(p);
  renderLifecycleActions(p);
  // セット切替トグルはヘッダーから撤去 (患者シートへ移設)。代わりに戻す/進むボタンの
  // 活性状態を現在患者の履歴で更新する (Phase 6)。
  refreshUndoButtons();

  // Phase 7: 6パネル (problem/S/O/A/P/shared) すべてを同じ展開カード + 入力シート +
  // ランチャーで描画する。旧 memo/shared textarea・旧自由記述フィールドは撤去。
  // DOM id は panel の小文字 + "FormatStrip"/"Expanded" (例 S→sFormatStrip / problem→problemFormatStrip)。
  for (const panel of ["problem", "S", "O", "A", "P", "shared"]) {
    const base = panel.toLowerCase();
    renderFormatStrip(panel, document.getElementById(base + "FormatStrip"));
    renderExpandedFormats(panel, document.getElementById(base + "Expanded"));
  }

  renderQrIfNeeded();
}

// ============================
// Detail event bindings
// ============================

export function initDetailEvents(renderHomeFn) {
  // Phase 7: 氏名編集は患者シート (openPatientSheet)、臨床入力 (problem/S/O/A/P/shared) は
  // 全て展開カード + 大入力シート経由で formatValues へ。旧 memo/shared textarea は撤去。

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
      const p = appState.patients[selectedNo - 1];
      if (!p) return;
      // Phase 7: 受診メモ = problem パネルの自由記述 (末尾 text) 項目へタイムスタンプ付き追記。
      captureUndoPoint("format"); // 追記の直前に Undo 起点 (1 操作・format スコープ)
      const ok = appendTextToProblemFreeNote(p, buildTimestampHeader() + "\n" + text);
      if (!ok) return;
      markUpdated(selectedNo);
      scheduleSave();
      // problem パネルカードと QR を再描画 + Undo ボタン更新
      renderExpandedFormats("problem", document.getElementById("problemExpanded"));
      renderQrIfNeeded();
      refreshUndoButtons();
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
      // 氏名/部屋/ステータス編集で「空スロット↔実在患者」が変わると患者管理ボタンの
      // 出し分け (空=転棟なし) も変わるので、シート内編集のたびに再描画する。
      renderLifecycleActions(appState.patients[selectedNo - 1]);
      renderQrIfNeeded();
    });
  });
}
