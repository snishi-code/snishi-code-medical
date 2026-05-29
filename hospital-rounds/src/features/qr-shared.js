"use strict";

import { appState, settings } from "../store.js";
import { finishDataChange } from "./drag.js";
import { createQrFlow } from "./qr-flow.js";
import { encodePatientList, decodePatientList, patientMatchesSharedFilter } from "./qr-patient-list.js";
import { t } from "../i18n.js";

// ============================
// メモQR / 共有QR (MM/SH)
//
// プロトコルとフローは共通 (qr-flow / qr-patient-list)。MM/SH 固有なのは:
//   - 対象患者は共有タグフィルタを適用、content がある患者だけを載せる
//   - 受信時の挙動分岐:
//     * 対象フィールド (memo/shared) が全患者で空 → マッチング反映モード
//       name+room+tags 一致で content を書き込み
//     * そうでない → pretty-print して受信メモ欄に dump（既存動線）
//   - 未マッチ/重複は受信メモ欄に残して可視化
// ============================

function arraysEqualAsSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

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

function makeApplyEntries({ fieldName, pasteCardId, pasteAreaId }) {
  return function applyEntries(decoded, ctrl) {
    const { tagNames: senderTagNames, patients: entries } = decoded;
    if (entries.length === 0) {
      alert(t("qr.import.empty.shared"));
      return;
    }
    const resolveSenderTag = (idx) => senderTagNames[idx - 1] || null;
    const isTargetEmptyForAll = appState.patients.every(p => !String(p?.[fieldName] || "").trim());

    if (isTargetEmptyForAll) {
      // マッチング反映モード
      let applied = 0;
      const noMatch = [];
      const multi = [];
      for (const e of entries) {
        const senderTagsResolved = e.tagIdxs.map(resolveSenderTag).filter(Boolean);
        const candidates = [];
        for (const p of appState.patients) {
          const pName = String(p?.name || "").trim();
          const pRoom = String(p?.room || "").trim();
          if (pName !== e.name || pRoom !== e.room) continue;
          if (!arraysEqualAsSet(p?.tags || [], senderTagsResolved)) continue;
          candidates.push(p);
        }
        if (candidates.length === 1) {
          candidates[0][fieldName] = e.content;
          applied++;
        } else if (candidates.length === 0) {
          noMatch.push(e);
        } else {
          multi.push(e);
        }
      }
      finishDataChange();
      ctrl.close();
      const msgs = [t("shared.qrImport.applied.count", { n: applied })];
      if (noMatch.length) msgs.push(t("shared.qrImport.noMatch", { n: noMatch.length }));
      if (multi.length) msgs.push(t("shared.qrImport.multiMatch", { n: multi.length }));
      if (noMatch.length || multi.length) {
        const leftover = [...noMatch, ...multi].map(formatEntry).join("\n\n");
        dumpToPasteCard(pasteCardId, pasteAreaId, t("shared.qrImport.leftoverHeader") + "\n" + leftover);
      }
      alert(msgs.join("\n"));
    } else {
      // dump モード: pretty-print して受信メモ欄に追加
      const pretty = entries.map(formatEntry).join("\n\n");
      dumpToPasteCard(pasteCardId, pasteAreaId, pretty);
      ctrl.close();
    }
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
  onApply: makeApplyEntries({ fieldName: "shared", pasteCardId: "sharedPasteCard", pasteAreaId: "sharedPasteArea" }),
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
  onApply: makeApplyEntries({ fieldName: "memo", pasteCardId: "memoPasteCard", pasteAreaId: "memoPasteArea" }),
  shouldEncrypt: () => !!settings.qrEncryption?.MM,
});

export const initSharedQr = () => sharedFlow.init();
export const isSharedQrActive = () => sharedFlow.isActive();
export const refreshSharedQrIfActive = () => sharedFlow.refresh();

export const initMemoQr = () => memoFlow.init();
export const isMemoQrActive = () => memoFlow.isActive();
export const refreshMemoQrIfActive = () => memoFlow.refresh();
