"use strict";

import { appState, settings } from "../store.js";
import { patientMatchesSharedFilter } from "./tags.js";
import { buildTagDict, patientToWire, patientFromWire } from "./qr-protocol.js";
import { t } from "../i18n.js";

// ============================
// 患者リスト系 QR ペイロード (HM/MM/SH 共通)
//
// wire format の詳細は qr-protocol.js の Wire Format Authority コメントを参照。
// ここでは「患者配列 + タグ辞書」のエンベロープ部分を組み立てる。
//
// 形式 (v3):
//   {
//     "v": 3,
//     "td": ["内科","外科"],          // tag dictionary (settings.tags のスナップショット)
//     "p": [
//       {"r":"203","n":"テスト太郎","t":[1,3],"c":"本日体温..."},
//       {},                            ← HM の空 slot
//       {"r":"204","n":"テスト次郎","t":[2]}
//     ]
//   }
//
// - HM (ホーム): 全 slot をその順で並べる。末尾の空はトリム可
// - MM/SH:       content がある患者だけを列挙
// ============================

const WIRE_V = 3;

export function encodePatientList(cfg) {
  // cfg.fieldName: null (HM) | "memo" (MM) | "shared" (SH)
  // cfg.includeEmpty: true (HM) | false (MM/SH)
  // cfg.matchesFilter: 任意フィルタ。指定があれば該当患者だけを対象に
  // cfg.kind: QR 種別 ("HM" / "MM" / "SH")。再配布制限の判定に使う
  const fieldName = cfg.fieldName || null;
  const includeEmpty = !!cfg.includeEmpty;
  const matchesFilter = cfg.matchesFilter || (() => true);

  // 再配布制限 (settings.qrRedistribution[kind] === "restricted") が ON なら
  // origin === "external" の患者 = 他端末から QR で受信したデータを送信時に除外。
  const kind = cfg.kind || "";
  const restrict = (settings.qrRedistribution && settings.qrRedistribution[kind] === "restricted");

  const tagDict = buildTagDict();

  const patientArr = [];
  for (const p of appState.patients) {
    // restricted な kind では external 患者を除外 (HM では空スロット扱い)
    if (restrict && p && p.origin === "external") {
      if (includeEmpty) patientArr.push({});
      continue;
    }
    if (!matchesFilter(p)) {
      if (includeEmpty) patientArr.push({});
      continue;
    }
    const wire = patientToWire(p, tagDict, fieldName);
    // MM/SH: content が無い患者は載せない
    if (fieldName && !wire.c) continue;
    patientArr.push(wire);
  }

  // HM の末尾連続空を削る（受信側は p.length までを反映、残りはデフォルト）
  if (includeEmpty) {
    while (patientArr.length > 0) {
      const last = patientArr[patientArr.length - 1];
      if (Object.keys(last).length === 0) patientArr.pop();
      else break;
    }
  }

  const out = {
    v: WIRE_V,
    td: tagDict,
    p: patientArr,
  };
  return JSON.stringify(out);
}

export function decodePatientList(payload) {
  const obj = JSON.parse(String(payload || ""));
  if (!obj || typeof obj !== "object") {
    throw new Error(t("qrSettings.invalid"));
  }
  if (obj.v !== WIRE_V) {
    throw new Error(t("qrSettings.versionMismatch", { a: obj.v, b: WIRE_V }));
  }
  const tagDict = Array.isArray(obj.td) ? obj.td.filter(x => typeof x === "string") : [];
  const rawList = Array.isArray(obj.p) ? obj.p : [];
  // 既存呼び出し側は { tagNames, patients:[{room,name,tagIdxs,content}] } を期待。
  // tagIdxs は受信側で使われていないので、後方互換のため tags(名前配列) と tagIdxs
  // (= tags の数値マッピング) の両方を提供する。
  const patients = rawList.map(entry => {
    const decoded = patientFromWire(entry, tagDict);
    // tagIdxs は「sender 辞書に対する 1-based index」を期待する旧呼び出し用に再構築
    const tagIdxs = decoded.tags.map(name => tagDict.indexOf(name) + 1).filter(i => i > 0);
    return {
      room: decoded.room,
      name: decoded.name,
      tagIdxs,
      content: decoded.content,
    };
  });
  return { tagNames: tagDict, patients };
}

// 共有/メモ画面で QR 生成対象を絞るときに使う（既存のタグフィルタを尊重）
export { patientMatchesSharedFilter };
