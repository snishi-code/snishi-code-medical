"use strict";

import { settings } from "../store.js";
import { createQrFlow } from "./qr-flow.js";
import { encodePatientList, decodePatientList, patientMatchesSharedFilter } from "./qr-patient-list.js";
import { t } from "../i18n.js";

// ============================
// メモQR / 共有QR (MM/SH)
//
// プロトコルとフローは共通 (qr-flow / qr-patient-list)。MM/SH 固有なのは:
//   - 送信: 対象患者は共有タグフィルタを適用、content がある患者だけを載せる
//   - 受信: **常に受信メモ欄に整形して dump するだけ** (v8.x で統一)。
//     患者欄への自動マッチング反映・上書きはしない。受け手は必要な箇所を
//     自分でコピーする。挙動が一定で説明しやすく、上書き事故も起きない。
// ============================

function formatEntry(e) {
  const resolveTag = (idx) => settings.tags?.[idx - 1] || `#${idx}`;
  const tagsText = e.tagIdxs.length ? ` [${e.tagIdxs.map(resolveTag).join(", ")}]` : "";
  const header = `【${e.name || "?"} (${e.room || "?"})】${tagsText}`;
  return `${header}\n${e.content}`;
}

function dumpToPasteCard(cardId, areaId, text) {
  const pasteCard = document.getElementById(cardId);
  const area = document.getElementById(areaId);
  if (pasteCard) pasteCard.classList.add("active");
  if (!area) return;
  const cur = area.value || "";
  const sep = cur && !cur.endsWith("\n") ? "\n" : "";
  area.value = cur + sep + text;
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeApplyEntries({ pasteCardId, pasteAreaId }) {
  return function applyEntries(decoded, ctrl) {
    const { patients: entries } = decoded;
    if (entries.length === 0) {
      alert(t("qr.import.empty.shared"));
      return;
    }
    // 常に受信メモ欄へ整形して追加するだけ (マッチング・上書きはしない)
    const pretty = entries.map(formatEntry).join("\n\n");
    dumpToPasteCard(pasteCardId, pasteAreaId, pretty);
    ctrl.close();
  };
}

// ============================
// Instances
// ============================

const sharedFlow = createQrFlow({
  kind: "SH",
  kindLabel: t("qr.kind.shared"),
  emptyMessage: t("qr.empty.noTargets"),
  ids: {
    wrapId: "sharedQrWrap",
    canvasId: "sharedQrCanvas",
    pageMetaId: "sharedQrPageMeta",
    prevBtnId: "sharedQrPrevBtn",
    nextBtnId: "sharedQrNextBtn",
    showBtnId: "sharedShowQrBtn",
    scanBtnId: "sharedQrScanBtn",
  },
  encodePayload: () => encodePatientList({
    fieldName: "shared",
    includeEmpty: false,
    matchesFilter: patientMatchesSharedFilter,
    kind: "SH",
  }),
  decodePayload: (payload) => decodePatientList(payload),
  onApply: makeApplyEntries({ pasteCardId: "sharedPasteCard", pasteAreaId: "sharedPasteArea" }),
  shouldEncrypt: () => !!settings.qrEncryption?.SH,
});

const memoFlow = createQrFlow({
  kind: "MM",
  kindLabel: t("qr.kind.memo"),
  emptyMessage: t("qr.empty.noTargets"),
  ids: {
    wrapId: "memoQrWrap",
    canvasId: "memoQrCanvas",
    pageMetaId: "memoQrPageMeta",
    prevBtnId: "memoQrPrevBtn",
    nextBtnId: "memoQrNextBtn",
    showBtnId: "memoShowQrBtn",
    scanBtnId: "memoQrScanBtn",
  },
  encodePayload: () => encodePatientList({
    fieldName: "memo",
    kind: "MM",
    includeEmpty: false,
    matchesFilter: patientMatchesSharedFilter,
  }),
  decodePayload: (payload) => decodePatientList(payload),
  onApply: makeApplyEntries({ pasteCardId: "memoPasteCard", pasteAreaId: "memoPasteArea" }),
  shouldEncrypt: () => !!settings.qrEncryption?.MM,
});

export const initSharedQr = () => sharedFlow.init();
export const isSharedQrActive = () => sharedFlow.isActive();
export const refreshSharedQrIfActive = () => sharedFlow.refresh();

export const initMemoQr = () => memoFlow.init();
export const isMemoQrActive = () => memoFlow.isActive();
export const refreshMemoQrIfActive = () => memoFlow.refresh();
