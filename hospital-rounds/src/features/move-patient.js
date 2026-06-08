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

import { appState, settings, selectedNo, markUpdated, scheduleSave, persistActiveOrThrow, makeDefaultPatient, isPatientEmpty, createWorkspaceWithPatients } from "../store.js";
import { STATUS } from "../constants.js";
import {
  listBundles, loadBundle, saveBundle, deleteBundle, getActiveWorkspaceId,
} from "../storage.js";
import { getSection, SECTION } from "../bundle.js";
import { captureSnapshot, REASON } from "./snapshots.js";
import { t } from "../i18n.js";

// 新 pid 生成 (storage 側の crypto を再利用するため makeDefaultPatient 経由でだけ取得)
function newPatientId() {
  return makeDefaultPatient().pid;
}

// Trash 病棟判定 (正本は patient-lifecycle.js#isTrashWorkspaceId)。patient-lifecycle が
// この move-patient を import しているため、逆向き import で循環しないようローカル複製。
const TRASH_WS_PREFIX = "__trash__::";
function isTrashWsId(id) {
  return typeof id === "string" && id.startsWith(TRASH_WS_PREFIX);
}

// 現アクティブ以外のワークスペース一覧 (id / label / title / updatedAt)。
// 「削除済み」(Trash) は転棟先・復元先の候補から除外する (普通の転棟で Trash に入れない /
// Trash から Trash へ復元させない)。Trash 操作は patient-lifecycle.js 専用 API で行う。
export async function listOtherWorkspaces() {
  const activeId = getActiveWorkspaceId();
  const all = await listBundles();
  return all
    .filter(r => r.id !== activeId)
    .filter(r => !isTrashWsId(r.id))
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

// 指定 pid 群を移動先 ws から取り除いて保存 (移動の補償 = append の取り消し用)。
// 移動先保存は成功したが元 ws 保存が失敗した時に、移動先のコピーを巻き戻して
// 「両病棟に重複」を防ぐために使う。
async function removePatientsFromWorkspace(destId, pids) {
  const drop = new Set((pids || []).filter(Boolean));
  if (!drop.size) return;
  const bundle = await loadBundle(destId);
  if (!bundle) return;
  const current = getSection(bundle, SECTION.PATIENTS);
  const next = (Array.isArray(current) ? current : []).filter(p => !drop.has(p && p.pid));
  bundle.sections = bundle.sections || {};
  bundle.sections.patients = next;
  await saveBundle(bundle, destId);
}

// 元 ws の患者に移動マーカーを立てる前の値を控え、失敗時に元へ戻すための snapshot。
function captureMarks(valid) {
  return valid.map(({ src }) => ({
    src,
    transferredAt: src.transferredAt,
    transferredTo: src.transferredTo,
    status: src.status,
  }));
}
function revertMarks(marks) {
  for (const m of marks) {
    m.src.transferredAt = m.transferredAt;
    m.src.transferredTo = m.transferredTo;
    m.src.status = m.status;
  }
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
    // 空スロット (初期 50 患者など) は転棟しない。元病棟に (移) 履歴を残す意味が
    // 無く、移動先に空の BLUE コピーが増えるだけ。UI でも抑止するがデータ層でも防御。
    if (isPatientEmpty(p)) continue;
    if (isPatientTransferred(p)) continue;
    valid.push({ idx, src: p });
  }
  if (!valid.length) return 0;

  // 破壊操作の直前: 元 ws (= 現アクティブ) の状態を 1 枚スナップショット
  await captureSnapshot(REASON.MOVE);

  // 2) 移動先用コピーを一括作成
  const copies = valid.map(({ src }) => buildDestCopy(src));

  // 3) 移動先 ws へまとめて append + save (失敗したら元 ws を一切触らず例外を caller に)
  await appendPatientsToWorkspace(destId, copies);

  // 4) 元 ws の各患者にマーカーを立てる (失敗時に戻せるよう旧値を控える)
  const marks = captureMarks(valid);
  for (const { idx, src } of valid) {
    markPatientTransferred(src, destLabel);
    markUpdated(idx + 1);
  }

  // 5) 元 ws を fail-closed で即時保存 (debounce しない)。失敗したら「全部成功か全部
  //    無し」を守るため補償する: 移動先に append したコピーを取り除き、元 ws のマーカー
  //    も戻してから throw する (握って成功件数を返すと両病棟に重複が残る)。
  try {
    await persistActiveOrThrow();
  } catch (e) {
    try { await removePatientsFromWorkspace(destId, copies.map(c => c.pid)); }
    catch (e2) { console.error("move rollback (dest cleanup) failed:", e2); }
    revertMarks(marks);
    throw e;
  }
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
    if (isPatientEmpty(p)) continue; // 空スロットは新規病棟へ移さない (データ層防御)
    if (isPatientTransferred(p)) continue;
    valid.push({ idx, src: p });
  }
  if (!valid.length) return 0;
  const copies = valid.map(({ src }) => buildDestCopy(src));
  // 新規 ws を作成 (コピーのみを内包)。失敗したら元 ws を触らず例外を caller に投げる
  const newWsId = await createWorkspaceWithPatients(label, copies);
  // 元 ws の各患者に移動マーカー (失敗時に戻せるよう旧値を控える)
  const marks = captureMarks(valid);
  for (const { idx, src } of valid) {
    markPatientTransferred(src, label);
    markUpdated(idx + 1);
  }
  // 元 ws を fail-closed で保存。失敗したら作成した新 ws を削除し、マーカーも戻して
  // throw する (新 ws にコピーが残ったまま元が未移動に戻る = 重複を防ぐ)。
  try {
    await persistActiveOrThrow();
  } catch (e) {
    try { await deleteBundle(newWsId); }
    catch (e2) { console.error("moveToNewWorkspace rollback (delete new ws) failed:", e2); }
    revertMarks(marks);
    throw e;
  }
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
// ピッカーの用途。"move" = 通常転棟 (movePatients)。"restore" = Trash からの復元
// (呼び出し側が渡す onPick で実処理。movePatients は使わない = Trash に (移) を残さない)。
let _pickMode = "move";
let _onPickCb = null;

