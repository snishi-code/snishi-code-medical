"use strict";

// ============================================================================
// Tags feature
//
// v7.7+: §3 (TAG GROUPING) は撤去。再実装するなら hospital-rounds-v7.6.1 を参照。
//
// このファイルは「タグ」関連を 5 セクションで扱う。store / DOM への直接アクセス
// は §2〜§4 に閉じる方針 (§5〜§6 が UI 層)。
//
//   §1. CONSTANTS
//        STATUS_TAG_DEFS / isStatusTag / getStatusFromTag
//
//   §2. MODEL: TAG LIST QUERIES
//        getAllTags / getAllFilterEntries / getStatusTagDefs
//
//   §4. MODEL: TAG LIST MUTATIONS & PATIENT TAGS
//        タグ自体の CRUD (addNewTag / renameTagAt / deleteTagAt / moveTag)
//        + 患者単位のアクセサ (getPatientTags / setPatientTags)
//
//   §5. MODEL: SHARED FILTER STATE
//        getSharedTagFilter / setSharedTagFilter /
//        getSharedFilterMode / setSharedFilterMode /
//        patientMatchesSharedFilter (フィルタ適用判定)
//
//   §6. UI
//        §6a. low-level helpers (closeOpenPopup / escapeHtml /
//             buildChipsHtml / entriesToIndex)
//        §6b. public widgets:
//             - makeAddTagWidget (タグ追加 chip)
//             - makeTagPicker (汎用ピッカー: filter / format / etc.)
//             - makePatientTagPicker (患者画面の専用 picker)
//             - makeSharedTagFilterPicker (shared/memo 画面のフィルタピッカー)
// ============================================================================

import { settings, appState, saveSettings, scheduleSave, markUpdated } from "../store.js";
import { STATUS, STATUS_TAG_PREFIX, TAG_FILTER_MODE_AND, TAG_FILTER_MODE_OR, DEFAULT_TAG_FILTER_MODE } from "../constants.js";
import { t } from "../i18n.js";

// ============================================================================
// §1. CONSTANTS
// ============================================================================

const TAG_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;

const AND_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/><path d="M9 6.6 a6 6 0 0 1 0 10.8 a6 6 0 0 1 0 -10.8 z" fill="currentColor" stroke="none" transform="translate(3 0)"/></svg>`;
const OR_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.85" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>`;

// Status virtual tags exposed in filter pickers (palette kept in sync with style.css)
// ステータス色のメタ。label は t() を遅延参照する getter にして、起動時の文字列
// キャプチャによる "locale 切替が効かない" 問題を回避する。
const STATUS_TAG_DEFS = [
  { value: STATUS_TAG_PREFIX + STATUS.NONE,   get label() { return t("tagStatus.none"); },   color: "#ffffff", borderColor: "#9ca3af" },
  { value: STATUS_TAG_PREFIX + STATUS.YELLOW, get label() { return t("tagStatus.yellow"); }, color: "#f59e0b", borderColor: "#b45309" },
  { value: STATUS_TAG_PREFIX + STATUS.GREEN,  get label() { return t("tagStatus.green"); },  color: "#14b8a6", borderColor: "#0f766e" },
  { value: STATUS_TAG_PREFIX + STATUS.GRAY,   get label() { return t("tagStatus.gray"); },   color: "#6b7280" },
  { value: STATUS_TAG_PREFIX + STATUS.BLUE,   get label() { return t("tagStatus.blue"); },   color: "#2563eb", borderColor: "#1e3a8a" },
];

// 色覚多様性対応: ステータスを「色だけ」でなく形マークでも示す。各色に 1:1 の記号を
// 割り当てる正準マッピング (CLAUDE.md にも明記)。形は互いに明確に異なるものを選ぶ。
// 青は ★ (＋ は十字ルール違反 + 視認性が悪いため v8.4 で変更)。NONE は無印。i18n 対象外。
const STATUS_TAG_MARK = {
  [STATUS.NONE]: "−",
  [STATUS.YELLOW]: "▲",
  [STATUS.GREEN]: "✓",
  [STATUS.GRAY]: "✕",
  [STATUS.BLUE]: "★",
};

export function isStatusTag(value) {
  return typeof value === "string" && value.startsWith(STATUS_TAG_PREFIX);
}

export function getStatusFromTag(value) {
  return isStatusTag(value) ? value.slice(STATUS_TAG_PREFIX.length) : "";
}

export function getStatusTagMark(value) {
  return STATUS_TAG_MARK[getStatusFromTag(value)] || "";
}

