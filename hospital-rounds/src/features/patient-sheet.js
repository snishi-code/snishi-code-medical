"use strict";

// 患者シート (詳細画面の「患者メタボタン」タップで開く)。
// スマホ・老眼・現場での誤タップを減らすため、ステータス / 部屋番号 / 氏名 / タグ
// の編集を「ヘッダーの小さなインライン操作」から「大きなシート内の確実な操作」へ
// 集約する。二重ポップアップを避けるため、ステータスもタグもシート内に常時表示し、
// 入れ子の popup は開かない。
//
// 開閉は main.js のグローバルハンドラ任せ (背景タップ / × = data-close-popup)。
// ステータス=単一選択だが、氏名・部屋・タグも同じシートで触るため「選んだら即閉じ」
// にはせず、シートは開いたままにする (× / 背景で閉じる)。

import { appState, markUpdated, scheduleSave } from "../store.js";
import { getStatusOptions, renderTagSelectionInto, getPatientTags, setPatientTags, getAllTags } from "./tags.js";
import { makeRoomInput } from "./room.js";
import { t } from "../i18n.js";

function field(labelKey, contentEl, extraClass) {
  const wrap = document.createElement("div");
  wrap.className = "patientSheetField" + (extraClass ? " " + extraClass : "");
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = t(labelKey);
  wrap.appendChild(label);
  wrap.appendChild(contentEl);
  return wrap;
}

// ステータス選択 (色＋形マークの大ボックスを横一列)。openStatusPicker と同じ見た目
// だが別オーバーレイを開かずシート内に常時表示する。選択後は再描画して selected を
// 移すだけ (シートは開いたまま)。
function buildStatusList(p, patientIdx, onChange) {
  const list = document.createElement("div");
  list.className = "statusPickerList patientSheetStatusList";
  const render = () => {
    list.textContent = "";
    for (const opt of getStatusOptions()) {
      const box = document.createElement("button");
      box.type = "button";
      box.className = "statusPickerBox" + (p.status === opt.status ? " selected" : "");
      const fg = opt.color === "#ffffff" ? "#111827" : "#fff";
      box.style.cssText = `background:${opt.color};border:2px solid ${opt.borderColor};color:${fg};`;
      box.textContent = opt.mark; // 無印(白)も記号(−)を持つ
      box.title = opt.label;
      box.setAttribute("aria-label", opt.label);
      box.setAttribute("aria-pressed", p.status === opt.status ? "true" : "false");
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        p.status = opt.status;
        markUpdated(patientIdx + 1);
        scheduleSave();
        render();
        if (onChange) onChange();
      });
      list.appendChild(box);
    }
  };
  render();
  return list;
}

// 患者シートを開く。patientIdx は 0-based。onChange は編集反映後に呼ばれる
// (= 詳細メタボタン再描画 + ホーム再描画 + QR 再生成)。
export function openPatientSheet(patientIdx, onChange) {
  const overlay = document.getElementById("patientMetaOverlay");
  const body = document.getElementById("patientMetaBody");
  const p = appState.patients[patientIdx];
  if (!overlay || !body || !p) return;

  body.textContent = "";

  // ステータス
  body.appendChild(field("patientSheet.status", buildStatusList(p, patientIdx, onChange)));

  // 部屋番号 (makeRoomInput は内部で保存。患者参照束縛で取り違え防止)
  const roomInp = makeRoomInput(p, onChange);
  roomInp.classList.add("patientSheetRoomInput");
  body.appendChild(field("patientSheet.room", roomInp));

  // 氏名
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.className = "patientSheetNameInput";
  nameInp.value = String(p.name ?? "");
  nameInp.addEventListener("input", () => {
    const next = nameInp.value;
    if (p.name !== next) p.name = next;
    markUpdated(patientIdx + 1);
    scheduleSave();
    if (onChange) onChange();
  });
  body.appendChild(field("patientSheet.name", nameInp));

  // タグ: 別 overlay (tagSheetOverlay) を開かず、共通のタグ選択 UI の「中身」を
  // このシート内へ直接描画する (二重ポップアップを避ける)。レンダリングは
  // ホーム/メモ/共有のタグピッカーと同一の renderTagSelectionInto を使うので、
  // 追加・選択・解除の挙動・見た目は完全に揃う。患者タグなのでステータス仮想タグは
  // 出さず (entries はユーザータグのみ)、選択変更は即時に onChange へ反映する。
  const tagBox = document.createElement("div");
  tagBox.className = "patientSheetTags";
  renderTagSelectionInto(tagBox, {
    getSelected: () => getPatientTags(patientIdx),
    setSelected: (tags) => setPatientTags(patientIdx, tags),
    entries: () => getAllTags().map(name => ({ value: name, label: name })),
    onSelectionMutated: () => { if (onChange) onChange(); },
  });
  body.appendChild(field("patientSheet.tags", tagBox, "patientSheetTagsField"));

  overlay.classList.add("active");
}
