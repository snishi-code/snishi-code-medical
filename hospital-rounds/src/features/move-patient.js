"use strict";

// ============================
// 患者の他ワークスペースへの移動
//
// 設計指針 (案 3):
//   - 元データは触らない (name / room は無傷)
//   - 元 ws の患者には transferredAt / transferredTo マーカーを立て、status = GRAY に
//   - 移動先 ws には新規 pid + status = BLUE で append (slot push 方式、既存
//     appendNewPatients と同じ流儀)
//   - 表示時に "(移)" prefix を付け、ソートで末尾に押し出すのは home.js / detail.js
//     / room.js 側の責務
//
// 既存 admin 機能との関係 (将来):
//   - 元 ws では物理 delete op を発火しない (= 他端末でデータが消えない)
//   - update op として transferredAt / transferredTo / status の変更を流せば最低限の整合
//   - これは admin 実装時にあらためて考える。今はローカル端末モードなので op は流さない
// ============================

import { appState, settings, selectedNo, markUpdated, scheduleSave, saveNow, makeDefaultPatient, createWorkspaceWithPatients } from "../store.js";
import { STATUS } from "../constants.js";
import {
  listBundles, loadBundle, saveBundle, getActiveWorkspaceId,
} from "../storage.js";
import { getSection, SECTION } from "../bundle.js";
import { captureSnapshot, REASON } from "./snapshots.js";
import { t } from "../i18n.js";

// 新 pid 生成 (storage 側の crypto を再利用するため makeDefaultPatient 経由でだけ取得)
function newPatientId() {
  return makeDefaultPatient().pid;
}