// 生のステータス値 (STATUS.YELLOW 等) → 形マーク。色盲対応で「色だけに依存しない」
// ために、色記号の単一ソース (STATUS_TAG_MARK) からそのまま引く。
export function getStatusMark(status) {
  return STATUS_TAG_MARK[status] || "";
}

// ステータス選択ポップアップ用の選択肢 (色 + 枠 + ラベル + 形マーク)。
// STATUS_TAG_DEFS と STATUS_TAG_MARK を単一ソースに、患者画面のステータス選択で使う。
export function getStatusOptions() {
  return STATUS_TAG_DEFS.map(d => {
    const status = getStatusFromTag(d.value);
    return {
      status,
      label: d.label,
      color: d.color,
      borderColor: d.borderColor || d.color,
      mark: STATUS_TAG_MARK[status] || "",
    };
  });
}

// ============================================================================
// §2. MODEL: TAG LIST QUERIES
// ============================================================================

// User-defined tags only (no virtual status tags)
export function getAllTags() {
  return Array.isArray(settings.tags)
    ? settings.tags.filter(d => typeof d === "string" && d.trim()).map(d => d.trim())
    : [];
}

// For filter pickers: user tags + virtual status tags
export function getAllFilterEntries() {
  const userTags = getAllTags().map(t => ({ value: t, label: t }));
  return [...userTags, ...STATUS_TAG_DEFS];
}

export function getStatusTagDefs() { return STATUS_TAG_DEFS.slice(); }

// v7.7+: §3 TAG GROUPING (タグ・カテゴリ機能) 撤去。設定モデル上の
// tagGroupingEnabled / tagGroups / tagGroupAssign は normalizeSettings の
// forward compat (未知フィールド温存) で旧 bundle から拾えるが、UI は無し。
// 再実装するなら git tag hospital-rounds-v7.6.1 を参照。

// ============================================================================
// §4. MODEL: TAG LIST MUTATIONS & PATIENT TAGS
// ============================================================================

export function getPatientTags(patientIndex) {
  const p = appState.patients[patientIndex];
  if (!p) return [];
  return Array.isArray(p.tags) ? p.tags.slice() : [];
}

// Add/remove a tag at the settings level (idempotent, no duplicates).
// Returns true if added, false if duplicate or invalid.
export function addNewTag(name) {
  const t = String(name || "").trim();
  if (!t) return false;
  if (!Array.isArray(settings.tags)) settings.tags = [];
  if (settings.tags.includes(t)) return false;
  settings.tags.push(t);
  saveSettings();
  return true;
}

export function renameTagAt(idx, newName) {
  if (!Array.isArray(settings.tags) || idx < 0 || idx >= settings.tags.length) return false;
  const oldName = settings.tags[idx];
  const next = String(newName || "").trim();
  if (!next) return false;
  if (oldName === next) return true;
  if (settings.tags.includes(next)) return false; // duplicate
  settings.tags[idx] = next;
  // Sync to all patients
  for (const p of appState.patients) {
    if (Array.isArray(p.tags)) {
      p.tags = p.tags.map(t => t === oldName ? next : t);
    }
  }
  saveSettings();
  scheduleSave();
  return true;
}

export function deleteTagAt(idx) {
  if (!Array.isArray(settings.tags) || idx < 0 || idx >= settings.tags.length) return;
  const name = settings.tags[idx];
  settings.tags.splice(idx, 1);
  // Remove tag from all patients
  for (const p of appState.patients) {
    if (Array.isArray(p.tags) && p.tags.includes(name)) {
      p.tags = p.tags.filter(t => t !== name);
    }
  }
  saveSettings();
  scheduleSave();
}

export function moveTag(fromIdx, toIdx) {
  if (!Array.isArray(settings.tags)) return;
  if (fromIdx === toIdx) return;
  if (fromIdx < 0 || fromIdx >= settings.tags.length) return;
  if (toIdx < 0 || toIdx >= settings.tags.length) return;
  const [t] = settings.tags.splice(fromIdx, 1);
  settings.tags.splice(toIdx, 0, t);
  saveSettings();
  // Tag order change doesn't need its own op type; recipients use admin sync if needed.
}

export function setPatientTags(patientIndex, tags) {
  const p = appState.patients[patientIndex];
  if (!p) return;
  const next = tags.slice();
  p.tags = next;
  markUpdated(patientIndex + 1);
  scheduleSave();
}

// ============================================================================
// §5. MODEL: SHARED FILTER STATE (cross-screen filter)
// ============================================================================

let _sharedTagFilter = []; // entries from getAllFilterEntries() values (incl. status tags)
let _sharedFilterMode = DEFAULT_TAG_FILTER_MODE;

