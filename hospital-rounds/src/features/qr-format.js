"use strict";

// ============================
// フォーマット 1 つだけを QR で共有
//
// 送信: フォーマット編集モーダルの「QR 共有」ボタン → このモジュールの
//        setFormatToShare(format) → openQrFormatOverlay() → QR を表示
// 受信: 同じオーバーレイのスキャンボタンから読み取り → applyFormat
//
// 受信ポリシー (case-by-case で前回ご相談時に合意):
//   - ID: 常に新発番 (修正版の上書きを避ける)
//   - 同名: 末尾に "(2)", "(3)"... と自動付与で常に追加成功
//   - tags: 受信側に未登録のタグは無視 (タグ辞書を勝手に増やさない)
//
// 移植性のため、store への直接書き込みは行わず、`setFormatStoreAdapter`
// で渡された adapter を経由する。
//
// wire format は qr-protocol.js の formatToWire / formatFromWire に委譲。
// FMT は単独フォーマット QR なので tag dict のオーバーヘッドを避けるため
// tags は文字列のまま wire に乗せる (formatToWire に tagDict=null を渡す)。
// ============================

import { DEFAULT_LABEL_SEP_TEXT, DEFAULT_LABEL_SEP_OTHER } from "../constants.js";
import { createQrFlow } from "./qr-flow.js";
import { formatToWire, formatFromWire, uniqueName } from "./qr-protocol.js";
import { t } from "../i18n.js";

const WIRE_V = 2;

// 共有対象。null なら encodePayload が空ペイロードを返す (= 何も表示しない)
let _formatToShare = null;
export function setFormatToShare(format) { _formatToShare = format || null; }

// store adapter: 受信フォーマット適用時の read/write を外から注入する
let _adapter = {
  getExistingFormats: () => [],
  getKnownTags: () => [],
  addFormat: () => { console.warn("[qr-format] addFormat called without adapter"); },
  shouldEncrypt: () => false,
};
export function setFormatStoreAdapter(adapter) {
  _adapter = { ..._adapter, ...(adapter || {}) };
}

function newFmtId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return "fmt_" + crypto.randomUUID();
  return "fmt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// format → v2 payload 文字列 (テスト容易化のため export)。
// 単独フォーマットなので tag dict 化はしない (tagDict=null で文字列のまま)。
export function encodeFormatPayload(format) {
  if (!format) return "";
  return JSON.stringify({ v: WIRE_V, f: formatToWire(format, null) });
}

// v2 payload 文字列 → format オブジェクト (純粋・export)。
export function decodeFormatPayload(payload) {
  const obj = JSON.parse(String(payload || ""));
  if (!obj || typeof obj !== "object") throw new Error(t("qrFormat.invalid"));
  if (obj.v !== WIRE_V) throw new Error(t("qrFormat.versionMismatch", { a: obj.v, b: WIRE_V }));
  if (!obj.f || typeof obj.f !== "object") throw new Error(t("qrFormat.noName"));
  const fmt = formatFromWire(obj.f, null);
  if (!fmt.name) throw new Error(t("qrFormat.noName"));
  return fmt;
}

