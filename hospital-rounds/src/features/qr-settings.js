"use strict";

import { settings, setSettings, saveSettings } from "../store.js";
import { createQrFlow } from "./qr-flow.js";
import { formatToWire, formatFromWire } from "./qr-protocol.js";
import { t } from "../i18n.js";

// ============================
// 設定 QR
//
// wire format の詳細は qr-protocol.js の Wire Format Authority コメントを参照。
// ここでは設定エンベロープ部分を組み立てる。
//
// 形式 (v4):
//   {
//     "v": 4,
//     "td": ["内科","外科"],          // tag dictionary
//     "f":  [<formatToWire>, ...],    // formats
//     "ct": {memo:false,s:true,...}   // clearTargets
//   }
//
// v7.7+ で tge / tgs / tga (タグ・カテゴリ機能) は撤去された。WIRE_V は 4 のまま
// 維持し、旧バージョンが生成した tge/tgs/tga フィールドは無視する (forward
// compat: 受信側で必要なフィールドだけ拾う)。
//
// 端末固有値 (deviceId 等) は wire に載せない。
// ============================

const WIRE_V = 4;

function encodePayload() {
  const tagDict = (Array.isArray(settings.tags) ? settings.tags : []).slice();

  const out = { v: WIRE_V };
  if (tagDict.length) out.td = tagDict;
  if (Array.isArray(settings.formats) && settings.formats.length) {
    out.f = settings.formats.map(f => formatToWire(f, tagDict));
  }
  if (settings.clearTargets && typeof settings.clearTargets === "object") {
    out.ct = settings.clearTargets;
  }
  return JSON.stringify(out);
}

function decodePayload(payload) {
  const obj = JSON.parse(String(payload || ""));
  if (!obj || typeof obj !== "object") throw new Error(t("qrSettings.invalid"));
  if (obj.v !== WIRE_V) throw new Error(t("qrSettings.versionMismatch", { a: obj.v, b: WIRE_V }));

  const tagDict = Array.isArray(obj.td) ? obj.td.filter(s => typeof s === "string") : [];
  const out = {};
  if (tagDict.length) out.tags = tagDict.slice();
  if (Array.isArray(obj.f)) out.formats = obj.f.map(w => formatFromWire(w, tagDict));
  if (obj.ct && typeof obj.ct === "object") {
    out.clearTargets = {};
    for (const [k, v] of Object.entries(obj.ct)) {
      if (typeof v === "boolean") out.clearTargets[k] = v;
    }
  }
  // v7.6 以前の tge / tgs / tga は無視する (タグ・カテゴリ機能撤去のため)
  return out;
}

let onAppliedHandler = null;
export function setOnSettingsApplied(fn) { onAppliedHandler = fn; }

const APPLIED_FIELDS = ["formats", "clearTargets", "tags"];

function applySettings(safe, ctrl) {
  if (!safe) {
    alert(t("qrSettings.parse.failed"));
    return;
  }
  const summary = [];
  if (Array.isArray(safe.tags)) summary.push(t("qrSettings.summary.tags", { n: safe.tags.length }));
  if (Array.isArray(safe.formats)) summary.push(t("qrSettings.summary.formats", { n: safe.formats.length }));
  if (safe.clearTargets) summary.push(t("qrSettings.summary.clearTargets"));
  const summaryText = summary.length ? `（${summary.join(", ")}）` : "";

  const ok = confirm(t("qrSettings.import.confirm", { summary: summaryText }));
  if (!ok) return;

  const next = { ...settings };
  for (const k of APPLIED_FIELDS) {
    if (safe[k] !== undefined) next[k] = safe[k];
  }
  setSettings(next);
  saveSettings();
  ctrl.close();
  if (onAppliedHandler) onAppliedHandler();
  alert(t("qrSettings.imported.alert"));
}

const flow = createQrFlow({
  kind: "ST",
  kindLabel: t("qr.kind.settings"),
  emptyMessage: t("qr.empty.noSettings"),
  ids: {
    wrapId: "settingsQrWrap",
    canvasId: "settingsQrCanvas",
    pageMetaId: "settingsQrPageMeta",
    prevBtnId: "settingsQrPrevBtn",
    nextBtnId: "settingsQrNextBtn",
    showBtnId: "settingsShowQrBtn",
    scanBtnId: "settingsQrScanBtn",
  },
  encodePayload,
  decodePayload,
  onApply: applySettings,
  shouldEncrypt: () => !!settings.qrEncryption?.ST,
});

export const initSettingsQr = () => flow.init();
export const isSettingsQrActive = () => flow.isActive();
export const refreshSettingsQrIfActive = () => flow.refresh();
