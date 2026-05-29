"use strict";

import { appState, settings } from "../store.js";
import { utf8ByteLength } from "../payload.js";
import { t } from "../i18n.js";
import {
  FORMAT_PANELS,
  FORMAT_ITEM_KINDS,
  DEFAULT_ITEM_KIND,
  DEFAULT_LABEL_SEP_OTHER,
  DEFAULT_LABEL_SEP_TEXT,
} from "../constants.js";

// ========================================================================
// QR Wire Format Authority (最終仕様)
//
// このファイルはすべての QR 種 (HM/MM/SH/ST/FMT) が従う共通仕様を定義する。
// 各 kind ファイル (qr-home.js / qr-shared.js / qr-settings.js / qr-format.js)
// は本ファイルが export するヘルパーを **必ず経由** すること。独自の wire
// format を定義しないこと。
//
// ── 設計 2 原則 ──
//
// 原則 ①「可変領域は冒頭辞書 + index 参照」:
//   ユーザーが順序や内容を変えうるもの (タグ名、フォーマット並び、項目並び等)
//   は、ペイロード冒頭に辞書を 1 回だけ置き、本体は数値 index で参照する。
//   位置依存のスキーマ宣言は禁止 (順序が変わると壊れる)。
//
// 原則 ②「コード固定値は wire に含めない」:
//   コード側で決まっている enum 許容値・デフォルト値は wire に乗せない。
//   受信側コードが復元する。enum 値は数値 index で送る (本ファイルの
//   PANEL_BY_INDEX 等を参照)。デフォルトと等価な値は省略する。
//
// ── 短キー命名規約 ──
//
//   トップレベル:
//     v   = version (WIRE_V)
//     td  = tag dictionary (string[]、1-based で参照される)
//     p   = patients array (HM/MM/SH)
//     f   = formats array (ST) / format object (FMT)
//     ct  = clearTargets (ST)
//     tge = tagGroupingEnabled (ST)
//     tgs = tagGroups array (ST)
//     tga = tagGroupAssign as [[tag_idx, group_idx], ...] (ST)
//
//   患者 (p[i]):
//     r = room
//     n = name
//     t = tag indices (td への 1-based 参照; 文字列も互換受信)
//     c = content (MM/SH のみ; HM では省略)
//
//   フォーマット (f[i] または FMT の f):
//     n  = name
//     p  = panel index (PANEL_BY_INDEX への 0-based 参照)
//     j  = joiner       (default は省略)
//     ls = labelSep     (default は省略)
//     tw = titleWrap    (展開時にフォーマット名を囲む括弧ペア。空は省略)
//     t  = tag indices (td への 1-based 参照、または辞書なしなら文字列配列)
//     i  = items array
//     (旧 pn=pinned / d=isDefault は v8 で撤去。クイックアクセス・規定文はグループ側で
//      管理するようになり、フォーマット単体の wire には含めない)
//
//   フォーマット項目 (f[i].i[j]):
//     l  = label
//     k  = kind index (KIND_BY_INDEX への 0-based 参照)
//     u  = unit         (空は省略)
//     nm = normal       (空は省略)
//
//   タググループ (tgs[i]):
//     n = name
//     m = mode index (MODE_BY_INDEX への 0-based 参照)
//     注: id は wire に含めない (受信側で新発番)
//
// ── 互換性ルール (WIRE_V bump 判定) ──
//
//   bump 必須:
//     - 既存フィールドの意味変更・削除
//     - enum 許容値の追加 (旧版が未知 index を解釈できないため)
//     - 短キー名の変更
//
//   bump 不要:
//     - 新規フィールドの追加 (normalize 側が未知フィールドを温存する仕組み
//       のおかげで forward compat)
//
// ── 圧縮 prefix の互換性 ──
//
//   "E1:" = AES-GCM のみ (deflate なし、v7.1.x)
//   "E2:" = AES-GCM(deflate-raw(plain)) (v7.2.0+)
//   送信側は最新のみ生成、受信側は過去全 prefix を読めること。
//
// ── 将来の開発者へ ──
//
//   この設計は「ユーザーの編集自由と互換性を両立する」ために選ばれた。
//   「キー名を直書きする」「enum を文字列のまま送る」「位置依存の配列に
//   する」といった素朴な実装に戻すと、ユーザーが順序を変えた途端に壊れる
//   データ破壊バグになりうる。本仕様を絶対に逸脱しないこと。
//   詳細議論は git log で v7.2.0 のコミットメッセージを参照。
//
// ========================================================================

