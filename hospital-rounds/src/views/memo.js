"use strict";

import { appState, selectedNo, markUpdated, scheduleSave } from "../store.js";
import { openActionMenu } from "../features/drag.js";
import { syncDetailMemoDisplay } from "../features/navigation.js";
import { makePatientTagPicker, makeSharedTagFilterPicker, patientMatchesSharedFilter } from "../features/tags.js";
import { makeRoomInput, formatPatientLabel, ensureRoomOrder, setRoomOrderLocked } from "../features/room.js";
import { refreshMemoQrIfActive } from "../features/qr-shared.js";
import { statusClass } from "../features/status-ui.js";
import { bindTapOrLongPress } from "../features/touch.js";

let _editMode = false;

export function setMemoEditMode(val) {
  _editMode = !!val;
  // 編集中は自動部屋順ソートを止める (インライン編集中に並びが動くと行が別患者を指す)
  setRoomOrderLocked(_editMode);
}

function renderMemoTagFilter(rerender) {
  const slot = document.getElementById("memoTagFilterSlot");
  if (!slot) return;
  slot.textContent = "";
  slot.appendChild(makeSharedTagFilterPicker(rerender));
}

export function renderMemoScreen(renderHomeFn, opts, navigateToPatientFn) {
  const rerender = () => renderMemoScreen(renderHomeFn, opts, navigateToPatientFn);
  // 自動部屋番号順 (編集モード中はインライン部屋入力があるので並べ替えない)
  if (!_editMode) ensureRoomOrder();
  renderMemoTagFilter(rerender);
  // 上のタグフィルターが変わったらメモQRの対象も追随させる。
  refreshMemoQrIfActive();
  const memoListHost = document.getElementById("memoListHost");
  if (!memoListHost) return;
  const len = appState.patients.length;
  const limit = opts && typeof opts.limit === "number" ? Math.max(0, Math.min(len, opts.limit)) : len;
  memoListHost.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= limit; i++) {
    const p = appState.patients[i - 1];
    if (!patientMatchesSharedFilter(p)) continue;
    const row = document.createElement("div");
    row.className = "memoRow";

    if (_editMode) {
      const nameWrap = document.createElement("div");
      nameWrap.className = "nameDoctorRow";
      // 患者は index でなくオブジェクト参照 p で捕捉する (ソートで並びが変わっても
      // 別患者へ書き込まない)。編集中はソート自体も止まる (setRoomOrderLocked) ので
      // index 束縛のタグピッカーも安全だが、テキスト入力は念のため p 直書きにする。
      nameWrap.appendChild(makeRoomInput(p, () => {
        if (renderHomeFn) renderHomeFn();
      }));
      const numInp = document.createElement("input");
      numInp.type = "text";
      numInp.className = "memoNoInp";
      numInp.placeholder = String(i);
      numInp.value = String(p?.name ?? "");
      numInp.addEventListener("input", () => {
        const next = String(numInp.value ?? "");
        if (p.name !== next) {
          p.name = next;
        }
        markUpdated(appState.patients.indexOf(p) + 1);
        scheduleSave();
        if (renderHomeFn) renderHomeFn();
      });
      nameWrap.appendChild(numInp);
      nameWrap.appendChild(makePatientTagPicker(i - 1));
      row.appendChild(nameWrap);
    } else {
      const numBtn = document.createElement("button");
      numBtn.type = "button";
      numBtn.className = "memoNoBtn secondary " + statusClass(p.status);
      const displayName = formatPatientLabel(p, String(i));
      numBtn.textContent = displayName;
      numBtn.title = displayName;
      // タップ=患者へ / 長押し=操作メニュー (ドラッグ並べ替えは自動ソート化で撤去)
      bindTapOrLongPress(
        numBtn,
        () => { if (navigateToPatientFn) navigateToPatientFn(i); },
        () => openActionMenu(appState.patients.indexOf(p))
      );
      row.appendChild(numBtn);
    }

    const inp = document.createElement("input");
    inp.type = "text";
    inp.autocomplete = "off";
    inp.maxLength = 200;
    inp.value = String(p?.memo ?? "");
    inp.addEventListener("input", () => {
      p.memo = String(inp.value ?? "");
      markUpdated(appState.patients.indexOf(p) + 1);
      scheduleSave();
      if (selectedNo === appState.patients.indexOf(p) + 1) syncDetailMemoDisplay();
    });
    row.appendChild(inp);
    frag.appendChild(row);
  }
  memoListHost.appendChild(frag);
}
