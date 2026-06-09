"use strict";

import { appState, selectedNo, markUpdated, scheduleSave } from "../store.js";
import { makePatientTagPicker, makeSharedTagFilterPicker, patientMatchesSharedFilter } from "../features/tags.js";
import { makeRoomInput, formatPatientLabel, ensureRoomOrder, setRoomOrderLocked } from "../features/room.js";
import { refreshSharedQrIfActive } from "../features/qr-shared.js";
import { statusClass } from "../features/status-ui.js";
import { bindTapOrLongPress } from "../features/touch.js";
import { makeAddPatientButton } from "../features/add-patient.js";
import { isTrashActive, isPatientDeleted, makeTrashBanner } from "../features/patient-lifecycle.js";

let _editMode = false;

export function setSharedEditMode(val) {
  _editMode = !!val;
  // 編集中は自動部屋順ソートを止める (インライン編集中に並びが動くと行が別患者を指す)
  setRoomOrderLocked(_editMode);
}

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
  const trash = isTrashActive();
  if (trash) sharedListHost.appendChild(makeTrashBanner());
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= limit; i++) {
    const p = appState.patients[i - 1];
    if (trash && !isPatientDeleted(p)) continue;
    if (!patientMatchesSharedFilter(p)) continue;
    const row = document.createElement("div");
    // read/edit の状態クラス: スマホ幅では read 時に「患者見出し + 共有本文」の2段表示へ
    // 寄せる (CSS 側で切替)。edit 時は既存の部屋/氏名/タグ インライン編集を維持。
    row.className = "memoRow " + (_editMode ? "edit" : "read");

    if (_editMode) {
      const nameWrap = document.createElement("div");
      nameWrap.className = "nameDoctorRow";
      // 患者は index でなくオブジェクト参照 p で捕捉する (ソートで並びが変わっても
      // 別患者へ書き込まない)。編集中はソート自体も止まる (setRoomOrderLocked)。
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
      // タップ=患者へ。長押し操作メニューは Phase 2 で廃止 (詳細下部の見える導線へ)。
      bindTapOrLongPress(numBtn, () => { if (navigateToPatientFn) navigateToPatientFn(i); });
      row.appendChild(numBtn);
    }

    const inp = document.createElement("textarea");
    // 共有本文。改行をそのまま入力・表示し、内容に応じて縦に伸びる (CSS field-sizing)。
    // 未対応ブラウザ向けに rows=1 を初期値にし、resize:vertical で手動調整できる (P5 P0)。
    // メモページ本文も textarea になったので read/edit・両画面で見た目が揃う。
    inp.rows = 1;
    inp.value = String(p?.shared ?? "");
    inp.addEventListener("input", () => {
      p.shared = String(inp.value ?? "");
      markUpdated(appState.patients.indexOf(p) + 1);
      scheduleSave();
      if (selectedNo === appState.patients.indexOf(p) + 1) {
        const detailSharedText = document.getElementById("detailSharedText");
        if (detailSharedText) detailSharedText.value = p.shared;
      }
    });
    row.appendChild(inp);
    frag.appendChild(row);
  }
  sharedListHost.appendChild(frag);
  // 末尾に「患者を追加する」(長押し不要)。追加→患者シート。Trash では追加導線は出さない。
  if (!trash) sharedListHost.appendChild(makeAddPatientButton(rerender));
}
