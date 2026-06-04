"use strict";

// ============================
// セット QR (FS) — フォーマットセット (formatGroup) 1 つ + 参照フォーマット一式
//
// 送信: セット編集モーダルの「QR 共有」→ setSetToShare(group) → openQrSetOverlay()
//        → 対象セットと、そのセットが参照する formats を 1 つの payload に詰める。
// 受信: 統一受信ルーター (qr-receive.js) 経由。常に新規追加:
//   - formats: 新 ID 採番で全件追加。同名は (2)/(3)… に rename (FMT と同等)。
//   - セット : 新 ID・isDefault=false・新 format ID 参照で追加。同名セットは rename。
//
// wire format は qr-protocol.js の formatToWire / formatGroupToWire に委譲
// (Wire Format Authority 参照)。セットは formats 配列への 1-based index 参照。
// ============================

import { settings, saveSettingsOrThrow, newFormatId, newGroupId } from "../store.js";
import { createQrFlow } from "./qr-flow.js";
import {
  formatToWire, formatFromWire,
  formatGroupToWire, formatGroupFromWire,
  uniqueName,
} from "./qr-protocol.js";
import { t } from "../i18n.js";

const WIRE_V = 1;

// 共有対象セット (formatGroup)。null なら encodePayload が空 (= 何も表示しない)。
let _setToShare = null;
export function setSetToShare(group) { _setToShare = group || null; }

// セット + 参照 formats → v1 payload 文字列 (純粋・テスト容易化のため export)。
//   group      : formatGroup
//   allFormats : settings.formats 相当 (group.formatIds の解決元)
//   tagDict    : settings.tags 相当 (空/未指定ならタグは文字列のまま inline)
export function encodeSetPayload(group, allFormats, tagDict) {
  if (!group) return "";
  const formats = Array.isArray(allFormats) ? allFormats : [];
  // セットが参照する formats を formatIds 順に解決
  const refFormats = (Array.isArray(group.formatIds) ? group.formatIds : [])
    .map(id => formats.find(f => f.id === id))
    .filter(Boolean);
  const dict = (Array.isArray(tagDict) && tagDict.length) ? tagDict : null;

  const out = { v: WIRE_V };
  if (dict) out.td = dict.slice();
  out.f = refFormats.map(f => formatToWire(f, dict));
  // refFormats 内での 1-based index に解決
  const idToIndex = (id) => {
    const i = refFormats.findIndex(f => f.id === id);
    return i >= 0 ? i + 1 : undefined;
  };
  // FS は単体セット共有。受信側では常に非デフォルトで追加するので、wire に
  // isDefault(d) は載せない (送信元のデフォルト状態を持ち込まない)。
  out.g = formatGroupToWire({ ...group, isDefault: false }, idToIndex);
  return JSON.stringify(out);
}

// v1 payload 文字列 → { formats:[{id,…}], group:{…} } (純粋・export)。
// formats は新 ID 採番済み、group はその ID を参照済み。
export function decodeSetPayload(payload) {
  const obj = JSON.parse(String(payload || ""));
  if (!obj || typeof obj !== "object") throw new Error(t("qrSet.invalid"));
  if (obj.v !== WIRE_V) throw new Error(t("qrSet.versionMismatch", { a: obj.v, b: WIRE_V }));
  if (!obj.g || typeof obj.g !== "object") throw new Error(t("qrSet.noSet"));
  const td = Array.isArray(obj.td) ? obj.td.filter(s => typeof s === "string") : null;
  const formats = (Array.isArray(obj.f) ? obj.f : [])
    .map(w => ({ id: newFormatId(), ...formatFromWire(w, td) }));
  const group = formatGroupFromWire(obj.g, formats);
  return { formats, group };
}

let _onAppliedHandler = null;
export function setOnSetApplied(fn) { _onAppliedHandler = fn; }

