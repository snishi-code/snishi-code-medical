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
// 修正2 follow-up: 旧自由記述フィールド (p.s / p.oFree / p.a.text / p.p.text) は QR に
// 出力しない。自由記述欄を撤去した今、これらは「画面に見えないのに電子カルテへ流れる」
// 不可視データになり臨床被害 (取り違え・古い所見の混入) のリスクになる。本アプリは
// パイロット前で「最新版以降のみ対応」(後方互換を持たない) 方針なので、旧フィールドは
// データとして温存はするが出力経路からは切り離す (dormant)。
//
// Phase 3: 未タップ欄に既定文を自動補完する fallback も撤去済み。出力されるのは
// 「ユーザーがタップ/入力したもの」だけ (空欄パネルは QR でも空)。
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
