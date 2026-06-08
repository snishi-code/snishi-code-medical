"use strict";

// ============================
// フォーマットグループ
//
// データモデル:
//   settings.formatGroups = [
//     { id: "grp_xxx", name: "発熱対応", formatIds: ["fmt_a", "fmt_b", ...] }
//   ]
//   patient.activeFormatGroupId = "" | "grp_xxx"
//
// 挙動:
//   - 患者画面のヘッダーの「束」アイコン → グループピッカーが開く
//   - 通常 / 各グループ から単選択。選んだものが patient.activeFormatGroupId に保存
//   - active なグループがあると、各パネルの strip の pin チップが「グループ内の
//     フォーマット (panel フィルタ済) 」だけに置き換わる (お気に入りの動的切替)
//   - グループ間で formats は重複可。同じフォーマットを複数グループに入れて OK
//   - 各グループ間で順序が保たれる (formatIds の並び順がそのまま strip の順序)
//   - 設定画面に「グループ」セクションを設け、新規追加・編集・削除を行う
// ============================

import { settings, appState, selectedNo, saveSettings, markUpdated, scheduleSave } from "../store.js";
import { FORMAT_PANELS } from "../constants.js";
import { openQrSetOverlay } from "./qr-set.js";
import {
  isLastExpandInPanel, missingExpandPanelsForGroup, repairGroupExpandInvariant,
} from "./format-values.js";
import { t } from "../i18n.js";

// 展開フォーマット不変条件のヘルパは pure データ層 (format-values.js) が正本。
// 仕様上「format-groups.js から参照できる」ことを満たすため、ここから re-export する。
export {
  panelFormatsInGroup, groupHasExpandForPanel, missingExpandPanelsForGroup,
  validateGroupHasExpandedFormatForEveryPanel, isLastExpandInPanel,
  formatRemovalBreaksAnyGroupExpand, repairGroupExpandInvariant,
} from "./format-values.js";

function newGroupId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return "grp_" + crypto.randomUUID().slice(0, 8);
  return "grp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function getAllFormatGroups() {
  return Array.isArray(settings.formatGroups) ? settings.formatGroups.slice() : [];
}

export function getFormatGroupById(id) {
  if (!id) return null;
  return getAllFormatGroups().find(g => g.id === id) || null;
}

// 起動時に必ず 1 つ存在するデフォルトグループ (isDefault=true)。万一見つからない
// (壊れたデータ等) 場合は先頭グループ、無ければ null。
export function getDefaultFormatGroup() {
  const groups = getAllFormatGroups();
  return groups.find(g => g.isDefault) || groups[0] || null;
}

// 患者に適用される実効グループ: activeFormatGroupId があればそれ、無ければ
// (= 通常状態) デフォルトグループに解決する。strip / 規定文 の両方がこれを使う。
export function resolveActiveGroup(patient) {
  const id = String(patient?.activeFormatGroupId || "");
  if (id) {
    const g = getFormatGroupById(id);
    if (g) return g;
  }
  return getDefaultFormatGroup();
}

// 現在開いている患者の active group に応じて、ヘッダー上のトグルボタンの
// 表示 (グループ名 or 「通常」) と active styling を更新する。
// 詳細画面の renderDetail から呼ばれる。
export function refreshFormatGroupToggle() {
  const btn = document.getElementById("detailFormatGroupBtn");
  const lbl = document.getElementById("detailFormatGroupLabel");
  if (!btn || !lbl) return;
  const p = appState.patients[selectedNo - 1];
  const g = resolveActiveGroup(p);
  if (!g) {
    // グループが 1 つも無い異常時のみ (通常はデフォルトグループが必ず存在)
    lbl.textContent = t("formatGroup.option.none.label");
    btn.classList.remove("active");
    btn.title = t("formatGroup.toggle.title");
    return;
  }
  lbl.textContent = g.name;
  // デフォルト以外を明示選択している時だけ「上書き中」スタイルを当てる
  const override = !g.isDefault;
  btn.classList.toggle("active", override);
  btn.title = override
    ? t("formatGroup.toggle.active.title", { name: g.name })
    : t("formatGroup.toggle.title");
}

// ============================
// 患者画面: ピッカー (この患者の active group を選ぶ)
// ============================
let _onPickedCb = null;

export function openFormatGroupPicker(onPicked) {
  _onPickedCb = onPicked || null;
  const overlay = document.getElementById("formatGroupPickerOverlay");
  if (!overlay) return;
  renderPickerList();
  overlay.classList.add("active");
}

function closePicker() {
  const overlay = document.getElementById("formatGroupPickerOverlay");
  if (overlay) overlay.classList.remove("active");
  _onPickedCb = null;
}

