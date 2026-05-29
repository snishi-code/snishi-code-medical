"use strict";

import { settings, appState, saveSettings } from "../store.js";
import { DEFAULT_TAGS, clone } from "../constants.js";
import { renameTagAt, deleteTagAt, moveTag, makeAddTagWidget } from "../features/tags.js";
import { bindLongPressAndDrag } from "../features/drag.js";
import { startNewFormat, startEditFormat, deleteFormatById } from "../features/formats.js";
import { getAllFormatGroups, startNewFormatGroup, startEditFormatGroup, deleteFormatGroupById } from "../features/format-groups.js";
import { listBundles, renameBundle, deleteBundle, getActiveWorkspaceId } from "../storage.js";
import { updateAppTitle, refreshAppTitle } from "../features/app-title.js";
import { getStatusOptions } from "../features/tags.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

// アイコンは icons.js を単一ソースに (drift 防止)
const MEMO_SVG = icon("memo", 16);
const SHARED_SVG = icon("people", 16);
const TRASH_SVG = icon("trash", 16);

const CLEAR_KEY_ORDER = ["memo", "s", "o", "a", "p", "shared", "statusYellow", "statusGreen", "statusGray", "statusBlue"];

// CLEAR_KEY_ORDER の各 key に対する表示ラベルを i18n から取得。
// 「メモ」「共有」は専用キー、SOAP パネルは panel.* を再利用、ステータス系は
// settings.clear.statusXxx の専用キー。
function clearItemTitle(key) {
  if (key === "memo") return t("settings.clear.memo");
  if (key === "shared") return t("settings.clear.shared");
  if (key === "s" || key === "o" || key === "a" || key === "p") return t("panel." + key.toUpperCase());
  return t("settings.clear." + key);
}

const PANELS_IN_ORDER = ["S", "O", "A", "P"];

function renderFormatListForPanel(panel) {
  const host = document.getElementById("setFormats_" + panel);
  if (!host) return;
  host.textContent = "";
  const all = Array.isArray(settings.formats) ? settings.formats : [];
  const list = all.filter(f => f.panel === panel);
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.style.padding = "8px 4px";
    empty.style.color = "#6b7280";
    empty.style.fontSize = "13px";
    empty.textContent = t("settings.format.list.empty");
    host.appendChild(empty);
    return;
  }
  for (const f of list) {
    const row = document.createElement("div");
    row.className = "formatListRow";

    const name = document.createElement("span");
    name.className = "formatListName";
    name.textContent = f.name;
    row.appendChild(name);

    // (kind 要約メタは撤去: 設定一覧では不要)

    const actions = document.createElement("span");
    actions.className = "formatListActions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "iconBtn";
    editBtn.title = t("common.edit");
    editBtn.setAttribute("aria-label", t("common.edit"));
    editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    editBtn.addEventListener("click", () => {
      startEditFormat(f, () => {
        renderFormatList();
        if (_renderDetailFn) _renderDetailFn();
      });
    });
    actions.appendChild(editBtn);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "iconBtn";
    del.title = t("common.delete");
    del.setAttribute("aria-label", t("common.delete"));
    del.innerHTML = TRASH_SVG;
    del.addEventListener("click", () => {
      if (!confirm(t("format.delete.confirm", { name: f.name }))) return;
      deleteFormatById(f.id);
      renderFormatList();
      if (_renderDetailFn) _renderDetailFn();
    });
    actions.appendChild(del);

    row.appendChild(actions);
    host.appendChild(row);
  }
}

function renderFormatList() {
  for (const panel of PANELS_IN_ORDER) renderFormatListForPanel(panel);
}

// フォーマットグループ一覧 (設定画面: フォーマット群の下のセクション)
function renderFormatGroupList() {
  const host = document.getElementById("setFormatGroups");
  if (!host) return;
  host.textContent = "";
  const groups = getAllFormatGroups();
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.style.padding = "8px 4px";
    empty.style.color = "#6b7280";
    empty.style.fontSize = "13px";
    empty.textContent = t("formatGroup.empty");
    host.appendChild(empty);
    return;
  }
  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "formatListRow" + (g.isDefault ? " formatGroupDefaultRow" : "");
    const name = document.createElement("span");
    name.className = "formatListName";
    name.textContent = g.name;
    row.appendChild(name);
    if (g.isDefault) {
      const badge = document.createElement("span");
      badge.className = "formatGroupDefaultBadge";
      badge.textContent = t("formatGroup.defaultBadge");
      row.appendChild(badge);
    }
    // フォーマット数の表示は撤去 (重要でないため)

    const actions = document.createElement("span");
    actions.className = "formatListActions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "iconBtn";
    editBtn.title = t("common.edit");
    editBtn.setAttribute("aria-label", t("common.edit"));
    editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    editBtn.addEventListener("click", () => {
      startEditFormatGroup(g, () => {
        renderFormatGroupList();
        if (_renderDetailFn) _renderDetailFn();
      });
    });
    actions.appendChild(editBtn);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "iconBtn";
    del.innerHTML = TRASH_SVG;
    if (g.isDefault) {
      // デフォルトグループは削除不可 (必ず 1 つ存在の不変条件)
      del.disabled = true;
      del.title = t("formatGroup.delete.defaultBlocked");
      del.setAttribute("aria-label", t("formatGroup.delete.defaultBlocked"));
    } else {
      del.title = t("common.delete");
      del.setAttribute("aria-label", t("common.delete"));
      del.addEventListener("click", () => {
        if (!confirm(t("formatGroup.delete.confirm", { name: g.name }))) return;
        deleteFormatGroupById(g.id);
        renderFormatGroupList();
        if (_renderDetailFn) _renderDetailFn();
      });
    }
    actions.appendChild(del);

    row.appendChild(actions);
    host.appendChild(row);
  }
}

