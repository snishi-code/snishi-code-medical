"use strict";

import { appState, settings, makeDefaultPatient, switchWorkspace } from "../store.js";
import { createWorkspaceRecord } from "../storage.js";
import { projectBundle } from "../bundle.js";
import { DEFAULT_PATIENT_COUNT } from "../constants.js";
import { createQrFlow } from "./qr-flow.js";
import { encodePatientList, decodePatientList } from "./qr-patient-list.js";
import { t } from "../i18n.js";

// ============================
// ホームQR (名簿: 部屋番号 + 名前 + タグ)
//
// プロトコルとフローは共通 (qr-flow / qr-patient-list)。ホーム固有なのは:
//   - includeEmpty=true で送る（slot 位置を保つ）
//   - 受信時は **常に新規ワークスペースとして作成 + 切替** (v7.6+ で統一)
//
// 旧 (v6.x〜v7.5): 受信側の名簿が空なら丸ごと上書き (reflect モード)、
//                   非空なら末尾に追加 (append モード)。タグ衝突 rename あり。
// 新 (v7.6+):     受信は常に新規 WS を作成し、現在の WS は無傷で残す。
//                   ユーザは確認ダイアログ後、自動的に新 WS に切り替わる。
// 利点: データ上書き事故ゼロ + 100 行のロジック削除 + WS 一覧が「データ来歴」になる
// ============================

function formatRecvLabel() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return t("home.qrImport.newWs.label", { ts: `${yyyy}-${mm}-${dd} ${hh}:${mi}` });
}

async function applyRosterAsNewWorkspace(decoded, ctrl) {
  const { tagNames: senderTagNames, patients: roster } = decoded;
  if (roster.length === 0) {
    alert(t("qr.import.empty.home"));
    return;
  }

  const label = formatRecvLabel();
  if (!confirm(t("home.qrImport.newWs.confirm", { count: roster.length, label }))) return;

  // 新規 WS の patients: 50 slot 確保し、受信 roster を先頭から流し込む。
  // 末尾の連続空 slot は roster.length で打ち切る想定だが、最低 DEFAULT_PATIENT_COUNT
  // は確保しておく (一般的な回診運用に合わせる)。
  const slotCount = Math.max(DEFAULT_PATIENT_COUNT, roster.length);
  const newPatients = [];
  for (let i = 0; i < slotCount; i++) {
    const p = makeDefaultPatient();
    const r = roster[i];
    if (r) {
      p.room = r.room || "";
      p.name = r.name || "";
      // tagIdxs は sender 辞書 (senderTagNames) に対する 1-based index
      p.tags = (r.tagIdxs || []).map(idx => senderTagNames[idx - 1]).filter(Boolean);
      // 受信した患者は外部由来としてマーク (qrRedistribution.HM=restricted 用)
      if (p.room || p.name || p.tags.length) p.origin = "external";
    }
    newPatients.push(p);
  }

  // 新規 WS の settings: 現在の settings をベースに、送信側のタグを union
  const mergedTags = (settings.tags || []).slice();
  for (const tag of senderTagNames) {
    if (!mergedTags.includes(tag)) mergedTags.push(tag);
  }
  const newSettings = { ...settings, tags: mergedTags };

  // bundle 化 → IDB に新規エントリ → 切替
  const newAppState = { v: 3, title: appState.title, patients: newPatients };
  const newBundle = projectBundle({ appState: newAppState, settings: newSettings });
  const newId = await createWorkspaceRecord(label, newBundle);
  // switchWorkspace は切替前に現病棟を fail-closed 保存する。失敗時は throw されるので
  // 切替を中断して通知 (現病棟データは保たれる。新病棟は作成済みなので後から手動切替可)。
  try {
    await switchWorkspace(newId);
  } catch (e) {
    console.error("qr import: switch to new ws failed:", e);
    ctrl.close();
    alert(t("io.ws.switch.failed"));
    return;
  }
  ctrl.close();
  alert(t("home.qrImport.newWs.done", { count: roster.length, label }));
}

const flow = createQrFlow({
  kind: "HM",
  kindLabel: t("qr.kind.home"),
  emptyMessage: t("qr.empty.noTargets"),
  ids: {
    wrapId: "homeQrWrap",
    canvasId: "homeQrCanvas",
    pageMetaId: "homeQrPageMeta",
    prevBtnId: "homeQrPrevBtn",
    nextBtnId: "homeQrNextBtn",
    showBtnId: "homeShowQrBtn",
    scanBtnId: "homeQrScanBtn",
  },
  encodePayload: () => encodePatientList({ fieldName: null, includeEmpty: true, kind: "HM" }),
  decodePayload: (payload) => decodePatientList(payload),
  onApply: applyRosterAsNewWorkspace,
  // 設定で kind=HM の暗号化が ON なら encrypt
  shouldEncrypt: () => !!settings.qrEncryption?.HM,
});

export const initHomeQr = () => flow.init();
export const isHomeQrActive = () => flow.isActive();
export const refreshHomeQrIfActive = () => flow.refresh();
