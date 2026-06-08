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
  FORMAT_ITEM_KINDS, DEFAULT_ITEM_KIND,
  DEFAULT_LABEL_SEP_TEXT, DEFAULT_LABEL_SEP_OTHER,
} from "../constants.js";
import { makeTagPicker, getAllTags, getPatientTags, setPatientTags } from "./tags.js";
import { openQrFormatOverlay } from "./qr-format.js";
import { resolveActiveGroup, getDefaultFormatGroup } from "./format-groups.js";
import { bindHandleDrag } from "./drag.js";
import {
  readNumericEntry, composeFormatFromValues,
} from "./format-values.js";
import { icon } from "../icons.js";
import { t, applyI18n } from "../i18n.js";

// strip 右端のハンバーガー (パネルごとの「全フォーマット一覧 = お気に入りトグル popup」を開く)
const FORMAT_PICKER_HAMBURGER_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

// 自由記述パネル (sText 等) は撤去 (修正2)。入力は全て展開カード + 大入力シート経由で
// patient.formatValues に構造保存する。

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

// 患者画面に常時出す展開カード (修正1 のワンタップ保証)。実効グループがこの panel の
// 展開フォーマットを持たない (カスタムセットが当該パネルを含まない / 壊れたデータ) 時は
// デフォルトグループの展開フォーマットへフォールバックする。これにより、どのグループが
// active でも S/O/A/P 各パネルに最低 1 つカードが出る。
export function effectiveExpandedFormatsForPanel(panel, group) {
  let out = expandedFormatsForPanel(panel, group);
  if (!out.length) {
    const def = getDefaultFormatGroup();
    if (def && (!group || def.id !== group.id)) out = expandedFormatsForPanel(panel, def);
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
      if (f) openFormatSheet(f, panel, 0);
    },
  });
}

