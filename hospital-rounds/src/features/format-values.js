"use strict";

// ============================
// フォーマット値ヘルパ (DOM 非依存)
//
// 展開(A)フォーマットの患者入力値は patient.formatValues に構造保存される:
//   formatValues[formatId] = { [itemIndex]: 値 }
//
// 各 item の保存形:
//   text     : 文字列 (規定文・所見)
//   number   : 旧 = 文字列 "96" / 新 = { value:"96", note:"O2 2L" }
//   fraction : 旧 = 文字列 "120/53" / 新 = { value:"120/53", note:"…" }
//
// note は「フォーマット定義」ではなく「患者ごとの入力値」(SpO2 の酸素投与量など短文
// 注記)。number/fraction だけが note を持つ。旧文字列値は note="" として読む
// (後方互換)。このモジュールは store.js / formats.js / payload.js が共有する
// 純データロジックを置く (DOM・store に依存しないので Node テストで直接検査できる)。
// ============================

import { DEFAULT_ITEM_KIND, DEFAULT_LABEL_SEP_OTHER } from "../constants.js";

// number/fraction の保存値を { value, note } に正規化する。旧文字列値も読める。
export function readNumericEntry(stored) {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return { value: String(stored.value ?? ""), note: String(stored.note ?? "") };
  }
  return { value: String(stored ?? ""), note: "" };
}

// 1 つの保存値に「入力がある」か判定する (空患者判定・サニタイズ用)。
//   number/fraction (object): value (スラッシュ除去後) か note のどちらかに文字があれば true
//   文字列 (text / 旧 number / 旧 fraction): スラッシュ除去後に文字があれば true
export function formatValueHasInput(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return !!(String(v.value ?? "").replace("/", "").trim() || String(v.note ?? "").trim());
  }
  return !!String(v ?? "").replace("/", "").trim();
}

// 値 + memo(注記) を組み合わせて「ラベル <labelSep> 値」を作る。
// 注記がある場合だけ末尾に半角スペース + 注記を付ける (例: "SpO2 96% O2 2L")。
export function combineLabelValueMemo(label, labelSep, value, memo) {
  const lab = String(label || "").trim();
  const val = String(value || "").trim();
  const m = String(memo || "").trim();
  // label が空なら値だけ出す (規定文「著変なし」など)
  let body;
  if (lab) body = `${lab}${labelSep}${val}`;
  else body = val;
  if (m) body += ` ${m}`;
  return body;
}

// 保存値 (formatValues[fid] = { itemIndex: 値 }) からフォーマット出力テキストを組み立てる。
// 展開(A)フォーマットの出力・流し込みで使う。fraction 値は "a/b" 文字列。
// number/fraction は note を末尾に付ける。戻り値: { text, hasValue }。
export function composeFormatFromValues(format, values) {
  const vals = (values && typeof values === "object") ? values : {};
  const labelSep = typeof format.labelSep === "string" ? format.labelSep : DEFAULT_LABEL_SEP_OTHER;
  const parts = [];
  (format.items || []).forEach((item, i) => {
    const kind = item.kind || DEFAULT_ITEM_KIND;
    const rawEntry = vals[i];
    if (kind === "number") {
      const { value, note } = readNumericEntry(rawEntry);
      const v = value.trim();
      if (!v) return; // 値なし注記だけは出力しない (文脈不明になるため)
      parts.push(combineLabelValueMemo(item.label, labelSep, `${v}${item.unit || ""}`, note));
    } else if (kind === "fraction") {
      const { value, note } = readNumericEntry(rawEntry);
      // "a/b" 両側空 ("" or "/") はスキップ
      if (!value.replace("/", "").trim()) return;
      parts.push(combineLabelValueMemo(item.label, labelSep, `${value}${item.unit || ""}`, note));
    } else {
      const value = String(rawEntry ?? "").trim();
      if (!value) return;
      const lab = String(item.label || "").trim();
      parts.push(lab ? `${lab}${labelSep}${value}` : value);
    }
  });
  const body = parts.join(format.joiner || ", ");
  const titleWrap = typeof format.titleWrap === "string" ? format.titleWrap : "";
  let text = body;
  if (titleWrap) {
    const L = titleWrap[0] || "";
    const R = titleWrap[1] || "";
    const titleLine = `${L}${format.name}${R}`;
    text = body ? `${titleLine}\n${body}` : titleLine;
  }
  return { text, hasValue: parts.length > 0 };
}

// ============================
// パネル本文 (自由記述) の読み書き — S/O は直接フィールド、A/P は {text} オブジェクト。
// ============================
const PANEL_FIELD_KEY = { S: "s", O: "oFree", A: "a", P: "p" };

export function getPanelText(p, panel) {
  if (panel === "O") return String(p.oFree ?? "");
  if (panel === "S") return String(p.s ?? "");
  const key = PANEL_FIELD_KEY[panel]; // "a" | "p"
  return String(p[key]?.text ?? "");
}

export function setPanelText(p, panel, val) {
  if (panel === "O") { p.oFree = val; return; }
  if (panel === "S") { p.s = val; return; }
  const key = PANEL_FIELD_KEY[panel];
  if (!p[key] || typeof p[key] !== "object") p[key] = { text: "" };
  p[key].text = val;
}

// データのみ末尾追加 (DOM 非依存)。グループ切替の流し込み用。
export function appendTextToPanelData(p, panel, text) {
  if (!text) return;
  const cur = getPanelText(p, panel);
  const sep = cur && !cur.endsWith("\n") ? "\n" : "";
  setPanelText(p, panel, cur + sep + text);
}

// ============================
// パネル単位クリア (診察開始) — settings.formats[].panel を正本に formatId を解決する。
// 自由記述と展開フォーマット値を S/O/A/P で同じ仕組みで一括クリアする。
// ============================

// settings.formats のうち panel に属する formatId 一覧 (panel が正本)。
export function formatIdsForPanel(panel, formats) {
  if (!Array.isArray(formats)) return [];
  return formats.filter(f => f && f.panel === panel).map(f => f.id);
}

// panel に属する展開フォーマット値だけを患者から削除する (他 panel の値は触らない)。
export function clearPanelFormatValues(patient, panel, formats) {
  if (!patient || !patient.formatValues || typeof patient.formatValues !== "object") return;
  for (const fid of formatIdsForPanel(panel, formats)) {
    delete patient.formatValues[fid];
  }
}

// panel の自由記述 + 同 panel 所属の展開フォーマット値を一括クリアする。
// 「診察開始」クリアが S/O/A/P で同じ仕組みを使うための単一ソース。
export function clearPanelClinicalInput(patient, panel, formats) {
  if (!patient) return;
  setPanelText(patient, panel, "");
  clearPanelFormatValues(patient, panel, formats);
}
