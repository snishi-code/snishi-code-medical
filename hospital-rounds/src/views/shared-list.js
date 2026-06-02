"use strict";

import { appState, selectedNo, markUpdated, scheduleSave } from "../store.js";
import { openActionMenu } from "../features/drag.js";
import { makePatientTagPicker, makeSharedTagFilterPicker, patientMatchesSharedFilter } from "../features/tags.js";
import { makeRoomInput, formatPatientLabel, ensureRoomOrder } from "../features/room.js";
import { refreshSharedQrIfActive } from "../features/qr-shared.js";
import { statusClass } from "./home.js";
import { bindTapOrLongPress } from "./detail.js";

let _editMode = false;

export function setSharedEditMode(val) { _editMode = !!val; }

function renderSharedTagFilter(rerender) {
  const slot = document.getElementById("sharedTagFilterSlot");
  if (!slot) return;
  slot.textContent = "";
  slot.appendChild(makeSharedTagFilterPicker(rerender));
}

export function renderSharedScreen(renderHomeFn, opts, navigateToPatientFn) {
  const rerender = () => renderSharedScreen(renderHomeFn, opts, navigateToPatientFn);
  // 自動部屋番号順 (編集モード中はインライン部屋入力があるので並べ替えない)
  if (!_editMode) ensureRoomOrder();
  renderSharedTagFilter(rerender);
  // Keep the QR-side picker in sync when the main filter changes from up here.
  refreshSharedQrIfActive();
  const sharedListHost = document.getElementById("sharedListHost");
  if (!sharedListHost) return;
  const len = appState.patients.length;
  const limit = opts && typeof opts.limit === "number" ? Math.max(0, Math.min(len, opts.limit)) : len;
  sharedListHost.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= limit; i++) {
    const p = appState.patients[i - 1];
    if (!patientMatchesSharedFilter(p)) continue;
    const row = document.createElement("div");
    row.className = "memoRow";

    if (_editMode) {
      const nameWrap = document.createElement("div");
      nameWrap.className = "nameDoctorRow";
      nameWrap.appendChild(makeRoomInput(i - 1, () => {
        if (renderHomeFn) renderHomeFn();
      }));
      const numInp = document.createElement("input");
      numInp.type = "text";
      numInp.className = "memoNoInp";
      numInp.placeholder = String(i);
      numInp.value = String(appState.patients[i - 1]?.name ?? "");
      numInp.addEventListener("input", () => {
        const next = String(numInp.value ?? "");
        const cur = appState.patients[i - 1];
        if (cur.name !== next) {
          cur.name = next;
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

    const inp = document.createElement("textarea");
    // 既定の rows=2 だとメモページの input (1行) より縦に高くなるため 1 行に揃える (#9)。
    // resize:vertical は CSS 側で残しているのでユーザーは必要時に伸ばせる。
    inp.rows = 1;
    inp.value = String(appState.patients[i - 1]?.shared ?? "");
    inp.addEventListener("input", () => {
      appState.patients[i - 1].shared = String(inp.value ?? "");
      markUpdated(appState.patients.indexOf(p) + 1);
      scheduleSave();
      if (selectedNo === appState.patients.indexOf(p) + 1) {
        const detailSharedText = document.getElementById("detailSharedText");
        if (detailSharedText) detailSharedText.value = appState.patients[i - 1].shared;
      }
    });
    row.appendChild(inp);
    frag.appendChild(row);
  }
  sharedListHost.appendChild(frag);
}