export function renderFormatStrip(panel, hostEl) {
  if (!hostEl) return;
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
    chip.addEventListener("click", () => openFormatSheet(f, panel, 0));
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
// 患者画面: 展開フォーマットカード (修正2/3/4)
//
// 各パネルに「展開(expand)フォーマット」を常時カードとして並べる (= ワンタップ入力面)。
// カードは小さな inline input を持たず、値の「読み表示」+ タップで大入力シートを開く面に
// する (修正3)。text item は item.normal があればワンタップの正常チェックも出す (修正2 の
// 文字入力最小化)。値は patient.formatValues に構造保存。グループ切替時も維持され、
// 値が入った非展開フォーマット (クイック/ランチャー入力で「展開」されたもの) もカードとして
// 出す (= 自由記述欄の代替の可視先)。format.titleWrap が空なら見出しを出さない (修正4)。
// ============================
const EXPANDED_HOST_ID = { S: "sExpanded", O: "oExpanded", A: "aExpanded", P: "pExpanded" };

// チェック(正常)アイコン (lucide: check)。
const CHECK_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

export function renderExpandedFormats(panel, hostEl) {
  if (!hostEl) return;
  hostEl.textContent = "";
  const p = appState.patients[selectedNo - 1];
  if (!p) return;
  if (!p.formatValues || typeof p.formatValues !== "object") p.formatValues = {};
  const fv = p.formatValues;
  const group = resolveActiveGroup(p);
  // 常時出す展開カード (実効グループ + デフォルトフォールバック)。
  const expand = effectiveExpandedFormatsForPanel(panel, group);
  const shown = new Set(expand.map(f => f.id));
  // 値が入っている非展開フォーマット (クイック/ランチャーで入力 → 「展開」されたもの)。
  const extras = formatsForPanel(panel)
    .filter(f => !shown.has(f.id) && composeFormatFromValues(f, fv[f.id] || {}).hasValue);
  for (const format of [...expand, ...extras]) hostEl.appendChild(buildExpandedWidget(format, p));
}

// number/fraction/text 各 item の「カード上の値表示」テキストと空判定。
function cardItemDisplay(format, item, kind, stored) {
  if (kind === "number") {
    const { value, note } = readNumericEntry(stored);
    const v = value.trim();
    if (!v) return { text: t("format.card.empty"), empty: true };
    return { text: `${v}${item.unit || ""}${note.trim() ? " " + note.trim() : ""}`, empty: false };
  }
  if (kind === "fraction") {
    const { value, note } = readNumericEntry(stored);
    if (!value.replace("/", "").trim()) return { text: t("format.card.empty"), empty: true };
    return { text: `${value}${item.unit || ""}${note.trim() ? " " + note.trim() : ""}`, empty: false };
  }
  const v = String(stored ?? "").trim();
  if (!v) return { text: t("format.card.empty"), empty: true };
  return { text: v, empty: false };
}

function buildExpandedWidget(format, patient) {
  if (!patient.formatValues || typeof patient.formatValues !== "object") patient.formatValues = {};
  const stored = (patient.formatValues[format.id] && typeof patient.formatValues[format.id] === "object")
    ? patient.formatValues[format.id] : {};

  const wrap = document.createElement("div");
  wrap.className = "formatExpanded";

  // 修正4: titleWrap が空ならカード見出し (format 名) を出さない。QR 出力
  // (composeFormatFromValues) も titleWrap 連動なので、表示と出力が一致する。
  if (typeof format.titleWrap === "string" && format.titleWrap !== "") {
    const head = document.createElement("div");
    head.className = "formatExpandedName";
    head.textContent = format.name;
    wrap.appendChild(head);
  }

  const body = document.createElement("div");
  body.className = "formatCardBody";
  wrap.appendChild(body);

  (format.items || []).forEach((item, i) => {
    body.appendChild(buildCardItemRow(format, item, i, stored, patient));
  });
  return wrap;
}

// カードの 1 行: ラベル + 値表示 (タップで大入力シート) + (text なら) ワンタップ正常。
function buildCardItemRow(format, item, i, stored, patient) {
  const kind = item.kind || DEFAULT_ITEM_KIND;
  const row = document.createElement("div");
  row.className = "formatCardItem";

  const labelText = String(item.label ?? "").trim();
  if (labelText) {
    const lab = document.createElement("div");
    lab.className = "formatCardItemLabel";
    lab.textContent = labelText;
    row.appendChild(lab);
  }

  // 値表示は大きいタップ領域。タップで該当 item にフォーカスした大入力シートを開く (修正3)。
  const valueBtn = document.createElement("button");
  valueBtn.type = "button";
  valueBtn.className = "formatCardValue";
  const disp = cardItemDisplay(format, item, kind, stored[i]);
  if (disp.empty) valueBtn.classList.add("empty");
  valueBtn.textContent = disp.text;
  valueBtn.setAttribute("aria-label", t("format.cell.edit.aria", { label: labelText || format.name }));
  valueBtn.addEventListener("click", () => openFormatSheet(format, format.panel, i));
  row.appendChild(valueBtn);

  // text item で normal があればワンタップの正常チェック (キーボードを出さない)。
  if (kind === "text" && item.normal) {
    const normalBtn = document.createElement("button");
    normalBtn.type = "button";
    normalBtn.className = "formatCardNormalBtn";
    const isNormal = String(stored[i] ?? "") === String(item.normal);
    normalBtn.classList.toggle("on", isNormal);
    normalBtn.title = t("format.normal.tooltip.has", { value: item.normal });
    normalBtn.setAttribute("aria-label", t("common.normal"));
    normalBtn.setAttribute("aria-pressed", isNormal ? "true" : "false");
    normalBtn.innerHTML = CHECK_SVG;
    normalBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      writeFormatValue(patient, format, i, item.normal || "");
      applyFormatTags(format);
      if (_onTextChanged) _onTextChanged(); // 再描画 (カード値更新 + 新カード反映 + QR)
    });
    row.appendChild(normalBtn);
  }
  return row;
}

// formatValues[format.id][itemIndex] へ値を書く小さなヘルパ (保存予約まで)。
function writeFormatValue(patient, format, itemIndex, value) {
  if (!patient.formatValues || typeof patient.formatValues !== "object") patient.formatValues = {};
  if (!patient.formatValues[format.id] || typeof patient.formatValues[format.id] !== "object") {
    patient.formatValues[format.id] = {};
  }
  patient.formatValues[format.id][itemIndex] = value;
  markUpdated(selectedNo);
  scheduleSave();
}

