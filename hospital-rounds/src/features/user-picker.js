"use strict";

// ============================================================================
// ユーザーピッカー (ヘッダーのユーザー名タップで開く軽量 popup) — 案B
//
// 動作:
//   - ヘッダーのユーザー名 (appTitleInput) / ▾ をタップ → このピッカーを開く
//   - 一覧からユーザーをタップ → switchUser して閉じる (close-on-select: 単一選択)
//   - 鉛筆 → インラインリネーム (renameUser、重複名は alert で拒否)
//   - 末尾の「+ 新規ユーザー」→ 名前入力 → createUserAndSwitch
//
// 含めない機能 (= 設定画面の「ユーザー管理」セクションで提供):
//   - delete (破壊的操作は設定画面に隔離)
//
// 背景タップ閉じ / data-close-popup は main.js のグローバル委譲に任せる
// (個別配線しない。CLAUDE.md ポップアップ規約)。
//
// CSS は ws ピッカーのクラス (wsPicker*/ioWs*) をそのまま再利用する。
// ============================================================================

import { listUsers, getCurrentUserId, renameUser, userNameExists } from "../storage.js";
import { switchUser, createUserAndSwitch } from "../store.js";
import { refreshAppUserName, refreshAppWsLabel } from "./app-title.js";
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

export function openUserPicker() {
  const overlay = document.getElementById("userPickerOverlay");
  if (!overlay) return;
  renderList();
  overlay.classList.add("active");
}

function closeUserPicker() {
  const overlay = document.getElementById("userPickerOverlay");
  if (overlay) overlay.classList.remove("active");
}

async function renderList() {
  const host = document.getElementById("userPickerList");
  if (!host) return;
  host.textContent = "";

  let all = [];
  try { all = await listUsers(); } catch (e) { console.error("listUsers failed:", e); }
  const currentId = getCurrentUserId();

  if (!all.length) {
    const empty = document.createElement("div");
    empty.className = "ioDbListEmpty";
    empty.textContent = t("io.user.list.empty");
    host.appendChild(empty);
    return;
  }

  // current が一番上、その他は createdAt 昇順 (登録順)
  const sorted = all.slice().sort((a, b) => {
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  for (const r of sorted) host.appendChild(buildRow(r, r.id === currentId));
}

function buildRow(r, isCurrent) {
  // 行 = 切替ボタン(主) + リネーム鉛筆。button のネストを避けるため div で包む。
  const row = document.createElement("div");
  row.className = "wsPickerRow" + (isCurrent ? " selected" : "");

  const main = document.createElement("button");
  main.type = "button";
  main.className = "wsPickerMain";
  const label = document.createElement("div");
  label.className = "wsPickerLabel";
  label.textContent = r.name || t("io.user.untitled");
  main.appendChild(label);
  const meta = document.createElement("div");
  meta.className = "wsPickerMeta";
  meta.textContent = fmtTimestamp(r.createdAt);
  main.appendChild(meta);

  if (isCurrent) {
    main.disabled = true; // 現在のユーザーへは切替不可 (リネームは可)
  } else {
    main.addEventListener("click", async () => {
      try {
        await switchUser(r.id);
        vibrate();
        closeUserPicker();
      } catch (err) {
        console.error("user switch failed:", err);
        alert(t("io.user.switch.failed"));
      }
    });
  }
  row.appendChild(main);

  // リネーム鉛筆: タップで name をインライン input に差し替え → blur/Enter で commit
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "wsPickerEdit";
  editBtn.title = t("common.edit");
  editBtn.setAttribute("aria-label", t("common.edit"));
  editBtn.innerHTML = icon("pencil", 16);
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(row, r, isCurrent);
  });
  row.appendChild(editBtn);
  return row;
}

// ユーザー行をインラインリネーム editor に切り替える。commit で renameUser → 再描画。
function startRename(row, r, isCurrent) {
  row.textContent = "";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "wsPickerRenameInput";
  inp.value = r.name || "";
  row.appendChild(inp);

  let done = false;
  async function finalize(commit) {
    if (done) return;
    done = true;
    const next = String(inp.value || "").trim();
    if (commit && next && next !== r.name) {
      try {
        if (await userNameExists(next, r.id)) {
          alert(t("io.user.name.duplicate"));
          done = false; // 再編集を許可
          setTimeout(() => { inp.focus(); inp.select(); }, 0);
          return;
        }
        await renameUser(r.id, next);
        if (isCurrent) refreshAppUserName(); // 現ユーザーのリネームはヘッダー表示も更新
      } catch (err) {
        console.error("user rename failed:", err);
        alert(t("io.user.rename.failed"));
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
  const host = document.getElementById("userPickerAdd");
  if (!host) return;
  showButton();

  function showButton() {
    host.textContent = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ioWsAddBtn";
    btn.title = t("io.user.create.action");
    btn.setAttribute("aria-label", t("io.user.create.action"));
    btn.innerHTML = icon("plus", 18);
    btn.addEventListener("click", showInput);
    host.appendChild(btn);
  }

  function showInput() {
    host.textContent = "";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "ioWsAddInput";
    inp.placeholder = t("io.user.create.placeholder");
    host.appendChild(inp);

    let done = false;
    async function finalize(commit) {
      if (done) return;
      done = true;
      if (!commit) { showButton(); return; }
      const name = String(inp.value || "").trim();
      if (!name) { showButton(); return; }
      try {
        const res = await createUserAndSwitch(name);
        if (!res.ok) {
          if (res.reason === "duplicate") alert(t("io.user.name.duplicate"));
          done = false;
          setTimeout(() => { inp.focus(); inp.select(); }, 0);
          return;
        }
        // 切替が起きるので一覧は閉じる。ヘッダーは _onUserChanged が更新するが念のため。
        vibrate();
        refreshAppUserName();
        refreshAppWsLabel();
        closeUserPicker();
      } catch (err) {
        console.error("user create failed:", err);
        alert(t("io.user.create.failed"));
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

export function initUserPicker() {
  // ヘッダーのユーザー名表示 / ▾ chevron をタップで起動
  const userLabel = document.getElementById("appTitleInput");
  if (userLabel) {
    userLabel.addEventListener("click", () => {
      if (!userLabel.readOnly) return;
      openUserPicker();
    });
  }
  const userChevron = document.getElementById("appUserChevron");
  if (userChevron) userChevron.addEventListener("click", openUserPicker);
  initAddWidget();
}
