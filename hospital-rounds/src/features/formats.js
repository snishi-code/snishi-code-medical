"use strict";

// ============================
// フォーマット (Formats) - 患者画面側のロジック
//
// 新データモデル (settings.formats[]):
//   {
//     id, name, panel:"S"|"O"|"A"|"P",
//     joiner,       // 項目間の区切り (例 ", " / "\n")
//     labelSep,     // ラベルと値の間の区切り (例 "：" / " ")
//     tags: [],     // 反映時に患者へ merge されるタグ名一覧 (重複追加はしない、外す処理は無し)
//     items: [
//       { label, kind:"text",     normal },        // ラベル + 規定文 (textarea)
//       { label, kind:"number",   unit   },        // ラベル + 数値 + 単位 + memo
//       { label, kind:"fraction", unit   },        // ラベル + 数値2つ "/" 結合 + 単位 + memo
//       { label, kind:"date",     normal },        // ラベル + 月日 + memo(normal=prefill)
//     ]
//   }
//
// このモジュールは:
//   1) 患者画面の各パネル (O/A/P) ヘッダに [+] [pin1...] [≡] ボタン群を組み立てる
//   2) フォーマット選択ピッカー (≡) を開く
//   3) フォーマット入力モーダル (kind 別の行) を開く
//   4) 反映時に対象 textarea の末尾に追記 + format.tags を患者タグへ merge
// ============================

import { appState, settings, selectedNo, saveSettings, scheduleSave, markUpdated } from "../store.js";
import {
  FORMAT_PANELS, FORMAT_ITEM_KINDS, DEFAULT_ITEM_KIND,
  DEFAULT_LABEL_SEP_TEXT, DEFAULT_LABEL_SEP_OTHER,
} from "../constants.js";
import { makeTagPicker, getAllTags, getPatientTags, setPatientTags } from "./tags.js";
import { openQrFormatOverlay } from "./qr-format.js";
import { resolveActiveGroup } from "./format-groups.js";
import { t, applyI18n } from "../i18n.js";

// strip 右端のハンバーガー (パネルごとの「全フォーマット一覧 = お気に入りトグル popup」を開く)
const FORMAT_PICKER_HAMBURGER_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

const PANEL_TEXTAREA_ID = { S: "sText", O: "oFreeText", A: "aText", P: "pText" };
const PANEL_FIELD_KEY   = { S: "s",     O: "oFree",    A: "a",     P: "p"    };

function newFmtId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return "fmt_" + crypto.randomUUID();
  return "fmt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ============================
// store adapter (移植性: 永続化を外から注入)
//
// formats.js は patient 画面の入力モーダル / 編集モーダルを担当する。
// データ層 (settings.formats へのアクセス) は adapter 経由にして、別アプリ
// への移植や Preact 化時の差し替えを容易にする。
//
// adapter API:
//   saveFormat(format, { isNew }): フォーマットを永続化。新規/更新どちらも
//   deleteFormat(id):              フォーマットを削除
// adapter 未注入時は store の settings.formats を直接 mutate (現状互換)。
// ============================
let _formatStoreAdapter = null;
export function setFormatStoreAdapter(adapter) {
  _formatStoreAdapter = adapter && typeof adapter === "object" ? adapter : null;
}

function adapterSaveFormat(target, isNew) {
  if (_formatStoreAdapter && typeof _formatStoreAdapter.saveFormat === "function") {
    _formatStoreAdapter.saveFormat(target, { isNew });
    return;
  }
  // フォールバック: adapter 未配線でも単独 testing 時に動くよう、settings を直接更新
  if (!Array.isArray(settings.formats)) settings.formats = [];
  if (isNew) {
    settings.formats.push(target);
  } else {
    const idx = settings.formats.findIndex(f => f.id === target.id);
    if (idx >= 0) settings.formats[idx] = target;
    else settings.formats.push(target);
  }
  saveSettings();
}

function adapterDeleteFormat(id) {
  if (_formatStoreAdapter && typeof _formatStoreAdapter.deleteFormat === "function") {
    _formatStoreAdapter.deleteFormat(id);
    return;
  }
  // フォールバック
  if (!Array.isArray(settings.formats)) return;
  const idx = settings.formats.findIndex(f => f.id === id);
  if (idx < 0) return;
  settings.formats.splice(idx, 1);
  saveSettings();
}

// 新しい item オブジェクトを kind に応じたフィールドで生成
function makeNewItem(kind) {
  const k = FORMAT_ITEM_KINDS.includes(kind) ? kind : DEFAULT_ITEM_KIND;
  if (k === "number" || k === "fraction") return { label: "", kind: k, unit: "" };
  return { label: "", kind: k, normal: "" }; // text / date
}

// item の kind を変更した時に、必要なフィールドだけ残して埋め直す
function morphItemKind(item, newKind) {
  const k = FORMAT_ITEM_KINDS.includes(newKind) ? newKind : DEFAULT_ITEM_KIND;
  const label = String(item?.label ?? "");
  if (k === "number" || k === "fraction") {
    return { label, kind: k, unit: String(item?.unit ?? "") };
  }
  return { label, kind: k, normal: String(item?.normal ?? "") };
}

export function formatsForPanel(panel) {
  if (!Array.isArray(settings.formats)) return [];
  return settings.formats.filter(f => f.panel === panel);
}