// ============================
// 大入力シート (フォーマット単位) — 修正3
//
// カードの値セル / クイック chip / ☰ ランチャーから開く。フォーマット全 item を大きい
// 入力欄で 1 枚にまとめて出し、タップした item にフォーカスする。draft (formatValues の
// コピー) を編集し、保存で formatValues へ確定 / キャンセルで破棄 / クリアで空に。
// ============================
let _currentSheet = null; // { format, draft }

function openFormatSheet(format, panel, focusIndex) {
  const overlay = document.getElementById("formatInputOverlay");
  const title = document.getElementById("formatInputTitle");
  const body = document.getElementById("formatInputBody");
  if (!overlay || !title || !body) return;

  // 修正4: 入力シートの「患者向けの目立つタイトル表示」も titleWrap に連動させる。
  // titleWrap が空なら見出しを出さない (カードと一致)。文脈は item label / panel と
  // ダイアログの aria-label で担保する。
  const showTitle = typeof format.titleWrap === "string" && format.titleWrap !== "";
  title.textContent = showTitle ? format.name : "";
  title.hidden = !showTitle;
  const menu = overlay.querySelector(".formatInputMenu");
  if (menu) {
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", t("format.cell.edit.aria", { label: format.name }));
  }
  body.textContent = "";
  const allText = (format.items || []).every(it => it && it.kind === "text");
  body.className = "formatInputBody " + (allText ? "text" : "mixed");

  const p = appState.patients[selectedNo - 1];
  const stored = (p?.formatValues?.[format.id] && typeof p.formatValues[format.id] === "object")
    ? p.formatValues[format.id] : {};
  const draft = { ...stored };
  _currentSheet = { format, draft };

  (format.items || []).forEach((item, i) => {
    const kind = item.kind || DEFAULT_ITEM_KIND;
    const opts = { value: draft[i], onInput: (v) => { draft[i] = v; } };
    if (kind === "number") buildNumberRow(body, item, opts);
    else if (kind === "fraction") buildFractionRow(body, item, opts);
    else buildTextRow(body, item, opts);
  });

  overlay.classList.add("active");
  // タップした item の入力欄へフォーカス (手入力をすぐ始められる)。text-only でも
  // 「セルをタップして開いた」= 手入力意図なのでフォーカスして良い。
  setTimeout(() => {
    const rows = body.querySelectorAll(".formatInputRow");
    const target = rows[focusIndex] || rows[0];
    const inp = target && target.querySelector("input, textarea");
    if (inp) inp.focus();
  }, 50);
}

function applyFormatSheet() {
  if (!_currentSheet) { closeFormatSheet(); return; }
  const { format, draft } = _currentSheet;
  const p = appState.patients[selectedNo - 1];
  if (p) {
    if (!p.formatValues || typeof p.formatValues !== "object") p.formatValues = {};
    p.formatValues[format.id] = { ...draft };
    applyFormatTags(format);
    markUpdated(selectedNo);
    scheduleSave();
  }
  closeFormatSheet();
  if (_onTextChanged) _onTextChanged(); // 再描画 (カード反映 + QR)
}

// クリア: シート内の入力を空にする (明示ボタン)。閉じず、保存で確定 / キャンセルで元へ。
// 重要: draft は build*Row の onInput クロージャが参照する「同一オブジェクト」を
// その場で空にする (別オブジェクトに差し替えると、以後の入力が旧 draft に入り、保存で
// 空が確定してしまう — 消去→再入力→保存で再入力が消えるバグになる)。
function clearFormatSheet() {
  if (!_currentSheet) return;
  const draft = _currentSheet.draft;
  for (const k of Object.keys(draft)) delete draft[k];
  const body = document.getElementById("formatInputBody");
  if (body) {
    for (const inp of body.querySelectorAll("input, textarea")) inp.value = "";
  }
  // title 等の文脈は維持。focus は触らない。
}