export function getSharedTagFilter() { return _sharedTagFilter.slice(); }
export function setSharedTagFilter(tags) { _sharedTagFilter = tags.slice(); }
export function getSharedFilterMode() { return _sharedFilterMode; }
export function setSharedFilterMode(mode) {
  _sharedFilterMode = (mode === TAG_FILTER_MODE_OR) ? TAG_FILTER_MODE_OR : TAG_FILTER_MODE_AND;
}

function patientFilterValues(p) {
  const out = Array.isArray(p.tags) ? p.tags.slice() : [];
  out.push(STATUS_TAG_PREFIX + (p.status || STATUS.NONE));
  return out;
}

export function patientMatchesSharedFilter(p) {
  if (!_sharedTagFilter.length) return true;
  const have = new Set(patientFilterValues(p));
  if (_sharedFilterMode === TAG_FILTER_MODE_OR) {
    return _sharedTagFilter.some(t => have.has(t));
  }
  return _sharedTagFilter.every(t => have.has(t));
}

// ============================================================================
// §6a. UI: low-level helpers
// (popup open 状態管理 / chip HTML 生成 / group section レンダ)
// ============================================================================

let _openPopup = null;
// When the user toggles a tag inside the popup we defer the screen re-render
// until the popup actually closes—otherwise the parent screen recreates the
// picker and the popup snaps shut on every tap.
let _pendingOnChange = null;
function closeOpenPopup() {
  if (_openPopup) {
    _openPopup.style.display = "none";
    _openPopup = null;
  }
  if (_pendingOnChange) {
    const fn = _pendingOnChange;
    _pendingOnChange = null;
    try { fn(); } catch (e) { console.error(e); }
  }
}
// Node 環境 (テスト) には document が無いため defensive check
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (!_openPopup) return;
    const wrap = _openPopup.closest(".tagPicker");
    if (wrap && !wrap.contains(e.target)) closeOpenPopup();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" })[c]);
}

function buildChipsHtml(selected, entriesIndex) {
  if (!selected || !selected.length) {
    return `<span class="tagPickerIcon">${TAG_SVG}</span>`;
  }
  const safe = selected.map(v => {
    const e = entriesIndex.get(v) || { label: v };
    if (e.color) {
      // ステータスチップ: 文字 (黄/緑…) は出さず、色 + 形マークで示す (色覚対応)
      const mark = getStatusTagMark(v);
      const fg = e.color === '#ffffff' ? '#111' : '#fff';
      return `<span class="tagChip statusChip" title="${escapeHtml(e.label)}" style="background:${e.color};border-color:${e.borderColor || e.color};color:${fg};">${escapeHtml(mark)}</span>`;
    }
    return `<span class="tagChip">${escapeHtml(e.label)}</span>`;
  }).join("");
  return `<span class="tagPickerIcon">${TAG_SVG}</span>${safe}`;
}

function entriesToIndex(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.value, e);
  return m;
}

// v7.7+: buildGroupSection / グルーピング描画ロジック撤去。
// 旧 makeTagPicker の grouped オプションも下記で使われなくなった。

// opts: { getSelected, setSelected, entries: [{value,label,color?}], onChange, fillWidth, withModeToggle, includeStatus, forPatient }

// ============================================================================
// §6b. UI: public widgets
// ============================================================================

// 「+ 新規タグ」ウィジェット（設定画面・各タグピッカー popup 共通）
//
// 既定: 小さい「+」ボタン (.tagSettingAdd と同じ見た目)
// タップ: その場が入力欄つきチップ (.tagSettingChip.editing) に差し替わる
// 入力後の挙動:
//   - Enter または別の場所をタップ (blur) で commit
//   - 空 commit や Escape はキャンセル扱いで「+」表示に戻る
//   - 既存タグと同名なら alert で通知し、入力チップを閉じる
// commit 成功時は onAdded(name) を呼ぶ（呼び元で popup や一覧を再描画）。
export function makeAddTagWidget({ onAdded } = {}) {
  const wrap = document.createElement("span");
  let activeInput = null; // 多重 commit/再描画ガード

  function showButton() {
    activeInput = null;
    wrap.className = "tagAddWidget";
    wrap.textContent = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tagSettingAdd";
    btn.title = t("tag.add.title");
    btn.setAttribute("aria-label", t("tag.add.aria"));
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showInput();
    });
    wrap.appendChild(btn);
  }

  function showInput() {
    wrap.className = "tagAddWidget tagSettingChip editing";
    wrap.textContent = "";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "tagSettingInput";
    inp.placeholder = t("tag.placeholder");
    activeInput = inp;
    let done = false;
    function finalize(commit) {
      if (done) return;
      done = true;
      const name = String(inp.value || "").trim();
      if (commit && name) {
        if (addNewTag(name)) {
          showButton();
          if (onAdded) onAdded(name);
          return;
        }
        alert(t("tag.exists"));
      }
      showButton();
    }
    inp.addEventListener("blur", () => finalize(true));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finalize(true); }
      else if (e.key === "Escape") { e.preventDefault(); finalize(false); }
    });
    // 親 popup の document click ハンドラに拾われて popup ごと閉じないように
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("mousedown", (e) => e.stopPropagation());
    wrap.appendChild(inp);
    setTimeout(() => inp.focus(), 0);
  }

  showButton();
  return wrap;
}