// ============================
// 患者画面: 各パネル右肩のボタン strip 描画
// ============================
let _onTextChanged = null;
export function setOnTextChanged(fn) { _onTextChanged = fn; }

// 新規フォーマット作成ウィジェット (タグの makeAddTagWidget と同じ「+」ボタンスタイル)。
function makeAddFormatWidget(panel, onAdded) {
  const wrap = document.createElement("span");
  wrap.className = "tagAddWidget";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tagSettingAdd";
  btn.title = t("format.new");
  btn.setAttribute("aria-label", t("format.new.aria"));
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    startNewFormat(() => {
      if (onAdded) onAdded();
    }, panel);
  });
  wrap.appendChild(btn);
  return wrap;
}

// 実効グループの「展開(A)」フォーマット (panel フィルタ済、expandFormatIds 順)。
export function expandedFormatsForPanel(panel, group) {
  if (!group) return [];
  const byId = new Map(formatsForPanel(panel).map(f => [f.id, f]));
  const out = [];
  for (const fid of group.expandFormatIds || []) {
    const f = byId.get(fid);
    if (f) out.push(f);
  }
  return out;
}

// 実効グループの「クイックアクセス(B)」= グループ内かつ展開でない (チップ表示)。
export function quickAccessFormatsForPanel(panel, group) {
  if (!group) return [];
  const expand = new Set(group.expandFormatIds || []);
  const byId = new Map(formatsForPanel(panel).map(f => [f.id, f]));
  const out = [];
  for (const fid of group.formatIds || []) {
    if (expand.has(fid)) continue;
    const f = byId.get(fid);
    if (f) out.push(f);
  }
  return out;
}

// パネルごとに 1 つ作る format ランチャー (☰)。グループ外 (C) も含む全フォーマットへの
// 入口。タップで入力モーダルを開く (カーソル位置に挿入)。
function makeFormatPicker(panel, onChange) {
  return makeTagPicker({
    launcher: true,
    entries: () => formatsForPanel(panel).map(f => ({ value: f.id, label: f.name })),
    onChange,
    iconOnly: true,
    iconHtml: FORMAT_PICKER_HAMBURGER_SVG,
    addWidget: (onAdded) => makeAddFormatWidget(panel, onAdded),
    onItemClick: (entry) => {
      const f = formatsForPanel(panel).find(x => x.id === entry.value);
      if (f) openFormatInputModal(f, panel);
    },
  });
}

export function renderFormatStrip(panel, hostEl) {
  if (!hostEl) return;
  ensureCaretTracker();
  hostEl.textContent = "";
  hostEl.className = "formatStrip";

  const p = appState.patients[selectedNo - 1];
  const group = resolveActiveGroup(p);

  // 1) クイックアクセス(B) チップ。タップ → モーダル → カーソル位置に挿入。
  const bFormats = quickAccessFormatsForPanel(panel, group);
  const chips = document.createElement("div");
  chips.className = "formatStripChips";
  for (const f of bFormats) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "formatStripBtn formatStripPinned";
    chip.textContent = f.name;
    chip.title = t("format.chip.input.title", { name: f.name });
    chip.addEventListener("click", () => openFormatInputModal(f, panel));
    chips.appendChild(chip);
  }
  hostEl.appendChild(chips);

  // 2) ☰ ランチャー (グループ外含む全フォーマット)。
  const picker = makeFormatPicker(panel, () => {
    renderFormatStrip(panel, hostEl);
    renderExpandedFormats(panel, document.getElementById(EXPANDED_HOST_ID[panel]));
  });
  hostEl.appendChild(picker);
}

// ============================
// インライン展開フォーマット (A・非揮発) (v8.3+)
//
// 実効グループの「展開(A)」フォーマットを、パネル本文の上に展開入力欄として並べる。
// 値は patient.formatValues に構造保存 (非揮発)。欄に出しっぱなしで再編集可。入力毎に
// formatValues を更新するだけで再描画はしない (フォーカス維持)。グループ切替時に
// flushGroupExpandedValues() で各欄の自由記述へ流し込んでクリアする。
// 出力 (payload) は「現グループの A 値合成 + 自由記述」。
// ============================
const EXPANDED_HOST_ID = { S: "sExpanded", O: "oExpanded", A: "aExpanded", P: "pExpanded" };

let _onExpandedInput = null;
export function setOnExpandedInput(fn) { _onExpandedInput = fn; }

export function renderExpandedFormats(panel, hostEl) {
  if (!hostEl) return;
  hostEl.textContent = "";
  const p = appState.patients[selectedNo - 1];
  if (!p) return;
  const group = resolveActiveGroup(p);
  const formats = expandedFormatsForPanel(panel, group);
  for (const format of formats) hostEl.appendChild(buildExpandedWidget(format, p));
}