// 共有QR・メモQR・JSON保存のファイル名・detail.js の受信タイムスタンプで
// 再利用するアプリ共通のタイムスタンプ文字列
//   ${title}_YYYY_MMDD_HHMM
export function buildTimestampHeader() {
  const d = new Date();
  const titleSafe = (appState.title || t("app.title")).replace(/[\\/:*?"<>|]/g, "_");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${titleSafe}_${yyyy}_${mm}${dd}_${hh}${min}`;
}

// ============================
// Enum index tables (原則 ②)
// ============================
// PANEL_BY_INDEX / KIND_BY_INDEX / MODE_BY_INDEX は wire の数値 index を
// 文字列 enum 値に復元するためのテーブル。新規 enum 値を末尾に追加する
// 時は WIRE_V を bump する必要がある (旧版が未知 index を解釈できない)。

export const PANEL_BY_INDEX = Object.freeze(FORMAT_PANELS.slice());      // ["S","O","A","P"]
export const KIND_BY_INDEX  = Object.freeze(FORMAT_ITEM_KINDS.slice());  // ["text","number","fraction","date"]
// v7.7+: MODE_BY_INDEX は撤去 (タグ・カテゴリ機能撤去のため)

const PANEL_INDEX = Object.fromEntries(PANEL_BY_INDEX.map((v, i) => [v, i]));
const KIND_INDEX  = Object.fromEntries(KIND_BY_INDEX.map((v, i) => [v, i]));

function panelToIdx(s) {
  const i = PANEL_INDEX[s];
  return typeof i === "number" ? i : PANEL_INDEX.O; // default O
}
function panelFromIdx(i) {
  return PANEL_BY_INDEX[i] || "O";
}
function kindToIdx(s) {
  const i = KIND_INDEX[s];
  return typeof i === "number" ? i : KIND_INDEX[DEFAULT_ITEM_KIND];
}
function kindFromIdx(i) {
  return KIND_BY_INDEX[i] || DEFAULT_ITEM_KIND;
}

// ============================
// Tag dictionary helpers (原則 ①)
// ============================
// 送信側の settings.tags を辞書として 1 回だけ wire に乗せ、その他の
// タグ参照は 1-based の数値 index に置換する。受信側は辞書から文字列を
// 復元する。dict が null の時 (= FMT の単独 QR で辞書化のオーバーヘッドを
// 避けたい場合) は文字列のまま wire に乗せる。

// 送信側の現在のタグ辞書を取得 (settings.tags のコピー)
export function buildTagDict() {
  return (settings.tags || []).slice();
}

// タグ名配列 → wire 用の値配列。dict 指定時は 1-based index、なしは文字列のまま。
function tagsToWire(tagNames, dict) {
  if (!Array.isArray(tagNames)) return [];
  if (dict) {
    const out = [];
    for (const name of tagNames) {
      const idx = dict.indexOf(name);
      if (idx >= 0) out.push(idx + 1);
    }
    return out;
  }
  return tagNames.filter(s => typeof s === "string");
}

// wire の値配列 → タグ名配列。数値は dict から、文字列はそのまま (互換受信)。
function tagsFromWire(wireValues, dict) {
  if (!Array.isArray(wireValues)) return [];
  const out = [];
  for (const v of wireValues) {
    if (typeof v === "number") {
      const name = dict?.[v - 1];
      if (name) out.push(name);
    } else if (typeof v === "string" && v) {
      out.push(v);
    }
  }
  return out;
}

// ============================
// Format ↔ wire (原則 ① + ②)
// ============================

export function formatToWire(format, tagDict) {
  const f = format || {};
  const o = {
    n: String(f.name || ""),
    p: panelToIdx(f.panel),
  };
  // default 値は省略 (原則 ②)
  if (typeof f.joiner === "string" && f.joiner !== ", ") o.j = f.joiner;
  if (typeof f.labelSep === "string") {
    // labelSep の default は item の kind 構成によって決まるが、wire 上は
    // 「明示されていれば省略しない」シンプルルール。受信側で復元
    o.ls = f.labelSep;
  }
  if (typeof f.titleWrap === "string" && f.titleWrap) o.tw = f.titleWrap;
  const tWire = tagsToWire(Array.isArray(f.tags) ? f.tags : [], tagDict);
  if (tWire.length) o.t = tWire;
  o.i = (Array.isArray(f.items) ? f.items : []).map(itemToWire);
  return o;
}

export function formatFromWire(wire, tagDict) {
  const w = wire || {};
  const items = (Array.isArray(w.i) ? w.i : []).map(itemFromWire);
  const labelSep = typeof w.ls === "string"
    ? w.ls
    : (items.length && items.every(it => it.kind === "text") ? DEFAULT_LABEL_SEP_TEXT : DEFAULT_LABEL_SEP_OTHER);
  return {
    name: String(w.n || ""),
    panel: panelFromIdx(w.p),
    joiner: typeof w.j === "string" ? w.j : ", ",
    labelSep,
    titleWrap: typeof w.tw === "string" ? w.tw : "",
    tags: tagsFromWire(w.t, tagDict),
    items,
  };
}

function itemToWire(it) {
  const o = { l: String(it?.label ?? ""), k: kindToIdx(it?.kind) };
  if (typeof it?.unit === "string" && it.unit) o.u = it.unit;
  if (typeof it?.normal === "string" && it.normal) o.nm = it.normal;
  return o;
}

function itemFromWire(w) {
  const kind = kindFromIdx(w?.k);
  const o = { label: String(w?.l || ""), kind };
  if (typeof w?.u === "string") o.unit = w.u;
  if (typeof w?.nm === "string") o.normal = w.nm;
  return o;
}

// ============================
// Patient ↔ wire (HM/MM/SH 用)
// ============================
//   patientToWire は HM では fieldName=null で content を省く。
//   MM/SH では fieldName="memo"/"shared" を渡して content を載せる。

export function patientToWire(patient, tagDict, fieldName) {
  const p = patient || {};
  const room = String(p.room || "").trim();
  const name = String(p.name || "").trim();
  const tagIdxs = tagsToWire(Array.isArray(p.tags) ? p.tags : [], tagDict);
  const content = fieldName ? String(p[fieldName] ?? "").trim() : "";

  const isEmpty = !room && !name && tagIdxs.length === 0 && !content;
  if (isEmpty) return {};
  const obj = {};
  if (room) obj.r = room;
  if (name) obj.n = name;
  if (tagIdxs.length) obj.t = tagIdxs;
  if (fieldName) obj.c = content;
  return obj;
}

export function patientFromWire(wire, tagDict) {
  const w = wire || {};
  return {
    room: String(w.r || ""),
    name: String(w.n || ""),
    tags: tagsFromWire(w.t, tagDict),
    content: String(w.c || ""),
  };
}

// v7.7+: Tag groups wire 変換 (tagGroupToWire / tagGroupFromWire /
// tagGroupAssignToWire / tagGroupAssignFromWire) は撤去。
// 再実装するなら git tag hospital-rounds-v7.6.1 を参照

// ============================
// 多ページ QR 共通プロトコル (transport layer)
//
// すべての QR 種が以下のページ書式を共有する:
//
//   RND_<KIND> #<batchId> N/M\n<本文>
//
//   - KIND: HM | MM | SH | ST | FMT など 2 文字以上の大文字
//   - batchId: 1 回の送信を識別する短い ID（Date.now().toString(36)）
//   - N/M: ページ番号 / 総ページ数
//
// 本文は wire format の文字列 (JSON.stringify した短キー JSON)、または
// "E1:" / "E2:" で始まる暗号化された base64url 文字列。
// ============================

// 5 種すべての QR の上限。QR version ~20 (~97 modules) 程度で iPad camera
// で確実にスキャンできる範囲。圧縮で 1 ページに収めにくい場合は複数ページに
// 分割される。
const MAX_BYTES = 750;
// 'RND_HM #abcdef12 99/99\n' = 約 25 バイト。余裕を持って 50 バイト確保
const HEADER_BUDGET = 50;
const HEADER_RE = /^RND_([A-Z]+)\s+#(\S+)\s+(\d+)\/(\d+)\n([\s\S]*)$/;

export function newBatchId() {
  return Date.now().toString(36);
}

// ============================
// Escape helpers
// ============================

export function escapeField(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n");
}

export function unescapeField(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const c = s[i + 1];
      out += c === "n" ? "\n" : c;
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

export function splitEscapedPipe(line) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) {
      cur += line[i] + line[i + 1];
      i++;
    } else if (line[i] === "|") {
      parts.push(cur);
      cur = "";
    } else {
      cur += line[i];
    }
  }
  parts.push(cur);
  return parts;
}

