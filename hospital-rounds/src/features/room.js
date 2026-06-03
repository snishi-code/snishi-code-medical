"use strict";

import { appState, settings, markUpdated, scheduleSave, saveNow } from "../store.js";
import { t } from "../i18n.js";

export function getPatientRoom(p) {
  return String(p?.room ?? "");
}

function sanitizeRoomInput(s) {
  return String(s ?? "").replace(/[^0-9]/g, "");
}

// 部屋入力欄は患者を index ではなく「患者オブジェクト参照」で捕捉する。これにより
// 入力中に appState.patients の並び (ensureRoomOrder の自動ソート) が変わっても、欄は
// 常に元の患者へ書き込む (= index 束縛による患者取り違えを防ぐ)。引数は患者オブジェクト。
export function makeRoomInput(patient, onChange) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.inputMode = "numeric";
  inp.pattern = "[0-9]*";
  inp.className = "roomInput";
  inp.maxLength = 6;
  inp.value = getPatientRoom(patient);
  inp.addEventListener("input", () => {
    const cleaned = sanitizeRoomInput(inp.value);
    if (cleaned !== inp.value) inp.value = cleaned;
    if (!patient) return;
    if (patient.room !== cleaned) {
      patient.room = cleaned;
    }
    // markUpdated は 1-based の no を取るので、現在位置を indexOf で解決する
    markUpdated(appState.patients.indexOf(patient) + 1);
    scheduleSave();
    if (onChange) onChange();
  });
  return inp;
}

export function formatPatientLabel(p, fallback) {
  const name = (p && p.name) ? p.name : (fallback || "");
  const room = String(p?.room ?? "").trim();
  const base = room ? `${room} ${name}` : name;
  // 移動済マーカーが立っていれば prefix で視覚的に区別。元 name は触らない (表示のみ)
  if (p && p.transferredAt) return `${t("move.namePrefix")} ${base}`;
  return base;
}

function patientRoomCompare(a, b) {
  // 移動済 (transferredAt > 0) は常に末尾グループに押し出す。
  // 同じ「移動済」同士は通常の比較に落とす (移動が古い順 / room 順)。
  const at = !!(a && a.transferredAt);
  const bt = !!(b && b.transferredAt);
  if (at !== bt) return at ? 1 : -1;
  const ar = String(a.room ?? "").trim();
  const br = String(b.room ?? "").trim();
  if (ar && br) {
    const ai = parseInt(ar, 10);
    const bi = parseInt(br, 10);
    if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
    return ar.localeCompare(br);
  }
  if (ar) return -1;
  if (br) return 1;
  return 0;
}

// v8.7+: 部屋番号順は「自動」。手動トグルは廃止。各 view の入室時 (描画前) に
// ensureRoomOrder() を呼び、appState.patients を部屋番号順に in-place ソートする。
// 「表示中に動く」気持ち悪さを避けるため、描画前にだけ並べ替える (描画後は動かさない)。
// 移動済 (transferred) は末尾、部屋番号なしも末尾グループ。
//
// 旧実装は「並びが変わったか」を返していたが、どの caller も使っておらず、
// 「意図せぬ並び替えを戻す」用途は画面遷移スナップショット (features/snapshots.js)
// が担うようになったため、変化検出は撤去した。
// 編集セッション中 (memo / 共有のインライン編集モード) は自動ソートを止める。
// インライン編集 UI は行ごとに患者を捕捉しているため、編集中に並びが動くと
// index 束縛の入力 (タグピッカー等) が別患者を指す。memo/shared の編集モード
// 出入りで set し、「ソートは view 入室時のみ」(描画前にだけ) の不変条件を編集中も守る。
let _orderLocked = false;
export function setRoomOrderLocked(v) { _orderLocked = !!v; }

export function ensureRoomOrder() {
  if (_orderLocked) return; // 編集中は並べ替えない (患者取り違え防止)
  appState.patients.sort(patientRoomCompare);
}