function buildExpandedWidget(format, patient) {
  if (!patient.formatValues || typeof patient.formatValues !== "object") patient.formatValues = {};
  const stored = (patient.formatValues[format.id] && typeof patient.formatValues[format.id] === "object")
    ? patient.formatValues[format.id] : {};

  const wrap = document.createElement("div");
  wrap.className = "formatExpanded";

  const head = document.createElement("div");
  head.className = "formatExpandedName";
  head.textContent = format.name;
  wrap.appendChild(head);

  const allText = (format.items || []).every(it => it && it.kind === "text");
  const body = document.createElement("div");
  body.className = "formatInputBody " + (allText ? "text" : "mixed");
  wrap.appendChild(body);

  const items = format.items || [];
  items.forEach((item, i) => {
    const kind = item.kind || DEFAULT_ITEM_KIND;
    const onInput = (v) => {
      if (!patient.formatValues[format.id] || typeof patient.formatValues[format.id] !== "object") {
        patient.formatValues[format.id] = {};
      }
      patient.formatValues[format.id][i] = v;
      markUpdated(selectedNo);
      scheduleSave();
      if (_onExpandedInput) _onExpandedInput(); // QR プレビュー等の軽量更新 (再描画はしない)
    };
    const opts = { value: stored[i], onInput };
    if (kind === "number") buildNumberRow(body, item, opts);
    else if (kind === "fraction") buildFractionRow(body, item, opts);
    else buildTextRow(body, item, opts);
  });

  return wrap;
}

// グループ切替時: 旧グループの展開(A)値を、各欄の自由記述へ流し込んでクリアする。
// (グループを変えても入力済みのデータを失わないため)。caller (format-groups) が
// activeFormatGroupId を変更する「前」に呼ぶ。
export function flushGroupExpandedValues(patient, group) {
  if (!patient || !group) return;
  const fv = (patient.formatValues && typeof patient.formatValues === "object") ? patient.formatValues : {};
  for (const panel of FORMAT_PANELS) {
    const aFormats = expandedFormatsForPanel(panel, group);
    const pieces = [];
    for (const f of aFormats) {
      const { text, hasValue } = composeFormatFromValues(f, fv[f.id] || {});
      if (hasValue) pieces.push(text);
      delete fv[f.id]; // 流し込んだら (空でも) クリア
    }
    if (pieces.length) appendTextToPanelData(patient, panel, pieces.join("\n"));
  }
}

// ============================
// フォーマット入力モーダル
// ============================
let _currentInput = null; // { format, panel, rowEls }

function openFormatInputModal(format, panel) {
  const overlay = document.getElementById("formatInputOverlay");
  const title = document.getElementById("formatInputTitle");
  const body = document.getElementById("formatInputBody");
  if (!overlay || !title || !body) return;

  title.textContent = format.name;
  body.textContent = "";
  // 全 item が text の format なら従来通り flex の 1 行レイアウト
  // それ以外は kind ごとに行 div を縦に積む (CSS grid は使わず行内 flex)
  const allText = (format.items || []).every(it => it && it.kind === "text");
  body.className = "formatInputBody " + (allText ? "text" : "mixed");
  _currentInput = { format, panel, rowEls: [] };

  for (const item of format.items) {
    const kind = item.kind || DEFAULT_ITEM_KIND;
    if (kind === "number") _currentInput.rowEls.push(buildNumberRow(body, item));
    else if (kind === "fraction") _currentInput.rowEls.push(buildFractionRow(body, item));
    else _currentInput.rowEls.push(buildTextRow(body, item));
  }

  overlay.classList.add("active");
  // 最初の入力欄にフォーカス
  setTimeout(() => {
    const first = body.querySelector("input, textarea");
    if (first) first.focus();
  }, 50);
}

// ============================
// iOS Safari の inputMode 引きずり対策ヘルパ
//
// iOS は input のフォーカスを別の input に移動した時に、前の input の inputMode を
// 引きずって誤った種類のキーボードを出すバグがある。対策:
//   1) IDL プロパティ (.inputMode) と HTML 属性 (inputmode="...") の両方を設定
//   2) pattern も付与 (数値系は数字キーボードを誘導)
//   3) autocomplete / autocapitalize / spellcheck を off にして補完誤動作を防ぐ
//   4) focus イベントで inputMode を再アサート (前の入力の影響を上書き)
// ============================
function setupNumericInput(inp, mode /* "decimal" | "numeric" */) {
  inp.type = "text";
  inp.inputMode = mode;
  inp.setAttribute("inputmode", mode);
  inp.setAttribute("pattern", mode === "numeric" ? "[0-9]*" : "[0-9.]*");
  inp.autocomplete = "off";
  inp.autocapitalize = "off";
  inp.spellcheck = false;
  inp.addEventListener("focus", () => {
    inp.inputMode = mode;
    inp.setAttribute("inputmode", mode);
  });
}

function setupTextInput(inp) {
  // textarea でも input でも同様。type は呼出元で設定済み想定。
  inp.inputMode = "text";
  inp.setAttribute("inputmode", "text");
  inp.addEventListener("focus", () => {
    inp.inputMode = "text";
    inp.setAttribute("inputmode", "text");
  });
}

