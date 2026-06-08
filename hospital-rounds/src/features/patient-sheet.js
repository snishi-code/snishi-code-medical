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

// 上部の患者情報セル (部屋番号 / 氏名)。頻繁に編集しないので主張を弱めた小さい label +
// input を <label> でまとめ、ラベルタップで input にフォーカスできるようにする。
function infoCell(labelKey, inputEl, cellClass) {
  const cell = document.createElement("label");
  cell.className = "patientSheetInfoCell " + cellClass;
  const lab = document.createElement("span");
  lab.className = "patientSheetInfoLabel";
  lab.textContent = t(labelKey);
  cell.appendChild(lab);
  cell.appendChild(inputEl);
  return cell;
}

// ステータス選択 (色＋形マークの大ボックスを横一列)。openStatusPicker と同じ見た目
// だが別オーバーレイを開かずシート内に常時表示する。選択後は再描画して selected を
// 移すだけ (シートは開いたまま)。
// curIdx は「操作時点の 0-based index を返す関数」。シート表示中にソートで並びが
// 動いても markUpdated が別患者を指さないよう、固定 index でなく都度解決する。
function buildStatusList(p, curIdx, onChange) {
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
        const no = curIdx() + 1;
        if (no > 0) markUpdated(no);
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

  // index-safety: シートは「患者オブジェクト p」を捕捉し、各操作 (氏名/部屋/タグ/
  // ステータス) の保存・タグ get/set は操作時に indexOf(p) で index を取り直す。
  // 追加直後や部屋番号入力で ensureRoomOrder が並びを変えても、固定 index 由来の
  // 患者取り違え (別患者に氏名・タグ・ステータスが書かれる) を防ぐ。
  const curIdx = () => appState.patients.indexOf(p);

  body.textContent = "";

  // レイアウト方針 (スマホ・現場): 部屋番号/氏名は患者確認用だが頻繁に編集しないので
  // 上部にコンパクトに。タグは中央。毎日何度も触るステータスは親指で押しやすい下部に
  // まとめ、タグが増えてスクロールしても下部に固定 (sticky) して常に届くようにする。

  // ── 上部: 部屋番号 + 氏名 (コンパクトな患者情報エリア) ──
  const roomInp = makeRoomInput(p, onChange); // 内部で保存。患者参照束縛で取り違え防止
  roomInp.classList.add("patientSheetRoomInput");
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.className = "patientSheetNameInput";
  nameInp.value = String(p.name ?? "");
  nameInp.addEventListener("input", () => {
    const next = nameInp.value;
    if (p.name !== next) p.name = next;
    const no = curIdx() + 1;
    if (no > 0) markUpdated(no);
    scheduleSave();
    if (onChange) onChange();
  });
  const infoRow = document.createElement("div");
  infoRow.className = "patientSheetInfoRow";
  infoRow.appendChild(infoCell("patientSheet.room", roomInp, "patientSheetRoomCell"));
  infoRow.appendChild(infoCell("patientSheet.name", nameInp, "patientSheetNameCell"));
  body.appendChild(infoRow);

  // ── 中央: タグ ──
  // 別 overlay (tagSheetOverlay) を開かず、共通のタグ選択 UI の「中身」をこのシート内へ
  // 直接描画する (二重ポップアップを避ける)。ホーム/メモ/共有と同一の
  // renderTagSelectionInto を使うので追加・選択・解除の挙動・見た目は揃う。患者タグなので
  // ステータス仮想タグは出さず (entries はユーザータグのみ)、変更は即時 onChange 反映。
  const tagBox = document.createElement("div");
  tagBox.className = "patientSheetTags";
  renderTagSelectionInto(tagBox, {
    getSelected: () => getPatientTags(curIdx()),
    setSelected: (tags) => setPatientTags(curIdx(), tags),
    entries: () => getAllTags().map(name => ({ value: name, label: name })),
    onSelectionMutated: () => { if (onChange) onChange(); },
  });
  body.appendChild(field("patientSheet.tags", tagBox, "patientSheetTagsField"));

  // ── 下部: ステータス (sticky で常に親指の届く位置に) ──
  const statusBar = document.createElement("div");
  statusBar.className = "patientSheetStatusBar";
  const statusLabel = document.createElement("div");
  statusLabel.className = "label";
  statusLabel.textContent = t("patientSheet.status");
  statusBar.appendChild(statusLabel);
  statusBar.appendChild(buildStatusList(p, curIdx, onChange));
  body.appendChild(statusBar);

  overlay.classList.add("active");
}
