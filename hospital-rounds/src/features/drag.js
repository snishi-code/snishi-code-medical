"use strict";

import { appState, settings, makeDefaultPatient, scheduleSave, isPatientEmpty } from "../store.js";
import { openMovePatientModal, isPatientTransferred } from "./move-patient.js";
import { formatPatientLabel } from "./room.js";
import { t } from "../i18n.js";

// Callback registered by main.js to re-render the current view after data changes
let _onDataChange = null;
export function setDataChangeHandler(fn) { _onDataChange = fn; }

export function finishDataChange() {
  scheduleSave();
  if (_onDataChange) _onDataChange();
}

// ============================
// Drag and Drop & Long Press
// ============================

// dragSelector: ドロップ候補要素の CSS セレクタ (省略時は active view から自動推定)
//   docs デモなど、ビュー自動推定が効かない場所で使う。
export function bindLongPressAndDrag(el, getIndexFn, onDrop, onMenu, onTap, dragSelector) {
  let startX = 0, startY = 0;
  let mode = 0;
  let localTimer = null;
  let longPressAt = 0; // ロングプレス検出時刻（低性能端末の誤touchend判定を除外するため）

  const onMove = (e) => {
    if (mode === 0) return;
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (mode === 1) {
      if (dist > 8) {
        clearTimeout(localTimer);
        mode = 0;
        unbindDoc();
      }
    } else if (mode === 2 || mode === 3) {
      e.preventDefault();
      if (mode === 2 && dist > 8) {
        mode = 3;
        startCustomDrag(el, getIndexFn(), pt.clientX, pt.clientY, dragSelector);
      }
      if (mode === 3) {
        moveCustomDrag(pt.clientX, pt.clientY);
      }
    }
  };

  const onUp = (e) => {
    if (localTimer) clearTimeout(localTimer);
    el.style.transform = "";
    el.style.opacity = "";
    if (mode === 2) {
      // ロングプレス検出直後200ms以内のtouchendは低性能端末の誤検出として無視する
      if (Date.now() - longPressAt < 200) {
        mode = 0;
        unbindDoc();
        return;
      }
      if (e.cancelable) e.preventDefault();
      onMenu(getIndexFn());
    } else if (mode === 3) {
      if (e.cancelable) e.preventDefault();
      endCustomDrag(onDrop);
    } else if (mode === 1 && onTap) {
      if (e.cancelable) e.preventDefault();
      onTap();
    }
    mode = 0;
    unbindDoc();
  };

  const bindDoc = () => {
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
    document.addEventListener("touchcancel", onUp);
    document.addEventListener("mousemove", onMove, { passive: false });
    document.addEventListener("mouseup", onUp);
  };

  const unbindDoc = () => {
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onUp);
    document.removeEventListener("touchcancel", onUp);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  const down = (e) => {
    if (e.touches && e.touches.length > 1) return;
    if (e.type === "mousedown" && e.button !== 0) return;
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX;
    startY = pt.clientY;
    mode = 1;

    if (localTimer) clearTimeout(localTimer);
    localTimer = setTimeout(() => {
      if (mode === 1) {
        mode = 2;
        longPressAt = Date.now();
        if (navigator.vibrate) navigator.vibrate(50);
        el.style.transform = "scale(0.96)";
        el.style.opacity = "0.8";
      }
    }, 400);
    bindDoc();
  };

  el.addEventListener("touchstart", down, { passive: true });
  el.addEventListener("mousedown", down);
}

let dragGhost = null;
let dragSourceIdx = -1;
let dragOverIdx = -1;
let dragElements = [];