function renderPickerList() {
  const host = document.getElementById("formatGroupPickerList");
  if (!host) return;
  host.textContent = "";
  const p = appState.patients[selectedNo - 1];
  const groups = getAllFormatGroups();

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "formatGroupPickerEmpty";
    empty.textContent = t("formatGroup.picker.empty");
    host.appendChild(empty);
    return;
  }

  // 実効選択 = activeFormatGroupId、未指定ならデフォルトグループ。デフォルト or
  // 選択中の行を再タップすると "" (= デフォルトに従う) に戻る。
  const defaultGroup = getDefaultFormatGroup();
  const currentId = String(p?.activeFormatGroupId || "") || (defaultGroup ? defaultGroup.id : "");
  for (const g of groups) {
    host.appendChild(buildPickerRow({
      id: g.id,
      name: g.name,
      isDefault: !!g.isDefault,
      selected: g.id === currentId,
    }));
  }
}

function buildPickerRow({ id, name, isDefault, selected, sub }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "formatGroupPickerRow" + (selected ? " selected" : "") + (isDefault ? " isDefault" : "");
  const head = document.createElement("div");
  head.className = "formatGroupPickerHead";
  const lbl = document.createElement("div");
  lbl.className = "formatGroupPickerName";
  lbl.textContent = name;
  head.appendChild(lbl);
  if (isDefault) {
    const badge = document.createElement("span");
    badge.className = "formatGroupDefaultBadge";
    badge.textContent = t("formatGroup.defaultBadge");
    head.appendChild(badge);
  }
  row.appendChild(head);
  if (sub) {
    const s = document.createElement("div");
    s.className = "formatGroupPickerSub";
    s.textContent = sub;
    row.appendChild(s);
  }
  row.addEventListener("click", () => {
    const p = appState.patients[selectedNo - 1];
    if (p) {
      // デフォルトグループ / 選択中の行を再タップ → "" (= デフォルトに従う)。
      // それ以外は明示選択。
      const newId = (isDefault || selected) ? "" : String(id || "");
      // グループ切替で patient.formatValues は触らない (formatId キーで非揮発に保持され、
      // 戻せば同じ値が再表示される)。旧実装は見えない自由記述へ流し込んでいたが、
      // 自由記述欄を撤去した (修正2) ため「見えない場所へデータを逃がす」ことになる。
      // 値は維持し、出力は「値が入った全フォーマット」を payload が拾う。
      p.activeFormatGroupId = newId;
      markUpdated(selectedNo);
      scheduleSave();
    }
    const cb = _onPickedCb;
    closePicker();
    if (cb) cb();
  });
  return row;
}

// ============================
// 設定画面: グループ CRUD UI
// ============================
let _currentEdit = null; // { isNew, target, onSaved }

export function startNewFormatGroup(onSaved) {
  _currentEdit = {
    isNew: true,
    target: { id: newGroupId(), name: "", isDefault: false, formatIds: [], defaultFormatIds: [], expandFormatIds: [] },
    onSaved,
  };
  openEditModal();
}

export function startEditFormatGroup(group, onSaved) {
  _currentEdit = {
    isNew: false,
    target: {
      id: group.id,
      name: String(group.name || ""),
      isDefault: !!group.isDefault,
      formatIds: Array.isArray(group.formatIds) ? group.formatIds.slice() : [],
      defaultFormatIds: Array.isArray(group.defaultFormatIds) ? group.defaultFormatIds.slice() : [],
      expandFormatIds: Array.isArray(group.expandFormatIds) ? group.expandFormatIds.slice() : [],
    },
    onSaved,
  };
  openEditModal();
}

// デフォルトグループは削除不可 (必ず 1 つ存在の不変条件)。呼び出し側 (settings-view)
// は default 行の削除ボタンを無効化するが、防御的にここでも弾く。削除できたら true。
export function deleteFormatGroupById(id) {
  if (!Array.isArray(settings.formatGroups)) return false;
  const g = settings.formatGroups.find(x => x.id === id);
  if (!g || g.isDefault) return false;
  settings.formatGroups = settings.formatGroups.filter(x => x.id !== id);
  // 各患者の activeFormatGroupId からも掃除 ("" = デフォルトに従う)
  for (const p of appState.patients) {
    if (p.activeFormatGroupId === id) p.activeFormatGroupId = "";
  }
  saveSettings();
  return true;
}

function openEditModal() {
  const overlay = document.getElementById("formatGroupEditOverlay");
  if (!overlay || !_currentEdit) return;
  const title = document.getElementById("formatGroupEditTitle");
  if (title) {
    title.textContent = t(_currentEdit.isNew ? "formatGroup.edit.title.new" : "formatGroup.edit.title.edit");
  }
  const nameInp = document.getElementById("formatGroupEditName");
  if (nameInp) nameInp.value = _currentEdit.target.name;
  const defChk = document.getElementById("formatGroupEditIsDefault");
  if (defChk) {
    defChk.checked = !!_currentEdit.target.isDefault;
    // 現在のデフォルトは直接「外す」ことはできない (別グループを default にすると
    // 自動的に外れる)。誤って唯一の default を消さないよう disabled にする。
    defChk.disabled = !!_currentEdit.target.isDefault;
  }
  renderFormatsCheckList();
  overlay.classList.add("active");
  if (nameInp) setTimeout(() => nameInp.focus(), 50);
}