// ピッカーを開く (1 患者 / 複数患者 兼用)。完了時に onMoveDone() を呼ぶ。
//   patientIndices: 数値 (1 患者) or 配列 (複数患者)
//   opts.mode: "restore" で復元モード。opts.onPick(wsId, label): 行クリック時の実処理。
export function openMovePatientModal(patientIndices, onMoveDone, opts) {
  const overlay = document.getElementById("movePatientOverlay");
  if (!overlay) return;
  _onMoveDoneCb = onMoveDone || null;
  _targetIndices = Array.isArray(patientIndices) ? patientIndices.slice() : [patientIndices];
  _pickMode = (opts && opts.mode === "restore") ? "restore" : "move";
  _onPickCb = (opts && typeof opts.onPick === "function") ? opts.onPick : null;
  applyModalChrome();
  renderMovePatientList();
  overlay.classList.add("active");
}

// モーダルの見出し/補足を用途別に差し替える (data-i18n 初期値の上書き)。
function applyModalChrome() {
  const title = document.getElementById("movePatientTitle");
  const hint = document.getElementById("movePatientHint");
  if (_pickMode === "restore") {
    if (title) title.textContent = t("patient.restore");
    if (hint) hint.textContent = t("trash.banner");
  } else {
    if (title) title.textContent = t("move.title");
    if (hint) hint.textContent = t("move.hint");
  }
}

function closeMovePatientModal() {
  const overlay = document.getElementById("movePatientOverlay");
  if (overlay) overlay.classList.remove("active");
  _onMoveDoneCb = null;
  _targetIndices = [];
  _pickMode = "move";
  _onPickCb = null;
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
  // 先頭に「＋ 新規ワークスペースへ移動」(復元モードでは既存病棟へのみ復元するので出さない)
  if (_pickMode !== "restore") host.appendChild(buildNewWorkspaceRow());
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
      // 復元モード: 実処理は呼び出し側 (detail.js) の onPick に委譲 (restore API を呼ぶ)。
      if (_pickMode === "restore") {
        const cb = _onPickCb;
        const done = _onMoveDoneCb;
        closeMovePatientModal();
        if (cb) await cb(ws.id, destName);
        if (done) done();
        return;
      }
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