// 受信したフォーマットを適用 (常に新規追加。ID 新発番、同名は (2)/(3)... に rename、
// 未登録タグは無視)。
async function applyReceivedFormat(safe, ctrl) {
  if (!safe) {
    alert(t("qrFormat.parse.failed"));
    return;
  }
  const all = _adapter.getExistingFormats() || [];

  // 同名 → 自動 rename (共通 util)
  const baseName = String(safe.name || t("qrFormat.untitled")).trim();
  const finalName = uniqueName(baseName, all.map(f => f.name));

  // 未登録タグを除外
  const knownTags = new Set(_adapter.getKnownTags() || []);
  const safeTags = (Array.isArray(safe.tags) ? safe.tags : []).filter(tg => knownTags.has(tg));
  const droppedTags = (Array.isArray(safe.tags) ? safe.tags : []).filter(tg => !knownTags.has(tg));

  const summaryParts = [
    t("qrFormat.summary.panel", { panel: safe.panel || "O" }),
    t("qrFormat.summary.items", { n: (safe.items || []).length }),
  ];
  if (safeTags.length) summaryParts.push(t("qrFormat.summary.tags", { n: safeTags.length }));
  if (droppedTags.length) summaryParts.push(t("qrFormat.summary.droppedTags", { n: droppedTags.length }));
  const summary = `（${summaryParts.join(", ")}）`;

  if (!confirm(t("qrFormat.import.confirm", { name: finalName, summary }))) return;

  // 構築 (formatFromWire で得たオブジェクトをそのまま使うが、id と name と tags を
  // case-by-case で調整)。クイックアクセス・規定文はグループ側の管理に移行したため、
  // 受信フォーマットはどのグループにも属さない素の状態で入る (必要なら受信後に
  // 設定画面でグループへ追加する)。
  const items = Array.isArray(safe.items) ? safe.items : [];
  const labelSep = safe.labelSep || (
    items.length && items.every(it => it && it.kind === "text")
      ? DEFAULT_LABEL_SEP_TEXT : DEFAULT_LABEL_SEP_OTHER
  );
  const newFmt = {
    id: newFmtId(),
    name: finalName,
    panel: safe.panel,
    joiner: safe.joiner,
    labelSep,
    titleWrap: typeof safe.titleWrap === "string" ? safe.titleWrap : "",
    tags: safeTags,
    items,
  };

  // 保存は adapter に委譲。store の実態を qr-format.js は知らない。
  // fail-closed: adapter.addFormat は保存を await し、失敗時は throw + ロールバック
  // する契約 (main.js)。保存が確認できてから閉じる/成功表示。
  try {
    await _adapter.addFormat(newFmt);
  } catch (e) {
    console.error("qr format import: save failed:", e);
    alert(t("qr.recv.save.failed"));
    return;
  }
  // 受信元 (統一ルーター) の overlay を閉じる
  ctrl.close();
  if (_onAppliedHandler) _onAppliedHandler(newFmt);
  alert(t("qrFormat.imported.alert", { name: finalName }));
}

let _onAppliedHandler = null;
export function setOnFormatApplied(fn) { _onAppliedHandler = fn; }

const flow = createQrFlow({
  kind: "FMT",
  kindLabel: t("qr.kind.format"),
  emptyMessage: t("qrFormat.empty"),
  ids: {
    wrapId: "qrFormatWrap",
    canvasId: "qrFormatCanvas",
    pageMetaId: "qrFormatPageMeta",
    prevBtnId: "qrFormatPrevBtn",
    nextBtnId: "qrFormatNextBtn",
    showBtnId: "qrFormatShowBtn",
    scanBtnId: "qrFormatScanBtn",
  },
  encodePayload: () => encodeFormatPayload(_formatToShare),
  decodePayload: decodeFormatPayload,
  onApply: applyReceivedFormat,
  // 受信は統一ルーターへ。送信オーバーレイは表示専用。暗号 OFF でも圧縮。
  inlineReceive: false,
  compress: true,
  shouldEncrypt: () => !!(_adapter.shouldEncrypt && _adapter.shouldEncrypt()),
});

export const initQrFormat = () => flow.init();
export const isQrFormatActive = () => flow.isActive();
export const refreshQrFormatIfActive = () => flow.refresh();

// オーバーレイの open / close (overlay 自体は HTML 側で popupMenuOverlay として用意)
export function openQrFormatOverlay(format) {
  setFormatToShare(format);
  const overlay = document.getElementById("qrFormatOverlay");
  if (overlay) overlay.classList.add("active");
  // QR card 自体を「show」状態にして強制的に描画する
  flow.open();
}

// 受信は統一ルーター (qr-receive.js) に集約したため、旧 openQrFormatReceiveOverlay
// は撤去。フォーマット QR の受信は設定の「QR から追加」から行う。

export function closeQrFormatOverlay() {
  const overlay = document.getElementById("qrFormatOverlay");
  if (overlay) overlay.classList.remove("active");
  flow.close();
  setFormatToShare(null);
}
