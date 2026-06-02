"use strict";

import { appState, settings, markUpdated, scheduleSave, saveNow } from "../store.js";
import { t } from "../i18n.js";

export function getPatientRoom(patientIndex) {
  const p = appState.patients[patientIndex];
  return String(p?.room ?? "");
}

function sanitizeRoomInput(s) {
  return String(s ?? "").replace(/[^0-9]/g, "");
}

export function makeRoomInput(patientIndex, onChange) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.inputMode = "numeric";
  inp.pattern = "[0-9]*";
  inp.className = "roomInput";
  inp.maxLength = 6;
  inp.value = getPatientRoom(patientIndex);
  inp.addEventListener("input", () => {
    const cleaned = sanitizeRoomInput(inp.value);
    if (cleaned !== inp.value) inp.value = cleaned;
    const p = appState.patients[patientIndex];
    if (!p) return;
    if (p.room !== cleaned) {
      p.room = cleaned;
    }
    markUpdated(patientIndex + 1);
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
export function ensureRoomOrder() {
  appState.patients.sort(patientRoomCompare);
}
