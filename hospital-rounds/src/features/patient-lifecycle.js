"use strict";

// ============================================================================
// 患者ライフサイクル (Phase 2): 削除 → 「削除済み」病棟 (Trash) への退避 / 復元 /
// 完全削除 / 30日自動 purge。
//
// 設計の要 (患者増殖を起こさない最重要不変条件):
//   - 削除退避: Trash へ deep copy を append → 元病棟から splice。元病棟に (移) は
//     残さない (転棟 movePatients とは別物)。元病棟保存が失敗したら Trash append を
//     巻き戻し、元病棟の live state も戻す (= 両病棟に重複させない / fail-closed)。
//   - 復元: 復元先へ append → Trash から splice。Trash 側に患者を残さない。
//     movePatients() は使わない (使うと Trash 側に (移) が残り不正)。
//   - 完全削除: 配列から取り除くだけ。Trash へ送らない。
//   - (移) 患者の削除 / Trash 内の削除 = 完全削除に回す (Trash へ二重退避しない)。
//
// 保存は全て persistActiveOrThrow() (fail-closed)。非アクティブ病棟は bundle 直接
// 読み書き。アクティブ病棟は live appState + persistActiveOrThrow。
//
// Trash 病棟 ID: `__trash__::<userId>` (ユーザー別固定 / 予約 ID ではないので病棟一覧
// には出るが、転棟先候補・新規作成とは別扱い = この API でのみ操作する)。
// ============================================================================

import {
  appState, settings, setAppState, makeDefaultPatient, isPatientEmpty, persistActiveOrThrow,
} from "../store.js";
import {
  getActiveWorkspaceId, getCurrentUserId, loadBundle, saveBundle, listBundles,
} from "../storage.js";
import { getSection, SECTION, projectBundle } from "../bundle.js";
import { captureSnapshot, REASON } from "./snapshots.js";
import { isPatientTransferred } from "./move-patient.js";
import { t } from "../i18n.js";

const TRASH_PREFIX = "__trash__";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// 多重クリック / 再入防止。削除・復元・完全削除は IDB await を挟むので、処理中に
// もう一度呼ばれると二重退避・二重削除になりうる。1 操作ずつに直列化する。
let _busy = false;

// ============================
// ID / 判定ヘルパ (純粋)
// ============================

export function isTrashWorkspaceId(wsId) {
  return typeof wsId === "string" && wsId.startsWith(TRASH_PREFIX + "::");
}

export function getTrashWorkspaceId(userId) {
  return `${TRASH_PREFIX}::${userId || getCurrentUserId()}`;
}

export function isTrashActive() {
  return isTrashWorkspaceId(getActiveWorkspaceId());
}

export function isPatientDeleted(p) {
  return !!(p && p.deletedAt);
}

// 削除済み病棟ビュー上部の注意書きバナーを生成する (home/memo/shared 共通)。
export function makeTrashBanner() {
  const el = document.createElement("div");
  el.className = "trashBanner";
  el.textContent = t("trash.banner");
  return el;
}

// 削除済み病棟ビューの空メッセージ (削除患者が居ない時)。
export function makeTrashEmpty() {
  const el = document.createElement("div");
  el.className = "trashEmpty";
  el.textContent = t("trash.empty");
  return el;
}

function newPatientId() {
  return makeDefaultPatient().pid;
}

function deepCopyPatient(p) {
  return JSON.parse(JSON.stringify(p));
}

// ============================
// 低レベル bundle 操作 (非アクティブ病棟用)
// ============================

async function loadWsPatients(wsId) {
  const bundle = await loadBundle(wsId);
  if (!bundle) return null;
  const cur = getSection(bundle, SECTION.PATIENTS);
  return { bundle, patients: Array.isArray(cur) ? cur.slice() : [] };
}

async function saveWsPatients(wsId, bundle, patients) {
  bundle.sections = bundle.sections || {};
  bundle.sections.patients = patients;
  // label 省略で既存 label (= 削除済み 等) を温存
  await saveBundle(bundle, wsId);
}

// 指定病棟へ患者 1 件を append (durable)。
async function appendPatientToBundle(wsId, patient) {
  const loaded = await loadWsPatients(wsId);
  if (!loaded) throw new Error(`workspace not found: ${wsId}`);
  const next = loaded.patients.slice();
  next.push(patient);
  await saveWsPatients(wsId, loaded.bundle, next);
}

// 指定病棟から pid の患者を取り除く (append の補償用)。
async function removePatientFromBundle(wsId, pid) {
  if (!pid) return;
  const loaded = await loadWsPatients(wsId);
  if (!loaded) return;
  const next = loaded.patients.filter(p => p && p.pid !== pid);
  await saveWsPatients(wsId, loaded.bundle, next);
}

// 指定病棟の pid 集合 (復元先の pid 衝突判定用)。
async function bundlePidSet(wsId) {
  const loaded = await loadWsPatients(wsId);
  const set = new Set();
  if (loaded) for (const p of loaded.patients) if (p && p.pid) set.add(p.pid);
  return set;
}