// ============================
// Page chunking + headers
//
// payload を `budget` バイト以下に分割。可能な限り `\n` 境界で切り、
// 改行が無い payload（暗号化された base64 など）もコードポイント境界で分割する。
// チャンクは境界の `\n` を保持するので、受信側は ""（空文字）で連結すれば
// 元の payload に戻る。
// ============================

function chunkPayload(payload, budget) {
  if (utf8ByteLength(payload) <= budget) return [payload];

  const chunks = [];
  let i = 0;
  const len = payload.length;
  while (i < len) {
    let chunkBytes = 0;
    let lastNewlineEnd = -1;
    let j = i;
    while (j < len) {
      const code = payload.codePointAt(j);
      const cpBytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (chunkBytes + cpBytes > budget) break;
      chunkBytes += cpBytes;
      const cpUtf16 = code >= 0x10000 ? 2 : 1;
      if (payload[j] === "\n") lastNewlineEnd = j + 1;
      j += cpUtf16;
    }
    if (j === i) {
      // 1 文字でも budget を超える病的ケース。これ以上分割できないので強制送出
      chunks.push(payload.slice(i, i + 1));
      i += 1;
      continue;
    }
    const splitJ = lastNewlineEnd > i ? lastNewlineEnd : j;
    chunks.push(payload.slice(i, splitJ));
    i = splitJ;
  }
  return chunks.length === 0 ? [""] : chunks;
}

// payload を全ページ分の文字列配列に変換
export function encodePages({ kind, payload, batchId, maxBytes = MAX_BYTES }) {
  const trimmed = String(payload || "").trim();
  if (!trimmed) return [];
  const id = batchId || newBatchId();
  const budget = maxBytes - HEADER_BUDGET;
  const chunks = chunkPayload(payload, budget);
  const total = chunks.length;
  return chunks.map((c, i) => `RND_${kind} #${id} ${i + 1}/${total}\n${c}`);
}

// ヘッダー解析。形式に合わなければ null
export function decodePage(text) {
  const m = String(text || "").match(HEADER_RE);
  if (!m) return null;
  return {
    kind: m[1],
    batchId: m[2],
    pageNum: parseInt(m[3], 10),
    totalPages: parseInt(m[4], 10),
    content: m[5],
  };
}
