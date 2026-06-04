"use strict";

import {
  settings, setSettings, saveSettingsOrThrow,
  newFormatId, newGroupId, makeDefaultFormatGroups, ensureOneDefaultGroup,
} from "../store.js";
import { createQrFlow } from "./qr-flow.js";
import {
  formatToWire, formatFromWire,
  formatGroupToWire, formatGroupFromWire,
} from "./qr-protocol.js";
import { t } from "../i18n.js";

// ============================
// 設定 QR (ST) — 設定全体 (formats + formatGroups + clearTargets + tags)
//
// wire format の詳細は qr-protocol.js の Wire Format Authority コメントを参照。
// ここでは設定エンベロープ部分を組み立てる。
//
// 形式 (v5):
//   {
//     "v": 5,
//     "td": ["内科","外科"],          // tag dictionary
//     "f":  [<formatToWire>, ...],    // formats
//     "fg": [<formatGroupToWire>, ...] // フォーマットセット (f への 1-based index 参照)
//     "ct": {memo:false,s:true,...}   // clearTargets
//   }
//
// v4 (formatGroups なし) は引き続き受信できる。受信時は formats を新 ID 採番し、
// fg があれば新 ID に解決、無ければ makeDefaultFormatGroups で既定セットを再構築する。
//
// v7.7+ で tge / tgs / tga (タグ・カテゴリ機能) は撤去。旧 bundle のそれらは無視。
// 端末固有値 (deviceId 等) は wire に載せない。
// ============================

const WIRE_V = 5;

// settings (live state) → v5 payload 文字列。テスト容易化のため export。
export function encodeSettingsPayload() {
  const tagDict = (Array.isArray(settings.tags) ? settings.tags : []).slice();
  const formats = Array.isArray(settings.formats) ? settings.formats : [];
  const groups = Array.isArray(settings.formatGroups) ? settings.formatGroups : [];

  const out = { v: WIRE_V };
  // td は「設定全体のタグ辞書」。設定全体 QR なので空でも常に載せる
  // (= 受信側のタグを送信側に一致させる。0 個ならタグ消去も伝わる)。
  out.td = tagDict;
  if (formats.length) out.f = formats.map(f => formatToWire(f, tagDict));
  if (groups.length) {
    // format id → f 配列での 1-based index
    const idToIndex = (id) => {
      const i = formats.findIndex(f => f.id === id);
      return i >= 0 ? i + 1 : undefined;
    };
    out.fg = groups.map(g => formatGroupToWire(g, idToIndex));
  }
  if (settings.clearTargets && typeof settings.clearTargets === "object") {
    out.ct = settings.clearTargets;
  }
  return JSON.stringify(out);
}

// v5/v4 payload 文字列 → 適用可能な settings 断片 ({tags?, formats?, formatGroups?, clearTargets?})。
// formats は新 ID 採番済み、formatGroups はその ID を参照済み (= そのまま setSettings 可)。
export function decodeSettingsPayload(payload) {
  const obj = JSON.parse(String(payload || ""));
  if (!obj || typeof obj !== "object") throw new Error(t("qrSettings.invalid"));
  const v = obj.v;
  if (v !== 4 && v !== WIRE_V) throw new Error(t("qrSettings.versionMismatch", { a: v, b: WIRE_V }));

  const tagDict = Array.isArray(obj.td) ? obj.td.filter(s => typeof s === "string") : [];
  const out = {};
  // v5 は td を常に送る (設定全体) ので tags を常に適用 = 空配列ならタグ消去も反映。
  // v4 は td があるときだけ (後方互換: 旧版は空タグ時に td を省略していた)。
  if (v === WIRE_V || tagDict.length) out.tags = tagDict.slice();

  // formats: 新 ID 採番 (v4/v5 共通)。formatGroups がこの ID を参照する。
  let formats = null;
  if (Array.isArray(obj.f)) {
    formats = obj.f.map(w => ({ id: newFormatId(), ...formatFromWire(w, tagDict) }));
    out.formats = formats;
  }

  // formatGroups: v5 の fg があれば新 format ID に解決、無ければ既定セットを再構築。
  // formats と必ずセットで返す (groups は format ID を参照するため不可分)。
  if (formats) {
    if (v === WIRE_V && Array.isArray(obj.fg)) {
      const groups = obj.fg.map(w => ({ id: newGroupId(), ...formatGroupFromWire(w, formats) }));
      out.formatGroups = ensureOneDefaultGroup(groups);
    } else {
      out.formatGroups = makeDefaultFormatGroups(formats);
    }
  }

  if (obj.ct && typeof obj.ct === "object") {
    out.clearTargets = {};
    for (const [k, val] of Object.entries(obj.ct)) {
      if (typeof val === "boolean") out.clearTargets[k] = val;
    }
  }
  // v7.6 以前の tge / tgs / tga は無視する (タグ・カテゴリ機能撤去のため)
  return out;
}

let onAppliedHandler = null;
export function setOnSettingsApplied(fn) { onAppliedHandler = fn; }

// formats と formatGroups はセットで置換 (groups は format ID を参照するため不可分)。
const APPLIED_FIELDS = ["formats", "formatGroups", "clearTargets", "tags"];

async function applySettings(safe, ctrl) {
  if (!safe) {
    alert(t("qrSettings.parse.failed"));
    return;
  }
  const summary = [];
  if (Array.isArray(safe.tags)) summary.push(t("qrSettings.summary.tags", { n: safe.tags.length }));
  if (Array.isArray(safe.formats)) summary.push(t("qrSettings.summary.formats", { n: safe.formats.length }));
  if (Array.isArray(safe.formatGroups)) summary.push(t("qrSettings.summary.sets", { n: safe.formatGroups.length }));
  if (safe.clearTargets) summary.push(t("qrSettings.summary.clearTargets"));
  const summaryText = summary.length ? `（${summary.join(", ")}）` : "";

  const ok = confirm(t("qrSettings.import.confirm", { summary: summaryText }));
  if (!ok) return;

  const prev = settings; // 保存失敗時のロールバック用
  const next = { ...settings };
  for (const k of APPLIED_FIELDS) {
    if (safe[k] !== undefined) next[k] = safe[k];
  }
  setSettings(next);
  // fail-closed: 保存が確認できてから閉じる/成功表示。失敗は in-memory を戻して中断。
  try {
    await saveSettingsOrThrow();
  } catch (e) {
    console.error("qr settings import: save failed:", e);
    setSettings(prev);
    alert(t("qr.recv.save.failed"));
    return;
  }
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
  encodePayload: encodeSettingsPayload,
  decodePayload: decodeSettingsPayload,
  onApply: applySettings,
  // 受信は統一ルーターへ。送信カードは表示専用。暗号 OFF でも圧縮を使う。
  inlineReceive: false,
  compress: true,
  shouldEncrypt: () => !!settings.qrEncryption?.ST,
});

export const initSettingsQr = () => flow.init();
export const isSettingsQrActive = () => flow.isActive();
export const refreshSettingsQrIfActive = () => flow.refresh();