// opts: { value, onInput } — value は初期値、onInput(現在値) は入力毎コールバック
// (インライン展開 A の formatValues バインド用)。省略時は従来のモーダル挙動。
function buildNumberRow(host, item, opts = {}) {
  const row = document.createElement("div");
  row.className = "formatInputRow number";

  const label = document.createElement("div");
  label.className = "formatInputLabel";
  label.textContent = item.label;
  row.appendChild(label);

  const val = document.createElement("input");
  val.className = "formatInputValue";
  setupNumericInput(val, "decimal");
  if (opts.value != null) val.value = String(opts.value);
  if (opts.onInput) val.addEventListener("input", () => opts.onInput(val.value));
  row.appendChild(val);

  // unit セルは常に出す (空 unit でも grid 列を揃える)
  const unit = document.createElement("span");
  unit.className = "formatInputUnit";
  unit.textContent = item.unit || "";
  row.appendChild(unit);

  // v6.10+ : 備考欄を撤去。grid 4 列との整合のため空 placeholder cell を 1 つ出す
  // (display:contents の row が cell 数を揃えないと次の行が前行に流れ込んでズレる)
  const memoPlaceholder = document.createElement("span");
  memoPlaceholder.className = "formatInputMemoPlaceholder";
  row.appendChild(memoPlaceholder);

  host.appendChild(row);
  return { item, kind: "number", val };
}

function buildFractionRow(host, item, opts = {}) {
  const row = document.createElement("div");
  row.className = "formatInputRow fraction";

  const label = document.createElement("div");
  label.className = "formatInputLabel";
  label.textContent = item.label;
  row.appendChild(label);

  // grid で「value セル」を 1 つに見せるため、numer / slash / denom を 1 つの
  // div でラップする (display: contents は input には使えないので明示 wrap)。
  const fracGroup = document.createElement("div");
  fracGroup.className = "formatInputFracGroup";

  // fraction の左右は英数字・記号を許容する (例: "CTRX 1g/1")。よって text inputMode。
  // 血圧 "120/53" のような数値用途も text キーボードで引き続き入力できる (壊さない)。
  const numer = document.createElement("input");
  numer.type = "text";
  numer.className = "formatInputValue formatInputFracNumer";
  setupTextInput(numer);
  fracGroup.appendChild(numer);

  const slash = document.createElement("span");
  slash.className = "formatInputFracSlash";
  slash.textContent = "/";
  fracGroup.appendChild(slash);

  const denom = document.createElement("input");
  denom.type = "text";
  denom.className = "formatInputValue formatInputFracDenom";
  setupTextInput(denom);
  fracGroup.appendChild(denom);

  // 初期値 "a/b" を numer / denom に分解 (最初の "/" で分割)
  if (opts.value != null) {
    const s = String(opts.value);
    const slash = s.indexOf("/");
    if (slash >= 0) { numer.value = s.slice(0, slash); denom.value = s.slice(slash + 1); }
    else numer.value = s;
  }
  if (opts.onInput) {
    const emit = () => opts.onInput(`${numer.value}/${denom.value}`);
    numer.addEventListener("input", emit);
    denom.addEventListener("input", emit);
  }

  row.appendChild(fracGroup);

  const unit = document.createElement("span");
  unit.className = "formatInputUnit";
  unit.textContent = item.unit || "";
  row.appendChild(unit);

  // v6.10+ : 備考欄を撤去。grid 4 列との整合のため空 placeholder cell を 1 つ出す
  const memoPlaceholder = document.createElement("span");
  memoPlaceholder.className = "formatInputMemoPlaceholder";
  row.appendChild(memoPlaceholder);

  host.appendChild(row);
  return { item, kind: "fraction", numer, denom };
}

function buildTextRow(host, item, opts = {}) {
  const row = document.createElement("div");
  row.className = "formatInputRow text";

  const label = document.createElement("div");
  label.className = "formatInputLabel";
  label.textContent = item.label;
  row.appendChild(label);

  const val = document.createElement("textarea");
  val.className = "formatInputValue formatInputText";
  val.rows = 1;
  setupTextInput(val);
  if (opts.value != null) val.value = String(opts.value);
  if (opts.onInput) val.addEventListener("input", () => opts.onInput(val.value));

  // 正常文ボタン (チェック)。ラベルと入力欄の間に置く (ラベルのすぐ右が自然)。
  const normalBtn = document.createElement("button");
  normalBtn.type = "button";
  normalBtn.className = "formatInputNormalBtn";
  normalBtn.title = item.normal ? t("format.normal.tooltip.has", { value: item.normal }) : t("format.normal.tooltip.empty");
  normalBtn.setAttribute("aria-label", t("common.normal"));
  // チェックマーク SVG (lucide: check)
  normalBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  if (!item.normal) normalBtn.disabled = true;
  normalBtn.addEventListener("click", () => {
    val.value = item.normal || "";
    val.focus();
    if (opts.onInput) opts.onInput(val.value);
  });
  row.appendChild(normalBtn);
  row.appendChild(val);

  host.appendChild(row);
  return { item, kind: "text", val };
}

export function closeFormatInputModal() {
  const overlay = document.getElementById("formatInputOverlay");
  if (overlay) overlay.classList.remove("active");
  _currentInput = null;
}

