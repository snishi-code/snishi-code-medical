"use strict";

// ============================================================================
// 患者画面の「戻す / 進む」(Undo/Redo) — Phase 6
//
// 設計方針 (依頼者と合意):
//   - **患者(pid)ごとに閉じる** = Ctrl-Z のドキュメント単位。今開いている患者の入力
//     (フォーマット値 / プロブレムリスト / 共有) だけを 1 操作ずつ戻す/進む。
//     全状態クローンだと「別患者へ遷移後に戻すと、見ていない前患者が裏で戻る」事故が
//     起きるため、患者ごとに閉じる (= その事故が構造的に発生しない)。
//   - **フィールドスコープ**: Undo は対象フィールド (formatValues / memo / shared) だけを
//     in-place で入れ替える。患者オブジェクトを丸ごと差し替えると、Undo 対象外の患者識別
//     情報 (氏名 / 部屋 / ステータス / タグ / セット = activeFormatGroupId) まで巻き戻り、
//     「フォーマットを戻したら氏名・部屋も古い値に戻る」サイレントな PII 巻き戻りが起きる。
//     スコープを切ることで識別情報には一切触れない (Codex 監査指摘の修正)。
//   - **セッション内メモリのみ**: 永続化しない。リロードで履歴は消える (多くのエディタの
//     Ctrl-Z と同じ)。snapshots.js (IDB 災害復旧) とは別物・無関係。
//   - **操作単位**: ワンタップ正常/クリアは 1 ステップ。入力シート (number note textarea や
//     text 項目を含む) は保存 (applyFormatSheet) 単位で 1 ステップ (formats.js が
//     captureFormatUndo で起点を撮る)。
//   - **カーソル方式 redo**: 戻す→進むで往復。新規編集が入ると redo 枝を破棄。
//   - **fail-closed**: 差し替え後の保存が失敗したら live を元へ戻し、成功扱いにしない。
//
// 公開 API: captureUndoPoint / undo / redo /
//           canUndo / canRedo / refreshUndoButtons / setUndoRefresh
// ============================================================================

import { appState, selectedNo, markUpdated, persistActiveOrThrow } from "../store.js";
import { showToast } from "../toast.js";
import { formatPatientLabel } from "./room.js";
import { mergeTagsAdd, mergeTagsRemove } from "./format-values.js";
import { t } from "../i18n.js";

const MAX = 50; // 患者ごとのスタック上限 (古いものから捨てる)
// Entry = { label, fields, tagsAdded }。tagsAdded = この操作で自動付与されたタグ。
// Undo で除去 / Redo で再付与する (タグ列全体を巻き戻さず delta だけ扱う = 手編集タグを守る)。
const _hist = new Map(); // pid -> { undo: Entry[], redo: Entry[] }

// 種別ごとに「戻す対象フィールド」を定義する。ここに無いフィールド (name/room/status/
// tags/activeFormatGroupId など患者識別情報) は Undo で一切触らない。
// Phase 7: 臨床入力本文は全て formatValues に集約されたため、患者画面 Undo は format
// スコープ 1 本 (旧 memo/shared 専用スコープは撤去)。プロブレム/共有/受診メモも formatValues。
const LABEL_FIELDS = {
  format: ["formatValues"],
};
function fieldsFor(label) { return LABEL_FIELDS[label] || LABEL_FIELDS.format; }
// 患者 p から、その label の対象フィールドだけをクローンして取り出す。
function snapshotFields(p, label) {
  const out = {};
  for (const f of fieldsFor(label)) out[f] = clone(p[f]);
  return out;
}

let _refresh = null; // 差し替え後の再描画 (= refreshPatientUI)。main.js が注入。
export function setUndoRefresh(fn) { _refresh = fn; }

function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } }
function curPatient() { return appState.patients[selectedNo - 1] || null; }
function pidOf(p) { return (p && typeof p.pid === "string") ? p.pid : ""; }
function bucket(pid) {
  let b = _hist.get(pid);
  if (!b) { b = { undo: [], redo: [] }; _hist.set(pid, b); }
  return b;
}
function pushUndo(pid, fields, label, tagsAdded) {
  const b = bucket(pid);
  b.undo.push({ label, fields, tagsAdded: Array.isArray(tagsAdded) ? tagsAdded : [] });
  if (b.undo.length > MAX) b.undo.shift();
  b.redo.length = 0; // 新規編集で redo 枝を破棄 (Ctrl-Z と同じ)
}

