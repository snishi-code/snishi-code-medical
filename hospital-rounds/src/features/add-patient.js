"use strict";

// 「患者を追加する」の見える導線 (長押しメニューに依存しない)。
// ホーム / プロブレムリスト / 共有 の一覧末尾に置くボタンと、その動作をまとめる。
//
// 動作: 新しい空患者を 1 件追加 → すぐ患者シートを開いて部屋番号・氏名を入れられる
// ようにする。長押し openActionMenu は使わない。
//
// 患者取り違え防止 (重要): 追加した患者は index でなく「オブジェクト参照」で捕捉する。
// finishDataChange() が現在の view を再描画する過程で ensureRoomOrder が
// appState.patients を in-place ソートするため、push 直後の index は当てにならない。
// ソート後に indexOf で index を取り直してからシートを開く。シート側も操作時に
// indexOf(p) で都度解決する index-safe 実装なので、開いたまま部屋番号を入れて並びが
// 変わっても別患者に書き込まない。

import { appState, makeDefaultPatient } from "../store.js";
import { finishDataChange } from "./drag.js";
import { openPatientSheet } from "./patient-sheet.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

// 空患者を 1 件追加し、その患者シートを開く。onChange はシート内編集の反映フック
// (= 呼び出し元 view の再描画関数)。
export function addPatientAndOpenSheet(onChange) {
  const p = makeDefaultPatient();
  // 末尾に追加 (room 未入力なので ensureRoomOrder で末尾グループへ並ぶ)。
  appState.patients.push(p);
  // 保存 + 現在 view を再描画 (_onDataChange → refreshPatientUI)。この中でソートされる。
  finishDataChange();
  // ソート後の実 index を取り直してからシートを開く (固定 index を渡さない)。
  const idx = appState.patients.indexOf(p);
  if (idx < 0) return;
  openPatientSheet(idx, onChange);
}

// 一覧末尾に置く「患者を追加する」ボタンを生成する。
// onChange はシート内編集の反映フック (呼び出し元 view の rerender)。
export function makeAddPatientButton(onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "addPatientBtn";
  btn.innerHTML = icon("add", 20);
  const label = document.createElement("span");
  label.className = "addPatientBtnLabel";
  label.textContent = t("patient.add");
  btn.appendChild(label);
  btn.setAttribute("aria-label", t("patient.add.aria"));
  btn.title = t("patient.add.title");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    addPatientAndOpenSheet(onChange);
  });
  return btn;
}