export function makeTagPicker(opts) {
  const {
    getSelected,
    setSelected,
    entries,
    onChange,
    fillWidth = false,
    withModeToggle = false,
    grouped = false,           // group sections when true (forces grouping mode)
    forPatient = false,        // patient picker: hide status group entirely
    iconOnly = false,          // trigger に選択チップを出さず、アイコンだけ表示する
    iconHtml = null,           // iconOnly のときに使う SVG 文字列 (省略時は TAG_SVG)
    addWidget = null,          // (onAddedCb) => element. 省略時は makeAddTagWidget
    onItemClick = null,        // (entry) => void. 指定時は名前タップで popup を閉じてこれを呼ぶ
                               //                  (checkbox はそのままお気に入りトグル)
    launcher = false,          // launcher モード: checkbox 無し。行全体タップで popup を
                               //                  閉じて onItemClick。getSelected/setSelected 不要
  } = opts;

  // 追加ウィジェット (タグ用は makeAddTagWidget、フォーマット用は外から差し替え可能)
  const buildAddWidget = (onAddedCb) => {
    if (addWidget) return addWidget(onAddedCb);
    return makeAddTagWidget({ onAdded: onAddedCb });
  };

  const wrap = document.createElement("div");
  wrap.className = "tagPicker";
  if (fillWidth) wrap.classList.add("tagPickerFill");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "tagPickerTrigger";

  const popup = document.createElement("div");
  popup.className = "tagPickerPopup";
  popup.style.display = "none";

  function refreshTrigger() {
    const selected = launcher ? [] : (getSelected() || []);
    const list = (typeof entries === "function" ? entries() : entries) || [];
    if (iconOnly) {
      const hasAny = !launcher && selected.length > 0;
      const svg = iconHtml || TAG_SVG;
      trigger.innerHTML = `<span class="tagPickerIcon" style="color:${hasAny ? '#2563eb' : 'var(--muted)'};">${svg}</span>`;
      trigger.classList.toggle("hasSelected", hasAny);
    } else {
      trigger.innerHTML = buildChipsHtml(selected, entriesToIndex(list));
    }
  }

  function refreshPopup() {
    popup.textContent = "";
    // フィルタ用ピッカー: かつ/または のモードトグルは撤去 (AND 固定で直感的に)。
    // 選択クリアのみ短文ボタンで残す。(v8.4)
    if (withModeToggle) {
      const modeRow = document.createElement("div");
      modeRow.className = "tagPickerModeRow";
      const clr = document.createElement("button");
      clr.type = "button";
      clr.className = "tagPickerClearBtn";
      clr.textContent = t("tag.filter.clear.label");
      clr.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!getSelected().length) return;
        setSelected([]);
        refreshPopup();
        refreshTrigger();
        if (onChange) _pendingOnChange = onChange;
      });
      modeRow.appendChild(clr);
      popup.appendChild(modeRow);
    }

    const list = (typeof entries === "function" ? entries() : entries) || [];
    if (!list.length) {
      // 既存タグが無い場合も「タグ未登録」のような空状態文言は出さず、
      // 設定画面と同じく「+」だけ並べる
      popup.appendChild(buildAddWidget(() => { refreshPopup(); refreshTrigger(); }));
      return;
    }
    // launcher モード: checkbox 無しの一覧。行全体タップで onItemClick。
    if (launcher) {
      for (const e of list) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tagPickerOpt tagPickerLauncherOpt";
        const txt = document.createElement("span");
        txt.className = "tagPickerOptName";
        txt.textContent = e.label;
        row.appendChild(txt);
        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          closeOpenPopup();
          if (onItemClick) onItemClick(e);
        });
        popup.appendChild(row);
      }
      popup.appendChild(buildAddWidget(() => { refreshPopup(); refreshTrigger(); }));
      return;
    }
    // v8.11: チェックボックス縦並び → チップ・トグル。タップで選択 ON/OFF (選択中=青)。
    // 設定画面のタグ chip と同じ pill 見た目で統一。ステータスは記号チップを横並びに。
    const current = new Set(getSelected());
    const buildSelChip = (e) => {
      const chip = document.createElement("button");
      chip.type = "button";
      const sel = current.has(e.value);
      chip.className = "tagSelChip" + (e.color ? " statusChip" : "") + (sel ? " selected" : "");
      if (e.color) {
        // Status: 色 swatch に形マーク (色＋形の2軸で色覚対応)
        const sw = document.createElement("span");
        sw.className = "tagSelChipSwatch";
        const fg = e.color === "#ffffff" ? "#111" : "#fff";
        sw.style.cssText = `background:${e.color};border-color:${e.borderColor || "rgba(0,0,0,.25)"};color:${fg};`;
        sw.textContent = getStatusTagMark(e.value);
        chip.appendChild(sw);
      } else {
        chip.textContent = e.label;
      }
      chip.title = e.label;
      chip.setAttribute("aria-label", e.label);
      chip.setAttribute("aria-pressed", sel ? "true" : "false");
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const nowSel = chip.classList.toggle("selected");
        chip.setAttribute("aria-pressed", nowSel ? "true" : "false");
        const next = new Set(getSelected());
        if (nowSel) next.add(e.value); else next.delete(e.value);
        setSelected(Array.from(next));
        refreshTrigger();
        if (onChange) _pendingOnChange = onChange;
      });
      return chip;
    };

    const statusEntries = list.filter(e => e.color);
    const tagEntries = list.filter(e => !e.color);
    if (statusEntries.length) {
      const srow = document.createElement("div");
      srow.className = "tagPickerChipRow tagPickerStatusRow";
      for (const e of statusEntries) srow.appendChild(buildSelChip(e));
      popup.appendChild(srow);
    }
    const trow = document.createElement("div");
    trow.className = "tagPickerChipRow";
    for (const e of tagEntries) trow.appendChild(buildSelChip(e));
    trow.appendChild(buildAddWidget(() => { refreshPopup(); refreshTrigger(); }));
    popup.appendChild(trow);
  }

  // launcher (= フォーマット ☰) は overflow:hidden の card 内に置かれるため、
  // position:absolute だと下半分が card にクリップされてスクロールできない。
  // fixed にして祖先の overflow から抜け出し、trigger 基準で配置する。
  function positionLauncherPopup() {
    const tr = trigger.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    popup.style.position = "fixed";
    popup.style.left = "auto";
    popup.style.right = Math.max(8, vw - tr.right) + "px";
    const below = vh - tr.bottom - 8;
    const above = tr.top - 8;
    if (below >= 160 || below >= above) {
      popup.style.top = (tr.bottom + 4) + "px";
      popup.style.bottom = "auto";
      popup.style.maxHeight = Math.max(120, Math.min(360, below)) + "px";
    } else {
      popup.style.top = "auto";
      popup.style.bottom = (vh - tr.top + 4) + "px";
      popup.style.maxHeight = Math.max(120, Math.min(360, above)) + "px";
    }
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const showing = popup.style.display !== "none";
    closeOpenPopup();
    if (!showing) {
      refreshPopup();
      popup.style.display = "";
      if (launcher) positionLauncherPopup();
      _openPopup = popup;
    }
  });

  refreshTrigger();
  wrap.appendChild(trigger);
  wrap.appendChild(popup);
  return wrap;
}

// Patient tag picker: user-defined tags only (no status virtual tags)
export function makePatientTagPicker(patientIndex, onChange) {
  return makeTagPicker({
    getSelected: () => getPatientTags(patientIndex),
    setSelected: (tags) => setPatientTags(patientIndex, tags),
    entries: () => getAllTags().map(t => ({ value: t, label: t })),
    onChange,
    grouped: true,
    forPatient: true,
    // 患者ピッカーは選択タグを外側 (inlineTagsRow) に出すので、トリガーは
    // アイコンのみ。チップが二重に出ないようにする。
    iconOnly: true,
  });
}

// Shared filter picker: user tags + status virtual tags + AND/OR toggle (when not grouped)
export function makeSharedTagFilterPicker(onChange) {
  return makeTagPicker({
    getSelected: getSharedTagFilter,
    setSelected: setSharedTagFilter,
    entries: getAllFilterEntries,
    onChange,
    withModeToggle: true,
    grouped: true,
    forPatient: false,
  });
}