// 値を変更する直前に呼ぶ Undo 起点 (操作単位)。preFields 省略時は現在患者の対象フィールド
// クローン (= 変更適用の直前に呼ぶ前提)。opts.tagsAdded = この操作で自動付与されるタグ delta。
export function captureUndoPoint(label, preFields, opts) {
  const p = curPatient();
  const pid = pidOf(p);
  if (!pid) return;
  const fields = (preFields !== undefined) ? preFields : snapshotFields(p, label);
  if (!fields) return;
  const tagsAdded = (opts && Array.isArray(opts.tagsAdded)) ? opts.tagsAdded.slice() : [];
  pushUndo(pid, fields, label, tagsAdded);
  refreshUndoButtons();
}

export function canUndo() { const b = _hist.get(pidOf(curPatient())); return !!(b && b.undo.length); }
export function canRedo() { const b = _hist.get(pidOf(curPatient())); return !!(b && b.redo.length); }

// entry の対象フィールドだけを現在患者へ in-place で書き戻し、反対スタックへ現状の同じ
// フィールドを積む。患者オブジェクトは差し替えず識別情報には触れない。自動付与タグの
// delta は dir に応じて undo=除去 / redo=再付与する (タグ列全体は巻き戻さない)。fail-closed。
async function applyEntry(entry, oppositeStack, dir) {
  const idx = selectedNo - 1;
  const p = appState.patients[idx];
  if (!p) return { ok: false };
  const keys = Object.keys(entry.fields);
  const tags = Array.isArray(entry.tagsAdded) ? entry.tagsAdded : [];
  const cur = {}; // 反対スタック用 (書き戻し前の現状フィールド)
  for (const f of keys) cur[f] = clone(p[f]);
  const tagsBackup = tags.length ? clone(p.tags) : null; // ロールバック用
  for (const f of keys) p[f] = entry.fields[f]; // 対象フィールドだけ in-place 入替
  if (tags.length) p.tags = (dir === "undo") ? mergeTagsRemove(p.tags, tags) : mergeTagsAdd(p.tags, tags);
  markUpdated(selectedNo);
  try {
    await persistActiveOrThrow();
  } catch (e) {
    console.error("patient-undo: save failed, rolling back live state", e);
    for (const f of keys) p[f] = cur[f]; // 画面と durable を一致させる (成功扱いにしない)
    if (tagsBackup) p.tags = tagsBackup;
    showToast(t("save.failed"), { ms: 4000 });
    return { ok: false };
  }
  oppositeStack.push({ label: entry.label, fields: cur, tagsAdded: tags });
  return { ok: true, label: entry.label };
}

function kindLabel(label) {
  const key = "undo.kind." + (label || "format");
  const s = t(key);
  return (s && s !== key) ? s : t("undo.kind.format");
}

async function step(dir) {
  const p = curPatient();
  const pid = pidOf(p);
  const b = _hist.get(pid);
  const from = dir === "undo" ? (b && b.undo) : (b && b.redo);
  const to = dir === "undo" ? (b && b.redo) : (b && b.undo);
  if (!from || !from.length) return { ok: false };
  const entry = from.pop();
  const res = await applyEntry(entry, to, dir);
  if (!res.ok) { from.push(entry); refreshUndoButtons(); return res; } // 失敗時は戻す
  // toast: 何を戻した/進めたか (患者名 + 種別)
  const name = formatPatientLabel(appState.patients[selectedNo - 1], String(selectedNo));
  showToast(t(dir === "undo" ? "undo.done" : "redo.done", { name, kind: kindLabel(entry.label) }));
  if (_refresh) _refresh();
  refreshUndoButtons();
  return res;
}

export function undo() { return step("undo"); }
export function redo() { return step("redo"); }

// ヘッダーの戻す/進むボタンの活性状態を現在患者のスタック深さで更新する。
// renderDetail (患者画面描画) と undo/redo 後に呼ぶ → 患者切替で自動的にその患者の
// スタックを反映する。
export function refreshUndoButtons() {
  const u = document.getElementById("detailUndoBtn");
  const r = document.getElementById("detailRedoBtn");
  if (u) { u.disabled = !canUndo(); u.setAttribute("aria-disabled", u.disabled ? "true" : "false"); }
  if (r) { r.disabled = !canRedo(); r.setAttribute("aria-disabled", r.disabled ? "true" : "false"); }
}