function closeFormatSheet() {
  const overlay = document.getElementById("formatInputOverlay");
  if (overlay) overlay.classList.remove("active");
  _currentSheet = null;
}

export function closeFormatInputModal() { closeFormatSheet(); }

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

// 短文注記欄 (grid 4 列目)。number/fraction の値の隣に「O2 2L」「RA」等の
// 文脈注記を 1 行で入れる。値とは別フィールドだが患者ごとの入力値。
function buildNoteInput(initial) {
  const noteInp = document.createElement("input");
  noteInp.type = "text";
  noteInp.className = "formatInputMemo";
  noteInp.placeholder = t("format.placeholder.memo");
  setupTextInput(noteInp);
  if (initial) noteInp.value = String(initial);
  return noteInp;
}

// opts: { value, onInput } — value は初期値、onInput(現在値) は入力毎コールバック
// (インライン展開 A の formatValues バインド用)。省略時は従来のモーダル挙動。
// number/fraction の value は { value, note } オブジェクト (旧文字列も読める)。
function buildNumberRow(host, item, opts = {}) {
  const row = document.createElement("div");
  row.className = "formatInputRow number";

  const label = document.createElement("div");
  label.className = "formatInputLabel";
  // ラベルが空の text item (規定文「特に新しい訴えなし」等) はラベル列の余白を残さず
  // 入力本文を左詰めにする (Phase 3 task5)。
  if (!String(item.label ?? "").trim()) label.classList.add("formatInputLabelEmpty");
  label.textContent = item.label;
  row.appendChild(label);

  const { value, note } = readNumericEntry(opts.value);

  const val = document.createElement("input");
  val.className = "formatInputValue";
  setupNumericInput(val, "decimal");
  if (opts.value != null) val.value = value;
  row.appendChild(val);

  // unit セルは常に出す (空 unit でも grid 列を揃える)
  const unit = document.createElement("span");
  unit.className = "formatInputUnit";
  unit.textContent = item.unit || "";
  row.appendChild(unit);

  // 短文注記 (grid 4 列目)。例: SpO2 の酸素投与量。
  const noteInp = buildNoteInput(opts.value != null ? note : "");
  row.appendChild(noteInp);

  if (opts.onInput) {
    const emit = () => opts.onInput({ value: val.value, note: noteInp.value });
    val.addEventListener("input", emit);
    noteInp.addEventListener("input", emit);
  }

  host.appendChild(row);
  return { item, kind: "number", val, note: noteInp };
}

function buildFractionRow(host, item, opts = {}) {
  const row = document.createElement("div");
  row.className = "formatInputRow fraction";

  const label = document.createElement("div");
  label.className = "formatInputLabel";
  // ラベルが空の text item (規定文「特に新しい訴えなし」等) はラベル列の余白を残さず
  // 入力本文を左詰めにする (Phase 3 task5)。
  if (!String(item.label ?? "").trim()) label.classList.add("formatInputLabelEmpty");
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

  // 初期値 "a/b" を numer / denom に分解 (最初の "/" で分割)。note は別欄。
  const { value: fracValue, note } = readNumericEntry(opts.value);
  if (opts.value != null) {
    const s = fracValue;
    const slash = s.indexOf("/");
    if (slash >= 0) { numer.value = s.slice(0, slash); denom.value = s.slice(slash + 1); }
    else numer.value = s;
  }

  row.appendChild(fracGroup);

  const unit = document.createElement("span");
  unit.className = "formatInputUnit";
  unit.textContent = item.unit || "";
  row.appendChild(unit);

  // 短文注記 (grid 4 列目)。例: 抗菌薬の "5/20-" の脇に補足など。
  const noteInp = buildNoteInput(opts.value != null ? note : "");
  row.appendChild(noteInp);

  if (opts.onInput) {
    const emit = () => opts.onInput({ value: `${numer.value}/${denom.value}`, note: noteInp.value });
    numer.addEventListener("input", emit);
    denom.addEventListener("input", emit);
    noteInp.addEventListener("input", emit);
  }

  host.appendChild(row);
  return { item, kind: "fraction", numer, denom, note: noteInp };
}

