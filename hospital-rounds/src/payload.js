"use strict";

import { appState, settings } from "./store.js";
import { resolveActiveGroup } from "./features/format-groups.js";
import { composeExpandedForPanel } from "./features/formats.js";

export function oneLineText(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, " / ")
    .replace(/\t+/g, " ")
    .trim();
}

export function multiLineText(s) {
  return String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function utf8ByteLength(text) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(String(text ?? "")).length;
  }
  return unescape(encodeURIComponent(String(text ?? ""))).length;
}

// 1 つの規定文フォーマットを text 化する (normal を持つ text item を結合)。
function renderOneDefault(def) {
  const labelSep = typeof def.labelSep === "string" ? def.labelSep : "：";
  const parts = [];
  for (const item of (def.items || [])) {
    if ((item.kind || "text") !== "text") continue; // normal を持つのは text のみ
    const label = String(item.label ?? "").trim();
    const normal = String(item.normal ?? "").trim();
    if (!normal) continue;
    parts.push(label ? `${label}${labelSep}${normal}` : normal);
  }
  return parts.join(def.joiner || ", ");
}

// 実効グループが対象パネルに指定した「規定文」フォーマットの中身を text として描画する。
// 空欄パネルの fallback テキスト生成。グループの defaultFormatIds を参照 (パネル内に
// 複数あれば全て補完 = 改行結合)。未指定なら空文字。
function renderDefaultForPanel(panel, group) {
  if (!group) return "";
  const fmts = (settings && Array.isArray(settings.formats)) ? settings.formats : [];
  const defIds = Array.isArray(group.defaultFormatIds) ? group.defaultFormatIds : [];
  // group 内の順序を保つため defaultFormatIds 順に取り出す
  const defs = defIds.map(id => fmts.find(f => f.id === id)).filter(f => f && f.panel === panel);
  return defs.map(renderOneDefault).filter(Boolean).join("\n");
}

// パネルの自由記述テキスト (S/O は直接フィールド、A/P は {text})。
function panelFreeText(p, panel) {
  if (panel === "O") return multiLineText(p?.oFree ?? "");
  if (panel === "S") return multiLineText(p?.s ?? "");
  if (panel === "A") return multiLineText(p?.a?.text ?? "");
  if (panel === "P") return multiLineText(p?.p?.text ?? "");
  return "";
}

// パネル出力 = 展開(A)フォーマットの値 + 自由記述。両方空なら規定文 fallback。
function buildPanelOut(p, panel, group) {
  const aText = composeExpandedForPanel(panel, group, p?.formatValues || {});
  const free = panelFreeText(p, panel);
  const parts = [];
  if (aText && aText.trim()) parts.push(aText.trim());
  if (free) parts.push(free);
  if (parts.length) return parts.join("\n");
  return renderDefaultForPanel(panel, group);
}

export function buildSoapParts(no) {
  const p = appState.patients[no - 1];
  // 実効グループ (active 指定 or デフォルト): 展開(A)値の合成と規定文 fallback に使う
  const group = resolveActiveGroup(p);
  const sOut = buildPanelOut(p, "S", group);
  const oOut = buildPanelOut(p, "O", group);
  const aOut = buildPanelOut(p, "A", group);
  const pOut = buildPanelOut(p, "P", group);
  return { sOut, oOut, aOut, pOut };
}

export function buildTabPayload(no) {
  const p = appState.patients[no - 1];
  const { sOut, oOut, aOut, pOut } = buildSoapParts(no);
  const memo = String(p?.memo ?? "").trim();

  const parts = [];
  if (memo) {
    parts.push(memo);
    parts.push("――");
  }
  parts.push("(S)");
  parts.push(sOut);
  parts.push("――");
  parts.push("(O)");
  parts.push(oOut);
  parts.push("――");
  parts.push("(A)");
  parts.push(aOut);
  parts.push("――");
  parts.push("(P)");
  parts.push(pOut);
  return parts.join("\n");
}
