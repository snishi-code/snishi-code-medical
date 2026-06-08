"use strict";

import { appState } from "./store.js";
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

// パネルの自由記述テキスト (S/O は直接フィールド、A/P は {text})。
// 既存患者の自由記述 (s / oFree / a.text / p.text) を消さず QR にも残すための互換読み取り。
function panelFreeText(p, panel) {
  if (panel === "O") return multiLineText(p?.oFree ?? "");
  if (panel === "S") return multiLineText(p?.s ?? "");
  if (panel === "A") return multiLineText(p?.a?.text ?? "");
  if (panel === "P") return multiLineText(p?.p?.text ?? "");
  return "";
}

// パネル出力 = 展開(A)フォーマットの入力値 (formatValues) + 既存自由記述。
// Phase 3: 未タップ欄に既定文を自動補完する fallback は撤去した。出力される文は原則
// 「ユーザーがタップ/入力したもの」だけにし、A 層が「未入力なのに入力済み」と誤認するのを
// 避ける (空欄パネルは QR でも空)。
function buildPanelOut(p, panel, group) {
  const aText = composeExpandedForPanel(panel, group, p?.formatValues || {});
  const free = panelFreeText(p, panel);
  const parts = [];
  if (aText && aText.trim()) parts.push(aText.trim());
  if (free) parts.push(free);
  return parts.join("\n");
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
