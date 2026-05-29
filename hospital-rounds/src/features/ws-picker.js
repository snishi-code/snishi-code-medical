"use strict";

// ============================================================================
// ワークスペースピッカー (ヘッダー WS 名タップで開く軽量 popup)
//
// 動作:
//   - ヘッダーの WS 名表示 (appWsLabelInput) をタップ → このピッカーを開く
//   - 一覧から WS をタップ → switchWorkspace して閉じる
//   - 末尾の「+ 新規ワークスペース」をタップ → ラベル入力 → createWorkspace
//
// 含めない機能 (= 設定画面の「ワークスペース管理」セクションで提供):
//   - rename
//   - delete
//   - JSON 取込/保存
//
// 設計意図:
//   頻繁に行う「切替・新規作成」だけをヘッダーから 1 タップで触れるようにし、
//   破壊的操作 (delete) や detail 管理は設定画面に隔離する。
// ============================================================================

import { listBundles, getActiveWorkspaceId, renameBundle } from "../storage.js";
import { switchWorkspace, createWorkspace } from "../store.js";
import { refreshAppWsLabel } from "./app-title.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

function vibrate() { try { navigator.vibrate?.(60); } catch (_) {} }

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

export function openWsPicker() {
  const overlay = document.getElementById("wsPickerOverlay");
  if (!overlay) return;
  renderList();
  overlay.classList.add("active");
}

function closeWsPicker() {
  const overlay = document.getElementById("wsPickerOverlay");
  if (overlay) overlay.classList.remove("active");
}

async function renderList() {
  const host = document.getElementById("wsPickerList");
  if (!host) return;
  host.textContent = "";

  let all = [];
  try { all = await listBundles(); } catch (e) { console.error("listBundles failed:", e); }
  const activeId = getActiveWorkspaceId();

  if (!all.length) {
    const empty = document.createElement("div");
    empty.className = "ioDbListEmpty";
    empty.textContent = t("io.ws.list.empty");
    host.appendChild(empty);
    return;
  }

  // active が一番上、その他は updatedAt 降順
  const sorted = all.slice().sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  for (const r of sorted) host.appendChild(buildRow(r, r.id === activeId));
}

function buildRow(r, isActive) {
  // 行 = 切替ボタン(主) + リネーム鉛筆。button のネストを避けるため div で包む。
  const row = document.createElement("div");
  row.className = "wsPickerRow" + (isActive ? " selected" : "");

  const main = document.createElement("button");
  main.type = "button";
  main.className = "wsPickerMain";
  const label = document.createElement("div");
  label.className = "wsPickerLabel";
  label.textContent = r.label || r.title || t("io.ws.untitled");
  main.appendChild(label);
  const meta = document.createElement("div");
  meta.className = "wsPickerMeta";
  meta.textContent = `${fmtTimestamp(r.updatedAt)}${r.title ? " ・ " + r.title : ""}`;
  main.appendChild(meta);

  if (isActive) {
    main.disabled = true; // 現在のWSへは切替不可 (リネームは可)
  } else {
    main.addEventListener("click", async () => {
      try {
        await switchWorkspace(r.id);
        vibrate();
        closeWsPicker();
      } catch (err) {
        console.error("workspace switch failed:", err);
        alert(t("io.ws.switch.failed"));
      }
    });
  }
  row.appendChild(main);

  // リネーム鉛筆: タップで label をインライン input に差し替え → blur/Enter で commit
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "wsPickerEdit";
  editBtn.title = t("common.edit");
  editBtn.setAttribute("aria-label", t("common.edit"));
  editBtn.innerHTML = icon("pencil", 16);
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(row, r, isActive);
  });
  row.appendChild(editBtn);
  return row;
}

// WS 行をインラインリネーム editor に切り替える。commit で renameBundle → 再描画。
function startRename(row, r, isActive) {
  row.textContent = "";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "wsPickerRenameInput";
  inp.value = r.label || r.title || "";
  row.appendChild(inp);

  let done = false;
  async function finalize(commit) {
    if (done) return;
    done = true;
    const next = String(inp.value || "").trim();
    if (commit && next && next !== r.label) {
      try {
        await renameBundle(r.id, next);
        if (isActive) refreshAppWsLabel(); // 現WSのリネームはヘッダー表示も更新
      } catch (err) {
        console.error("ws rename failed:", err);
        alert(t("io.ws.switch.failed"));
      }
    }
    renderList();
  }
  inp.addEventListener("blur", () => finalize(true));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finalize(true); }
    else if (e.key === "Escape") { e.preventDefault(); finalize(false); }
  });
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

// 「+ 新規」ボタン: クリックで input に展開 → Enter/blur で commit
function initAddWidget() {
  const host = document.getElementById("wsPickerAdd");
  if (!host) return;
  showButton();

  function showButton() {
    host.textContent = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ioWsAddBtn";
    btn.title = t("io.ws.create.action");
    btn.setAttribute("aria-label", t("io.ws.create.action"));
    btn.innerHTML = icon("plus", 18);
    btn.addEventListener("click", showInput);
    host.appendChild(btn);
  }

  function showInput() {
    host.textContent = "";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "ioWsAddInput";
    inp.placeholder = t("io.ws.create.placeholder");
    host.appendChild(inp);

    let done = false;
    async function finalize(commit) {
      if (done) return;
      done = true;
      if (!commit) { showButton(); return; }
      const label = String(inp.value || "").trim();
      if (!label) { showButton(); return; }
      try {
        await createWorkspace(label);
        vibrate();
        closeWsPicker();
      } catch (err) {
        console.error("workspace create failed:", err);
        alert(t("io.ws.create.failed"));
        showButton();
      }
    }
    inp.addEventListener("blur", () => finalize(true));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finalize(true); }
      else if (e.key === "Escape") { e.preventDefault(); finalize(false); }
    });
    setTimeout(() => inp.focus(), 0);
  }
}

export function initWsPicker() {
  // ヘッダーの WS 名表示 / ▾ chevron をタップで起動
  const wsLabel = document.getElementById("appWsLabelInput");
  if (wsLabel) {
    wsLabel.addEventListener("click", () => {
      if (!wsLabel.readOnly) return;
      openWsPicker();
    });
  }
  const wsChevron = document.getElementById("appWsChevron");
  if (wsChevron) wsChevron.addEventListener("click", openWsPicker);
  // overlay 外 (= 暗幕部分) タップで閉じる。他モーダル共通の挙動に合わせる。
  const overlay = document.getElementById("wsPickerOverlay");
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeWsPicker();
  });
  initAddWidget();
}