// アクティブ病棟の label を取得 (deletedFromWorkspaceLabel 用)。
async function getActiveWorkspaceLabel() {
  try {
    const id = getActiveWorkspaceId();
    const all = await listBundles();
    const me = all.find(r => r.id === id);
    return me ? (me.label || "") : "";
  } catch (_) { return ""; }
}

// ============================
// Trash 病棟の作成/取得
// ============================

// 現ユーザーの Trash 病棟が無ければ作成し、その ID を返す。
export async function ensureTrashWorkspace() {
  const trashId = getTrashWorkspaceId();
  const existing = await loadBundle(trashId);
  if (existing) return trashId;
  const bundle = projectBundle({
    appState: { v: 3, title: "", patients: [] },
    settings,
    sections: [SECTION.META, SECTION.PATIENTS],
  });
  await saveBundle(bundle, trashId, t("trash.workspace.label"));
  return trashId;
}

// ============================
// 削除 → Trash 退避
// ============================

// 通常病棟での「削除」。対象を Trash へ deep copy で退避し、元病棟から取り除く。
//   - (移) 患者 / Trash 内での呼び出しは完全削除へ委譲 (二重退避を防ぐ)。
//   - 元病棟が空になったら既存仕様どおり makeDefaultPatient() を 1 件補充。
//   - fail-closed: 元病棟保存に失敗したら Trash append と live state を巻き戻す。
export async function deletePatientToTrash(patientIndex) {
  if (_busy) return { ok: false, reason: "busy" };
  const p = appState.patients[patientIndex];
  if (!p) return { ok: false, reason: "not_found" };

  const activeId = getActiveWorkspaceId();
  // Trash へ送らず完全削除に回すケース:
  //   - 空スロット (初期 50 患者など): PII が無いので30日保存する意味がない。単純除去。
  //   - (移) 患者: Trash へ二重退避すると患者が増殖する。
  //   - 既に Trash 内: Trash 内の削除は完全削除。
  if (isPatientEmpty(p) || isPatientTransferred(p) || isTrashWorkspaceId(activeId)) {
    return permanentlyDeletePatient(patientIndex);
  }

  _busy = true;
  try {
    await captureSnapshot(REASON.PATIENT_DELETE);
    const trashId = await ensureTrashWorkspace();
    const srcLabel = await getActiveWorkspaceLabel();

    const copy = deepCopyPatient(p);
    copy.deletedAt = Date.now();
    copy.deletedFromWorkspaceId = activeId;
    copy.deletedFromWorkspaceLabel = srcLabel;
    // 退避コピーには転棟マーカーを持ち込まない (Trash 内で (移) 扱いにしない)
    copy.transferredAt = 0;
    copy.transferredTo = "";

    // 1) Trash へ append (durable)
    await appendPatientToBundle(trashId, copy);

    // 2) 元病棟 (= アクティブ) から live で取り除く。失敗時に完全復元できるよう
    //    配列を控える。空になったら既定患者を補充 (ホーム不変条件)。
    const beforePatients = appState.patients.slice();
    const nextPatients = appState.patients.slice();
    nextPatients.splice(patientIndex, 1);
    if (nextPatients.length === 0) nextPatients.push(makeDefaultPatient());
    setAppState({ ...appState, patients: nextPatients });

    // 3) 元病棟を fail-closed 保存。失敗したら Trash append を巻き戻し live も戻す。
    try {
      await persistActiveOrThrow();
    } catch (e) {
      setAppState({ ...appState, patients: beforePatients });
      try { await removePatientFromBundle(trashId, copy.pid); }
      catch (e2) { console.error("delete rollback (trash cleanup) failed:", e2); }
      console.error("deletePatientToTrash save failed:", e);
      return { ok: false, reason: "save_failed" };
    }
    return { ok: true, mode: "trash" };
  } finally {
    _busy = false;
  }
}

// ============================
// 完全削除
// ============================

// 完全削除。Trash 内の削除 / (移) stub の削除 / 30日 purge が使う。Trash へは送らない。
//   - Trash 以外の病棟で空になったらホーム不変条件のため既定患者を補充。Trash は空を許容。
//   - fail-closed: 保存失敗時は live を元へ戻し成功扱いにしない。
export async function permanentlyDeletePatient(patientIndex) {
  const reentrant = _busy;
  const p = appState.patients[patientIndex];
  if (!p) return { ok: false, reason: "not_found" };
  if (!reentrant) _busy = true;
  try {
    await captureSnapshot(REASON.PATIENT_DELETE);
    const beforePatients = appState.patients.slice();
    const nextPatients = appState.patients.slice();
    nextPatients.splice(patientIndex, 1);
    if (nextPatients.length === 0 && !isTrashWorkspaceId(getActiveWorkspaceId())) {
      nextPatients.push(makeDefaultPatient());
    }
    setAppState({ ...appState, patients: nextPatients });
    try {
      await persistActiveOrThrow();
    } catch (e) {
      setAppState({ ...appState, patients: beforePatients });
      console.error("permanentlyDeletePatient save failed:", e);
      return { ok: false, reason: "save_failed" };
    }
    return { ok: true, mode: "permanent" };
  } finally {
    if (!reentrant) _busy = false;
  }
}

