"use strict";

import { appState } from "./store.js";
import { resolveActiveGroup } from "./features/format-groups.js";
import { composeExpandedForPanel } from "./features/formats.js";

export function utf8ByteLength(text) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(String(text ?? "")).length;
  }
  return unescape(encodeURIComponent(String(text ?? ""))).length;
}

// パネル出力 = 「値が入ったフォーマット」(formatValues) の合成のみ。
//
// Phase 7: 臨床入力本文は全パネル (problem/S/O/A/P/shared) が formatValues に集約された。
// 患者画面QR (電子カルテ転記用) には problem/S/O/A/P を出し、shared は含めない (共有QR専用)。
// 出力されるのは「ユーザーがタップ/入力したもの」だけ (空欄パネルは QR でも空)。
function buildPanelOut(p, panel, group) {
  const aText = composeExpandedForPanel(panel, group, p?.formatValues || {});
  return (aText && aText.trim()) ? aText.trim() : "";
}

export function buildSoapParts(no) {
  const p = appState.patients[no - 1];
  // 実効グループ (active 指定 or デフォルト): 展開フォーマット値の合成に使う
  // (規定文による空欄 fallback は撤去済み。出力はタップ/入力した欄だけ)。
  const group = resolveActiveGroup(p);
  const sOut = buildPanelOut(p, "S", group);
  const oOut = buildPanelOut(p, "O", group);
  const aOut = buildPanelOut(p, "A", group);
  const pOut = buildPanelOut(p, "P", group);
  return { sOut, oOut, aOut, pOut };
}

export function buildTabPayload(no) {
  const p = appState.patients[no - 1];
  const group = resolveActiveGroup(p);
  // 先頭にプロブレムリスト (problem panel)。shared は含めない (共有QR専用)。
  const problemOut = buildPanelOut(p, "problem", group);
  const { sOut, oOut, aOut, pOut } = buildSoapParts(no);

  const parts = [];
  if (problemOut) {
    parts.push(problemOut);
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