function buildTextRow(host, item, opts = {}) {
  const row = document.createElement("div");
  row.className = "formatInputRow text";

  const label = document.createElement("div");
  label.className = "formatInputLabel";
  // ラベルが空の text item (規定文「特に新しい訴えなし」等) はラベル列の余白を残さず
  // 入力本文を左詰めにする (Phase 3 task5)。
  if (!String(item.label ?? "").trim()) label.classList.add("formatInputLabelEmpty");
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
  // 正常文を流し込むだけ (focus はしない)。連打してもキーボードが出ず画面が
  // 飛ばないよう、val.focus() を呼ばない (「ぽちぽち正常を押す」体験を壊さない)。
  normalBtn.addEventListener("click", () => {
    val.value = item.normal || "";
    if (opts.onInput) opts.onInput(val.value);
  });
  row.appendChild(normalBtn);
  row.appendChild(val);

  host.appendChild(row);
  return { item, kind: "text", val };
}

// payload.js から呼ぶ: パネルに属する「値が入った全フォーマット」を合成して返す。
// 展開カード・クイック chip・☰ ランチャーのいずれで入力しても formatValues に入るので、
// グループ所属に関わらず settings.formats(panel) のうち値があるものを順に出す。
// group 引数は後方互換のため残すが未使用 (出力はグループ非依存 = 値が正本)。
export function composeExpandedForPanel(panel, _group, formatValues) {
  const fv = (formatValues && typeof formatValues === "object") ? formatValues : {};
  const pieces = [];
  for (const f of formatsForPanel(panel)) {
    const { text, hasValue } = composeFormatFromValues(f, fv[f.id] || {});
    if (hasValue) pieces.push(text);
  }
  return pieces.join("\n");
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

// 項目をドラッグで並び替えた時の確定処理。配列順をそのまま入れ替えて再描画する
// (スキーマ変更なし。出力・展開は items 配列順に従うので順序がそのまま反映される)。
function onFormatItemDrop(fromIdx, toIdx) {
  if (!_currentEdit) return;
  const items = _currentEdit.target.items;
  if (fromIdx < 0 || fromIdx >= items.length) return;
  if (toIdx < 0 || toIdx >= items.length || fromIdx === toIdx) return;
  const [moved] = items.splice(fromIdx, 1);
  items.splice(toIdx, 0, moved);
  const host = document.getElementById("formatEditItems");
  if (host) renderFormatEditItems(host);
}

function renderFormatEditItems(host) {
  host.textContent = "";
  const target = _currentEdit.target;
  for (let i = 0; i < target.items.length; i++) {
    const item = target.items[i];
    const row = document.createElement("div");
    row.className = "formatEditItemRow";

    // 0) ドラッグハンドル (左端)。見える掴み手から並び替え開始。入力欄に触れても
    //    暴発しないよう、ドラッグ開始領域はこのハンドルに限定する。
    const handle = document.createElement("span");
    handle.className = "formatEditItemHandle";
    handle.setAttribute("role", "button");
    handle.setAttribute("tabindex", "0");
    handle.title = t("format.reorderItem.title");
    handle.setAttribute("aria-label", t("format.reorderItem.aria"));
    handle.innerHTML = icon("reorder", 18);
    // 縦1列リスト: axis:"y" (左端ハンドルから縦移動だけで並び替え)
    bindHandleDrag(handle, row, () => i, onFormatItemDrop, "#formatEditItems .formatEditItemRow", { axis: "y" });
    row.appendChild(handle);

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
  const inputClear = document.getElementById("formatInputClearBtn");
  const inputOverlay = document.getElementById("formatInputOverlay");
  if (inputApply) inputApply.addEventListener("click", applyFormatSheet);
  if (inputCancel) inputCancel.addEventListener("click", closeFormatSheet);
  if (inputClear) inputClear.addEventListener("click", clearFormatSheet);
  if (inputOverlay) inputOverlay.addEventListener("click", (e) => {
    if (e.target === inputOverlay) closeFormatSheet();
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