function closeEditModal() {
  const overlay = document.getElementById("formatGroupEditOverlay");
  if (overlay) overlay.classList.remove("active");
  _currentEdit = null;
}

function renderFormatsCheckList() {
  const host = document.getElementById("formatGroupEditFormats");
  if (!host || !_currentEdit) return;
  host.textContent = "";
  const all = Array.isArray(settings.formats) ? settings.formats : [];
  // panel ごとにグルーピングして見せる (S/O/A/P)
  for (const panel of FORMAT_PANELS) {
    const inPanel = all.filter(f => f.panel === panel);
    if (!inPanel.length) continue;
    const sec = document.createElement("div");
    sec.className = "formatGroupEditSection";
    const head = document.createElement("div");
    head.className = "formatGroupEditSectionHead";
    head.textContent = t("format.panelSection", { panel: t("panel." + panel) });
    sec.appendChild(head);
    for (const f of inPanel) sec.appendChild(buildGroupFormatRow(f, panel));
    host.appendChild(sec);
  }
  if (!host.children.length) {
    const empty = document.createElement("div");
    empty.className = "formatGroupPickerEmpty";
    empty.textContent = t("formatGroup.edit.noFormats");
    host.appendChild(empty);
  }
}

// グループ編集内の 1 フォーマット行: 左に「束ねる」チェック、include 時は右に
// 「規定文」トグル (空欄補完に使う。パネル毎 最大 1 つ = 排他)。
function buildGroupFormatRow(f, panel) {
  const target = _currentEdit.target;
  const included = target.formatIds.includes(f.id);
  const row = document.createElement("div");
  row.className = "formatGroupEditOpt" + (included ? " included" : "");

  const lab = document.createElement("label");
  lab.className = "formatGroupEditOptMain";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = included;
  cb.addEventListener("change", () => {
    if (cb.checked) {
      if (!target.formatIds.includes(f.id)) target.formatIds.push(f.id);
    } else {
      // 修正1: そのパネルの「最後の展開フォーマット」をセットから外すのは不可。
      // (外すと S/O/A/P のどれかにワンタップ入力カードが無くなる)
      if (isLastExpandInPanel(target, settings.formats, f.id, panel)) {
        cb.checked = true;
        alert(t("formatGroup.expand.lastBlocked", { panel: t("panel." + panel) }));
        return;
      }
      target.formatIds = target.formatIds.filter(x => x !== f.id);
      target.defaultFormatIds = target.defaultFormatIds.filter(x => x !== f.id);
      target.expandFormatIds = (target.expandFormatIds || []).filter(x => x !== f.id);
    }
    renderFormatsCheckList();
  });
  const nm = document.createElement("span");
  nm.textContent = f.name;
  lab.appendChild(cb);
  lab.appendChild(nm);
  row.appendChild(lab);

  if (included) {
    // 表示方法を 2 択セグメントで選ぶ: 展開(A) / クイック(B)。
    //   展開   = expandFormatIds に入れる (本文上に常時カード = ワンタップ入力面)
    //   クイック = どちらにも入れない (ヘッダーのチップ。タップで入力モーダル)
    // 旧「規定文」(defaultFormatIds による空欄補完) は QR fallback 撤去で挙動が無く
    // なったため日常導線から外した。データ層 (defaultFormatIds) と QR wire は forward-compat
    // のため温存し、ここでは出さない。既存の規定文データはクイック扱いで表示し、表示方法を
    // 触ると下の setMode が defaultFormatIds から外して整理する (P5 P1)。
    if (!Array.isArray(target.expandFormatIds)) target.expandFormatIds = [];
    const mode = target.expandFormatIds.includes(f.id) ? "expand" : "quick";
    const setMode = (next) => {
      // 修正1: そのパネルの「最後の展開フォーマット」を quick へ落とすのは不可。
      if (next !== "expand" && isLastExpandInPanel(target, settings.formats, f.id, panel)) {
        alert(t("formatGroup.expand.lastBlocked", { panel: t("panel." + panel) }));
        return;
      }
      target.expandFormatIds = target.expandFormatIds.filter(x => x !== f.id);
      // 旧「規定文」割当が残っていたら、表示方法を触ったタイミングで整理する。
      target.defaultFormatIds = target.defaultFormatIds.filter(x => x !== f.id);
      if (next === "expand") target.expandFormatIds.push(f.id);
      renderFormatsCheckList();
    };
    const seg = document.createElement("div");
    seg.className = "formatGroupModeSeg";
    for (const [key, label, title] of [
      ["expand", t("formatGroup.mode.expand"), t("formatGroup.mode.expand.title")],
      ["quick",  t("formatGroup.mode.quick"),  t("formatGroup.mode.quick.title")],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "formatGroupModeBtn" + (mode === key ? " active" : "");
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-pressed", mode === key ? "true" : "false");
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setMode(key); });
      seg.appendChild(b);
    }
    row.appendChild(seg);
  }
  return row;
}