// clearTargets の statusXxx キー → STATUS 値
const CLEAR_KEY_TO_STATUS = { statusYellow: "yellow", statusGreen: "green", statusGray: "gray", statusBlue: "blue" };

function buildClearTargetLabelContent(key) {
  const status = CLEAR_KEY_TO_STATUS[key];
  if (status) {
    // 色 + 形マークを canonical (getStatusOptions) から取得 = 全 UI で統一
    const opt = getStatusOptions().find(o => o.status === status);
    const sw = document.createElement("span");
    const fg = opt && opt.color === "#ffffff" ? "#111827" : "#fff";
    sw.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:${opt?.color};border:1px solid ${opt?.borderColor};color:${fg};font-size:11px;font-weight:700;line-height:1;flex-shrink:0;`;
    sw.textContent = opt?.mark || "";
    return sw;
  }
  if (key === "memo" || key === "shared") {
    const span = document.createElement("span");
    span.style.cssText = "display:inline-flex;align-items:center;color:var(--text);";
    span.innerHTML = key === "memo" ? MEMO_SVG : SHARED_SVG;
    return span;
  }
  return document.createTextNode(clearItemTitle(key));
}

function renderClearTargets() {
  const body = document.getElementById("clearTargetsBody");
  if (!body) return;
  body.textContent = "";
  body.className = "cardBody clearTargets";
  for (const key of CLEAR_KEY_ORDER) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "clearTargetBtn" + (settings.clearTargets?.[key] ? " selected" : "");
    const label = clearItemTitle(key);
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.appendChild(buildClearTargetLabelContent(key));
    const x = document.createElement("span");
    x.className = "clearTargetX";
    x.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    btn.appendChild(x);
    btn.addEventListener("click", () => {
      const next = !settings.clearTargets[key];
      settings.clearTargets[key] = next;
      btn.classList.toggle("selected", next);
      saveSettings();
    });
    body.appendChild(btn);
  }
}

function renderToggleIcon(iconEl, on) {
  if (!iconEl) return;
  if (on) {
    iconEl.innerHTML = `<rect x="2" y="7" width="20" height="10" rx="5" fill="${getComputedStyle(document.documentElement).getPropertyValue('--status-green-bg') || '#14b8a6'}" stroke="currentColor"/><circle cx="16" cy="12" r="3" fill="#ffffff" stroke="currentColor"/>`;
  } else {
    iconEl.innerHTML = `<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="8" cy="12" r="3" fill="currentColor"/>`;
  }
}

// v7.7+: タグ・カテゴリ機能 (renderTagGroups / renderTagGroupingToggleIcon /
// openGroupMembershipPicker) は撤去。再実装は git tag hospital-rounds-v7.6.1 を参照

// ============================
// Tag list (chip-based UI with tap-to-edit, long-press to delete/drag)
// ============================

let _draftTagIndex = -1; // index of empty draft tag being added

function makeTagChip(idx) {
  const name = settings.tags[idx] || "";
  const wrap = document.createElement("div");
  wrap.className = "tagSettingChip";
  const labelBtn = document.createElement("button");
  labelBtn.type = "button";
  labelBtn.className = "tagSettingChipLabel";
  labelBtn.textContent = name || t("settings.tagGroup.name.empty");
  wrap.appendChild(labelBtn);

  bindLongPressAndDrag(
    labelBtn,
    () => idx,
    (fromIdx, toIdx) => { moveTag(fromIdx, toIdx); renderTagsList(); if (_renderPatientUIFn) _renderPatientUIFn(); },
    () => {
      if (confirm(t("settings.tag.delete.confirm", { name }))) {
        deleteTagAt(idx);
        renderTagsList();
        if (_renderPatientUIFn) _renderPatientUIFn();
      }
    },
    () => openInlineTagEditor(wrap, idx)
  );

  return wrap;
}

function openInlineTagEditor(chipWrap, idx) {
  chipWrap.textContent = "";
  chipWrap.classList.add("editing");
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "tagSettingInput";
  inp.value = settings.tags[idx] || "";
  inp.placeholder = t("settings.tag.placeholder");
  let done = false;
  const finalize = (commit) => {
    if (done) return;
    done = true;
    const next = String(inp.value || "").trim();
    if (commit && next) {
      const old = settings.tags[idx] || "";
      if (!old) {
        // New tag: rename empty entry to new name
        if (settings.tags.includes(next)) {
          alert(t("settings.tag.name.duplicate"));
          settings.tags.splice(idx, 1);
        } else {
          settings.tags[idx] = next;
          saveSettings();
        }
      } else if (next !== old) {
        if (!renameTagAt(idx, next)) {
          alert(t("settings.tag.name.duplicate"));
        }
      }
    } else if (!settings.tags[idx]) {
      // Empty entry left blank → remove
      settings.tags.splice(idx, 1);
      saveSettings();
    }
    _draftTagIndex = -1;
    renderTagsList();
    if (_renderPatientUIFn) _renderPatientUIFn();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finalize(true); }
    else if (e.key === "Escape") { e.preventDefault(); finalize(false); }
  });
  inp.addEventListener("blur", () => finalize(true));
  chipWrap.appendChild(inp);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

function renderTagsList() {
  const host = document.getElementById("tagsList");
  if (!host) return;
  host.textContent = "";

  if (!Array.isArray(settings.tags)) settings.tags = [];

  const wrap = document.createElement("div");
  wrap.className = "tagSettingList";

  for (let idx = 0; idx < settings.tags.length; idx++) {
    const chip = makeTagChip(idx);
    wrap.appendChild(chip);
    if (idx === _draftTagIndex) openInlineTagEditor(chip, idx);
  }

  // 「+ 新規タグ」は features/tags.js の共通ウィジェットを使う（患者画面・
  // メモ/共有ピッカーと同じ実装＆見た目）。
  wrap.appendChild(makeAddTagWidget({
    onAdded: () => {
      _draftTagIndex = -1;
      renderTagsList();
      if (_renderPatientUIFn) _renderPatientUIFn();
    },
  }));

  host.appendChild(wrap);
}

// v7.1+: QR セキュリティ (暗号化 / 再配布制限) はユーザ向け UI からは隠している。
// 設定モデル (settings.qrEncryption / qrRedistribution) はデフォルト値で常時動作する。
// 将来 admin 機能から expose する場合はここに renderQrSecurity を復活させる。

// ============================
// ワークスペース管理 (v7.6+: 旧 DB chooser から settings page に移植)
// ============================
// 切替・新規作成はヘッダーの WS picker に分離した。ここでは rename / delete /
// JSON 取込/保存ができる。

function fmtTimestamp(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yy}-${mm}-${dd} ${hh}:${mi}`;
}

async function renderWorkspaceList() {
  const host = document.getElementById("settingsWorkspaceList");
  if (!host) return;
  host.textContent = "";

  let all = [];
  try { all = await listBundles(); } catch (e) { console.error("listBundles failed:", e); }
  if (!all.length) {
    const empty = document.createElement("div");
    empty.className = "ioDbListEmpty";
    empty.textContent = t("io.ws.list.empty");
    host.appendChild(empty);
    return;
  }

  const activeId = getActiveWorkspaceId();
  // active が一番上、その他は updatedAt 降順
  const sorted = all.slice().sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  for (const r of sorted) host.appendChild(buildWorkspaceRow(r, r.id === activeId));
}

function buildWorkspaceRow(r, isActive) {
  const row = document.createElement("div");
  row.className = "ioDbRow" + (isActive ? " activeRow" : "");

  const main = document.createElement("div");
  main.className = "ioDbRowMain";
  main.style.cursor = "default";
  row.appendChild(main);

  const labelHost = document.createElement("div");
  labelHost.className = "ioDbRowLabelHost";
  main.appendChild(labelHost);

  const meta = document.createElement("div");
  meta.className = "ioDbRowMeta";
  meta.textContent = `${fmtTimestamp(r.updatedAt)}${r.title ? " ・ " + r.title : ""}`;
  main.appendChild(meta);

  // アクション欄: 鉛筆 (rename) + 削除 (active 以外のみ)
  const actions = document.createElement("div");
  actions.className = "ioDbRowActions";
  row.appendChild(actions);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "ioDbRowEdit";
  editBtn.title = t("io.ws.rename.title");
  editBtn.setAttribute("aria-label", t("io.ws.rename.title"));
  editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
  editBtn.addEventListener("click", () => enterRenameMode());
  actions.appendChild(editBtn);

  if (!isActive) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ioDbRowDel";
    del.title = t("common.delete");
    del.setAttribute("aria-label", t("common.delete"));
    del.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    del.addEventListener("click", async () => {
      const name = r.label || r.title || t("io.ws.untitled");
      if (!confirm(t("io.ws.delete.confirm", { name }))) return;
      try {
        await deleteBundle(r.id);
        await renderWorkspaceList();
      } catch (err) {
        console.error("workspace delete failed:", err);
        alert(t("io.ws.delete.failed"));
      }
    });
    actions.appendChild(del);
  }

  showReadMode();

  function showReadMode() {
    labelHost.textContent = "";
    const lbl = document.createElement("div");
    lbl.className = "ioDbRowLabel";
    lbl.textContent = r.label || r.title || t("io.ws.untitled");
    labelHost.appendChild(lbl);
    editBtn.style.display = "";
  }

  function enterRenameMode() {
    labelHost.textContent = "";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "ioDbRowEditInput";
    inp.value = r.label || r.title || "";
    labelHost.appendChild(inp);
    editBtn.style.display = "none";

    let done = false;
    async function finalize(commit) {
      if (done) return;
      done = true;
      if (!commit) { showReadMode(); return; }
      const next = String(inp.value || "").trim();
      if (!next || next === (r.label || "")) { showReadMode(); return; }
      try {
        await renameBundle(r.id, next);
        r.label = next;
        // active workspace を改名した時はヘッダーの WS 名表示も更新
        if (r.id === getActiveWorkspaceId() && _refreshHeaderWsLabelFn) _refreshHeaderWsLabelFn();
      } catch (err) {
        console.error("workspace rename failed:", err);
        alert(t("io.ws.rename.failed"));
      }
      showReadMode();
    }
    inp.addEventListener("blur", () => finalize(true));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finalize(true); }
      else if (e.key === "Escape") { e.preventDefault(); finalize(false); }
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }

  return row;
}