// ============================
// Trash → 通常病棟 へ復元
// ============================

// Trash 内の患者を通常病棟へ復元する。movePatients() は使わない (Trash 側に (移) を
// 残さないため)。復元先へ append し、Trash 側からは取り除く。
//   pid: 原則そのまま保持。復元先に同 pid が既に居る時だけ新発番する。
//   fail-closed: Trash 保存失敗時は復元先 append と live を巻き戻す。
export async function restoreDeletedPatientToWorkspace(patientIndex, destWorkspaceId, destLabel) {
  if (_busy) return { ok: false, reason: "busy" };
  const activeId = getActiveWorkspaceId();
  if (!isTrashWorkspaceId(activeId)) return { ok: false, reason: "not_trash" };
  if (!destWorkspaceId || isTrashWorkspaceId(destWorkspaceId)) return { ok: false, reason: "bad_dest" };
  const p = appState.patients[patientIndex];
  if (!p || !isPatientDeleted(p)) return { ok: false, reason: "not_deleted" };

  _busy = true;
  try {
    await captureSnapshot(REASON.PATIENT_DELETE);

    const restored = deepCopyPatient(p);
    // 削除/転棟マーカーを消す (通常病棟の現役患者として復活)
    restored.deletedAt = 0;
    restored.deletedFromWorkspaceId = "";
    restored.deletedFromWorkspaceLabel = "";
    restored.transferredAt = 0;
    restored.transferredTo = "";
    // pid 衝突時のみ新発番
    const destPids = await bundlePidSet(destWorkspaceId);
    if (destPids.has(restored.pid)) restored.pid = newPatientId();

    // 1) 復元先へ append (durable)
    await appendPatientToBundle(destWorkspaceId, restored);

    // 2) Trash (= アクティブ) から live で取り除く。Trash は空を許容 (補充しない)。
    const beforePatients = appState.patients.slice();
    const nextPatients = appState.patients.slice();
    nextPatients.splice(patientIndex, 1);
    setAppState({ ...appState, patients: nextPatients });

    // 3) Trash を fail-closed 保存。失敗したら復元先 append と live を巻き戻す。
    try {
      await persistActiveOrThrow();
    } catch (e) {
      setAppState({ ...appState, patients: beforePatients });
      try { await removePatientFromBundle(destWorkspaceId, restored.pid); }
      catch (e2) { console.error("restore rollback (dest cleanup) failed:", e2); }
      console.error("restoreDeletedPatientToWorkspace save failed:", e);
      return { ok: false, reason: "save_failed" };
    }
    return { ok: true };
  } finally {
    _busy = false;
  }
}

// ============================
// 30日自動 purge
// ============================

// 病棟ごとの「残す」述語。Trash は 30日超の削除患者と非削除ゴミ (deletedAt=0 の
// inflate 空スロット) を落とす。通常病棟は 30日超の (移) stub を落とす。
function makeKeepFilter(wsId, now) {
  if (isTrashWorkspaceId(wsId)) {
    return (p) => isPatientDeleted(p) && (now - p.deletedAt) <= THIRTY_DAYS_MS;
  }
  return (p) => !(isPatientTransferred(p) && (now - p.transferredAt) > THIRTY_DAYS_MS);
}

// 個人情報を Trash / (移) stub に無期限で残さないための自動完全削除。起動後・病棟切替
// 後・Trash 表示時に呼ぶ。アクティブ病棟は live appState を直接 filter して
// persistActiveOrThrow で保存 (durable と live のズレ = resurrection を防ぐ)。非アクティブ
// 病棟は bundle を直接 filter して保存。失敗は warning に留め、他病棟の purge は続ける。
//   戻り値: { ok, saved, activeChanged }
export async function purgeExpiredPatientLifecycleRecords(now = Date.now()) {
  const activeId = getActiveWorkspaceId();
  let saved = 0;
  let activeChanged = false;
  let all = [];
  try { all = await listBundles(); }
  catch (e) { console.warn("purge: listBundles failed:", e); return { ok: false, saved: 0, activeChanged: false }; }

  for (const r of all) {
    const keep = makeKeepFilter(r.id, now);
    try {
      if (r.id === activeId) {
        // アクティブ: live を真とする。filter して変化があれば persist。
        const cur = appState.patients;
        const next = cur.filter(keep);
        if (next.length !== cur.length) {
          const before = cur;
          setAppState({ ...appState, patients: next });
          try {
            await persistActiveOrThrow();
            saved++;
            activeChanged = true;
          } catch (e) {
            setAppState({ ...appState, patients: before });
            console.warn("purge: active save failed:", e);
          }
        }
      } else {
        const loaded = await loadWsPatients(r.id);
        if (!loaded) continue;
        const next = loaded.patients.filter(keep);
        if (next.length === loaded.patients.length) continue;
        await saveWsPatients(r.id, loaded.bundle, next);
        saved++;
      }
    } catch (e) {
      console.warn("purge: workspace failed:", r.id, e);
    }
  }
  return { ok: true, saved, activeChanged };
}
