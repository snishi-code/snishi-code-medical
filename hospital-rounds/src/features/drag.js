"use strict";

import { appState, settings, scheduleSave } from "../store.js";
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

// ============================
// ハンドル起点のドラッグ並び替え (長押し不要)
//
// bindLongPressAndDrag が「要素全体を長押し → ドラッグ」なのに対し、こちらは
// 見える handle の pointerdown で即ドラッグを開始する。入力欄が同居する行
// (フォーマット編集の項目・設定のタグ chip 等) で「掴む場所はハンドルに限定」し、
// 入力中のドラッグ暴発を防ぐ用途。ghost / 最近傍判定は既存の低レベル関数
// (startCustomDrag / moveCustomDrag / endCustomDrag) を流用する。
//   handleEl       : ドラッグ開始トリガ (グリップ)
//   rowEl          : ghost の元 + 並び替え対象の行要素 (handle の親行)
//   getIndexFn     : rowEl の現在 index (DOM 順 = データ配列順)
//   onDrop(from,to): 並び替え確定コールバック
//   dragSelector   : 兄弟行を列挙する CSS セレクタ (省略不可。view 自動推定に頼らない)
//   opts.axis      : "y" = 縦1列リスト (横位置無視・ghost も縦固定。フォーマット項目)。
//                    "2d"= 横並び/折り返しグリッド (X/Y 両方で最近傍。設定のタグ chip)。
//                    既定は "2d" (汎用)。縦リストの呼出側だけ "y" を明示する。
// ============================
export function bindHandleDrag(handleEl, rowEl, getIndexFn, onDrop, dragSelector, opts = {}) {
  const axis = opts.axis === "y" ? "y" : "2d";
  let active = false, dragging = false, startX = 0, startY = 0;

  const onMove = (e) => {
    if (!active) return;
    const pt = e.touches ? e.touches[0] : e;
    if (e.cancelable) e.preventDefault();
    if (!dragging) {
      const dx = pt.clientX - startX;
      const dy = pt.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) > 6) {
        dragging = true;
        // axis を engine へ。"y" は Y のみ最近傍 + ghost 縦固定、"2d" は従来どおり
        // X/Y 両方の最近傍 + ghost が指に追従 (折り返しタグ chip 用)。
        startCustomDrag(rowEl, getIndexFn(), pt.clientX, pt.clientY, dragSelector, { axis });
      }
    }
    if (dragging) moveCustomDrag(pt.clientX, pt.clientY);
  };


  const onUp = (e) => {
    if (dragging) {
      if (e.cancelable) e.preventDefault();
      endCustomDrag(onDrop);
    }
    active = false;
    dragging = false;
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
    active = true;
    // handle はドラッグ専用領域なのでスクロール/テキスト選択を抑止して掴みを優先
    if (e.cancelable) e.preventDefault();
    bindDoc();
  };

  handleEl.addEventListener("touchstart", down, { passive: false });
  handleEl.addEventListener("mousedown", down);
}

let dragGhost = null;
let dragSourceIdx = -1;
let dragOverIdx = -1;
let dragElements = [];
let dragAxis = null;    // "y" = 縦リスト (handle ドラッグ)。null = 2D グリッド (既定)
let dragLockLeft = 0;   // 縦リスト時に ghost の X を固定する左座標 (横ジャンプ防止)

function startCustomDrag(sourceEl, sourceIdx, clientX, clientY, dragSelector, opts = {}) {
  dragSourceIdx = sourceIdx;
  dragOverIdx = sourceIdx;
  dragElements = [];
  dragAxis = opts.axis === "y" ? "y" : null;
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
  dragLockLeft = rect.left;
  dragGhost = sourceEl.cloneNode(true);
  dragGhost.style.position = "fixed";
  dragGhost.style.left = rect.left + "px";
  dragGhost.style.top = rect.top + "px";
  dragGhost.style.width = rect.width + "px";
  dragGhost.style.height = rect.height + "px";
  dragGhost.style.margin = "0";
  // モーダル overlay (z-index:10000) より前面に。9999 だと編集モーダル上のドラッグで
  // ghost が背面に隠れて「ポップアップの裏を動く」ように見えていた。
  dragGhost.style.zIndex = "10001";
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
  // 縦リスト (axis:"y") は X を元の行位置に固定し Y だけ追従 = まっすぐ上下にスライド。
  // 2D グリッドは従来どおり指の真下に ghost 中心を合わせる。
  dragGhost.style.left = (dragAxis === "y" ? dragLockLeft : clientX - dragGhost.offsetWidth / 2) + "px";
  dragGhost.style.top = (clientY - dragGhost.offsetHeight / 2) + "px";

  let bestIdx = dragSourceIdx;
  let minDist = Infinity;
  for (const item of dragElements) {
    const cx = item.rect.left + item.rect.width / 2;
    const cy = item.rect.top + item.rect.height / 2;
    // 縦リストは Y のみで最近傍を取る (横位置は無関係。左端ハンドルでも縦移動で効く)。
    // 2D グリッドは中心点までのユークリッド距離 + 100px 上限で従来挙動を維持。
    const dist = dragAxis === "y"
      ? Math.abs(cy - clientY)
      : Math.sqrt((cx - clientX) ** 2 + (cy - clientY) ** 2);
    if (dist < minDist && (dragAxis === "y" || dist < 100)) {
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
  dragAxis = null;
}