// 受信したセットを適用 (常に新規追加)。fail-closed: 保存後に完了表示。
async function applyReceivedSet(decoded, ctrl) {
  if (!decoded || !decoded.group) {
    alert(t("qrSet.parse.failed"));
    return;
  }
  const existingFormats = Array.isArray(settings.formats) ? settings.formats : [];
  const existingGroups = Array.isArray(settings.formatGroups) ? settings.formatGroups : [];

  // formats を rename (既存名 + このバッチ内で既に採用した名前を避ける)。ID は温存。
  const usedNames = new Set(existingFormats.map(f => f.name));
  const newFormats = (Array.isArray(decoded.formats) ? decoded.formats : []).map(f => {
    const finalName = uniqueName(f.name || t("qrFormat.untitled"), usedNames);
    usedNames.add(finalName);
    return { ...f, name: finalName };
  });

  // セット名 rename
  const groupName = uniqueName(decoded.group.name || t("qrSet.untitled"), existingGroups.map(g => g.name));
  const newGroup = {
    id: newGroupId(),
    name: groupName,
    isDefault: false,
    formatIds: (decoded.group.formatIds || []).slice(),
    defaultFormatIds: (decoded.group.defaultFormatIds || []).slice(),
    expandFormatIds: (decoded.group.expandFormatIds || []).slice(),
  };

  const summary = `（${t("qrSet.summary.formats", { n: newFormats.length })}）`;
  if (!confirm(t("qrSet.import.confirm", { name: groupName, summary }))) return;

  if (!Array.isArray(settings.formats)) settings.formats = [];
  if (!Array.isArray(settings.formatGroups)) settings.formatGroups = [];
  settings.formats.push(...newFormats);
  settings.formatGroups.push(newGroup);
  // fail-closed: 保存が確認できてから閉じる/成功表示。失敗は追加分を戻して中断。
  try {
    await saveSettingsOrThrow();
  } catch (e) {
    console.error("qr set import: save failed:", e);
    settings.formats = settings.formats.filter(f => !newFormats.includes(f));
    settings.formatGroups = settings.formatGroups.filter(g => g !== newGroup);
    alert(t("qr.recv.save.failed"));
    return;
  }
  ctrl.close();
  if (_onAppliedHandler) _onAppliedHandler(newGroup);
  alert(t("qrSet.imported.alert", { name: groupName }));
}

const flow = createQrFlow({
  kind: "FS",
  kindLabel: t("qr.kind.set"),
  emptyMessage: t("qrSet.empty"),
  ids: {
    wrapId: "qrSetWrap",
    canvasId: "qrSetCanvas",
    pageMetaId: "qrSetPageMeta",
    prevBtnId: "qrSetPrevBtn",
    nextBtnId: "qrSetNextBtn",
    showBtnId: "qrSetShowBtn",
    scanBtnId: "qrSetScanBtn",
  },
  encodePayload: () => encodeSetPayload(_setToShare, settings.formats, settings.tags),
  decodePayload: decodeSetPayload,
  onApply: applyReceivedSet,
  // 受信は統一ルーターへ。送信オーバーレイは表示専用。暗号 OFF でも圧縮。
  inlineReceive: false,
  compress: true,
  shouldEncrypt: () => !!settings.qrEncryption?.FS,
});

export const initQrSet = () => flow.init();
export const isQrSetActive = () => flow.isActive();
export const refreshQrSetIfActive = () => flow.refresh();

// オーバーレイの open / close (overlay は HTML 側に popupMenuOverlay として用意)
export function openQrSetOverlay(group) {
  setSetToShare(group);
  const overlay = document.getElementById("qrSetOverlay");
  if (overlay) overlay.classList.add("active");
  flow.open();
}

export function closeQrSetOverlay() {
  const overlay = document.getElementById("qrSetOverlay");
  if (overlay) overlay.classList.remove("active");
  flow.close();
  setSetToShare(null);
}