export function renderSettings() {
  const titleInp = document.getElementById("settingsTitleInput");
  if (titleInp) titleInp.value = appState.title;
  renderClearTargets();
  renderTagsList();
  renderFormatList();
  renderFormatGroupList();
  renderWorkspaceList();
}

// Callbacks wired by main.js to avoid circular deps
let _renderDetailFn = null;
let _renderQrFn = null;
let _renderPatientUIFn = null;
let _refreshHeaderWsLabelFn = null;

export function initSettingsView(renderDetailFn, renderQrFn, renderPatientUIFn, refreshHeaderWsLabelFn) {
  _renderDetailFn = renderDetailFn;
  _renderQrFn = renderQrFn;
  _renderPatientUIFn = renderPatientUIFn;
  _refreshHeaderWsLabelFn = refreshHeaderWsLabelFn || null;

  // アプリ名 (端末固定タイトル) の編集 → updateAppTitle で保存 + ヘッダー反映
  const settingsTitleInput = document.getElementById("settingsTitleInput");
  if (settingsTitleInput) {
    settingsTitleInput.addEventListener("input", () => {
      updateAppTitle(settingsTitleInput.value);
      refreshAppTitle();
    });
  }

  const addTagBtn = document.getElementById("addTagBtn");
  const resetTagsBtn = document.getElementById("resetTagsBtn");

  // S/O/A/P それぞれの「+」ボタンをそのパネル用にバインド
  for (const panel of PANELS_IN_ORDER) {
    const btn = document.getElementById("addFormatBtn" + panel);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      startNewFormat(() => {
        renderFormatList();
        if (_renderDetailFn) _renderDetailFn();
      }, panel);
    });
  }

  // フォーマットグループ追加ボタン
  const addFormatGroupBtn = document.getElementById("addFormatGroupBtn");
  if (addFormatGroupBtn) {
    addFormatGroupBtn.addEventListener("click", () => {
      startNewFormatGroup(() => {
        renderFormatGroupList();
        if (_renderDetailFn) _renderDetailFn();
      });
    });
  }

  if (addTagBtn) addTagBtn.addEventListener("click", () => {
    if (!Array.isArray(settings.tags)) settings.tags = [];
    settings.tags.push("");
    saveSettings();
    renderTagsList();
    if (_renderPatientUIFn) _renderPatientUIFn();
  });

  if (resetTagsBtn) resetTagsBtn.addEventListener("click", () => {
    const ok = confirm(t("tag.reset.confirm"));
    if (!ok) return;
    settings.tags = clone(DEFAULT_TAGS);
    saveSettings();
    renderTagsList();
    if (_renderPatientUIFn) _renderPatientUIFn();
  });
}