// 現アクティブ以外のワークスペース一覧 (id / label / title / updatedAt)
export async function listOtherWorkspaces() {
  const activeId = getActiveWorkspaceId();
  const all = await listBundles();
  return all
    .filter(r => r.id !== activeId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// 指定 ws の bundle に複数患者を末尾追加して保存 (active か非 active かを問わない)。
// 戻り値: 追加後の bundle の patients.length (= 末尾患者の表示上の position+1)
async function appendPatientsToWorkspace(destId, patients) {
  const bundle = await loadBundle(destId);
  if (!bundle) throw new Error(`workspace not found: ${destId}`);
  const current = getSection(bundle, SECTION.PATIENTS);
  const next = Array.isArray(current) ? current.slice() : [];
  for (const p of patients) next.push(p);
  bundle.sections = bundle.sections || {};
  bundle.sections.patients = next;
  // saveBundle は label を省略すれば既存 label を温存する
  await saveBundle(bundle, destId);
  return next.length;
}

// 1 患者用の thin wrapper (互換維持)
async function appendPatientToWorkspace(destId, patient) {
  return appendPatientsToWorkspace(destId, [patient]);
}

// 移動先用に「コピー版」を作る (pid 新発番、status BLUE、transferred マーカー無し)
function buildDestCopy(src) {
  return {
    ...src,
    pid: newPatientId(),
    status: STATUS.BLUE,
    updatedAt: Date.now(),
    transferredAt: 0,
    transferredTo: "",
    tags: Array.isArray(src.tags) ? src.tags.slice() : [],
    a: { text: String(src.a?.text ?? "") },
    p: { text: String(src.p?.text ?? "") },
    // 展開(A)値は参照共有を避けてディープコピー (移動先で別個に編集できるように)
    formatValues: (src.formatValues && typeof src.formatValues === "object")
      ? JSON.parse(JSON.stringify(src.formatValues)) : {},
  };
}

// 元 ws の patient に「他 ws へ移動した」マーカーを立てる (物理削除はしない)
function markPatientTransferred(p, destLabel) {
  p.transferredAt = Date.now();
  p.transferredTo = String(destLabel || "");
  p.status = STATUS.GRAY;
}

// 移動操作の本体 (1 患者用)。
//   srcPatientIdx: 元 ws の患者 index (0-based)
//   destId / destLabel: 移動先 workspace の id + 表示用 label
export async function movePatient(srcPatientIdx, destId, destLabel) {
  return movePatients([srcPatientIdx], destId, destLabel);
}

// 複数患者を一括移動する。失敗時は元 ws を触らず例外を投げる (atomicity)。
//   srcPatientIndices: 移動対象の patient.index (0-based) 配列。空 idx (= 範囲外
//   や空患者) は内部でスキップ。
export async function movePatients(srcPatientIndices, destId, destLabel) {
  if (destId === getActiveWorkspaceId()) {
    throw new Error("cannot move within the same workspace");
  }
  // 1) 有効な patient だけを抽出。移動済 (transferred) は除外 (再移動で移動先に
  //    増殖するのを防ぐ。一度移したら再移動不可)。UI 側でも除外しているがここでも防御。
  const valid = [];
  for (const idx of srcPatientIndices) {
    const p = appState.patients[idx];
    if (!p) continue;
    if (isPatientTransferred(p)) continue;
    valid.push({ idx, src: p });
  }
  if (!valid.length) return 0;

  // 破壊操作の直前: 元 ws (= 現アクティブ) の状態を 1 枚スナップショット
  await captureSnapshot(REASON.MOVE);

  // 2) 移動先用コピーを一括作成
  const copies = valid.map(({ src }) => buildDestCopy(src));

  // 3) 移動先 ws へまとめて append + save (失敗したら例外を caller に)
  await appendPatientsToWorkspace(destId, copies);

  // 4) 元 ws の各患者にマーカーを立てる
  for (const { idx, src } of valid) {
    markPatientTransferred(src, destLabel);
    markUpdated(idx + 1);
  }
  // 移動の完全性のためここは即時保存 (debounce しない)
  await saveNow();
  return valid.length;
}

// 指定患者を「新規ワークスペース」に移動する。移動先には渡した患者のコピーだけが
// 入る (空 50 患者は作らない)。失敗時は元 ws を触らず例外を投げる。
//   srcPatientIndices: 移動対象の patient index (0-based) 配列
//   label: 新規ワークスペースの表示名
export async function moveToNewWorkspace(srcPatientIndices, label) {
  const valid = [];
  for (const idx of srcPatientIndices) {
    const p = appState.patients[idx];
    if (!p) continue;
    if (isPatientTransferred(p)) continue;
    valid.push({ idx, src: p });
  }
  if (!valid.length) return 0;
  const copies = valid.map(({ src }) => buildDestCopy(src));
  // 新規 ws を作成 (コピーのみを内包)。失敗したら例外を caller に投げる
  await createWorkspaceWithPatients(label, copies);
  // 元 ws の各患者に移動マーカー
  for (const { idx, src } of valid) {
    markPatientTransferred(src, label);
    markUpdated(idx + 1);
  }
  await saveNow();
  return valid.length;
}

// 表示用ヘルパ
// 移動済 = transferredAt > 0 (false な GRAY = ユーザーが手動で付けた灰 (例: 退院済)
// と区別したいケースで利用)
export function isPatientTransferred(p) {
  return !!(p && p.transferredAt);
}

// 名前表示時に "(移)" prefix を付ける装飾 (元 name は触らない)
// (実装は room.js#formatPatientLabel に集約。ここは将来 caller 側から
//  直接装飾したい時のためのエクスポート枠)
export function decorateTransferredName(name, p) {
  if (!isPatientTransferred(p)) return name;
  return `${t("move.namePrefix")} ${name}`;
}

// ============================
// 移動先ピッカー モーダル
// ============================

let _onMoveDoneCb = null;
let _targetIndices = [];   // 移動対象の patient index 配列。複数 = ホーム長押し「移動 ×5」

// ピッカーを開く (1 患者 / 複数患者 兼用)。完了時に onMoveDone() を呼ぶ
//   patientIndices: 数値 (1 患者) or 配列 (複数患者)
export function openMovePatientModal(patientIndices, onMoveDone) {
  const overlay = document.getElementById("movePatientOverlay");
  if (!overlay) return;
  _onMoveDoneCb = onMoveDone || null;
  _targetIndices = Array.isArray(patientIndices) ? patientIndices.slice() : [patientIndices];
  renderMovePatientList();
  overlay.classList.add("active");
}

function closeMovePatientModal() {
  const overlay = document.getElementById("movePatientOverlay");
  if (overlay) overlay.classList.remove("active");
  _onMoveDoneCb = null;
  _targetIndices = [];
}

// 「＋ 新規ワークスペースへ移動」行を作る。クリックで名前を尋ね、その患者だけを
// 含む新規ワークスペースを作成して移動する。
function buildNewWorkspaceRow() {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "ioDbRow moveNewWsRow";
  const main = document.createElement("div");
  main.className = "ioDbRowMain";
  const lbl = document.createElement("div");
  lbl.className = "ioDbRowLabel";
  lbl.textContent = t("move.newWs.row");
  main.appendChild(lbl);
  row.appendChild(main);
  row.addEventListener("click", async () => {
    const indices = _targetIndices.slice();
    if (!indices.length) return;
    // 既定名: 単一なら患者名/部屋、複数なら汎用名
    let def;
    if (indices.length === 1) {
      const sp = appState.patients[indices[0]];
      def = (sp?.name || sp?.room || t("move.newWs.default"));
    } else {
      def = t("move.newWs.default");
    }
    const input = prompt(t("move.newWs.prompt"), def);
    if (input === null) return; // キャンセル
    const label = String(input || "").trim() || def;
    try {
      await moveToNewWorkspace(indices, label);
      const done = _onMoveDoneCb;
      closeMovePatientModal();
      if (done) done();
    } catch (err) {
      console.error("move to new ws failed:", err);
      alert(t("move.failed"));
    }
  });
  return row;
}

async function renderMovePatientList() {
  const host = document.getElementById("movePatientList");
  if (!host) return;
  host.textContent = "";
  // 先頭に「＋ 新規ワークスペースへ移動」を常に出す
  host.appendChild(buildNewWorkspaceRow());
  const others = await listOtherWorkspaces();
  if (!others.length) {
    // 既存 ws が無い場合でも「＋ 新規」は使えるので empty 文言は補助的に
    const empty = document.createElement("div");
    empty.className = "ioDbListEmpty";
    empty.textContent = t("move.list.empty");
    host.appendChild(empty);
    return;
  }
  for (const ws of others) {
    const row = document.createElement("div");
    row.className = "ioDbRow";
    const main = document.createElement("div");
    main.className = "ioDbRowMain";
    const lbl = document.createElement("div");
    lbl.className = "ioDbRowLabel";
    lbl.textContent = ws.label || ws.title || t("io.ws.untitled");
    const meta = document.createElement("div");
    meta.className = "ioDbRowMeta";
    meta.textContent = ws.title || "";
    main.appendChild(lbl);
    main.appendChild(meta);
    row.appendChild(main);
    row.addEventListener("click", async () => {
      const destName = ws.label || ws.title || t("io.ws.untitled");
      const indices = _targetIndices.slice();
      const isBulk = indices.length > 1;
      // confirm: 単一なら患者ラベル, 複数なら件数表記
      let confirmed;
      if (isBulk) {
        confirmed = confirm(t("move.confirm.bulk", { count: indices.length, dest: destName }));
      } else {
        const srcPatient = appState.patients[indices[0]];
        const patientLabel = (srcPatient?.name || srcPatient?.room || `#${indices[0] + 1}`);
        confirmed = confirm(t("move.confirm", { patient: patientLabel, dest: destName }));
      }
      if (!confirmed) return;
      try {
        await movePatients(indices, ws.id, destName);
        // closeMovePatientModal() が _onMoveDoneCb を null にするので、閉じる前に
        // コールバックを退避してから呼ぶ (退避し忘れると移動後に画面が再描画されない)
        const done = _onMoveDoneCb;
        closeMovePatientModal();
        if (done) done();
      } catch (err) {
        console.error("move failed:", err);
        alert(t("move.failed"));
      }
    });
    host.appendChild(row);
  }
}

// 画面 ready 後に main.js から initMovePatient を呼んで配線する
export function initMovePatient(callbacks) {
  const overlay = document.getElementById("movePatientOverlay");
  const cancelBtn = document.getElementById("movePatientCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeMovePatientModal);
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeMovePatientModal();
  });

  // patientDetail のヘッダー右側「移動」ボタン
  const trigger = document.getElementById("detailMovePatientBtn");
  if (trigger) {
    trigger.addEventListener("click", () => {
      const idx = (selectedNo | 0) - 1;
      if (idx < 0) return;
      // 移動済の患者は再移動不可。黙ってピッカーを開かず、理由をポップアップで知らせる
      const p = appState.patients[idx];
      if (isPatientTransferred(p)) {
        alert(t("move.already.transferred", { dest: p.transferredTo || "" }));
        return;
      }
      openMovePatientModal(idx, () => {
        if (callbacks?.renderHome) callbacks.renderHome();
        if (callbacks?.renderDetail) callbacks.renderDetail();
      });
    });
  }
}