// 値 + memo を組み合わせて「ラベル <labelSep> 値」を作る
// memo 付きの場合は末尾に半角スペース + memo を付ける (Labo / CT のような自然な並び)
function combineLabelValueMemo(label, labelSep, value, memo) {
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

// rowEls (build*Row が返す行参照) から展開テキストを組み立てる。モーダルとインライン
// 展開の両方で共用。戻り値: { text, hasValue }。hasValue=実際に値が入った item があるか
// (titleWrap だけのタイトル行は hasValue=false 扱い → インライン自動反映で空タブ抜けでは
//  挿入しないために使う)。
function composeFormatText(format, rowEls) {
  const labelSep = typeof format.labelSep === "string" ? format.labelSep : DEFAULT_LABEL_SEP_OTHER;
  const parts = [];
  for (const row of rowEls) {
    if (row.kind === "number") {
      const value = String(row.val.value || "").trim();
      if (!value) continue;
      const unit = row.item.unit || "";
      parts.push(combineLabelValueMemo(row.item.label, labelSep, `${value}${unit}`, ""));
    } else if (row.kind === "fraction") {
      // "120/53" / "/53" / "120/" を許容 (片側だけ入力可)。日付 "5/20" もここ
      const a = String(row.numer.value || "").trim();
      const b = String(row.denom.value || "").trim();
      if (!a && !b) continue;
      const unit = row.item.unit || "";
      parts.push(combineLabelValueMemo(row.item.label, labelSep, `${a}/${b}${unit}`, ""));
    } else {
      const value = String(row.val.value || "").trim();
      if (!value) continue;
      const lab = String(row.item.label || "").trim();
      parts.push(lab ? `${lab}${labelSep}${value}` : value);
    }
  }
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

// composeFormatText の「保存値 (formatValues[fid] = {itemIndex: 値}) から組み立てる」版。
// 展開(A)フォーマットの出力・流し込みで使う。fraction 値は "a/b" 文字列。
function composeFormatFromValues(format, values) {
  const vals = (values && typeof values === "object") ? values : {};
  const labelSep = typeof format.labelSep === "string" ? format.labelSep : DEFAULT_LABEL_SEP_OTHER;
  const parts = [];
  (format.items || []).forEach((item, i) => {
    const kind = item.kind || DEFAULT_ITEM_KIND;
    const raw = String(vals[i] ?? "");
    if (kind === "number") {
      const value = raw.trim();
      if (!value) return;
      parts.push(combineLabelValueMemo(item.label, labelSep, `${value}${item.unit || ""}`, ""));
    } else if (kind === "fraction") {
      // "a/b" 文字列。両側空 ("" or "/") はスキップ
      if (!raw.replace("/", "").trim()) return;
      parts.push(combineLabelValueMemo(item.label, labelSep, `${raw}${item.unit || ""}`, ""));
    } else {
      const value = raw.trim();
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

// payload.js から呼ぶ: 実効グループの展開(A)値を panel 別に合成して返す (再エクスポート用)。
export function composeExpandedForPanel(panel, group, formatValues) {
  if (!group) return "";
  const fv = (formatValues && typeof formatValues === "object") ? formatValues : {};
  const pieces = [];
  for (const f of expandedFormatsForPanel(panel, group)) {
    const { text, hasValue } = composeFormatFromValues(f, fv[f.id] || {});
    if (hasValue) pieces.push(text);
  }
  return pieces.join("\n");
}

function applyFormatInput() {
  if (!_currentInput) { closeFormatInputModal(); return; }
  const { format, panel, rowEls } = _currentInput;
  const { text } = composeFormatText(format, rowEls);
  // タグ merge を appendToPanel より前に実行する。appendToPanel が _onTextChanged
  // (= 詳細画面の再描画) を発火するので、その時点で tags も新しい状態になっている
  // ようにしておく (= inline タグ表示が即時更新される)。
  applyFormatTags(format);
  appendToPanel(panel, text);
  closeFormatInputModal();
}

function applyFormatTags(format) {
  const fmtTags = Array.isArray(format?.tags) ? format.tags : [];
  if (!fmtTags.length) return;
  const idx = (selectedNo | 0) - 1;
  if (idx < 0) return;
  const existing = getPatientTags(idx);
  const set = new Set(existing);
  // 設定上に存在するタグのみ追加 (タグが削除されていたら無視。新規生成はしない)
  const known = new Set(getAllTags());
  let changed = false;
  for (const t of fmtTags) {
    if (!known.has(t)) continue;
    if (!set.has(t)) {
      set.add(t);
      changed = true;
    }
  }
  if (changed) setPatientTags(idx, Array.from(set));
}

// 直近にカーソルが置かれていたパネルと、その時の患者 pid。フォーマット展開時に
// 「同じパネルにカーソルがあればその位置へ、無ければ末尾へ」を判定するのに使う。
let _lastFocusedPanel = null;
let _lastFocusedPid = null;
let _caretTrackerAttached = false;

// 4 つのパネル textarea は index.html で静的。focusin を 1 度だけ document に張り、
// どのパネルが直近フォーカスされたかを記録する (chip タップで blur しても保持される)。
function ensureCaretTracker() {
  if (_caretTrackerAttached) return;
  _caretTrackerAttached = true;
  document.addEventListener("focusin", (e) => {
    const id = e.target && e.target.id;
    if (!id) return;
    const panel = Object.keys(PANEL_TEXTAREA_ID).find(k => PANEL_TEXTAREA_ID[k] === id);
    if (!panel) return;
    _lastFocusedPanel = panel;
    const p = appState.patients[selectedNo - 1];
    _lastFocusedPid = p ? p.pid : null;
  }, true);
}

// パネル本文テキストの読み書き。S/O は直接の文字列フィールド (p.s / p.oFree)、
// A/P は {text} オブジェクト (p.a.text / p.p.text)。この差を吸収する。
function getPanelText(p, panel) {
  if (panel === "O") return String(p.oFree ?? "");
  if (panel === "S") return String(p.s ?? "");
  const key = PANEL_FIELD_KEY[panel]; // "a" | "p"
  return String(p[key]?.text ?? "");
}
function setPanelText(p, panel, val) {
  if (panel === "O") { p.oFree = val; return; }
  if (panel === "S") { p.s = val; return; }
  const key = PANEL_FIELD_KEY[panel];
  if (!p[key] || typeof p[key] !== "object") p[key] = { text: "" };
  p[key].text = val;
}
// データのみ末尾追加 (DOM 非依存)。グループ切替の流し込み用。
function appendTextToPanelData(p, panel, text) {
  if (!text) return;
  const cur = getPanelText(p, panel);
  const sep = cur && !cur.endsWith("\n") ? "\n" : "";
  setPanelText(p, panel, cur + sep + text);
}

function appendToPanel(panel, text) {
  if (!text) return;
  const p = appState.patients[selectedNo - 1];
  if (!p) return;
  const taId = PANEL_TEXTAREA_ID[panel];
  const ta = document.getElementById(taId);
  const current = getPanelText(p, panel);

  // カーソル位置展開: 同じパネルが直近フォーカスされ、かつ同じ患者なら caret 位置へ
  // 挿入する。別パネルにカーソルがあった / どこにも無い場合は末尾へ。
  const useCaret = !!ta && _lastFocusedPanel === panel && _lastFocusedPid === p.pid;
  let next, caretAfter;
  if (useCaret) {
    const len = current.length;
    const start = Math.max(0, Math.min(ta.selectionStart ?? len, len));
    const end = Math.max(start, Math.min(ta.selectionEnd ?? start, len));
    const before = current.slice(0, start);
    const after = current.slice(end);
    // 前後の行とくっつかないよう必要なら改行を補う
    const nlBefore = before && !before.endsWith("\n") ? "\n" : "";
    const nlAfter = after && !after.startsWith("\n") ? "\n" : "";
    const ins = nlBefore + text + nlAfter;
    next = before + ins + after;
    caretAfter = (before + nlBefore + text).length; // 挿入テキスト直後
  } else {
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    next = current + sep + text;
    caretAfter = next.length;
  }

  setPanelText(p, panel, next);
  if (ta) {
    ta.value = next;
    if (useCaret) {
      try { ta.focus(); ta.selectionStart = ta.selectionEnd = caretAfter; } catch (_) { /* noop */ }
    }
  }
  markUpdated(selectedNo);
  scheduleSave();
  if (_onTextChanged) _onTextChanged();
}

// ============================
// フォーマット編集モーダル (新規/編集)
// ============================
let _currentEdit = null; // { isNew, target, panel, onSaved, lastKind }

function openFormatEditModal(target, panel, onSaved) {
  const overlay = document.getElementById("formatEditOverlay");
  if (!overlay) return;
  _currentEdit = {
    isNew: !target,
    // 編集中は target の deep copy を弄り、保存時に確定。キャンセル時の rollback はオブジェクト破棄で済む。
    target: target ? {
      ...target,
      tags: Array.isArray(target.tags) ? target.tags.slice() : [],
      items: (target.items || []).map(it => ({ ...it })),
    } : {
      id: newFmtId(),
      name: "",
      panel: panel || "O",
      joiner: "\n",
      labelSep: DEFAULT_LABEL_SEP_OTHER,
      titleWrap: "", // 新規は既定でタイトル OFF (出力をすっきり; 必要なら編集でトグル ON)
      tags: [],
      items: [],
    },
    onSaved,
    // 「項目追加」時に直前の item の kind を引き継ぐためのヒント
    lastKind: DEFAULT_ITEM_KIND,
  };
  if (_currentEdit.target.items.length) {
    const last = _currentEdit.target.items[_currentEdit.target.items.length - 1];
    if (last && FORMAT_ITEM_KINDS.includes(last.kind)) _currentEdit.lastKind = last.kind;
  }
  // パネル表記をモーダルタイトル横に表示 (固定: ユーザーは変更不可)
  // タイトル表示なし (UIを簡潔に保つため)
  renderFormatEditForm();
  overlay.classList.add("active");
  const nameInp = document.getElementById("formatEditName");
  if (nameInp) setTimeout(() => nameInp.focus(), 50);
}

function renderTagsHost() {
  const host = document.getElementById("formatEditTagsHost");
  if (!host || !_currentEdit) return;
  host.textContent = "";
  // forPatient = true: status タグは出さず、ユーザータグだけを選ばせる
  const picker = makeTagPicker({
    getSelected: () => _currentEdit.target.tags.slice(),
    setSelected: (tags) => { _currentEdit.target.tags = tags.slice(); },
    entries: () => getAllTags().map(name => ({ value: name, label: name })),
    iconOnly: true,
    grouped: true,
    forPatient: true,
    // 設定 (フォーマット編集) のタグ選択も、ホーム/患者画面と同じ全画面シートで統一。
    presentation: "auto",
    sheetTitle: t("format.tags.title"),
  });
  // tagPicker 自体に title/aria を載せる
  const trigger = picker.querySelector(".tagPickerTrigger");
  if (trigger) {
    trigger.title = t("format.tags.title");
    trigger.setAttribute("aria-label", t("format.tags.aria"));
  }
  host.appendChild(picker);
}

function renderFormatEditForm() {
  const nameInp = document.getElementById("formatEditName");
  // 区切り (joiner): select は "newline"/"comma" の意味値。実値 "\n"/", " との変換はここで吸収。
  const joinerSel = document.getElementById("formatEditJoiner");
  const labelSepInp = document.getElementById("formatEditLabelSep");
  // タイトル表示 (titleWrap): checkbox。非空=ON。括弧種類自体はデータ層で温存。
  const titleToggle = document.getElementById("formatEditTitleToggle");
  const itemsHost = document.getElementById("formatEditItems");
  if (!_currentEdit || !nameInp) return;
  const target = _currentEdit.target;
  nameInp.value = target.name;
  // 区切りの 2 択 (改行/コンマ) は既存の独自 joiner (例 " / "・"、") を壊さないため、
  // ユーザーが select を明示変更した時だけ保存で上書きする (joinerDirty フラグ)。
  // 表示は "\n"→改行、それ以外→コンマに寄せる (将来「その他」入力欄を足す余地を残す)。
  _currentEdit.joinerDirty = false;
  if (joinerSel) {
    joinerSel.value = target.joiner === "\n" ? "newline" : "comma";
    joinerSel.onchange = () => { if (_currentEdit) _currentEdit.joinerDirty = true; };
  }
  if (labelSepInp) labelSepInp.value = typeof target.labelSep === "string" ? target.labelSep : "";
  if (titleToggle) titleToggle.checked = typeof target.titleWrap === "string" && target.titleWrap !== "";
  renderTagsHost();
  if (itemsHost) renderFormatEditItems(itemsHost);
}

function renderFormatEditItems(host) {
  host.textContent = "";
  const target = _currentEdit.target;
  for (let i = 0; i < target.items.length; i++) {
    const item = target.items[i];
    const row = document.createElement("div");
    row.className = "formatEditItemRow";

    // 1) ラベル入力 (常に左)
    const label = document.createElement("input");
    label.type = "text";
    label.className = "formatEditItemLabel";
    label.placeholder = t("format.placeholder.label");
    label.value = item.label || "";
    label.addEventListener("input", () => { item.label = String(label.value || ""); });
    row.appendChild(label);

    // 2) kind セレクタ
    const kindSel = document.createElement("select");
    kindSel.className = "formatEditItemKind";
    kindSel.title = t("format.itemKind.title");
    kindSel.setAttribute("aria-label", t("format.itemKind.aria"));
    for (const k of FORMAT_ITEM_KINDS) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = t("format.itemKind." + k);
      kindSel.appendChild(opt);
    }
    kindSel.value = item.kind || DEFAULT_ITEM_KIND;
    kindSel.addEventListener("change", () => {
      const next = morphItemKind(item, kindSel.value);
      target.items[i] = next;
      _currentEdit.lastKind = next.kind;
      renderFormatEditItems(host);
    });
    row.appendChild(kindSel);

    // 3) kind ごとの補助入力 (unit / normal)。text は normal、number / fraction は unit
    if (item.kind === "number" || item.kind === "fraction") {
      const unit = document.createElement("input");
      unit.type = "text";
      unit.className = "formatEditItemUnit";
      unit.placeholder = t("format.placeholder.unit");
      unit.value = item.unit || "";
      unit.addEventListener("input", () => { item.unit = String(unit.value || ""); });
      row.appendChild(unit);
    } else {
      // text
      const normal = document.createElement("input");
      normal.type = "text";
      normal.className = "formatEditItemNormal";
      normal.placeholder = t("format.placeholder.normal");
      normal.value = item.normal || "";
      normal.addEventListener("input", () => { item.normal = String(normal.value || ""); });
      row.appendChild(normal);
    }

    // 4) 削除ボタン
    const del = document.createElement("button");
    del.type = "button";
    del.className = "formatEditItemDel";
    del.title = t("format.deleteItem.title");
    del.setAttribute("aria-label", t("format.deleteItem.aria"));
    del.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    del.addEventListener("click", () => {
      target.items.splice(i, 1);
      renderFormatEditItems(host);
    });
    row.appendChild(del);

    host.appendChild(row);
  }
}

function saveFormatEdit() {
  if (!_currentEdit) { closeFormatEditModal(); return; }
  const nameInp = document.getElementById("formatEditName");
  const joinerSel = document.getElementById("formatEditJoiner");
  const labelSepInp = document.getElementById("formatEditLabelSep");
  const titleToggle = document.getElementById("formatEditTitleToggle");

  const target = _currentEdit.target;
  const name = String(nameInp?.value || "").trim();
  if (!name) {
    alert(t("format.name.required"));
    return;
  }
  // 同名チェック
  const all = Array.isArray(settings.formats) ? settings.formats : [];
  const dup = all.find(f => f.id !== target.id && f.name === name);
  if (dup) {
    alert(t("format.name.duplicate"));
    return;
  }

  target.name = name;
  // panel はモーダル外で固定。
  // 区切り (joiner) と タイトル表示 (titleWrap) は UI 露出。ラベル区切り (labelSep) は
  // 非表示 (欄なし) なので、欄がある時だけ反映し、無い時は既存値 (defaults プリセット)
  // を温存する (上書きでプリセットを潰さない)。
  // joiner は「ユーザーが select を触った時」だけ 2 択値で上書きする。触っていなければ
  // 既存の独自 joiner (defaults プリセットや QR 取込由来の " / " 等) を温存する。
  if (joinerSel && _currentEdit.joinerDirty) target.joiner = joinerSel.value === "newline" ? "\n" : ", ";
  else if (typeof target.joiner !== "string") target.joiner = ", ";
  if (labelSepInp) {
    target.labelSep = String(labelSepInp.value ?? "");
  } else if (typeof target.labelSep !== "string") {
    const allText = target.items.every(it => it && it.kind === "text");
    target.labelSep = allText ? DEFAULT_LABEL_SEP_TEXT : DEFAULT_LABEL_SEP_OTHER;
  }
  // ON の時、既存の括弧ペア (例 "[]") があれば温存し、無ければ既定の "（）"。OFF は空。
  if (titleToggle) {
    if (titleToggle.checked) {
      if (typeof target.titleWrap !== "string" || target.titleWrap === "") target.titleWrap = "（）";
    } else {
      target.titleWrap = "";
    }
  } else if (typeof target.titleWrap !== "string") {
    target.titleWrap = "";
  }
  // tags: 削除済みタグを掃除 (UI で picker を介して付けたが、その後にタグ自体が消された場合に備えて)
  const knownTags = new Set(getAllTags());
  target.tags = (target.tags || []).filter(t => knownTags.has(t));

  // 項目の除外ルール:
  //   text:               label / normal どちらか入力があれば保持
  //   date:               ラベル無しでも保持 (日付だけ展開する用途。例 抗菌薬の "5/20-")
  //   number / fraction:  label が空なら除外 (値だけでは意味を成さない)
  target.items = target.items
    .map(it => {
      // kind が壊れていたら text にフォールバック
      if (!FORMAT_ITEM_KINDS.includes(it.kind)) return morphItemKind(it, DEFAULT_ITEM_KIND);
      return it;
    })
    .filter(it => {
      const label = String(it.label || "").trim();
      if (it.kind === "text") {
        const normal = String(it.normal || "").trim();
        return !!label || !!normal;
      }
      if (it.kind === "fraction") return true; // 分数はラベル任意 (日付 "5/20" 等)
      return !!label; // number はラベル必須
    });

  adapterSaveFormat(target, _currentEdit.isNew);
  const cb = _currentEdit.onSaved;
  const savedTarget = target;
  closeFormatEditModal();
  if (cb) cb(savedTarget);
}

export function closeFormatEditModal() {
  const overlay = document.getElementById("formatEditOverlay");
  if (overlay) overlay.classList.remove("active");
  _currentEdit = null;
}

function addFormatItem() {
  if (!_currentEdit) return;
  const target = _currentEdit.target;
  target.items.push(makeNewItem(_currentEdit.lastKind || DEFAULT_ITEM_KIND));
  const itemsHost = document.getElementById("formatEditItems");
  if (itemsHost) renderFormatEditItems(itemsHost);
}

// ============================
// 設定画面側の CRUD ヘルパ (settings-view.js から呼ばれる)
// ============================
export function startNewFormat(onSaved, panel) {
  openFormatEditModal(null, panel || "O", onSaved);
}

export function startEditFormat(format, onSaved) {
  openFormatEditModal(format, format.panel, onSaved);
}

export function deleteFormatById(id) {
  adapterDeleteFormat(id);
}

// ============================
// 共通配線 (DOM ready 後 main.js から initFormats を呼ぶ)
// ============================
export function initFormats() {
  const inputApply = document.getElementById("formatInputApplyBtn");
  const inputCancel = document.getElementById("formatInputCancelBtn");
  const inputOverlay = document.getElementById("formatInputOverlay");
  if (inputApply) inputApply.addEventListener("click", applyFormatInput);
  if (inputCancel) inputCancel.addEventListener("click", closeFormatInputModal);
  if (inputOverlay) inputOverlay.addEventListener("click", (e) => {
    if (e.target === inputOverlay) closeFormatInputModal();
  });

  const editSave = document.getElementById("formatEditSaveBtn");
  const editCancel = document.getElementById("formatEditCancelBtn");
  const editAddItem = document.getElementById("formatEditAddItemBtn");
  const editOverlay = document.getElementById("formatEditOverlay");
  const editQrShare = document.getElementById("formatEditQrShareBtn");
  if (editSave) editSave.addEventListener("click", saveFormatEdit);
  if (editCancel) editCancel.addEventListener("click", closeFormatEditModal);
  if (editAddItem) editAddItem.addEventListener("click", addFormatItem);
  if (editOverlay) editOverlay.addEventListener("click", (e) => {
    if (e.target === editOverlay) closeFormatEditModal();
  });
  // QR 共有: 編集中のフォーマット (= _currentEdit.target) を渡してオーバーレイを開く。
  // 未保存でも編集中状態の中身がそのまま QR 化される (= 試行錯誤しやすい)。
  // ただし name 空のままは弾く。
  if (editQrShare) editQrShare.addEventListener("click", () => {
    if (!_currentEdit) return;
    const target = _currentEdit.target;
    const name = String(target?.name || "").trim();
    if (!name) {
      alert(t("format.name.required"));
      return;
    }
    openQrFormatOverlay(target);
  });
}