function startCustomDrag(sourceEl, sourceIdx, clientX, clientY, dragSelector) {
  dragSourceIdx = sourceIdx;
  dragOverIdx = sourceIdx;
  dragElements = [];
  let query = "";
  if (dragSelector) {
    query = dragSelector;
  } else {
    const viewId = document.querySelector(".view.active")?.id;
    if (viewId === "homeView") query = ".patientBtn";
    else if (viewId === "memoView") query = "#memoView .memoRow";
    else if (viewId === "sharedView") query = "#sharedView .memoRow";
    else if (viewId === "settingsView" && sourceEl.closest(".tagSettingList"))
      query = ".tagSettingList .tagSettingChip";
  }

  if (query) {
    document.querySelectorAll(query).forEach((el, i) => {
      dragElements.push({ el, idx: i, rect: el.getBoundingClientRect() });
    });
  }

  const rect = sourceEl.getBoundingClientRect();
  dragGhost = sourceEl.cloneNode(true);
  dragGhost.style.position = "fixed";
  dragGhost.style.left = rect.left + "px";
  dragGhost.style.top = rect.top + "px";
  dragGhost.style.width = rect.width + "px";
  dragGhost.style.height = rect.height + "px";
  dragGhost.style.margin = "0";
  dragGhost.style.zIndex = "9999";
  dragGhost.style.pointerEvents = "none";
  dragGhost.style.opacity = "0.8";
  dragGhost.style.boxShadow = "0 20px 40px rgba(0,0,0,0.2)";
  dragGhost.style.transform = "scale(1.05)";
  dragGhost.style.transition = "transform 0.1s";
  document.body.appendChild(dragGhost);

  sourceEl.classList.add("dragGhost");
}

function moveCustomDrag(clientX, clientY) {
  if (!dragGhost) return;
  dragGhost.style.left = (clientX - dragGhost.offsetWidth / 2) + "px";
  dragGhost.style.top = (clientY - dragGhost.offsetHeight / 2) + "px";

  let bestIdx = dragSourceIdx;
  let minDist = Infinity;
  for (const item of dragElements) {
    const cx = item.rect.left + item.rect.width / 2;
    const cy = item.rect.top + item.rect.height / 2;
    const dist = Math.sqrt((cx - clientX) ** 2 + (cy - clientY) ** 2);
    if (dist < minDist && dist < 100) {
      minDist = dist;
      bestIdx = item.idx;
    }
  }

  if (dragOverIdx !== bestIdx) {
    dragElements.forEach(item => item.el.classList.remove("dragOver"));
    if (dragElements[bestIdx]) {
      dragElements[bestIdx].el.classList.add("dragOver");
    }
    dragOverIdx = bestIdx;
  }
}

function endCustomDrag(onDrop) {
  dragElements.forEach(item => {
    item.el.classList.remove("dragGhost");
    item.el.classList.remove("dragOver");
  });
  if (dragGhost) {
    dragGhost.remove();
    dragGhost = null;
  }
  if (dragSourceIdx !== -1 && dragOverIdx !== -1 && dragSourceIdx !== dragOverIdx) {
    onDrop(dragSourceIdx, dragOverIdx);
  }
  dragSourceIdx = -1;
  dragOverIdx = -1;
  dragElements = [];
}

export function onPatientDrop(fromIdx, toIdx) {
  const item = appState.patients.splice(fromIdx, 1)[0];
  appState.patients.splice(toIdx, 0, item);
  finishDataChange();
}

// ============================
// Action menu (long-press patient operations)
// ============================

let targetActionIdx = -1;

export function openActionMenu(idx) {
  targetActionIdx = idx;
  const p = appState.patients[idx];
  const title = document.getElementById("actionMenuTitle");
  // ホーム画面の患者ボタンと同じ表記を使う (例: "202 テスト" / 部屋未入力なら "名前" / それも未入力なら番号)
  if (title) title.textContent = formatPatientLabel(p, String(idx + 1));
  const overlay = document.getElementById("actionMenuOverlay");
  if (overlay) overlay.classList.add("active");
}

export function closeActionMenu() {
  targetActionIdx = -1;
  const overlay = document.getElementById("actionMenuOverlay");
  if (overlay) overlay.classList.remove("active");
}

export function insertPatients(atIdx, count) {
  const newItems = [];
  for (let i = 0; i < count; i++) {
    const p = makeDefaultPatient();
    newItems.push(p);
  }
  appState.patients.splice(atIdx, 0, ...newItems);
  finishDataChange();
}