function saveEdit() {
  if (!_currentEdit) { closeEditModal(); return; }
  const nameInp = document.getElementById("formatGroupEditName");
  const name = String(nameInp?.value || "").trim();
  if (!name) {
    alert(t("formatGroup.name.required"));
    return;
  }
  const target = _currentEdit.target;
  target.name = name;
  // デフォルト指定 (disabled で来る = 現デフォルトは true 固定)
  const defChk = document.getElementById("formatGroupEditIsDefault");
  target.isDefault = !!defChk?.checked;
  // defaultFormatIds / expandFormatIds は formatIds の部分集合に正規化
  target.defaultFormatIds = (target.defaultFormatIds || []).filter(id => target.formatIds.includes(id));
  target.expandFormatIds = (target.expandFormatIds || []).filter(id => target.formatIds.includes(id));
  // 修正1: 防御的に不変条件を補修 (含むパネルで expand が欠けていたら先頭を昇格)。
  // UI のブロックを擦り抜けた場合や、含むパネルに 1 つも expand を選ばず保存した場合の救済。
  repairGroupExpandInvariant(target, settings.formats);
  // 同名チェック
  const all = Array.isArray(settings.formatGroups) ? settings.formatGroups : [];
  const dup = all.find(g => g.id !== target.id && g.name === name);
  if (dup) {
    alert(t("formatGroup.name.duplicate"));
    return;
  }
  if (_currentEdit.isNew) {
    if (!Array.isArray(settings.formatGroups)) settings.formatGroups = [];
    settings.formatGroups.push(target);
  } else {
    const idx = all.findIndex(g => g.id === target.id);
    if (idx >= 0) settings.formatGroups[idx] = target;
    else settings.formatGroups.push(target);
  }
  // 「ちょうど 1 つ default」を担保: target が default なら他を全て解除。
  // 解除操作で default が 0 件になった場合は先頭を昇格。
  if (target.isDefault) {
    for (const g of settings.formatGroups) if (g.id !== target.id) g.isDefault = false;
  } else if (!settings.formatGroups.some(g => g.isDefault) && settings.formatGroups.length) {
    settings.formatGroups[0].isDefault = true;
  }
  saveSettings();
  const cb = _currentEdit.onSaved;
  closeEditModal();
  if (cb) cb(target);
}

// ============================
// 配線 (DOM ready 後 main.js から)
// ============================
export function initFormatGroups(callbacks) {
  const pickerOverlay = document.getElementById("formatGroupPickerOverlay");
  const pickerClose = document.getElementById("formatGroupPickerCloseBtn");
  if (pickerClose) pickerClose.addEventListener("click", closePicker);
  if (pickerOverlay) pickerOverlay.addEventListener("click", (e) => {
    if (e.target === pickerOverlay) closePicker();
  });

  const editOverlay = document.getElementById("formatGroupEditOverlay");
  const editCancel = document.getElementById("formatGroupEditCancelBtn");
  const editSave = document.getElementById("formatGroupEditSaveBtn");
  const editQrShare = document.getElementById("formatGroupEditQrShareBtn");
  if (editCancel) editCancel.addEventListener("click", closeEditModal);
  if (editSave) editSave.addEventListener("click", saveEdit);
  if (editOverlay) editOverlay.addEventListener("click", (e) => {
    if (e.target === editOverlay) closeEditModal();
  });
  // QR 共有: 編集中のセット (= _currentEdit.target) をそのまま QR 化 (未保存でも可)。
  // 名前が空のままは弾く。参照 formats は settings.formats から id 解決される。
  if (editQrShare) editQrShare.addEventListener("click", () => {
    if (!_currentEdit) return;
    const nameInp = document.getElementById("formatGroupEditName");
    const name = String(nameInp?.value || "").trim();
    if (!name) { alert(t("formatGroup.name.required")); return; }
    _currentEdit.target.name = name;
    openQrSetOverlay(_currentEdit.target);
  });

  // 患者画面ヘッダーの「束」ボタン → ピッカーを開く
  const triggerBtn = document.getElementById("detailFormatGroupBtn");
  if (triggerBtn) {
    triggerBtn.addEventListener("click", () => {
      openFormatGroupPicker(() => {
        if (callbacks?.renderDetail) callbacks.renderDetail();
      });
    });
  }
}