// 長押し位置から後ろ count 件のインデックスを返す。末尾に到達したら短くなる。
function deletionSliceIndices(count) {
  if (targetActionIdx < 0) return [];
  const end = Math.min(targetActionIdx + count, appState.patients.length);
  const indices = [];
  for (let i = targetActionIdx; i < end; i++) indices.push(i);
  return indices;
}

// 指定インデックス群を一括削除。空になったら既定患者を1件補充する。
function deletePatientsByIndices(indices) {
  const sorted = [...indices].sort((a, b) => b - a);
  for (const idx of sorted) {
    const victim = appState.patients[idx];
    appState.patients.splice(idx, 1);
  }
  if (appState.patients.length === 0) {
    const p = makeDefaultPatient();
    appState.patients.push(p);
  }
  finishDataChange();
}

export function initActionMenu() {
  const overlay = document.getElementById("actionMenuOverlay");
  const cancelBtn = document.getElementById("actionCancelBtn");
  const add1Btn = document.getElementById("actionAdd1Btn");
  const add5Btn = document.getElementById("actionAdd5Btn");
  const deleteBtn = document.getElementById("actionDeleteBtn");
  const delete5Btn = document.getElementById("actionDelete5Btn");
  const move1Btn = document.getElementById("actionMove1Btn");
  const move5Btn = document.getElementById("actionMove5Btn");

  if (cancelBtn) cancelBtn.addEventListener("click", closeActionMenu);

  // オーバーレイ (ポップアップの外側) タップで閉じる
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeActionMenu();
  });

  if (add1Btn) add1Btn.addEventListener("click", () => {
    if (targetActionIdx < 0) return;
    insertPatients(targetActionIdx + 1, 1);
    closeActionMenu();
  });

  if (add5Btn) add5Btn.addEventListener("click", () => {
    if (targetActionIdx < 0) return;
    insertPatients(targetActionIdx + 1, 5);
    closeActionMenu();
  });

  if (deleteBtn) deleteBtn.addEventListener("click", () => {
    const indices = deletionSliceIndices(1);
    if (indices.length === 0) { closeActionMenu(); return; }
    const target = appState.patients[indices[0]];
    if (!isPatientEmpty(target)) {
      if (!confirm(t("patient.delete.confirm"))) { closeActionMenu(); return; }
    }
    deletePatientsByIndices(indices);
    closeActionMenu();
  });

  if (delete5Btn) delete5Btn.addEventListener("click", () => {
    const indices = deletionSliceIndices(5);
    if (indices.length === 0) { closeActionMenu(); return; }
    const allEmpty = indices.every(i => isPatientEmpty(appState.patients[i]));
    if (!allEmpty) {
      if (!confirm(t("patient.delete.bulk.confirm", { n: indices.length }))) { closeActionMenu(); return; }
    }
    deletePatientsByIndices(indices);
    closeActionMenu();
  });

  // 移動 ×1 / ×5: 長押し位置から N 件を他ワークスペースへ転送。
  // 空患者・移動済 (transferred) 患者はスキップ。移動済を再度移すと移動先で
  // 増殖する (= 同一患者が複数 WS に存在) ため、一度移したら再移動不可とする。
  // 0 件になったら何もせずメニューを閉じる。
  const movableAt = (i) => {
    const p = appState.patients[i];
    return !isPatientEmpty(p) && !isPatientTransferred(p);
  };
  const handleMove = (n) => {
    const raw = deletionSliceIndices(n);
    const indices = raw.filter(movableAt);
    if (indices.length === 0) {
      // 動かせる患者が無い。移動済が含まれていた場合は「再移動不可」を明示する
      // (空患者だけなら黙って閉じる)。
      const transferred = raw.map(i => appState.patients[i]).find(p => isPatientTransferred(p));
      if (transferred) {
        alert(t("move.already.transferred", { dest: transferred.transferredTo || "" }));
      }
      closeActionMenu();
      return;
    }
    openMovePatientModal(indices, () => {
      if (_onDataChange) _onDataChange();
    });
    closeActionMenu();
  };
  if (move1Btn) move1Btn.addEventListener("click", () => handleMove(1));
  if (move5Btn) move5Btn.addEventListener("click", () => handleMove(5));
}
